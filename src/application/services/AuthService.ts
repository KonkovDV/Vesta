/**
 * AuthService - базовая аутентификация/авторизация для BFF слоя
 * Layer: Application
 *
 * Консолидация:
 * - Убран импорт несуществующего getSecurityConfig
 * - Добавлены методы уровня BFF: authenticateRequest(), validateApiKey(), getUserInfo()
 * - Единый контракт permissions совместим со спецификацией WebUI
 * - DI-регистрация выполняется через инфраструктурный bootstrap (infrastructure/di/bootstrap.ts)
 */

import { ProtocolErrorCode, ProtocolUtils } from '../../protocol/index';
import type { IAuthService, AuthContext as CoreAuthContext } from '../../core/auth/IAuthService';
import { getConfig, getRawEnv } from '../../config';
import type { AppConfig } from '../../config/schema';
import { tryJsonParse } from '../../core/utils/json';
import type { ApiKeyService } from './ApiKeyService';
import type { ILogger } from '../../core/decorators/ILogger';
/** Разрешения в стиле спецификации WebUI */
export interface AuthPermissions {
  can_stream: boolean;
  can_upload_files: boolean;
  max_context_length: number;
  rate_limit: {
    requests_per_minute: number;
    tokens_per_minute: number;
  };
}

/** Контекст авторизации для внутреннего использования (application-level shape). */
export interface AuthContext {
  userId: string;
  tenantId?: string | null;
  tokenType: 'apiKey';
  permissions: AuthPermissions;
  scopes: string[];
  metadata?: Record<string, unknown>;
}

/** Результат валидации API ключа (совместимость с WebUI-стилем) */
export interface AuthResult {
  valid: boolean;
  user_id?: string;
  tenant_id?: string | null;
  permissions: AuthPermissions;
}

type ApiKeyRecord = {
  userId: string;
  tenantId?: string | null;
  permissions: AuthPermissions;
  scopes: string[];
  metadata?: Record<string, unknown>;
};

function createProtocolAuthError(message: string, status = 401): Error {
  const errorResponse = ProtocolUtils.error(
    status === 401 ? ProtocolErrorCode.UNAUTHORIZED : ProtocolErrorCode.FORBIDDEN,
    message,
  );
  const error = new Error(message) as Error & {
    status?: number;
    statusCode?: number;
    response?: unknown;
  };
  error.statusCode = status;
  error.status = status;
  error.response = errorResponse;
  return error;
}

function isProductionNodeEnv(nodeEnv: string | undefined): boolean {
  const normalized = (nodeEnv || '').toLowerCase();
  return normalized === 'production' || normalized === 'prod';
}

/**
 * A key in the query string ends up in proxy logs, browser history and Referer.
 * It is accepted only outside production and only with ALLOW_QUERY_API_KEY=true.
 */
function allowQueryApiKey(nodeEnv: string | undefined): boolean {
  return !isProductionNodeEnv(nodeEnv) && getRawEnv().ALLOW_QUERY_API_KEY === 'true';
}

function extractApiKeyFromRequestValue(req: {
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
}, allowQueryApiKey: boolean): string {
  const xKey = req.headers?.['x-api-key'];
  if (typeof xKey === 'string' && xKey.trim().length > 0) {
    return xKey.trim();
  }

  const authHeader = req.headers?.['authorization'];
  if (authHeader && typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1].trim();
    }
  }

  if (allowQueryApiKey) {
    const queryKey = req.query?.['api_key'];
    if (typeof queryKey === 'string' && queryKey.trim().length > 0) {
      return queryKey.trim();
    }
  }

  throw createProtocolAuthError('API token is required', 401);
}

/**
 * Application-уровневая реализация core-контракта IAuthService.
 * Используется SecurityAspect через DI-токен 'IAuthService'.
 * Не выполняет глобальную саморегистрацию — wiring только через bootstrap.
 */
