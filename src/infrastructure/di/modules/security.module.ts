/**
 * Security Module - DI registration for security components
 * Layer: Infrastructure/DI
 *
 * Registers security-related services:
 * - CSPManager
 * - DistributedRateLimiter
 * - SecurityHeadersMiddleware
 * - ApiGateway
 */

import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { container } from '../../../core/di/container';
import type { ILogger } from '../../../core/decorators/ILogger';
import type { ICache } from '../../../domain/cache/ICache';
import type { ICSPManager } from '../../../core/http/ICSPManager';
import { CSPManager } from '../../security/csp-manager';
import { DistributedRateLimiter, InMemoryRateLimiter } from '../../http/rate-limiter';
import { SecurityHeadersMiddleware } from '../../../application/middleware/security-headers.middleware';
import { ApiGateway, GatewayMemoryRateLimiter } from '../../http/api-gateway';
import { FirewallService } from '../../../application/security/firewall.service';
import { ToolPolicyResolverImpl } from '../../security/ToolPolicyResolverImpl';
import { SecretRotationOrchestratorService } from '../../../application/services/security/SecretRotationOrchestratorService';
import type { ISecretInventory } from '../../../domain/security/secret-inventory.port';
import type { ISecretRotationPlanner } from '../../../domain/security/secret-rotation-planner.port';
import type { ISecretRotationExecutor } from '../../../domain/security/secret-rotation-executor.port';
import type { ISecretRotationReceiptStore } from '../../../domain/security/secret-rotation-receipt-store.port';
import { StaticSecretInventoryAdapter } from '../../secrets/StaticSecretInventoryAdapter';
import { DryRunSecretRotationPlannerAdapter } from '../../secrets/DryRunSecretRotationPlannerAdapter';
import { DryRunSecretRotationExecutorAdapter } from '../../secrets/DryRunSecretRotationExecutorAdapter';
import { FileSecretRotationReceiptStoreAdapter } from '../../secrets/FileSecretRotationReceiptStoreAdapter';
import { SsrfDnsGuard } from '../../security/SsrfDnsGuard';
import { PromptInjectionScanner } from '../../security/PromptInjectionScanner';
import { OutputRailScanner } from '../../security/OutputRailScanner';
import { ContentBoundaryWrapper } from '../../../domain/security/ContentBoundaryWrapper';

/**
 * Security module configuration
 */
export interface SecurityModuleConfig {
  /** Environment */
  environment?: 'production' | 'development' | 'test';
  /** Enable strict CSP in production */
  strictCsp?: boolean;
  /** Default rate limit window (ms) */
  rateLimitWindowMs?: number;
  /** Default max requests per window */
  rateLimitMaxRequests?: number;
  /** CSP report URI */
  cspReportUri?: string;
  /** Enable security header logging */
  enableLogging?: boolean;
}

/**
 * DI tokens for security services
 */
export const SECURITY_TOKENS = {
  CSPManager: 'CSPManager',
  RateLimiter: 'RateLimiter',
  SecurityHeadersMiddleware: 'SecurityHeadersMiddleware',
  ApiGateway: 'ApiGateway',
  ToolExecutionPolicy: 'IToolExecutionPolicy',
} as const;

export function registerSsrfDnsGuard(): void {
  if (container.isRegistered(DI_TOKENS.ISsrfDnsGuard)) {
    return;
  }

  container.register(
    DI_TOKENS.ISsrfDnsGuard,
    () => new SsrfDnsGuard(),
    {
      lifecycle: 'singleton',
      tags: ['security', 'ssrf', 'infrastructure'],
      description: 'SSRF DNS guard for outbound URL validation',
    }
  );
}

/**
 * Register Tool Policy Resolver (Infrastructure adapter for IToolPolicyResolver port)
 */
export function registerToolPolicyResolver(): void {
  if (container.isRegistered(DI_TOKENS.IToolPolicyResolver)) {
    return;
  }

  container.register(
    DI_TOKENS.IToolPolicyResolver,
    () => new ToolPolicyResolverImpl(),
    {
      lifecycle: 'singleton',
      tags: ['security', 'policy', 'infrastructure'],
      description: 'Tool Policy Resolver — normalizes names, expands groups, resolves profiles',
    },
  );
}

/**
 * Register Cognitive Firewall Service
 */
