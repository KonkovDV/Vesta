/**
 * DistributedRateLimiter - Redis-backed rate limiting with sliding window
 * Layer: Infrastructure
 *
 * Provides distributed rate limiting using Redis for multi-instance deployments.
 * Implements sliding window algorithm for accurate rate limiting.
 *
 * @example
 * ```typescript
 * const rateLimiter = new DistributedRateLimiter(redisAdapter, {
 *   windowMs: 60000,  // 1 minute
 *   maxRequests: 100  // 100 requests per window
 * });
 *
 * const result = await rateLimiter.checkLimit('user:123', '/api/chat');
 * if (!result.allowed) {
 *   return res.status(429).json({ retryAfter: result.retryAfter });
 * }
 * ```
 */

import type { ICache } from '../../domain/cache/ICache';
import type { ILogger } from '../../core/decorators/ILogger';

/**
 * Rate limit check result
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Total limit for the window */
  limit: number;
  /** Remaining requests in current window */
  remaining: number;
  /** Unix timestamp when the window resets */
  resetTime: number;
  /** Seconds until retry (only when not allowed) */
  retryAfter?: number;
}

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Window size in milliseconds */
  windowMs: number;
  /** Maximum requests per window */
  maxRequests: number;
  /** Key prefix for Redis storage */
  keyPrefix?: string;
  /** Skip successful requests from counting */
  skipSuccessfulRequests?: boolean;
}

/**
 * Per-endpoint rate limit configuration
 */
export interface EndpointRateLimit {
  /** Route pattern (e.g., '/api/chat', '/api/*') */
  route: string;
  /** Rate limit configuration */
  config: RateLimitConfig;
  /** Custom key extractor */
  keyExtractor?: (req: unknown) => string;
}

/**
 * Rate limiter options
 */
export interface RateLimiterOptions {
  /** Default configuration for all routes */
  defaultConfig?: RateLimitConfig;
  /** Per-endpoint configurations */
  endpoints?: EndpointRateLimit[];
  /** Enable logging */
  enableLogging?: boolean;
}

/**
 * Rate limit exceeded error
 */
export class RateLimitExceededError extends Error {
  constructor(
    public readonly retryAfter: number,
    public readonly limit: number,
    public readonly resetTime: number,
    message = 'Rate limit exceeded'
  ) {
    super(message);
    this.name = 'RateLimitExceededError';
  }
}

/**
 * Sliding window entry
 */
interface WindowEntry {
  /** Timestamp of request */
  timestamp: number;
  /** Request weight (default 1) */
  weight: number;
}

/**
 * DistributedRateLimiter - Redis-backed sliding window rate limiter
 */
export class DistributedRateLimiter {
  private readonly cache: ICache;
  private readonly defaultConfig: Required<RateLimitConfig>;
  private readonly endpoints: Map<string, EndpointRateLimit>;
  private readonly logger?: ILogger;
  private readonly enableLogging: boolean;

  /**
   * Default rate limit configuration
   */
  static readonly DEFAULT_CONFIG: Required<RateLimitConfig> = {
    windowMs: 60000, // 1 minute
    maxRequests: 100,
    keyPrefix: 'ratelimit:',
    skipSuccessfulRequests: false,
  };

  constructor(cache: ICache, options: RateLimiterOptions = {}, logger?: ILogger) {
    this.cache = cache;
    this.defaultConfig = {
      ...DistributedRateLimiter.DEFAULT_CONFIG,
      ...options.defaultConfig,
    };
    this.endpoints = new Map();
    this.logger = logger;
    this.enableLogging = options.enableLogging ?? false;

    // Register endpoint configs
    options.endpoints?.forEach((endpoint) => {
      this.endpoints.set(endpoint.route, endpoint);
    });
  }

