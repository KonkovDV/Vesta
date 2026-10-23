// AuthMiddleware - Middleware для проверки API ключей и rate limiting
// Перемещено в Application/Protocol слой для соблюдения границ слоев

import express from 'express';
import * as core from 'express-serve-static-core';
import { AuthService, AuthContext, AuthPermissions } from '../services/AuthService';
import { RateLimitService, RateLimitError } from '../services/RateLimitService';
import { RequestContext, BrandedIds, RequestContextError } from '../context/request-context';

function wrapAsyncMiddleware(
  handler: (req: core.Request, res: core.Response, next: core.NextFunction) => Promise<void>,
): core.RequestHandler {
  return (req, res, next): void => {
    void handler(req, res, next).catch(next);
  };
}

export interface AuthenticatedRequest extends core.Request {
  user?: {
    id: string;
    tenantId: string | null;
    permissions: AuthPermissions;
  };
  authContext?: AuthContext;
}

export class AuthorizationError extends Error {
  constructor(
    public code: 'UNAUTHORIZED' | 'RATE_LIMIT_EXCEEDED' | 'FORBIDDEN',
    message: string,
    public statusCode: number = 401,
    public retryAfter?: number
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export class RateLimitExceededError extends AuthorizationError {
  constructor(message: string, retryAfter: number) {
    super('RATE_LIMIT_EXCEEDED', message, 429, retryAfter);
    this.name = 'RateLimitExceededError';
  }
}

interface ErrorWithStatus extends Error {
  status?: number;
}

// Type guard для проверки структуры запроса
function isValidRequest(req: unknown): req is {
  headers?: Record<string, unknown>;
  ip?: string;
  connection?: { remoteAddress?: string };
  socket?: { remoteAddress?: string };
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  body?: unknown;
} {
  return req !== null && typeof req === 'object';
}

const TENANT_HEADERS = ['x-tenant-id', 'x-organization-id'] as const;

function headerValues(req: { headers?: Record<string, unknown> }, name: string): string[] {
  const raw = req.headers?.[name];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function forbidden(message: string): ErrorWithStatus {
  const error: ErrorWithStatus = new Error(message);
  error.status = 403;
  return error;
}

/**
 * The API key decides who is calling. x-user-id must name the key's user, and
 * x-tenant-id / x-organization-id the key's tenant. Only a key without a tenant
 * may choose the tenant by header.
 */
function assertIdentityHeaders(req: { headers?: Record<string, unknown> }, authContext: AuthContext): void {
  if (headerValues(req, 'x-user-id').some((value) => value !== authContext.userId)) {
    throw forbidden('x-user-id does not match the authenticated user');
  }
  const keyTenantId = authContext.tenantId;
  if (!keyTenantId) {
    return;
  }
  for (const name of TENANT_HEADERS) {
    if (headerValues(req, name).some((value) => value !== keyTenantId)) {
      throw forbidden(`${name} does not match the tenant of the API key`);
    }
  }
}

export type ScopedTenant = { allowed: true; tenantId: string | undefined } | { allowed: false };

/**
 * The tenant a request acts on: the API key's tenant, else the x-tenant-id a key without a
 * tenant set (read through `contextTenantId`), else the tenant such a key names in the body.
 * A body tenantId that differs from the key or header tenant is refused.
 */
export function resolveScopedTenant(
  req: core.Request,
  bodyTenantId: string | undefined,
  contextTenantId: () => string | undefined,
): ScopedTenant {
  const keyTenantId = (req as AuthenticatedRequest).authContext?.tenantId;
  const scopedTenantId = typeof keyTenantId === 'string' && keyTenantId.length > 0 ? keyTenantId : contextTenantId();
  if (scopedTenantId && bodyTenantId && bodyTenantId !== scopedTenantId) {
    return { allowed: false };
  }
  return { allowed: true, tenantId: scopedTenantId ?? bodyTenantId };
}

/** Tenant in RequestContext, or undefined outside an HTTP request context. */
export function requestContextTenantId(): string | undefined {
  try {
    const tenantId = RequestContext.getContext().tenantId;
    return typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : undefined;
  } catch {
    return undefined;
  }
}

export function requireScope(scope: string): core.RequestHandler {
  return (req, res, next): void => {
    const scopes = (req as AuthenticatedRequest).authContext?.scopes ?? [];
    if (!scopes.includes(scope)) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: `missing scope ${scope}` },
      });
      return;
    }
    next();
  };
}