export function registerFirewallService(): void {
  if (container.isRegistered(DI_TOKENS.IFirewallService)) {
    return;
  }

  container.register<FirewallService>(
    'IFirewallService',
    () => new FirewallService(),
    {
      lifecycle: 'singleton',
      tags: ['security', 'firewall', 'application'],
      description: 'Cognitive Firewall — schema validation, XSS sanitization, jailbreak detection',
    }
  );
}

/**
 * Register CSP Manager
 */
export function registerCSPManager(config?: SecurityModuleConfig): void {
  if (container.isRegistered(SECURITY_TOKENS.CSPManager)) {
    return;
  }

  const isProduction = config?.environment === 'production';
  const logger = container.isRegistered(DI_TOKENS.ILogger)
    ? container.resolve<ILogger>(DI_TOKENS.ILogger)
    : undefined;

  container.register<CSPManager>(
    SECURITY_TOKENS.CSPManager,
    () => {
      const policy = isProduction
        ? CSPManager.DEFAULT_POLICY
        : { ...CSPManager.DEFAULT_POLICY, ...CSPManager.DEVELOPMENT_POLICY };

      return new CSPManager({
        policy,
        reportOnly: !isProduction && config?.strictCsp !== true,
        excludeRoutes: ['/health', '/metrics', '/ready', '/api/security/csp-report'],
        onViolation: (report, req) => {
          logger?.warn?.('csp_violation', {
            documentUri: report['document-uri'],
            blockedUri: report['blocked-uri'],
            directive: report['effective-directive'],
            userAgent: req.headers['user-agent'],
          });
        },
      });
    },
    {
      lifecycle: 'singleton',
      tags: ['security', 'csp', 'infrastructure'],
      description: 'Content Security Policy manager',
    }
  );
}

/**
 * Register Rate Limiter
 */
export function registerRateLimiter(config?: SecurityModuleConfig): void {
  if (container.isRegistered(SECURITY_TOKENS.RateLimiter)) {
    return;
  }

  const windowMs = config?.rateLimitWindowMs ?? 60000;
  const maxRequests = config?.rateLimitMaxRequests ?? 100;

  container.register<DistributedRateLimiter | InMemoryRateLimiter>(
    SECURITY_TOKENS.RateLimiter,
    (c) => {
      const logger = c.isRegistered(DI_TOKENS.ILogger) ? c.resolve<ILogger>(DI_TOKENS.ILogger) : undefined;

      // Use Redis if available
      if (c.isRegistered(DI_TOKENS.ICache)) {
        const cache = c.resolve<ICache>(DI_TOKENS.ICache);
        return new DistributedRateLimiter(
          cache,
          {
            defaultConfig: {
              windowMs,
              maxRequests,
            },
            endpoints: [
              { route: '/api/chat', config: { windowMs: 60000, maxRequests: 30 } },
              { route: '/api/agents/*', config: { windowMs: 60000, maxRequests: 50 } },
              { route: '/api/mas/*', config: { windowMs: 60000, maxRequests: 20 } },
            ],
            enableLogging: config?.enableLogging ?? false,
          },
          logger
        );
      }

      // Fallback to in-memory
      return new InMemoryRateLimiter({
        defaultConfig: {
          windowMs,
          maxRequests,
        },
        endpoints: [
          { route: '/api/chat', config: { windowMs: 60000, maxRequests: 30 } },
          { route: '/api/agents/*', config: { windowMs: 60000, maxRequests: 50 } },
        ],
      });
    },
    {
      lifecycle: 'singleton',
      tags: ['security', 'rate-limiting', 'infrastructure'],
      description: 'Distributed rate limiter with Redis fallback',
    }
  );
}

/**
 * Register Security Headers Middleware
 */
export function registerSecurityHeadersMiddleware(config?: SecurityModuleConfig): void {
  if (container.isRegistered(SECURITY_TOKENS.SecurityHeadersMiddleware)) {
    return;
  }

  const isProduction = config?.environment === 'production';
  const logger = container.isRegistered(DI_TOKENS.ILogger)
    ? container.resolve<ILogger>(DI_TOKENS.ILogger)
    : undefined;

  container.register<SecurityHeadersMiddleware>(
    SECURITY_TOKENS.SecurityHeadersMiddleware,
    (c) => {
      const cspManager = c.isRegistered(SECURITY_TOKENS.CSPManager)
        ? c.resolve<ICSPManager>(SECURITY_TOKENS.CSPManager)
        : undefined;

      return new SecurityHeadersMiddleware(
        {
          hsts: isProduction
            ? { maxAge: 31536000, includeSubDomains: true, preload: true }
            : { maxAge: 31536000, includeSubDomains: true },
          frameOptions: 'DENY',
          contentTypeOptions: true,
          xssProtection: false,
          referrerPolicy: 'strict-origin-when-cross-origin',
          permissionsPolicy: {
            camera: "'none'",
            microphone: "'none'",
            geolocation: "'none'",
            notifications: "'self'",
            push: "'self'",
            fullscreen: "'self'",
            payment: "'none'",
            usb: "'none'",
          },
          coep: false,
          coop: 'same-origin',
          corp: 'cross-origin',
          cspManager,
          excludeRoutes: ['/health', '/metrics', '/ready'],
          enableLogging: config?.enableLogging ?? false,
        },
        logger
      );
    },
    {
      lifecycle: 'singleton',
      tags: ['security', 'headers', 'middleware', 'application'],
      description: 'Security headers middleware',
    }
  );
}

