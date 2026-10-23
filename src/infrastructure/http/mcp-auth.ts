/**
 * MCP HTTP authentication. Depends on a request authenticator, not on AuthService.
 * Layer: Infrastructure
 */

import type { RequestHandler } from 'express';
import { BrandedIds, RequestContext, RequestContextError } from '../../core/context/request-context';

export interface HttpAuthPermissions {
  can_stream: boolean;
  can_upload_files: boolean;
  max_context_length: number;
  rate_limit: {
    requests_per_minute: number;
    tokens_per_minute: number;
  };
}

export interface HttpAuthContext {
  userId: string;
  tenantId?: string | null;
  permissions: HttpAuthPermissions;
  scopes: string[];
}

export interface HttpRequestAuthenticator {
  authenticateRequest(req: object): Promise<HttpAuthContext>;
}

type ErrorWithStatus = Error & { status?: number };

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

function assertIdentityHeaders(
  req: { headers?: Record<string, unknown> },
  authContext: HttpAuthContext,
): void {
  if (headerValues(req, 'x-user-id').some((value) => value !== authContext.userId)) {
    throw forbidden('x-user-id does not match the authenticated user');
  }
  const keyTenantId = authContext.tenantId;
  if (!keyTenantId) return;
  for (const name of TENANT_HEADERS) {
    if (headerValues(req, name).some((value) => value !== keyTenantId)) {
      throw forbidden(`${name} does not match the tenant of the API key`);
    }
  }
}

export function createMcpAuthMiddleware(authenticator: HttpRequestAuthenticator): RequestHandler {
  return (req, res, next): void => {
    void (async (): Promise<void> => {
      if (req === null || typeof req !== 'object') {
        throw new Error('Invalid request object');
      }
      const authContext = await authenticator.authenticateRequest(req);
      assertIdentityHeaders(req, authContext);
      const authenticated = req as {
        authContext?: HttpAuthContext;
        user?: { id: string; tenantId: string | null; permissions: HttpAuthPermissions };
      };
      authenticated.authContext = authContext;
      authenticated.user = {
        id: authContext.userId,
        tenantId: authContext.tenantId ?? null,
        permissions: authContext.permissions,
      };
      try {
        if (authContext.userId) {
          RequestContext.setUserId(BrandedIds.createUserId(authContext.userId));
        }
        if (authContext.tenantId) {
          RequestContext.setTenantId(BrandedIds.createTenantId(authContext.tenantId));
        }
      } catch (error) {
        if (!(error instanceof RequestContextError)) throw error;
      }
      next();
    })().catch((error: unknown) => {
      const status = error instanceof Error && 'status' in error && typeof error.status === 'number'
        ? error.status
        : 401;
      const message = error instanceof Error ? error.message : 'Authentication failed';
      res.status(status).json({
        error: { code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message },
      });
    });
  };
}