  /**
   * Check rate limit for a key
   */
  async checkLimit(
    identifier: string,
    endpoint?: string,
    weight = 1
  ): Promise<RateLimitResult> {
    const config = this.getConfigForEndpoint(endpoint);
    const key = this.buildKey(identifier, endpoint, config);
    const now = Date.now();
    const windowStart = now - config.windowMs;

    try {
      // Get current window entries from Redis
      const entries = await this.getWindowEntries(key, config);

      // Filter to current window
      const validEntries = entries.filter((e) => e.timestamp > windowStart);
      const currentUsage = validEntries.reduce((sum, e) => sum + e.weight, 0);

      // Check if limit exceeded
      if (currentUsage + weight > config.maxRequests) {
        const oldestEntry = validEntries[0];
        const resetTime = oldestEntry ? oldestEntry.timestamp + config.windowMs : now + config.windowMs;
        const retryAfter = Math.ceil((resetTime - now) / 1000);

        this.log('warn', 'rate_limit_exceeded', {
          key,
          identifier,
          endpoint,
          currentUsage,
          limit: config.maxRequests,
        });

        return {
          allowed: false,
          limit: config.maxRequests,
          remaining: 0,
          resetTime,
          retryAfter,
        };
      }

      // Add new entry
      const newEntry: WindowEntry = { timestamp: now, weight };
      validEntries.push(newEntry);

      // Store updated entries
      await this.storeWindowEntries(key, validEntries, config);

      const remaining = config.maxRequests - currentUsage - weight;
      const resetTime = now + config.windowMs;

      return {
        allowed: true,
        limit: config.maxRequests,
        remaining: Math.max(0, remaining),
        resetTime,
      };
    } catch (error) {
      this.log('error', 'rate_limit_check_failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });

      // Fail open - allow request on error
      return {
        allowed: true,
        limit: config.maxRequests,
        remaining: 1,
        resetTime: now + config.windowMs,
      };
    }
  }

  /**
   * Consume rate limit (throws on exceeded)
   */
  async consume(
    identifier: string,
    endpoint?: string,
    weight = 1
  ): Promise<RateLimitResult> {
    const result = await this.checkLimit(identifier, endpoint, weight);

    if (!result.allowed) {
      throw new RateLimitExceededError(
        result.retryAfter ?? 60,
        result.limit,
        result.resetTime
      );
    }

    return result;
  }

  /**
   * Reset rate limit for an identifier
   */
  async reset(identifier: string, endpoint?: string): Promise<void> {
    const config = this.getConfigForEndpoint(endpoint);
    const key = this.buildKey(identifier, endpoint, config);

    try {
      await this.cache.delete(key);
      this.log('info', 'rate_limit_reset', { key, identifier, endpoint });
    } catch (error) {
      this.log('error', 'rate_limit_reset_failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get current usage for an identifier
   */
  async getUsage(identifier: string, endpoint?: string): Promise<number> {
    const config = this.getConfigForEndpoint(endpoint);
    const key = this.buildKey(identifier, endpoint, config);
    const now = Date.now();
    const windowStart = now - config.windowMs;

    try {
      const entries = await this.getWindowEntries(key, config);
      const validEntries = entries.filter((e) => e.timestamp > windowStart);
      return validEntries.reduce((sum, e) => sum + e.weight, 0);
    } catch (error) {
      this.log('error', 'rate_limit_usage_check_failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Register endpoint-specific configuration
   */
  registerEndpoint(endpoint: string, config: RateLimitConfig): void {
    this.endpoints.set(endpoint, { route: endpoint, config });
  }

  /**
   * Build Redis key for rate limit
   */
  private buildKey(
    identifier: string,
    endpoint: string | undefined,
    config: Required<RateLimitConfig>
  ): string {
    const endpointPart = endpoint ? `:${endpoint.replace(/[^a-zA-Z0-9]/g, '_')}` : '';
    return `${config.keyPrefix}${identifier}${endpointPart}`;
  }

  /**
   * Get configuration for endpoint
   */
  private getConfigForEndpoint(endpoint?: string): Required<RateLimitConfig> {
    if (!endpoint) {
      return this.defaultConfig;
    }

    // Find matching endpoint config
    for (const [pattern, endpointConfig] of this.endpoints) {
      if (this.matchesPattern(endpoint, pattern)) {
        return {
          ...this.defaultConfig,
          ...endpointConfig.config,
        };
      }
    }

    return this.defaultConfig;
  }

  /**
   * Check if endpoint matches pattern
   */
  private matchesPattern(endpoint: string, pattern: string): boolean {
    // Simple glob matching
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(endpoint);
  }

  /**
   * Get window entries from cache
   */
  private async getWindowEntries(
    key: string,
    _config: Required<RateLimitConfig>
  ): Promise<WindowEntry[]> {
    const result = await this.cache.get<string>(key);

    if (!result) {
      return [];
    }

    try {
      const entries = JSON.parse(result) as WindowEntry[];
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  }

  /**
   * Store window entries to cache
   */
  private async storeWindowEntries(
    key: string,
    entries: WindowEntry[],
    config: Required<RateLimitConfig>
  ): Promise<void> {
    const ttlSeconds = Math.ceil(config.windowMs / 1000);
    await this.cache.set(key, JSON.stringify(entries), { ttlSeconds });
  }

  /**
   * Log message if logging enabled
   */
  private log(
    level: 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>
  ): void {
    if (!this.enableLogging || !this.logger) {
      return;
    }

    const logMethod = this.logger[level];
    if (typeof logMethod === 'function') {
      logMethod.call(this.logger, message, meta);
    }
  }
}

/**
 * In-memory rate limiter for single-instance deployments
 */
export class InMemoryRateLimiter {
  private readonly storage = new Map<string, WindowEntry[]>();
  private readonly defaultConfig: Required<RateLimitConfig>;
  private readonly endpoints: Map<string, EndpointRateLimit>;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(options: RateLimiterOptions = {}) {
    this.defaultConfig = {
      ...DistributedRateLimiter.DEFAULT_CONFIG,
      ...options.defaultConfig,
    };
    this.endpoints = new Map();

    options.endpoints?.forEach((endpoint) => {
      this.endpoints.set(endpoint.route, endpoint);
    });

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Check rate limit for a key
   */
  async checkLimit(
    identifier: string,
    endpoint?: string,
    weight = 1
  ): Promise<RateLimitResult> {
    const config = this.getConfigForEndpoint(endpoint);
    const key = this.buildKey(identifier, endpoint, config);
    const now = Date.now();
    const windowStart = now - config.windowMs;

    // Get and filter entries
    const entries = this.storage.get(key) ?? [];
    const validEntries = entries.filter((e) => e.timestamp > windowStart);
    const currentUsage = validEntries.reduce((sum, e) => sum + e.weight, 0);

    // Check limit
    if (currentUsage + weight > config.maxRequests) {
      const oldestEntry = validEntries[0];
      const resetTime = oldestEntry ? oldestEntry.timestamp + config.windowMs : now + config.windowMs;
      const retryAfter = Math.ceil((resetTime - now) / 1000);

      return {
        allowed: false,
        limit: config.maxRequests,
        remaining: 0,
        resetTime,
        retryAfter,
      };
    }

    // Add new entry
    validEntries.push({ timestamp: now, weight });
    this.storage.set(key, validEntries);

    const remaining = config.maxRequests - currentUsage - weight;

    return {
      allowed: true,
      limit: config.maxRequests,
      remaining: Math.max(0, remaining),
      resetTime: now + config.windowMs,
    };
  }

  /**
   * Consume rate limit (throws on exceeded)
   */
  async consume(
    identifier: string,
    endpoint?: string,
    weight = 1
  ): Promise<RateLimitResult> {
    const result = await this.checkLimit(identifier, endpoint, weight);

    if (!result.allowed) {
      throw new RateLimitExceededError(
        result.retryAfter ?? 60,
        result.limit,
        result.resetTime
      );
    }

    return result;
  }

  /**
   * Reset rate limit
   */
  async reset(identifier: string, endpoint?: string): Promise<void> {
    const config = this.getConfigForEndpoint(endpoint);
    const key = this.buildKey(identifier, endpoint, config);
    this.storage.delete(key);
  }

  /**
   * Get current usage
   */
  async getUsage(identifier: string, endpoint?: string): Promise<number> {
    const config = this.getConfigForEndpoint(endpoint);
    const key = this.buildKey(identifier, endpoint, config);
    const now = Date.now();
    const windowStart = now - config.windowMs;

    const entries = this.storage.get(key) ?? [];
    const validEntries = entries.filter((e) => e.timestamp > windowStart);
    return validEntries.reduce((sum, e) => sum + e.weight, 0);
  }

  /**
   * Stop cleanup interval
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  private buildKey(
    identifier: string,
    endpoint: string | undefined,
    config: Required<RateLimitConfig>
  ): string {
    const endpointPart = endpoint ? `:${endpoint.replace(/[^a-zA-Z0-9]/g, '_')}` : '';
    return `${config.keyPrefix}${identifier}${endpointPart}`;
  }

  private getConfigForEndpoint(endpoint?: string): Required<RateLimitConfig> {
    if (!endpoint) {
      return this.defaultConfig;
    }

    for (const [pattern, endpointConfig] of this.endpoints) {
      if (this.matchesPattern(endpoint, pattern)) {
        return {
          ...this.defaultConfig,
          ...endpointConfig.config,
        };
      }
    }

    return this.defaultConfig;
  }

  private matchesPattern(endpoint: string, pattern: string): boolean {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(endpoint);
  }

  private cleanup(): void {
    const now = Date.now();

    for (const [key, entries] of this.storage.entries()) {
      const config = this.defaultConfig;
      const windowStart = now - config.windowMs;
      const validEntries = entries.filter((e) => e.timestamp > windowStart);

      if (validEntries.length === 0) {
        this.storage.delete(key);
      } else if (validEntries.length !== entries.length) {
        this.storage.set(key, validEntries);
      }
    }
  }
}
