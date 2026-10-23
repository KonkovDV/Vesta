/**
 * ApiGateway - API Gateway with routing, rate limiting, and auth
 * Layer: Infrastructure
 *
 * Provides centralized request routing, authentication, rate limiting,
 * request/response transformation, and circuit breaker integration.
 *
 * @example
 * ```typescript
 * const gateway = new ApiGateway({
 *   routes: [
 *     { path: '/api/chat', target: 'http://chat-service:3000', methods: ['POST'] },
 *     { path: '/api/agents', target: 'http://agent-service:3001' }
 *   ]
 * });
 *
 * app.use('/gateway', gateway.middleware());
 * ```
 */

import type * as core from 'express-serve-static-core';
import type { ILogger } from '../../core/decorators/ILogger';
import type { ICircuitBreaker } from '../../domain/external/ICircuitBreaker';
import { IdGenerator } from '../../core/utils/IdGenerator';

/**
 * Route configuration
 */
export interface GatewayRoute {
  /** Route path pattern (e.g., '/api/chat', '/api/*') */
  path: string;
  /** Target service URL */
  target: string;
  /** Allowed HTTP methods (default: all) */
  methods?: string[];
  /** Require authentication */
  requireAuth?: boolean;
  /** Required permissions */
  requiredPermissions?: string[];
  /** Rate limit configuration */
  rateLimit?: {
    windowMs: number;
    maxRequests: number;
  };
  /** Circuit breaker name */
  circuitBreaker?: string;
  /** Request transformation */
  transformRequest?: (req: core.Request) => Promise<core.Request> | core.Request;
  /** Response transformation */
  transformResponse?: (res: core.Response, body: unknown) => Promise<void>;
  /** Strip path prefix when forwarding */
  stripPrefix?: boolean;
  /** Additional headers to add */
  headers?: Record<string, string>;
}

/**
 * Gateway configuration
 */
export interface ApiGatewayConfig {
  /** Routes configuration */
  routes: GatewayRoute[];
  /** Default timeout for requests (ms) */
  defaultTimeout?: number;
  /** Enable CORS */
  enableCors?: boolean;
  /** CORS origins */
  corsOrigins?: string[];
  /** Global rate limit */
  globalRateLimit?: {
    windowMs: number;
    maxRequests: number;
  };
  /** Enable request logging */
  enableLogging?: boolean;
  /** Authentication handler */
  authHandler?: (req: core.Request) => Promise<AuthResult> | AuthResult;
  /** Rate limiter instance */
  rateLimiter?: RateLimiterAdapter;
  /** Circuit breaker registry */
  circuitBreakers?: Map<string, ICircuitBreaker>;
}

/**
 * Authentication result
 */
export interface AuthResult {
  /** Authentication successful */
  authenticated: boolean;
  /** User identifier */
  userId?: string;
  /** Tenant identifier */
  tenantId?: string;
  /** User permissions */
  permissions?: string[];
  /** Error message if not authenticated */
  error?: string;
}

/**
 * Rate limiter adapter interface
 */
export interface RateLimiterAdapter {
  checkLimit(identifier: string, endpoint?: string): Promise<RateLimitCheckResult>;
}

/**
 * Rate limit check result
 */
export interface RateLimitCheckResult {
  allowed: boolean;
  remaining?: number;
  resetTime?: number;
  retryAfter?: number;
}

/**
 * Gateway context attached to requests
 */
export interface GatewayContext {
  /** Matched route */
  route: GatewayRoute;
  /** Request start time */
  startTime: number;
  /** Authentication result */
  authResult?: AuthResult;
  /** Request ID for tracing */
  requestId: string;
}

/**
 * API Gateway error
 */
export class GatewayError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/**
 * ApiGateway - Centralized API gateway
 */
export class ApiGateway {
  private readonly config: ApiGatewayConfig;
  private readonly logger?: ILogger;
  private readonly routes: Map<string, GatewayRoute>;
  private readonly resolvedConfig: {
    defaultTimeout: number;
    enableCors: boolean;
    corsOrigins: string[];
    globalRateLimit: { windowMs: number; maxRequests: number };
    enableLogging: boolean;
    circuitBreakers: Map<string, ICircuitBreaker>;
  };