export function createAuthMiddleware(authService: AuthService): core.RequestHandler {
  return wrapAsyncMiddleware(async (req, res, next) => {
    try {
      // Проверяем, что req имеет нужную структуру
      if (!isValidRequest(req)) {
        throw new Error('Invalid request object');
      }
      
      // Используем оригинальный объект без создания копий
      const authContext = await authService.authenticateRequest(req);
      assertIdentityHeaders(req, authContext);
      
      // Type-safe установка свойств
      (req as AuthenticatedRequest).authContext = authContext;
      (req as AuthenticatedRequest).user = {
        id: authContext.userId,
        tenantId: authContext.tenantId ?? null,
        permissions: authContext.permissions
      };

      // The authenticated identity replaces the one RequestContextFactory read from headers.
      // A key without a tenant keeps the tenant from x-tenant-id / x-organization-id.
      try {
        if (authContext.userId) {
          RequestContext.setUserId(BrandedIds.createUserId(authContext.userId));
        }
        if (authContext.tenantId) {
          RequestContext.setTenantId(BrandedIds.createTenantId(authContext.tenantId));
        }
      } catch (rctxError) {
        if (!(rctxError instanceof RequestContextError)) {
          throw rctxError;
        }
        // RequestContext may not be initialized (non-HTTP flows); ignore silently.
      }
      
      next();
    } catch (error) {
      const statusValue = error instanceof Error && 'status' in error && typeof error.status === 'number'
        ? error.status
        : 401;
      const status = statusValue ?? 401;
      const message = error instanceof Error ? error.message : 'Authentication failed';
      
      // Проверяем, что res имеет нужные методы
      if (res && typeof res === 'object' && 'status' in res && 'json' in res) {
        const response = res as { status: (code: number) => { json: (data: unknown) => void } };
        response.status(status).json({
          error: { code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message }
        });
      }
    }
  });
}

export function createRateLimitMiddleware(rateLimitService: RateLimitService): core.RequestHandler {
  return wrapAsyncMiddleware(async (req, res, next) => {
    try {
      // Проверяем путь без приведения типов
      const path = req && typeof req === 'object' && 'path' in req && typeof (req as { path?: string }).path === 'string'
        ? (req as { path: string }).path
        : '';
      
      if (path.startsWith('/health') || path.startsWith('/metrics')) {
        next();
        return;
      }
      
      // Проверяем аутентификацию
      const authReq = req as Partial<AuthenticatedRequest>;
      if (!authReq.authContext || !authReq.user) {
        if (res && typeof res === 'object' && 'status' in res && 'json' in res) {
          const response = res as { status: (code: number) => { json: (data: unknown) => void } };
          response.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Пользователь не аутентифицирован' } });
        }
        return;
      }
      
      const userId = authReq.authContext.userId;
      const operation = getOperationFromRequest(req);
      await rateLimitService.checkLimit(userId, operation);
      
      try {
        const stats = await rateLimitService.getUserStats(userId);
        const limit = stats.requests_today + stats.requests_remaining;
        
        if (res && typeof res === 'object' && 'setHeader' in res) {
          const response = res as { setHeader: (name: string, value: string) => void };
          response.setHeader('X-RateLimit-Limit', limit.toString());
          response.setHeader('X-RateLimit-Remaining', stats.requests_remaining.toString());
          response.setHeader('X-RateLimit-Reset', Math.ceil(stats.reset_time / 1000).toString());
          response.setHeader('X-RateLimit-Window', '60');
        }
      } catch { /* intentional: best-effort rate limit headers, non-critical */ }
      
      next();
    } catch (error) {
      if (res && typeof res === 'object' && 'status' in res && 'json' in res) {
        const response = res as { status: (code: number) => { json: (data: unknown) => void } };
        
        if (error instanceof RateLimitError) {
          response.status(429).json({
            error: {
              code: 'RATE_LIMIT_EXCEEDED',
              message: error.message,
              retry_after: error.retryAfterSeconds
            }
          });
          return;
        }
        
        if (error instanceof AuthorizationError) {
          response.status(error.statusCode).json({
            error: {
              code: error.code,
              message: error.message,
              retry_after: error.retryAfter
            }
          });
          return;
        }
        
        response.status(500).json({
          error: {
            code: 'INTERNAL_RATE_LIMIT_ERROR',
            message: 'Внутренняя ошибка проверки лимитов'
          }
        });
      }
    }
  });
}

