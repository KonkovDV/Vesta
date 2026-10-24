import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { registerDefaultHttpRoutes } from '../../src/presentation/http/register-default-routes';

async function withScopes(scopes: string[], run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  const authMw: express.RequestHandler = (req, _res, next) => {
    (req as express.Request & { authContext?: { scopes: string[] } }).authContext = { scopes };
    next();
  };
  const rateLimitMw: express.RequestHandler = (_req, _res, next) => next();
  registerDefaultHttpRoutes(app, { authMw, rateLimitMw });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : 'downstream' });
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('test server has no port');
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function status(base: string, path: string): Promise<number> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return response.status;
}

test('a key without the product scope gets 403', async () => {
  await withScopes(['agents.run'], async (base) => {
    assert.equal(await status(base, '/api/v1/sales/forecast'), 403);
    assert.equal(await status(base, '/api/v1/hr/engagement'), 403);
    assert.equal(await status(base, '/api/v1/healthcare/diagnosis'), 403);
    assert.equal(await status(base, '/api/v1/memory/ingest/document'), 403);
  });
});

test('a key with the product scope is not refused for scope', async () => {
  await withScopes(['sales.use', 'hr.use', 'healthcare.use', 'memory.ingest'], async (base) => {
    for (const path of ['/api/v1/sales/forecast', '/api/v1/hr/engagement', '/api/v1/healthcare/diagnosis', '/api/v1/memory/ingest/document']) {
      assert.notEqual(await status(base, path), 403, path);
    }
  });
});

test('MRI review and finalize need healthcare.review in addition to healthcare.use', async () => {
  const review = '/api/v1/healthcare/mri-second-opinion/case-1/review';
  const finalize = '/api/v1/healthcare/mri-second-opinion/case-1/finalize';
  await withScopes(['healthcare.use'], async (base) => {
    assert.equal(await status(base, review), 403);
    assert.equal(await status(base, finalize), 403);
  });
  await withScopes(['healthcare.use', 'healthcare.review'], async (base) => {
    assert.notEqual(await status(base, review), 403);
    assert.notEqual(await status(base, finalize), 403);
  });
});