  constructor(config: ApiGatewayConfig, logger?: ILogger) {
    this.config = config;
    this.logger = logger;
    this.resolvedConfig = {
      defaultTimeout: config.defaultTimeout ?? 30000,
      enableCors: config.enableCors ?? true,
      corsOrigins: config.corsOrigins ?? ['*'],
      globalRateLimit: config.globalRateLimit ?? { windowMs: 60000, maxRequests: 1000 },
      enableLogging: config.enableLogging ?? false,
      circuitBreakers: config.circuitBreakers ?? new Map(),
    };
    this.routes = new Map();

    // Index routes by path for faster lookup
    config.routes.forEach((route) => {
      this.routes.set(route.path, route);
    });
  }

  /**
   * Get Express middleware
   */
  middleware(): (req: core.Request, res: core.Response, next: core.NextFunction) => Promise<void> {
    return async (req: core.Request, res: core.Response, next: core.NextFunction): Promise<void> => {
      try {
        // Generate request ID
        const requestId = this.generateRequestId();
        res.setHeader('X-Request-Id', requestId);

        // Find matching route
        const route = this.findRoute(req.path, req.method);
        if (!route) {
          this.log('warn', 'gateway_route_not_found', { path: req.path, method: req.method });
          res.status(404).json({
            error: 'Route not found',
            path: req.path,
            requestId,
          });
          return;
        }

        // Create gateway context
        const context: GatewayContext = {
          route,
          startTime: Date.now(),
          requestId,
        };
        (req as core.Request & { gatewayContext?: GatewayContext }).gatewayContext = context;

        // Apply CORS if enabled
        if (this.resolvedConfig.enableCors) {
          this.applyCors(res);
        }

        // Check global rate limit
        if (this.config.rateLimiter) {
          const clientId = this.extractClientId(req);
          const globalLimit = await this.config.rateLimiter.checkLimit(
            clientId,
            'global'
          );

          if (!globalLimit.allowed) {
            res.setHeader('Retry-After', String(globalLimit.retryAfter ?? 60));
            res.status(429).json({
              error: 'Global rate limit exceeded',
              retryAfter: globalLimit.retryAfter,
              requestId,
            });
            return;
          }

          // Check route-specific rate limit
          if (route.rateLimit) {
            const routeLimit = await this.config.rateLimiter.checkLimit(
              clientId,
              route.path
            );

            if (!routeLimit.allowed) {
              res.setHeader('Retry-After', String(routeLimit.retryAfter ?? 60));
              res.status(429).json({
                error: 'Route rate limit exceeded',
                retryAfter: routeLimit.retryAfter,
                requestId,
              });
              return;
            }
          }
        }

        // Authenticate if required
        if (route.requireAuth || this.config.authHandler) {
          if (!this.config.authHandler) {
            throw new GatewayError(500, 'Auth handler not configured', 'AUTH_NOT_CONFIGURED');
          }

          const authResult = await this.config.authHandler(req);
          if (!authResult.authenticated) {
            res.status(401).json({
              error: authResult.error ?? 'Authentication required',
              requestId,
            });
            return;
          }

          // Check permissions
          if (route.requiredPermissions && route.requiredPermissions.length > 0) {
            const hasPermission = route.requiredPermissions.every((perm) =>
              authResult.permissions?.includes(perm)
            );

            if (!hasPermission) {
              res.status(403).json({
                error: 'Insufficient permissions',
                required: route.requiredPermissions,
                requestId,
              });
              return;
            }
          }

          context.authResult = authResult;

          // Forward auth info to downstream service
          if (authResult.userId) {
            req.headers['x-user-id'] = authResult.userId;
          }
          if (authResult.tenantId) {
            req.headers['x-tenant-id'] = authResult.tenantId;
          }
        }

        // Add route-specific headers
        if (route.headers) {
          Object.entries(route.headers).forEach(([key, value]) => {
            req.headers[key.toLowerCase()] = value;
          });
        }

        // Log request
        this.log('info', 'gateway_request', {
          requestId,
          method: req.method,
          path: req.path,
          target: route.target,
          userId: context.authResult?.userId,
        });

        // Pass to next handler (actual proxy implementation would go here)
        next();
      } catch (error) {
        this.handleError(error, res);
      }
    };
  }

