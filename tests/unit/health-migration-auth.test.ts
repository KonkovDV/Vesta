import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express-serve-static-core';
import { registerOperationalRoutes } from '../../src/application/operational/register-operational-routes';

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('GET /health/migration requires a key', async () => {
  const app = express();
  const authMw: RequestHandler = (req, res, next) => {
    if (!req.headers.authorization) {
      res.status(401).end();
      return;
    }
    next();
  };
  registerOperationalRoutes({
    app,
    authMw,
    featureFlagsAdminMw: (_req, _res, next) => next(),
    healthCheckService: {
      async checkMigrationStatus() {
        return { migrated: true };
      },
    } as never,
    layer: 'test',
    metricsEnabled: false,
    metricsRouteEnabled: false,
  });
  const server = await listen(app);
  const port = (server.address() as { port: number }).port;
  try {
    const closed = await fetch(`http://127.0.0.1:${port}/health/migration`);
    assert.equal(closed.status, 401);
    const open = await fetch(`http://127.0.0.1:${port}/health/migration`, {
      headers: { authorization: 'Bearer test' },
    });
    assert.equal(open.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
