import express from 'express';
import { DI_TOKENS } from '../core/di/DI_TOKENS';
import * as core from 'express-serve-static-core';
type ExpressRequest = core.Request;
type ExpressResponse = core.Response;
type NextFunction = core.NextFunction;
import compression from 'compression';
import helmet from 'helmet';
import cors from 'cors';
import { buildApplicationCorsOptions } from './middleware/cors-options';
import hpp from 'hpp';
import http from 'http';
import path from 'path';

import { createEventLoopGuard } from './middleware/event-loop-guard.middleware';
import { registerChatPresentationRoutes } from './chat/register-chat-presentation-routes';
import { registerMessageRoutes } from './chat/register-message-routes';
import { registerConversationRoutes } from './conversations/register-conversation-routes';
import { registerUploadRoutes } from './conversations/register-upload-routes';
import { registerFeatureFlagsAdminRoutes } from './feature-flags/register-feature-flags-admin-routes';
import { registerMasRoutes } from './mas/register-mas-routes';
import { registerQueryRoutes } from './memory/register-query-routes';
import { registerMcpApprovalRoutes } from './mcp/register-mcp-approval-routes';
import { registerIntegrationRoutes } from './integrations/register-integration-routes';
import { registerOperationalRoutes } from './operational/register-operational-routes';

import type { AuthService } from './services/AuthService';
import type { RateLimitService } from './services/RateLimitService';
import { HealthCheckService } from './services/HealthCheckService';
import { FeatureFlagsService } from './services/FeatureFlagsService';

import { createAuthMiddleware, createRateLimitMiddleware, createFeatureFlagsAdminMiddleware } from './middleware/auth';
import { applyTransportSecurity } from './middleware/transport-security';
import { rateLimiterMiddleware } from './middleware/rate-limiter.middleware';
import { RequestContextMiddleware, RequestContext } from './context/request-context';
import { createEventStoreMiddleware } from './middleware/event-store.middleware';
import { createUploadMiddleware } from './middleware/upload.middleware';
import {
  RagQueryRequestSchema,
  AdvancedRetrievalRequestSchema,
  MasExecuteRequestSchema,
} from './validators/api-schemas';
import { registerDefaultMetrics, getOrCreateCounter, getOrCreateHistogram } from '../monitoring';
import { getMetricsConfig, readStr } from '../core/config/app-config';
import type { ILogger } from '../core/decorators/ILogger';
import type { RagQueryService } from './memory/rag-query.service';
import type { EventStoreService } from './services/EventStoreService';
import type { MasAdvancedRetrievalFacade } from './agents/memory/mas-advanced-retrieval.facade';
import type { MasPolicyService } from './agents/security/mas-policy-service';
import { ChatController } from './controllers/chatController';
import { ConversationController } from './controllers/ConversationController';
import { PluginController } from './controllers/PluginController';
import { SlackEntController } from './controllers/slackEntController';
import { MemorySearchController } from './controllers/memorySearchController';
import { MasController } from './controllers/masController';
import { McpApprovalsController } from './controllers/McpApprovalsController';
import { registerAgentRunRoutes } from './agents/register-agent-run-routes';

export type HttpRouteRegistrationContext = {
  authMw: core.RequestHandler;
  rateLimitMw: core.RequestHandler;
};

export type HttpRouteRegistrar = (
  app: express.Application,
  context: HttpRouteRegistrationContext,
) => void;

export interface HttpAppDependencies {
  authService: AuthService;
  rateLimitService: RateLimitService;
  healthCheckService: HealthCheckService;
  featureFlagsService: FeatureFlagsService;
  httpRateLimiter?: HttpIngressRateLimiter;
  logger?: ILogger;
  chatController: ChatController;
  conversationController: ConversationController;
  pluginController: PluginController;
  slackEntController: SlackEntController;
  memorySearchController: MemorySearchController;
  masController: MasController;
  mcpApprovalsController: McpApprovalsController;
  ragQueryService: RagQueryService;
  masAdvancedRetrievalFacade: MasAdvancedRetrievalFacade;
  masterAgent: import('./agents/core/master-agent').IMasterAgent;
  masPolicyService: MasPolicyService;
  eventStoreService: EventStoreService;
  agentRuns?: Pick<import('./agents/AgentRunService').AgentRunService, 'start'>;
  /** Optional workspace root override — avoids process.cwd() in Application layer */
  workspaceRoot?: string;
  /** Transitional seam for presentation route mounting */
  registerRoutes?: HttpRouteRegistrar;
}

