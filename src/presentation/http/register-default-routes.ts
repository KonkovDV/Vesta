import type express from 'express';
import type { HttpRouteRegistrar, HttpRouteRegistrationContext } from '../../application/app';
import { requireScope } from '../../application/middleware/auth';
import { createIdentityRoutes } from './routes/identity.routes';
import { createSalesRoutes } from './routes/sales.routes';
import { createHrRoutes } from './routes/hr.routes';
import { createHealthcareRoutes, HEALTHCARE_REVIEW_SCOPE } from './routes/healthcare.routes';
import { createIngestionRoutes } from './routes/ingestion.routes';

/**
 * Scope each product mount requires after authentication. A key without it gets 403
 * (MP-K32). MRI review and finalization also need `healthcare.review`.
 */
export const PRODUCT_ROUTE_SCOPES = {
  sales: 'sales.use',
  hr: 'hr.use',
  healthcare: 'healthcare.use',
  healthcareReview: HEALTHCARE_REVIEW_SCOPE,
  ingest: 'memory.ingest',
} as const;

export const registerDefaultHttpRoutes: HttpRouteRegistrar = (
  app: express.Application,
  context: HttpRouteRegistrationContext,
): void => {
  const { authMw, rateLimitMw } = context;

  // Identity Routes — IP-based rate limiting only (no auth required for register/login)
  // NOTE: rateLimiterMiddleware (IP-based) is already applied globally via app.use('/api', ...).
  app.use('/api/v1/identity', createIdentityRoutes(authMw));
  app.use('/api/v1/sales', authMw, rateLimitMw, requireScope(PRODUCT_ROUTE_SCOPES.sales), createSalesRoutes());
  app.use('/api/v1/hr', authMw, rateLimitMw, requireScope(PRODUCT_ROUTE_SCOPES.hr), createHrRoutes());
  app.use('/api/v1/healthcare', authMw, rateLimitMw, requireScope(PRODUCT_ROUTE_SCOPES.healthcare), createHealthcareRoutes());
  app.use('/api/v1/memory/ingest', authMw, rateLimitMw, requireScope(PRODUCT_ROUTE_SCOPES.ingest), createIngestionRoutes());
};