export class AuthService implements IAuthService {
  private readonly defaultPermissions: AuthPermissions = {
    can_stream: true,
    can_upload_files: true,
    max_context_length: 8192,
    rate_limit: {
      requests_per_minute: 60,
      tokens_per_minute: 10000
    }
  };

  /**
   * Хранилище валидных API ключей (память процесса).
   * Формат переменной окружения BFF_API_KEYS:
   * - JSON: [{"key":"k1","userId":"u1","tenantId":"t1"}, ...]
   * - CSV (упрощенно): key1:user1:tenant1,key2:user2
   * Также поддерживается одиночный ключ в BFF_API_KEY.
   */
  private readonly apiKeys: Map<string, ApiKeyRecord>;
  private readonly config: AppConfig;
  private readonly apiKeyService?: ApiKeyService;
  private readonly apiKeyPoliciesById: Map<string, ApiKeyRecord>;
  private envBootstrapPromise: Promise<void> | null;
  private readonly logger?: ILogger;

  constructor(apiKeyService?: ApiKeyService, logger?: ILogger) {
    this.config = getConfig();
    this.apiKeys = this.loadApiKeysFromEnv();
    this.apiKeyService = apiKeyService;
    this.apiKeyPoliciesById = new Map<string, ApiKeyRecord>();
    this.envBootstrapPromise = null;
    this.logger = logger;
  }

  /**
   * Внутренняя аутентификация по токену. Возвращает полный AuthContext (application-level).
   *
   * Предпочитает проверку через ApiKeyService (хранилище хешей в БД),
   * а env-конфигурацию использует как источник политик (permissions/scopes) и fallback.
   */
  private async authenticateInternal(token: string): Promise<AuthContext> {
    if (!token || typeof token !== 'string') {
      throw createProtocolAuthError('API token is required', 401);
    }

    const normalizedToken = token.trim();
    if (normalizedToken.length === 0) {
      throw createProtocolAuthError('API token is required', 401);
    }

    if (this.apiKeyService) {
      await this.ensureEnvKeysBootstrapped();
      const validated = await this.apiKeyService.validate(normalizedToken);

      if (!validated) {
        throw createProtocolAuthError('Invalid API token', 401);
      }

      const policy = this.apiKeyPoliciesById.get(validated.keyId);
      const permissions = policy ? policy.permissions : this.defaultPermissions;
      const scopes = policy ? policy.scopes : [...validated.scopes];
      const metadata = policy ? policy.metadata : undefined;

      const ctxFromStore: AuthContext = {
        userId: validated.ownerId,
        tenantId: validated.tenantId ?? null,
        tokenType: 'apiKey',
        permissions,
        scopes,
        metadata,
      };
      return ctxFromStore;
    }

    const rec = this.apiKeys.get(normalizedToken);
    if (!rec) {
      throw createProtocolAuthError('Invalid API token', 401);
    }

    const ctx: AuthContext = {
      userId: rec.userId,
      tenantId: rec.tenantId ?? null,
      tokenType: 'apiKey',
      permissions: rec.permissions,
      scopes: rec.scopes,
      metadata: rec.metadata,
    };
    return ctx;
  }

  /**
   * Аутентификация по токену. Возвращает CoreAuthContext (core-level) либо бросает ошибку.
   * Реализация интерфейса IAuthService.authenticate.
   */
  async authenticate(token: string): Promise<CoreAuthContext> {
    const ctx = await this.authenticateInternal(token);
    const coreCtx: CoreAuthContext = {
      userId: ctx.userId,
      scopes: ctx.scopes,
      metadata: ctx.metadata
    };
    return coreCtx;
  }

  /**
   * BFF-уровень: аутентифицирует Express Request.
   * Извлекает ключ из x-api-key, Authorization: Bearer, либо query api_key.
   */
  async authenticateRequest(req: {
    headers?: Record<string, unknown>;
    ip?: string;
    connection?: { remoteAddress?: string };
    socket?: { remoteAddress?: string };
    method?: string;
    path?: string;
    query?: Record<string, unknown>;
    body?: unknown;
  }): Promise<AuthContext> {
    const token = extractApiKeyFromRequestValue(req, allowQueryApiKey(this.config.NODE_ENV));
    return this.authenticateInternal(token);
  }

