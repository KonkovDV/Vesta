/**
 * RateLimitService - система ограничения запросов для BFF API
 * Layer: Application
 *
 * Консолидация:
 * - Единый контракт: checkLimit(userId, operation) → boolean/throws
 * - Использует токен 'ICache' (не 'CacheInterface')
 * - Совместим с ChatController.checkRateLimit()
 * - Регистрация только через infrastructure/application bootstrap; без саморегистрации.
 */

import type { ICache } from '../../domain/cache/ICache';
import type { AuthService } from './AuthService';
import type { ILogger } from '../../core/decorators/ILogger';

export interface RateLimitConfig {
  requests_per_minute: number;
  tokens_per_minute: number;
  burst_multiplier?: number; // Множитель для burst (по умолчанию 1.5)
}

export interface RateLimitStats {
  requests_today: number;
  tokens_today: number;
  requests_remaining: number;
  tokens_remaining: number;
  reset_time: number;
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly userId: string,
    public readonly operation: string,
    public readonly retryAfterSeconds: number
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class RateLimitService {
  private readonly namespace = 'bff:rate_limit';
  private readonly cache: ICache;
  private auth?: AuthService;
  private readonly logger?: ILogger;

  // Дефолтные лимиты (совместимы с WebUI спецификацией)
  private readonly defaultLimits: RateLimitConfig = {
    requests_per_minute: 60,
    tokens_per_minute: 10000,
    burst_multiplier: 1.5,
  };

  constructor(cache: ICache, auth?: AuthService, logger?: ILogger) {
    this.cache = cache;
    this.auth = auth;
    this.logger = logger;
  }

  /**
   * Проверка лимита запросов для пользователя.
   * Контракт совместим с ChatController.checkRateLimit(userId, operation).
   * 
   * @param userId - ID пользователя
   * @param operation - тип операции ('chat_completions', 'file_upload', etc.)
   * @returns true если разрешено
   * @throws RateLimitError если превышен лимит
   */
  async checkLimit(userId: string, operation: string): Promise<boolean> {
    try {
      const config = await this.getLimitsForUser(userId);
      const now = Date.now();
      
      // Проверяем лимит запросов
      const requestsAllowed = await this.checkRequestsLimit(userId, operation, config, now);
      if (!requestsAllowed) {
        throw new RateLimitError(
          `Rate limit exceeded for operation ${operation}`,
          userId,
          operation,
          60 // retry after 60 seconds
        );
      }

      // Инкрементируем счетчик при успешной проверке
      await this.incrementRequestCounter(userId, operation, now);
      
      return true;
    } catch (error) {
      if (error instanceof RateLimitError) {
        throw error;
      }

      this.logWarn('rate_limit_check_failed', {
        userId,
        operation,
        error: this.safeError(error),
      });

      // При ошибке кэша - разрешаем запрос (fail-open)
      return true;
    }
  }

  /**
   * Обновление счетчика использованных токенов после генерации.
   * 
   * @param userId - ID пользователя
   * @param tokensUsed - количество использованных токенов
   */
  async incrementTokenUsage(userId: string, tokensUsed: number): Promise<void> {
    try {
      const tokenKey = `${this.namespace}:tokens:${userId}`;
      
      // Инкрементируем счетчик токенов
      await this.cache.increment(tokenKey, tokensUsed);
      
      // Устанавливаем TTL на 1 минуту (sliding window)
      const currentCount = await this.cache.get<string>(tokenKey);
      await this.cache.set(tokenKey, currentCount || tokensUsed.toString(), {
        ttlSeconds: 60,
      });

      this.logInfo('rate_limit_tokens_incremented', {
        userId,
        tokensUsed,
      });
    } catch (error) {
      this.logWarn('rate_limit_tokens_increment_failed', {
        userId,
        error: this.safeError(error),
      });
    }
  }

  /**
   * Получение статистики использования для пользователя.
   */
  async getUserStats(userId: string): Promise<RateLimitStats> {
    try {
      const config = await this.getLimitsForUser(userId);
      const now = Date.now();
      
      // Получаем текущие счетчики с устойчивой обработкой ошибок
      const [requestsResult, tokensResult] = await Promise.allSettled([
        this.getCurrentRequestCount(userId, now),
        this.getCurrentTokenCount(userId)
      ]);
 
      const requestsToday =
        requestsResult.status === 'fulfilled' ? requestsResult.value : 0;
      const tokensToday =
        tokensResult.status === 'fulfilled' ? tokensResult.value : 0;

      return {
        requests_today: requestsToday,
        tokens_today: tokensToday,
        requests_remaining: Math.max(0, config.requests_per_minute - requestsToday),
        tokens_remaining: Math.max(0, config.tokens_per_minute - tokensToday),
        reset_time: now + (60 * 1000) // Следующее окно через минуту
      };
    } catch (error) {
      this.logWarn('rate_limit_get_stats_failed', {
        userId,
        error: this.safeError(error),
      });
      return {
        requests_today: 0,
        tokens_today: 0,
        requests_remaining: this.defaultLimits.requests_per_minute,
        tokens_remaining: this.defaultLimits.tokens_per_minute,
        reset_time: Date.now() + 60 * 1000,
      };
    }
  }

  /**
   * Сброс лимитов пользователя (для администраторов).
   */
  async resetUserLimits(userId: string): Promise<void> {
    try {
      const patterns = [
        `${this.namespace}:requests:${userId}:*`,
        `${this.namespace}:tokens:${userId}`
      ];

      for (const pattern of patterns) {
        const scanResult = await this.cache.scanKeys({ pattern });
        for (const key of scanResult.keys) {
          await this.cache.delete(key);
        }
      }

      this.logInfo('rate_limit_reset_completed', {
        userId,
      });
    } catch (error) {
      this.logWarn('rate_limit_reset_failed', {
        userId,
        error: this.safeError(error),
      });
    }
  }

  /**
   * Проверка работоспособности сервиса (Connectivity Probe).
   * Не подавляет ошибки, а возвращает false, если кэш недоступен.
   */
  async isHealthy(): Promise<boolean> {
    try {
      // Пытаемся выполнить простую операцию, которая гарантированно требует RT
      await this.cache.get(`${this.namespace}:health`);
      return true;
    } catch (error) {
      return false;
    }
  }

  // ====================== Вспомогательные методы ======================

  private async getLimitsForUser(userId: string): Promise<RateLimitConfig> {
    try {
      const authWithPermissions = this.auth as { getPermissionsForUser?: (userId: string) => Promise<unknown> | unknown };
      if (this.auth && typeof authWithPermissions.getPermissionsForUser === 'function') {
        const perms = await authWithPermissions.getPermissionsForUser(userId);
        if (perms && typeof perms === 'object' && 'rate_limit' in perms && perms.rate_limit) {
          const rateLimit = (perms as { rate_limit: { requests_per_minute: number; tokens_per_minute: number } }).rate_limit;
          return {
            requests_per_minute: rateLimit.requests_per_minute,
            tokens_per_minute: rateLimit.tokens_per_minute,
            burst_multiplier: this.defaultLimits.burst_multiplier
          };
        }
      }
    } catch {
      // fail-open: при ошибке возвращаем дефолтные лимиты
    }
    return { ...this.defaultLimits };
  }

  private async checkRequestsLimit(
    userId: string, 
    operation: string, 
    config: RateLimitConfig, 
    now: number
  ): Promise<boolean> {
    const requestKey = `${this.namespace}:requests:${userId}:${operation}`;
    
    // Получаем текущий счетчик запросов за минуту
    const currentCount = await this.getCurrentRequestCount(userId, now, operation);
    
    // Проверяем лимит с учетом burst
    const burstLimit = Math.floor(config.requests_per_minute * (config.burst_multiplier || 1.5));
    
    return currentCount < burstLimit;
  }

  private async getCurrentRequestCount(userId: string, now: number, operation?: string): Promise<number> {
    try {
      const key = operation
        ? `${this.namespace}:requests:${userId}:${operation}`
        : `${this.namespace}:requests:${userId}:total`;
      
      const count = await this.cache.get<string>(key);
      return count ? parseInt(count) : 0;
    } catch {
      return 0;
    }
  }

  private async getCurrentTokenCount(userId: string): Promise<number> {
    try {
      const tokenKey = `${this.namespace}:tokens:${userId}`;
      const count = await this.cache.get<string>(tokenKey);
      return count ? parseInt(count) : 0;
    } catch {
      return 0;
    }
  }

  private async incrementRequestCounter(
    userId: string,
    operation: string,
    now: number,
  ): Promise<void> {
    try {
      const requestKey = `${this.namespace}:requests:${userId}:${operation}`;

      // Инкрементируем счетчик
      await this.cache.increment(requestKey, 1);

      // Устанавливаем TTL на 1 минуту (используем set с ttlSeconds)
      const currentCount = await this.cache.get<string>(requestKey);
      await this.cache.set(requestKey, currentCount || '1', {
        ttlSeconds: 60,
      });
    } catch (error) {
      this.logWarn('rate_limit_requests_increment_failed', {
        userId,
        operation,
        error: this.safeError(error),
      });
    }
  }

  private logInfo(message: string, meta?: Record<string, unknown>): void {
    if (!this.logger) {
      return;
    }
    if (typeof this.logger.info === 'function') {
      this.logger.info(message, meta);
    } else {
      this.logger.log(message, meta);
    }
  }

  private logWarn(message: string, meta?: Record<string, unknown>): void {
    if (!this.logger) {
      return;
    }
    this.logger.warn(message, meta);
  }

  private safeError(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) {
      return {
        message: error.message,
        stack: error.stack,
      };
    }
    return { message: String(error) };
  }
}

