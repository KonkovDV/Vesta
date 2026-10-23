import express from 'express';
import * as core from 'express-serve-static-core';
import { timingSafeEqual } from 'crypto';

import { getRegistry, getOverallHealth } from '../../monitoring';
import { readStr } from '../../core/config/app-config';
import type { ILogger } from '../../core/decorators/ILogger';
import type { HealthCheckService } from '../services/HealthCheckService';

type ExpressRequest = core.Request;
type ExpressResponse = core.Response;

type CoreReadinessService = {
  name: 'eventStore' | 'eventBus' | 'outbox';
  status: string;
};

type ReadinessSnapshot = {
  isReady: boolean;
  services: CoreReadinessService[];
  timestamp: string;
  featureFlags: Record<string, boolean>;
};

export type RegisterOperationalRoutesOptions = {
  app: express.Application;
  authMw: core.RequestHandler;
  featureFlagsAdminMw: core.RequestHandler;
  healthCheckService: HealthCheckService;
  layer: string;
  metricsEnabled: boolean;
  metricsRouteEnabled: boolean;
  logger?: ILogger;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function getCoreReadinessSnapshot(
  healthCheckService: HealthCheckService,
): Promise<ReadinessSnapshot> {
  const [health, migration] = await Promise.all([
    healthCheckService.checkAll(),
    healthCheckService.checkMigrationStatus(),
  ]);
  const criticalServices = ['eventStore', 'eventBus', 'outbox'] as const;

  const services = criticalServices.map((name) => {
    const svc = health.services[name];
    const migrationService = isRecord(migration.services)
      ? migration.services[name]
      : undefined;
    let status: string =
      isRecord(svc) && typeof svc.status === 'string'
        ? svc.status
        : 'unknown';

    if (isRecord(migrationService)) {
      const stubStatus =
        isRecord(migrationService.stub) &&
        typeof migrationService.stub.status === 'string'
          ? migrationService.stub.status
          : undefined;
      const realStatus =
        isRecord(migrationService.real) &&
        typeof migrationService.real.status === 'string'
          ? migrationService.real.status
          : undefined;
      const migrated = migrationService.migrated === true;

      if (migrated && realStatus) {
        status = realStatus;
      } else if (!migrated && stubStatus) {
        status = stubStatus;
      }
    }

    return {
      name,
      status,
    };
  });

  const featureFlags = isRecord(migration.featureFlags)
    ? Object.entries(migration.featureFlags).reduce<Record<string, boolean>>((acc, [key, value]) => {
        if (typeof value === 'boolean') {
          acc[key] = value;
        }
        return acc;
      }, {})
    : {};

  return {
    isReady: services.every((service) => service.status === 'healthy'),
    services,
    timestamp: health.timestamp ?? new Date().toISOString(),
    featureFlags,
  };
}

export function registerOperationalRoutes(
  options: RegisterOperationalRoutesOptions,
): void {
  const {
    app,
    authMw,
    featureFlagsAdminMw,
    healthCheckService,
    layer,
    metricsEnabled,
    metricsRouteEnabled,
  } = options;

  app.get('/health', (_req: ExpressRequest, res: ExpressResponse) =>
    res.status(200).json({ status: 'ok', layer })
  );

  app.get('/health/live', (_req: ExpressRequest, res: ExpressResponse) => {
    res.status(200).json({
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      layer,
    });
  });

  app.get('/healthz', async (_req: ExpressRequest, res: ExpressResponse) => {
    try {
      const [status, readiness] = await Promise.all([
        getOverallHealth(),
        getCoreReadinessSnapshot(healthCheckService),
      ]);

      const probeToFlag: Record<string, string> = {
        database: 'useRealDatabase',
        event_store: 'useRealEventStore',
        event_bus: 'useRealEventBus',
        outbox: 'useRealOutbox',
      };
      const flags = readiness.featureFlags;

      const components: Record<string, unknown> = {};
      for (const [name, probe] of Object.entries(status.components)) {
        const flagKey = probeToFlag[name];
        const isStub = flagKey ? flags[flagKey] !== true : false;
        components[name] = isStub
          ? { ...probe, mode: 'stub', note: 'Service running in stub mode — failure expected' }
          : probe;
      }

      const code = readiness.isReady ? 200 : 503;
      res.status(code).json({
        ok: readiness.isReady,
        components,
        aggregatedOk: status.ok,
        readiness: {
          status: readiness.isReady ? 'ready' : 'not_ready',
          services: readiness.services,
          timestamp: readiness.timestamp,
        },
      });
    } catch (e: unknown) {
      const error = e as { message?: string };
      res.status(500).json({ ok: false, error: error?.message || 'healthz_failed' });
    }
  });

  if (metricsRouteEnabled) {
    app.get('/metrics', async (req: ExpressRequest, res: ExpressResponse) => {
      if (!metricsEnabled) {
        res.status(404).type('text/plain').send('metrics_disabled');
        return;
      }

      const metricsToken = readStr('METRICS_AUTH_TOKEN', '');
      if (metricsToken) {
        const authHeader = req.headers.authorization ?? '';
        const providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        const expected = Buffer.from(metricsToken);
        const provided = Buffer.from(providedToken);
        if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
          res.status(401).type('text/plain').send('metrics_unauthorized');
          return;
        }
      }

      try {
        const registry = getRegistry();
        const metrics = await registry.metrics();
        const registryWithContentType = registry as { contentType?: string };

        if (registryWithContentType.contentType) {
          res.setHeader('Content-Type', registryWithContentType.contentType);
        } else {
          res.setHeader('Content-Type', 'text/plain; version=0.0.4');
        }

        res.status(200).send(metrics);
      } catch {
        res.status(500).type('text/plain').send('metrics_error');
      }
    });
  }

  app.get('/health/ready', async (_req: ExpressRequest, res: ExpressResponse) => {
    try {
      const readiness = await getCoreReadinessSnapshot(healthCheckService);

      res.status(readiness.isReady ? 200 : 503).json({
        status: readiness.isReady ? 'ready' : 'not_ready',
        services: readiness.services,
        timestamp: readiness.timestamp,
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        error: error instanceof Error ? error.message : 'health_ready_failed',
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.get('/health/detailed', authMw, featureFlagsAdminMw, async (_req: ExpressRequest, res: ExpressResponse) => {
    try {
      const health = await healthCheckService.checkAll();

      const httpCode = health.status === 'unhealthy'
        ? 503
        : 200;

      res.status(httpCode).json(health);
    } catch (error) {
      res.status(500).json({
        status: 'error',
        error: error instanceof Error ? error.message : 'health_detailed_failed',
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.get('/health/migration', async (_req: ExpressRequest, res: ExpressResponse) => {
    try {
      const migration = await healthCheckService.checkMigrationStatus();

      res.status(200).json({
        status: 'ok',
        migration,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }
  });
}