/**
 * Register API Gateway
 */
export function registerApiGateway(config?: SecurityModuleConfig): void {
  if (container.isRegistered(SECURITY_TOKENS.ApiGateway)) {
    return;
  }

  const logger = container.isRegistered(DI_TOKENS.ILogger)
    ? container.resolve<ILogger>(DI_TOKENS.ILogger)
    : undefined;

  container.register<ApiGateway>(
    SECURITY_TOKENS.ApiGateway,
    (c) => {
      const rateLimiter = c.isRegistered(SECURITY_TOKENS.RateLimiter)
        ? c.resolve<DistributedRateLimiter | InMemoryRateLimiter>(SECURITY_TOKENS.RateLimiter)
        : undefined;

      const rateLimiterAdapter = rateLimiter
        ? {
            checkLimit: (identifier: string, endpoint?: string) =>
              rateLimiter.checkLimit(identifier, endpoint),
          }
        : new GatewayMemoryRateLimiter(
            config?.rateLimitWindowMs ?? 60000,
            config?.rateLimitMaxRequests ?? 100
          );

      return new ApiGateway(
        {
          routes: [
            {
              path: '/api/chat',
              target: 'internal',
              methods: ['POST', 'GET'],
              requireAuth: true,
              rateLimit: { windowMs: 60000, maxRequests: 30 },
            },
            {
              path: '/api/agents/*',
              target: 'internal',
              requireAuth: true,
              rateLimit: { windowMs: 60000, maxRequests: 50 },
            },
            {
              path: '/api/mas/*',
              target: 'internal',
              requireAuth: true,
              requiredPermissions: ['mas:execute'],
              rateLimit: { windowMs: 60000, maxRequests: 20 },
            },
            {
              path: '/api/health',
              target: 'internal',
              requireAuth: false,
            },
          ],
          defaultTimeout: 30000,
          enableCors: true,
          corsOrigins: isProduction(config) ? [] : ['*'],
          globalRateLimit: {
            windowMs: config?.rateLimitWindowMs ?? 60000,
            maxRequests: config?.rateLimitMaxRequests ?? 1000,
          },
          enableLogging: config?.enableLogging ?? false,
          rateLimiter: rateLimiterAdapter,
        },
        logger
      );
    },
    {
      lifecycle: 'singleton',
      tags: ['security', 'gateway', 'routing', 'infrastructure'],
      description: 'API Gateway with authentication and rate limiting',
    }
  );
}

/**
 * Register dry-run secret rotation services.
 */