  /**
   * Валидация API ключа (совместимо с ожидаемым контрактом фронта).
   */
  async validateApiKey(apiKey: string): Promise<AuthResult> {
    const normalized = apiKey.trim();
    if (normalized.length === 0) {
      return {
        valid: false,
        permissions: this.defaultPermissions,
      };
    }

    if (this.apiKeyService) {
      await this.ensureEnvKeysBootstrapped();
      const validated = await this.apiKeyService.validate(normalized);
      if (!validated) {
        return {
          valid: false,
          permissions: this.defaultPermissions,
        };
      }

      const policy = this.apiKeyPoliciesById.get(validated.keyId);
      const permissions = policy ? policy.permissions : this.defaultPermissions;

      return {
        valid: true,
        user_id: validated.ownerId,
        tenant_id: validated.tenantId ?? null,
        permissions,
      };
    }

    const rec = this.apiKeys.get(normalized);
    if (!rec) {
      return {
        valid: false,
        permissions: this.defaultPermissions,
      };
    }
    return {
      valid: true,
      user_id: rec.userId,
      tenant_id: rec.tenantId ?? null,
      permissions: rec.permissions,
    };
  }

  /**
   * Получить user_id/tenant_id по токену
   */
  async getUserInfo(token: string): Promise<{ user_id: string; tenant_id: string | null } | null> {
    const normalized = token.trim();
    if (normalized.length === 0) {
      return null;
    }

    if (this.apiKeyService) {
      await this.ensureEnvKeysBootstrapped();
      const validated = await this.apiKeyService.validate(normalized);
      if (!validated) {
        return null;
      }
      return { user_id: validated.ownerId, tenant_id: validated.tenantId ?? null };
    }

    const rec = this.apiKeys.get(normalized);
    if (!rec) {
      return null;
    }
    return { user_id: rec.userId, tenant_id: rec.tenantId ?? null };
  }

  /**
   * Получить permissions по userId
   */
  async getPermissionsForUser(userId: string): Promise<AuthPermissions> {
    const normalizedUserId = userId.trim();
    if (normalizedUserId.length === 0) {
      return this.defaultPermissions;
    }

    if (this.apiKeyService) {
      for (const policy of this.apiKeyPoliciesById.values()) {
        if (policy.userId === normalizedUserId) {
          return policy.permissions;
        }
      }
      return this.defaultPermissions;
    }

    for (const rec of this.apiKeys.values()) {
      if (rec.userId === normalizedUserId) {
        return rec.permissions;
      }
    }
    return this.defaultPermissions;
  }

  /**
   * Проверяет scope и выбрасывает ошибку 403 при отсутствии.
   * Реализация IAuthService.ensureScope.
   */
  ensureScope(context: CoreAuthContext, requiredScope: string | string[]): void {
    const requiredScopes = Array.isArray(requiredScope) ? requiredScope : [requiredScope];
    const hasAll = requiredScopes.every((s) => context.scopes.includes(s));
    if (!hasAll) {
      throw createProtocolAuthError(
        `Missing required scope(s): ${requiredScopes.filter((s) => !context.scopes.includes(s)).join(', ')}`,
        403,
      );
    }
  }

  // ====================== Вспомогательные ======================

  private async ensureEnvKeysBootstrapped(): Promise<void> {
    if (!this.apiKeyService) {
      return;
    }

    if (this.envBootstrapPromise) {
      await this.envBootstrapPromise;
      return;
    }

    const promise = this.bootstrapEnvApiKeysIntoStore(this.apiKeyService);
    this.envBootstrapPromise = promise;
    await promise;
  }