type RequestWithOptionalRoute = ExpressRequest & {
  route?: {
    path?: string;
  };
};

type HttpIngressRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
};

type HttpIngressRateLimiter = {
  checkLimit(identifier: string, endpoint?: string, weight?: number): Promise<HttpIngressRateLimitResult>;
};

type ContainerLike = {
  resolve<T>(token: string): T;
  isRegistered(token: string): boolean;
};

const REQUIRED_HTTP_DEPENDENCIES: ReadonlyArray<keyof HttpAppDependencies> = [
  'authService',
  'rateLimitService',
  'healthCheckService',
  'featureFlagsService',
  'chatController',
  'conversationController',
  'pluginController',
  'slackEntController',
  'memorySearchController',
  'masController',
  'mcpApprovalsController',
  'ragQueryService',
  'masAdvancedRetrievalFacade',
  'masterAgent',
  'masPolicyService',
  'eventStoreService',
];

function getOptionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function getRequestMethod(req: ExpressRequest): string {
  return req.method || 'GET';
}

function getRequestPath(req: ExpressRequest): string {
  return req.originalUrl || req.url;
}

function getRequestRouteHint(req: ExpressRequest): string {
  return (req as RequestWithOptionalRoute).route?.path || req.path;
}

function getClientIdentifier(req: ExpressRequest): string {
  const forwardedFor = req.headers['x-forwarded-for'];

  if (typeof forwardedFor === 'string') {
    const firstHop = forwardedFor.split(',')[0]?.trim();
    if (firstHop) {
      return firstHop;
    }
  }

  if (Array.isArray(forwardedFor)) {
    const firstHop = forwardedFor[0]?.trim();
    if (firstHop) {
      return firstHop;
    }
  }

  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function createIngressRateLimitMiddleware(
  httpRateLimiter: HttpIngressRateLimiter | undefined,
  logger?: ILogger,
) {
  if (!httpRateLimiter) {
    return rateLimiterMiddleware;
  }

  return async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    try {
      const identifier = getClientIdentifier(req);
      const endpoint = getRequestPath(req);
      const result = await httpRateLimiter.checkLimit(identifier, endpoint, 1);

      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetTime / 1000)));

      if (!result.allowed) {
        if (typeof result.retryAfter === 'number') {
          res.setHeader('Retry-After', String(result.retryAfter));
        }

        res.status(429).json({
          error: 'Too Many Requests',
          retryAfter: result.retryAfter,
        });
        return;
      }

      next();
    } catch (error) {
      logger?.error?.('http_ingress_rate_limit_failed', {
        error: error instanceof Error ? error.message : String(error),
        path: getRequestPath(req),
      });
      next();
    }
  };
}

/**
 * Создает и настраивает HTTP приложение (Express) c RequestContext и метриками
 * @param deps - зависимости (опционально, если не переданы - берутся из DI контейнера)
 */
function resolveContainerToken<T>(container: { isRegistered(token: string): boolean; resolve(token: string): T }, primary: string, legacyAliases: string[] = []): T {
  if (container.isRegistered(primary)) {
    return container.resolve(primary);
  }

  for (const alias of legacyAliases) {
    if (container.isRegistered(alias)) {
      return container.resolve(alias);
    }
  }

  return container.resolve(primary);
}

function getHttpAppContainer(): ContainerLike {
  const { container } = require('../core/di/container') as typeof import('../core/di/container');
  return container;
}

function resolveCompatibilityWorkspaceRoot(): string {
  return path.resolve(__dirname, '../..');
}

function resolveContainerRouteRegistrar(ctr: ContainerLike): HttpRouteRegistrar | undefined {
  try {
    if (ctr.isRegistered('HttpRouteRegistrar')) {
      return ctr.resolve<HttpRouteRegistrar>('HttpRouteRegistrar');
    }
  } catch { /* no registrar in container — caller decides fallback */ }
  return undefined;
}

