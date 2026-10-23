import type express from 'express';
import type { HttpRouteRegistrar, HttpRouteRegistrationContext } from '../../application/app';
import { createIdentityRoutes } from './routes/identity.routes';
import { createSalesRoutes } from './routes/sales.routes';
import { createHrRoutes } from './routes/hr.routes';
import { createHealthcareRoutes } from './routes/healthcare.routes';
import { createIngestionRoutes } from './routes/ingestion.routes';

export const registerDefaultHttpRoutes: HttpRouteRegistrar = (
  app: express.Application,
  context: HttpRouteRegistrationContext,
): void => {
  const { authMw, rateLimitMw } = context;

  // Identity Routes — IP-based rate limiting only (no auth required for register/login)
  // NOTE: rateLimiterMiddleware (IP-based) is already applied globally via app.use('/api', ...).
  app.use('/api/v1/identity', createIdentityRoutes(authMw));
  app.use('/api/v1/sales', authMw, rateLimitMw, createSalesRoutes());
  app.use('/api/v1/hr', authMw, rateLimitMw, createHrRoutes());
  app.use('/api/v1/healthcare', authMw, rateLimitMw, createHealthcareRoutes());
  app.use('/api/v1/memory/ingest', authMw, rateLimitMw, createIngestionRoutes());
};