  private async bootstrapEnvApiKeysIntoStore(service: ApiKeyService): Promise<void> {
    const entries: Array<[string, ApiKeyRecord]> = Array.from(this.apiKeys.entries());
    for (const entry of entries) {
      const rawKey = entry[0];
      const record = entry[1];
      const trimmedKey = rawKey.trim();
      if (trimmedKey.length === 0) {
        continue;
      }

      try {
        const created = await service.registerExistingKey(
          record.userId,
          trimmedKey,
          {
            tenantId: record.tenantId ?? null,
            scopes: record.scopes,
          },
        );

        this.apiKeyPoliciesById.set(created.keyId, {
          userId: record.userId,
          tenantId: record.tenantId ?? null,
          permissions: record.permissions,
          scopes: record.scopes,
          metadata: record.metadata,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.logger) {
          this.logger.warn('auth_bootstrap_env_api_key_failed', {
            message,
          });
        }
      }
    }
  }

  private extractApiKeyFromRequest(req: {
    headers?: Record<string, unknown>;
    query?: Record<string, unknown>;
  }): string {
    return extractApiKeyFromRequestValue(req, allowQueryApiKey(this.config.NODE_ENV));
  }

  // Реализация IAuthService.authError.
  authError(message: string, status = 401): Error {
    return createProtocolAuthError(message, status);
  }

  private loadApiKeysFromEnv(): Map<string, ApiKeyRecord> {
    const map = new Map<string, ApiKeyRecord>();
    const config = this.config;

    // 1) JSON массив
    const json = config.BFF_API_KEYS;
    if (json) {
      const parsed = tryJsonParse<Array<{ key: string; userId: string; tenantId?: string; permissions?: Partial<AuthPermissions>; scopes?: string[] }>>(json);
      if (parsed.ok) {
        for (const rec of parsed.value) {
          if (!rec.key || !rec.userId) continue;
          map.set(rec.key, {
            userId: rec.userId,
            tenantId: rec.tenantId ?? null,
            permissions: { ...this.defaultPermissions, ...(rec.permissions ?? {}) },
            scopes: rec.scopes ?? []
          });
        }
      }
    }

    // 2) CSV key:user[:tenant]
    if (map.size === 0 && config.BFF_API_KEYS_CSV) {
      const csv = config.BFF_API_KEYS_CSV.split(',').map(s => s.trim()).filter(Boolean);
      for (const item of csv) {
        const [key, userId, tenantId] = item.split(':');
        if (!key || !userId) continue;
        map.set(key, {
          userId,
          tenantId: tenantId ?? null,
          permissions: { ...this.defaultPermissions },
          scopes: []
        });
      }
    }

    // 3) Один ключ BFF_API_KEY.
    // ВАЖНО:
    // - В production отсутствие явного ключа считается фатальной ошибкой (fail-fast).
    // - Никаких дефолтных test/demo ключей или demo-user в production.
    // - В non-prod без ключей возвращаем пустую карту (и тогда все запросы будут получать 401).
    if (map.size === 0) {
      const single = config.BFF_API_KEY;
      const nodeEnv = (config.NODE_ENV || '').toLowerCase();
      const isProd =
        nodeEnv === 'production' ||
        nodeEnv === 'prod';

      if (!single && isProd) {
        throw new Error(
          'SECURITY: Missing BFF API key configuration in production. ' +
          'Set BFF_API_KEYS, BFF_API_KEYS_CSV or BFF_API_KEY explicitly; no fallback or demo keys are allowed.'
        );
      }

      if (!single) {
        // non-prod без ключей: не регистрируем demo-ключи, оставляем карту пустой.
        // Все попытки аутентификации будут получать 401 "API token is required/Invalid API token".
        return map;
      }

      map.set(single, {
        userId: config.BFF_DEFAULT_USER_ID && !isProd
          ? config.BFF_DEFAULT_USER_ID
          : 'bff-api-user',
        tenantId: (config.BFF_DEFAULT_TENANT_ID && !isProd)
          ? config.BFF_DEFAULT_TENANT_ID
          : null,
        permissions: { ...this.defaultPermissions },
        scopes: []
      });
    }

    return map;
  }
}