function resolveHttpAppDependencies(deps?: Partial<HttpAppDependencies>): HttpAppDependencies {
  const container = getHttpAppContainer();

  if (!deps || Object.keys(deps).length === 0) {
    return {
      authService: resolveContainerToken<AuthService>(container, 'authService', ['AuthService']),
      rateLimitService: resolveContainerToken<RateLimitService>(container, 'rateLimitService', ['RateLimitService']),
      healthCheckService: resolveContainerToken<HealthCheckService>(container, 'healthCheckService', ['HealthCheckService']),
      featureFlagsService: resolveContainerToken<FeatureFlagsService>(container, 'featureFlagsService', ['FeatureFlagsService']),
      httpRateLimiter: container.isRegistered('RateLimiter')
        ? container.resolve('RateLimiter')
        : undefined,
      chatController: container.resolve('ChatController'),
      conversationController: container.resolve('ConversationController'),
      pluginController: container.resolve('PluginController'),
      slackEntController: container.resolve('SlackEntController'),
      memorySearchController: container.resolve('MemorySearchController'),
      masController: container.resolve('MasController'),
      mcpApprovalsController: container.resolve('McpApprovalsController'),
      ragQueryService: container.resolve(DI_TOKENS.RagQueryService),
      masAdvancedRetrievalFacade: container.resolve('MasAdvancedRetrievalFacade'),
      masterAgent: container.resolve(DI_TOKENS.IMasterAgent),
      masPolicyService: resolveContainerToken<MasPolicyService>(container, 'MasPolicyService', ['masPolicyService']),
      eventStoreService: container.resolve('eventStoreService'),
      logger: container.isRegistered(DI_TOKENS.ILogger)
        ? container.resolve(DI_TOKENS.ILogger)
        : undefined,
      workspaceRoot: resolveCompatibilityWorkspaceRoot(),
      registerRoutes: resolveContainerRouteRegistrar(container),
    };
  }

  const resolvedDeps = { ...deps } as HttpAppDependencies;
  for (const field of REQUIRED_HTTP_DEPENDENCIES) {
    if (!resolvedDeps[field]) {
      const tokenMap: Partial<Record<keyof HttpAppDependencies, string>> = {
        'authService': 'authService',
        'rateLimitService': 'rateLimitService',
        'healthCheckService': 'healthCheckService',
        'featureFlagsService': 'featureFlagsService',
        'httpRateLimiter': 'RateLimiter',
        'chatController': 'ChatController',
        'conversationController': 'ConversationController',
        'pluginController': 'PluginController',
        'slackEntController': 'SlackEntController',
        'memorySearchController': 'MemorySearchController',
        'masController': 'MasController',
        'mcpApprovalsController': 'McpApprovalsController',
        'ragQueryService': 'RagQueryService',
        'masAdvancedRetrievalFacade': 'MasAdvancedRetrievalFacade',
        'masterAgent': 'IMasterAgent',
        'masPolicyService': 'MasPolicyService',
        'eventStoreService': 'eventStoreService',
        'logger': 'ILogger',
      };
      const token = tokenMap[field] ?? field;
      const legacyAliases: Partial<Record<keyof HttpAppDependencies, string[]>> = {
        authService: ['AuthService'],
        rateLimitService: ['RateLimitService'],
        healthCheckService: ['HealthCheckService'],
        featureFlagsService: ['FeatureFlagsService'],
        masPolicyService: ['masPolicyService'],
      };
      (resolvedDeps as Record<keyof HttpAppDependencies, unknown>)[field] = resolveContainerToken(container, token, legacyAliases[field] ?? []);
    }
  }

  if (!resolvedDeps.workspaceRoot) {
    resolvedDeps.workspaceRoot = resolveCompatibilityWorkspaceRoot();
  }

  if (!resolvedDeps.registerRoutes) {
    resolvedDeps.registerRoutes = resolveContainerRouteRegistrar(container);
  }

  return resolvedDeps;
}