export function registerSecretRotationServices(): void {
  if (!container.isRegistered(DI_TOKENS.ISecretInventory)) {
    container.register<ISecretInventory>(
      DI_TOKENS.ISecretInventory,
      () => new StaticSecretInventoryAdapter(),
      {
        lifecycle: 'singleton',
        tags: ['security', 'secrets', 'inventory', 'infrastructure'],
        description: 'Static inventory of critical production secrets for release evidence and planning',
      }
    );
  }

  if (!container.isRegistered(DI_TOKENS.ISecretRotationPlanner)) {
    container.register<ISecretRotationPlanner>(
      DI_TOKENS.ISecretRotationPlanner,
      (c) => new DryRunSecretRotationPlannerAdapter(c.resolve(DI_TOKENS.ISecretInventory)),
      {
        lifecycle: 'singleton',
        tags: ['security', 'secrets', 'planner', 'infrastructure'],
        description: 'Dry-run secret rotation planner',
      }
    );
  }

  if (!container.isRegistered(DI_TOKENS.ISecretRotationExecutor)) {
    container.register<ISecretRotationExecutor>(
      DI_TOKENS.ISecretRotationExecutor,
      () => new DryRunSecretRotationExecutorAdapter(),
      {
        lifecycle: 'singleton',
        tags: ['security', 'secrets', 'executor', 'infrastructure'],
        description: 'Dry-run secret rotation executor',
      }
    );
  }

  if (!container.isRegistered(DI_TOKENS.ISecretRotationReceiptStore)) {
    container.register<ISecretRotationReceiptStore>(
      DI_TOKENS.ISecretRotationReceiptStore,
      () => new FileSecretRotationReceiptStoreAdapter(),
      {
        lifecycle: 'singleton',
        tags: ['security', 'secrets', 'receipt-store', 'infrastructure'],
        description: 'Append-only file-backed receipt store for secret rotation evidence',
      }
    );
  }

  if (!container.isRegistered(DI_TOKENS.SecretRotationOrchestratorService)) {
    container.register<SecretRotationOrchestratorService>(
      DI_TOKENS.SecretRotationOrchestratorService,
      (c) => new SecretRotationOrchestratorService(
        c.resolve(DI_TOKENS.ISecretRotationPlanner),
        c.resolve(DI_TOKENS.ISecretRotationExecutor),
        c.resolve(DI_TOKENS.ISecretRotationReceiptStore),
        c.isRegistered(DI_TOKENS.ILogger) ? c.resolve<ILogger>(DI_TOKENS.ILogger) : undefined,
      ),
      {
        lifecycle: 'singleton',
        tags: ['security', 'secrets', 'application'],
        description: 'Application orchestrator for secret rotation planning, execution, and receipt persistence',
      }
    );
  }
}

/**
 * Register all security services
 */
function registerPromptInjectionScanner(): void {
  if (container.isRegistered(DI_TOKENS.IPromptInjectionScanner)) {
    return;
  }
  container.register(DI_TOKENS.IPromptInjectionScanner, (c) => {
    const logger = c.isRegistered(DI_TOKENS.ILogger)
      ? c.resolve<ILogger>(DI_TOKENS.ILogger)
      : undefined;
    return new PromptInjectionScanner(new ContentBoundaryWrapper(), logger);
  }, {
    lifecycle: 'singleton',
    tags: ['security', 'prompt-injection'],
    description: 'Detects prompt injection in untrusted tool and file text',
  });
}

function registerOutputRail(): void {
  if (container.isRegistered(DI_TOKENS.IOutputRail)) {
    return;
  }
  container.register(DI_TOKENS.IOutputRail, (c) => {
    const logger = c.isRegistered(DI_TOKENS.ILogger)
      ? c.resolve<ILogger>(DI_TOKENS.ILogger)
      : undefined;
    return new OutputRailScanner(logger);
  }, {
    lifecycle: 'singleton',
    tags: ['security', 'output-rail'],
    description: 'Scans model output for policy violations (NeMo-style output rail)',
  });
}

export function registerSecurityModule(config?: SecurityModuleConfig): void {
  registerSsrfDnsGuard();
  registerPromptInjectionScanner();
  registerOutputRail();
  registerToolPolicyResolver();
  registerFirewallService();
  registerCSPManager(config);

  registerRateLimiter(config);
  registerSecurityHeadersMiddleware(config);
  registerApiGateway(config);
  registerSecretRotationServices();
}

/**
 * Check if environment is production
 */
function isProduction(config?: SecurityModuleConfig): boolean {
  return config?.environment === 'production';
}

/**
 * Create security middleware stack
 */
export function createSecurityMiddlewareStack(
  config?: SecurityModuleConfig
): Array<(req: unknown, res: unknown, next: (err?: unknown) => void) => void> {
  const cspManager = container.isRegistered(SECURITY_TOKENS.CSPManager)
    ? container.resolve<ICSPManager>(SECURITY_TOKENS.CSPManager)
    : new CSPManager();

  const securityHeaders = container.isRegistered(SECURITY_TOKENS.SecurityHeadersMiddleware)
    ? container.resolve<SecurityHeadersMiddleware>(SECURITY_TOKENS.SecurityHeadersMiddleware)
    : new SecurityHeadersMiddleware(config);

  return [
    // Security headers first
    securityHeaders.middleware() as (req: unknown, res: unknown, next: (err?: unknown) => void) => void,
    // CSP next
    cspManager.middleware() as (req: unknown, res: unknown, next: (err?: unknown) => void) => void,
  ];
}

export { CSPManager, DistributedRateLimiter, InMemoryRateLimiter, SecurityHeadersMiddleware, ApiGateway };
