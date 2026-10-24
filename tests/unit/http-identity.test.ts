import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { getClientIdentifier, getRequestRouteLabel } from '../../src/application/app';
import { AuthService } from '../../src/application/services/AuthService';

async function serve(app: express.Application, run: (base: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the client identifier ignores X-Forwarded-For unless trust proxy says otherwise', async () => {
  const app = express();
  app.get('/id', (req, res) => { res.send(getClientIdentifier(req)); });
  await serve(app, async (base) => {
    const response = await fetch(`${base}/id`, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    assert.equal(await response.text(), '127.0.0.1');
  });
  const trusting = express();
  trusting.set('trust proxy', 'loopback');
  trusting.get('/id', (req, res) => { res.send(getClientIdentifier(req)); });
  await serve(trusting, async (base) => {
    const response = await fetch(`${base}/id`, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    assert.equal(await response.text(), '203.0.113.7');
  });
});

test('metric route labels use the route template, so ids do not create series', async () => {
  const labels: string[] = [];
  const app = express();
  app.use((req, res, next) => { res.on('finish', () => labels.push(getRequestRouteLabel(req))); next(); });
  const router = express.Router();
  router.get('/runs/:id/events', (_req, res) => { res.send('ok'); });
  app.use('/api/agents', router);
  await serve(app, async (base) => {
    await fetch(`${base}/api/agents/runs/run-1/events`);
    await fetch(`${base}/api/agents/runs/run-2/events?x=1`);
    await fetch(`${base}/nowhere/123`);
  });
  assert.deepEqual(labels, ['/api/agents/runs/:id/events', '/api/agents/runs/:id/events', 'unmatched']);
});

test('an API key in the query string is refused unless explicitly allowed outside production', async () => {
  process.env.BFF_API_KEY = 'query-key-0123456789abcdef';
  delete process.env.ALLOW_QUERY_API_KEY;
  const service = new AuthService();
  await assert.rejects(service.authenticateRequest({ headers: {}, query: { api_key: 'query-key-0123456789abcdef' } }), /required/);
  process.env.ALLOW_QUERY_API_KEY = 'true';
  const context = await new AuthService().authenticateRequest({ headers: {}, query: { api_key: 'query-key-0123456789abcdef' } });
  assert.equal(context.userId.length > 0, true);
  delete process.env.ALLOW_QUERY_API_KEY;
});