function createHttpApp(deps?: Partial<HttpAppDependencies>) {
  const resolvedDeps = resolveHttpAppDependencies(deps);
  const app = express();

  // Trust proxy — required behind NGINX/LB for correct client IP, rate limiting, secure cookies.
  // TRUST_PROXY=1 means trust first hop; 'loopback' is safe default for dev.
  const trustProxy = readStr('TRUST_PROXY');
  if (trustProxy) {
    const numeric = parseInt(trustProxy, 10);
    app.set('trust proxy', Number.isFinite(numeric) ? numeric : trustProxy);
  }

  const ingressRateLimiter = createIngressRateLimitMiddleware(
    resolvedDeps.httpRateLimiter,
    resolvedDeps.logger,
  );

  // 1. Digital Membrane (Transport Security)
  applyTransportSecurity(app); // Replaces helmet() and cors() setup
  app.use('/api', ingressRateLimiter);

  app.use(compression({ level: 6, threshold: 1024 }));

  // CORS setup - Handled by applyTransportSecurity above, but keeping logic if needed or removing.
  // The 'applyTransportSecurity' function sets up strict CORS. 
  // We should probably remove the redundant manual CORS setup below to avoid conflicts.
  // However, the manual setup has complex logging.
  // Let's comment out the manual one or rely on the new one.
  // For 'Highest Quality', we trust our new Digital Membrane.
  // Removing redundant CORS block below (lines 140-189).
  const defaultAllowedMethods = 'GET,POST,PUT,DELETE,OPTIONS';
  const defaultAllowedHeaders =
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key, Cache-Control, X-Correlation-Id';

  const rawOrigins = readStr('ALLOWED_ORIGINS') ?? '';
  const methodsRaw = readStr('ALLOWED_METHODS') ?? defaultAllowedMethods;
  const headersRaw = readStr('ALLOWED_HEADERS') ?? defaultAllowedHeaders;
  const corsOptions = buildApplicationCorsOptions({
    rawOrigins,
    methodsRaw,
    headersRaw,
    onReject: (origin, allowedOrigins) => {
      const loggerForCors = resolvedDeps.logger;
      if (!loggerForCors) return;
      const meta = {
        origin,
        allowedOrigins,
        note: 'Configure ALLOWED_ORIGINS or use "*" only in dev',
      };
      if (typeof loggerForCors.warn === 'function') {
        loggerForCors.warn('cors_origin_rejected', meta);
      } else {
        loggerForCors.log('cors_origin_rejected', meta);
      }
    },
  });

  app.use(cors(corsOptions));

  // Gzip bomb / decompression bomb defense (CWE-409, OWASP DoS Cheat Sheet)
  // Layer 1: Reject oversized compressed payloads by Content-Length header
  // Layer 2: Reject unknown Content-Encoding values (prevent bypass via custom encoding)
  // Layer 3: Streaming body tracking aborts connections exceeding limit regardless of headers
  // Note: express.json/urlencoded already enforce limit on DECOMPRESSED body via raw-body
  const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024; // 2 MB compressed limit
  const MAX_RAW_BODY_BYTES = 5 * 1024 * 1024; // 5 MB absolute raw stream limit
  const ALLOWED_ENCODINGS = new Set(['identity', 'gzip', 'deflate', 'br']);

  // Metrics: track body defense rejections for Prometheus alerting
  const bodyDefenseBlockedTotal = getOrCreateCounter(
    'http_body_defense_blocked_total',
    'Total requests blocked by body size / encoding defense',
    ['layer', 'reason'],
  );

  app.use((req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    // Layer 1: Content-Length pre-check (fast rejection for honest clients)
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > MAX_COMPRESSED_BYTES) {
      bodyDefenseBlockedTotal.labels('L1', 'content_length_exceeded').inc();
      res.status(413).type('application/problem+json').json({
        type: 'about:blank',
        title: 'Payload Too Large',
        status: 413,
        detail: 'Request body exceeds the maximum allowed size',
        instance: req.originalUrl,
      });
      return;
    }

    // Layer 2: Reject unknown Content-Encoding values
    const encoding = req.headers['content-encoding'];
    if (encoding && !ALLOWED_ENCODINGS.has(encoding.toLowerCase())) {
      bodyDefenseBlockedTotal.labels('L2', 'unsupported_encoding').inc();
      res.status(415).type('application/problem+json').json({
        type: 'about:blank',
        title: 'Unsupported Media Type',
        status: 415,
        detail: `Unsupported Content-Encoding: ${encoding.slice(0, 30)}`,
        instance: req.originalUrl,
      });
      return;
    }

    // Layer 3: Streaming body size enforcement — kills connection if raw bytes exceed absolute limit
    // Defends against Transfer-Encoding: chunked with spoofed/absent Content-Length
    let bytesReceived = 0;
    const originalOn = req.on.bind(req);
    req.on = function (event: string, listener: (...args: unknown[]) => void) {
      if (event === 'data') {
        const wrappedListener = (chunk: Buffer) => {
          bytesReceived += chunk.length;
          if (bytesReceived > MAX_RAW_BODY_BYTES) {
            bodyDefenseBlockedTotal.labels('L3', 'stream_limit_exceeded').inc();
            req.destroy();
            try {
              if (!res.headersSent && !res.destroyed) {
                res.status(413).type('application/problem+json').json({
                  type: 'about:blank',
                  title: 'Payload Too Large',
                  status: 413,
                  detail: 'Request body stream exceeds maximum allowed size',
                  instance: req.originalUrl,
                });
              }
            } catch { /* Socket already torn down — response impossible, req.destroy() is sufficient */ }
            return;
          }
          listener(chunk);
        };
        return originalOn(event, wrappedListener as (...args: unknown[]) => void);
      }
      return originalOn(event, listener);
    } as typeof req.on;

    next();
  });

  // Capture raw body buffer for webhook signature verification (Slack, Stripe, GitHub etc.)
  const captureRawBody = (req: http.IncomingMessage, _res: http.ServerResponse, buf: Buffer): void => {
    (req as http.IncomingMessage & { rawBody?: Buffer }).rawBody = buf;
  };
  app.use(express.json({ limit: '1mb', verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, limit: '1mb', verify: captureRawBody }));
  app.use(hpp()); // HTTP Parameter Pollution protection (OWASP)

  // Event loop overload protection — 503 when p99 lag > 70ms
  app.use('/api', createEventLoopGuard());

  // Cache-Control: prevent caching of API responses (OWASP REST Security CS)
  app.use('/api', (_req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  const workspaceRoot = resolvedDeps.workspaceRoot ?? resolveCompatibilityWorkspaceRoot();
  const publicDir = path.join(workspaceRoot, 'public');
  app.use(express.static(publicDir));

  app.use(RequestContextMiddleware.express());
  app.use(createEventStoreMiddleware(resolvedDeps.eventStoreService));

  const { enabled: METRICS_ENABLED, appRouteEnabled: APP_METRICS_ROUTE_ENABLED, httpBucketsSeconds } = getMetricsConfig();
  if (METRICS_ENABLED) registerDefaultMetrics();

  const httpRequestsTotal = getOrCreateCounter(
    'http_requests_total',
    'Total HTTP requests',
    ['method', 'route', 'status', 'layer']
  );

  const httpRequestDurationSeconds = getOrCreateHistogram(
    'http_request_duration_seconds',
    'HTTP request duration seconds',
    ['method', 'route', 'status', 'layer'],
    httpBucketsSeconds
  );

  const LAYER_APPLICATION = 'application';
  app.use((req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    const start = process.hrtime.bigint();
    const routeHint = getRequestRouteHint(req);

    res.on('finish', () => {
      const end = process.hrtime.bigint();
      const durSec = Number(end - start) / 1e9;
      const labels = {
        method: getRequestMethod(req),
        route: routeHint,
        status: String(res.statusCode),
        layer: LAYER_APPLICATION,
      } as const;
      httpRequestsTotal.labels(labels.method, labels.route, labels.status, labels.layer).inc();
      httpRequestDurationSeconds.labels(labels.method, labels.route, labels.status, labels.layer).observe(durSec);

      let corr: string | undefined;
      try {
        corr = RequestContext.getCorrelationId();
      } catch {
        // ignore
      }
      const loggerForHttp = resolvedDeps.logger;
      if (loggerForHttp) {
        const meta = {
          method: getRequestMethod(req),
          path: getRequestPath(req),
          status: res.statusCode,
          duration_ms: Math.round(durSec * 1000),
          correlation_id: corr,
          layer: LAYER_APPLICATION,
        };
        if (typeof loggerForHttp.info === 'function') {
          loggerForHttp.info('http_request', meta);
        } else {
          loggerForHttp.log('http_request', meta);
        }
      }
    });
    next();
  });

  const {
    authService,
    rateLimitService,
    healthCheckService,
    featureFlagsService,
    logger,
    chatController,
    conversationController,
    pluginController,
    slackEntController,
    memorySearchController,
    masController,
    mcpApprovalsController,
    ragQueryService,
    masAdvancedRetrievalFacade,
    masterAgent,
    masPolicyService,
    eventStoreService,
  } = resolvedDeps;
 
  const authMw = createAuthMiddleware(authService);
  const rateLimitMw = createRateLimitMiddleware(rateLimitService);
  const featureFlagsAdminMw = createFeatureFlagsAdminMiddleware(authService);
  const uploadMw = createUploadMiddleware();

  registerOperationalRoutes({
    app,
    authMw,
    featureFlagsAdminMw,
    healthCheckService,
    layer: LAYER_APPLICATION,
    metricsEnabled: METRICS_ENABLED,
    metricsRouteEnabled: APP_METRICS_ROUTE_ENABLED,
    logger,
  });

  registerFeatureFlagsAdminRoutes({
    app,
    authMw,
    featureFlagsAdminMw,
    featureFlagsService,
    logger,
  });

  registerMcpApprovalRoutes({
    app,
    authMw,
    featureFlagsAdminMw,
    rateLimitMw,
    mcpApprovalsController,
  });
  registerAgentRunRoutes({
    app,
    authMw,
    rateLimitMw,
    events: eventStoreService,
    runs: resolvedDeps.agentRuns,
    workspaceRoot: resolvedDeps.workspaceRoot,
    logger,
  });
  registerMasRoutes({
    app,
    authMw,
    rateLimitMw,
    requestContext: RequestContext,
    masterAgent,
    masPolicyService,
    logger,
  });
  registerQueryRoutes({
    app,
    authMw,
    rateLimitMw,
    requestContext: RequestContext,
    ragQueryService,
    memorySearchController,
    masAdvancedRetrievalFacade,
    masController,
  });

  registerChatPresentationRoutes({
    app,
    authMw,
    rateLimitMw,
    chatController,
  });

  registerConversationRoutes({
    app,
    authMw,
    conversationController,
  });

  registerUploadRoutes({
    app,
    authMw,
    rateLimitMw,
    uploadMw,
    conversationController,
  });

  registerMessageRoutes({
    app,
    authMw,
    rateLimitMw,
    chatController,
  });
 
  registerIntegrationRoutes({
    app,
    authMw,
    rateLimitMw,
    pluginController,
    slackEntController,
  });

  resolvedDeps.registerRoutes?.(app, { authMw, rateLimitMw });

  // --- 404 Handler (must come after all routes) ---
  // RFC 9457 (obsoletes RFC 7807): application/problem+json
  app.use((req: ExpressRequest, res: ExpressResponse) => {
    res.status(404).type('application/problem+json').json({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'The requested resource does not exist',
      instance: req.originalUrl,
    });
  });

  // --- Global Error Handler (4-param signature required by Express) ---
  // OWASP Error Handling CS: never expose stack traces or internal details to clients
  // RFC 9457 (obsoletes RFC 7807): application/problem+json
  app.use((err: Error, req: ExpressRequest, res: ExpressResponse, _next: NextFunction) => {
    // Express/http-errors may set .statusCode or .status
    const statusCode = (err as unknown as { statusCode?: number; status?: number }).statusCode
      || (err as unknown as { status?: number }).status
      || 500;

    // Log full error details server-side
    if (resolvedDeps.logger && typeof resolvedDeps.logger.error === 'function') {
      resolvedDeps.logger.error('unhandled_error', {
        error: err.message,
        stack: err.stack,
        statusCode,
      });
    } else {
      console.error('[ErrorHandler]', err);
    }

    // Return sanitized RFC 9457 response — no stack traces, no internal paths
    // For non-500 errors: sanitize message to strip file paths and limit length (OWASP)
    const sanitizedMessage = statusCode >= 500
      ? 'An unexpected error occurred. Please try again later.'
      : err.message.replace(/[A-Z]:\\[^\s]+|\/?[\w.-]+\/[\w./-]+/gi, '[path]').slice(0, 200);
    // RFC 9457 §4.2.1: title SHOULD match the HTTP status phrase for about:blank type
    const title = http.STATUS_CODES[statusCode] || 'Error';
    res.status(statusCode).type('application/problem+json').json({
      type: 'about:blank',
      title,
      status: statusCode,
      detail: sanitizedMessage,
      instance: req.originalUrl,
    });
  });

  return app;
}

export function createApp(deps: HttpAppDependencies) {
  const app = createHttpApp(deps);
  return { app } as const;
}

export { createHttpApp };