export function createPermissionMiddleware(requiredPermission: keyof AuthPermissions) {
  return (req: unknown, res: unknown, next: () => void) => {
    const authReq = req as Partial<AuthenticatedRequest>;
    
    if (!authReq.user || !authReq.authContext) {
      if (res && typeof res === 'object' && 'status' in res && 'json' in res) {
        const response = res as { status: (code: number) => { json: (data: unknown) => void } };
        response.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Пользователь не аутентифицирован' }
        });
      }
      return;
    }
    
    if (!authReq.authContext.permissions[requiredPermission]) {
      if (res && typeof res === 'object' && 'status' in res && 'json' in res) {
        const response = res as { status: (code: number) => { json: (data: unknown) => void } };
        response.status(403).json({
          error: { code: 'FORBIDDEN', message: `Недостаточно прав для операции: ${requiredPermission}` }
        });
      }
      return;
    }
    
    next();
  };
}

export const FEATURE_FLAGS_ADMIN_SCOPE = 'admin.feature_flags';

export function createFeatureFlagsAdminMiddleware(authService: AuthService) {
  return (req: unknown, res: unknown, next: () => void) => {
    const authReq = req as Partial<AuthenticatedRequest>;

    if (!authReq.user || !authReq.authContext) {
      if (res && typeof res === 'object' && 'status' in res && 'json' in res) {
        const response = res as { status: (code: number) => { json: (data: unknown) => void } };
        response.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Пользователь не аутентифицирован' }
        });
      }
      return;
    }

    const scopes = Array.isArray(authReq.authContext.scopes)
      ? authReq.authContext.scopes
      : [];

    if (!scopes.includes(FEATURE_FLAGS_ADMIN_SCOPE)) {
      if (res && typeof res === 'object' && 'status' in res && 'json' in res) {
        const response = res as { status: (code: number) => { json: (data: unknown) => void } };
        response.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: `Недостаточно прав для управления feature flags. Требуется scope "${FEATURE_FLAGS_ADMIN_SCOPE}".`
          }
        });
      }
      return;
    }

    next();
  };
}
export function createContextLimitMiddleware() {
  return (req: unknown, res: unknown, next: () => void) => {
    const authReq = req as Partial<AuthenticatedRequest>;
    
    if (!authReq.user || !authReq.authContext) {
      if (res && typeof res === 'object' && 'status' in res && 'json' in res) {
        const response = res as { status: (code: number) => { json: (data: unknown) => void } };
        response.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Пользователь не аутентифицирован' }
        });
      }
      return;
    }
    
    const maxContextLength = authReq.authContext.permissions.max_context_length;
    
    // Безопасно проверяем структуру запроса
    if (req && typeof req === 'object' && 'body' in req) {
      const request = req as { body?: unknown };
      const body = request.body;
      
      if (body && typeof body === 'object' && 'messages' in body) {
        const bodyWithMessages = body as { messages?: unknown };
        const messages = bodyWithMessages.messages;
        
        if (Array.isArray(messages)) {
          const totalContent = messages
            .map((msg: unknown) => {
              if (msg && typeof msg === 'object' && 'content' in msg) {
                const msgWithContent = msg as { content?: unknown };
                return typeof msgWithContent.content === 'string' ? msgWithContent.content : '';
              }
              return '';
            })
            .join(' ').length;
            
          if (totalContent > maxContextLength) {
            if (res && typeof res === 'object' && 'status' in res && 'json' in res) {
              const response = res as { status: (code: number) => { json: (data: unknown) => void } };
              response.status(400).json({
                error: {
                  code: 'CONTEXT_LENGTH_EXCEEDED',
                  message: `Размер контекста превышает лимит: ${maxContextLength} токенов`,
                  details: { current: totalContent, limit: maxContextLength }
                }
              });
            }
            return;
          }
        }
      }
    }
    
    next();
  };
}

function getOperationFromRequest(req: unknown): string {
  const path = req && typeof req === 'object' && 'path' in req && typeof (req as { path?: string }).path === 'string'
    ? (req as { path: string }).path.toLowerCase()
    : '';
    
  if (path.includes('/chat/completions')) return 'chat_completions';
  if (path.includes('/upload')) return 'file_upload';
  if (path.includes('/props')) return 'server_props';
  if (path.includes('/slots')) return 'server_slots';
  return 'general';
}