  /**
   * Add a new route dynamically
   */
  addRoute(route: GatewayRoute): void {
    this.routes.set(route.path, route);
    this.config.routes.push(route);
  }

  /**
   * Remove a route
   */
  removeRoute(path: string): boolean {
    const deleted = this.routes.delete(path);
    if (deleted) {
      this.config.routes = this.config.routes.filter((r) => r.path !== path);
    }
    return deleted;
  }

  /**
   * Get all registered routes
   */
  getRoutes(): GatewayRoute[] {
    return [...(this.config.routes ?? [])];
  }

  /**
   * Find matching route for path and method
   */
  private findRoute(path: string, method: string): GatewayRoute | undefined {
    // Direct match first
    const direct = this.routes.get(path);
    if (direct && this.methodMatches(method, direct.methods)) {
      return direct;
    }

    // Pattern match
    for (const route of this.routes.values()) {
      if (this.pathMatches(path, route.path) && this.methodMatches(method, route.methods)) {
        return route;
      }
    }

    return undefined;
  }

  /**
   * Check if path matches pattern
   */
  private pathMatches(path: string, pattern: string): boolean {
    // Simple glob matching - can be enhanced with regex
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
      return regex.test(path);
    }
    return path === pattern || path.startsWith(pattern + '/');
  }

  /**
   * Check if method is allowed
   */
  private methodMatches(method: string, allowed?: string[]): boolean {
    if (!allowed || allowed.length === 0) {
      return true;
    }
    return allowed.includes(method.toUpperCase());
  }

  /**
   * Apply CORS headers
   */
  private applyCors(res: core.Response): void {
    const origin = this.resolvedConfig.corsOrigins.includes('*')
      ? '*'
      : this.resolvedConfig.corsOrigins.join(', ');

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  /**
   * Extract client identifier from request
   */
  private extractClientId(req: core.Request): string {
    // Try API key first, then IP address
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      return `api:${apiKey}`;
    }

    const forwarded = req.headers['x-forwarded-for'] as string | undefined;
    if (forwarded) {
      return `ip:${forwarded.split(',')[0].trim()}`;
    }

    return `ip:${req.ip ?? 'unknown'}`;
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return IdGenerator.generateWithPrefix('req');
  }

  /**
   * Handle gateway errors
   */
  private handleError(error: unknown, res: core.Response): void {
    if (error instanceof GatewayError) {
      this.log('error', 'gateway_error', {
        code: error.code,
        statusCode: error.statusCode,
        message: error.message,
      });
      res.status(error.statusCode).json({
        error: error.message,
        code: error.code,
        details: error.details,
      });
    } else {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log('error', 'gateway_internal_error', { message });
      res.status(500).json({ error: 'Internal gateway error' });
    }
  }

  /**
   * Log if enabled
   */
  private log(
    level: 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>
  ): void {
    if (!this.resolvedConfig.enableLogging || !this.logger) {
      return;
    }

    const logMethod = this.logger[level];
    if (typeof logMethod === 'function') {
      logMethod.call(this.logger, message, meta);
    }
  }
}

/**
 * Simple in-memory rate limiter adapter for gateway
 */
export class GatewayMemoryRateLimiter implements RateLimiterAdapter {
  private readonly storage = new Map<string, { count: number; resetTime: number }>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  async checkLimit(identifier: string, _endpoint?: string): Promise<RateLimitCheckResult> {
    const now = Date.now();
    const key = `${identifier}`;
    const entry = this.storage.get(key);

    if (!entry || now > entry.resetTime) {
      // New window
      this.storage.set(key, {
        count: 1,
        resetTime: now + this.windowMs,
      });
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetTime: now + this.windowMs,
      };
    }

    if (entry.count >= this.maxRequests) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        resetTime: entry.resetTime,
        retryAfter,
      };
    }

    entry.count++;
    return {
      allowed: true,
      remaining: this.maxRequests - entry.count,
      resetTime: entry.resetTime,
    };
  }
}

/**
 * Get gateway context from request
 */
export function getGatewayContext(req: core.Request): GatewayContext | undefined {
  return (req as core.Request & { gatewayContext?: GatewayContext }).gatewayContext;
}
