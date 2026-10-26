import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(__filename);
const gates = require('../../scripts/ci-gates-lib.cjs');

test('a nested Express router keeps its mount prefix', () => {
  const fixture = path.join(__dirname, '..', 'gates', 'express-walk-fixture.cjs');
  const result = spawnSync(process.execPath, [fixture], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /POST \/api\/v1\/healthcare\/mri\/:caseId\/review/);
  assert.match(result.stdout, /GET \/health/);
});

test('a route parameter becomes a probe segment', () => {
  assert.equal(gates.fillRouteParams('/api/agents/runs/:id/approvals/:toolCallId'), '/api/agents/runs/probe/approvals/probe');
});

test('an unlisted answer fails the route gate', () => {
  const allow = ['GET /health'];
  assert.deepEqual(gates.unexpectedOpenRoutes([
    { method: 'GET', path: '/health', status: 200 },
    { method: 'POST', path: '/api/v1/sales/lead-scoring', status: 401 },
    { method: 'POST', path: '/api/mcp/x/y', status: 404 },
  ], allow), []);
  assert.deepEqual(gates.unexpectedOpenRoutes([
    { method: 'GET', path: '/admin/export', status: 200 },
  ], allow), ['GET /admin/export']);
  assert.deepEqual(gates.unexpectedOpenRoutes([
    { method: 'POST', path: '/api/v1/hr/talent-acquisition', status: 400 },
  ], allow), ['POST /api/v1/hr/talent-acquisition']);
});

test('a new unresolved token fails the resolve gate', () => {
  const budget = ['LLMAdapterFactory', 'IUnitOfWork'];
  assert.deepEqual(gates.unexpectedResolveFailures([
    { token: 'LLMAdapterFactory' },
  ], budget), []);
  assert.deepEqual(gates.unexpectedResolveFailures([
    { token: 'LLMAdapterFactory' },
    { token: 'INewBrokenToken' },
  ], budget), ['INewBrokenToken']);
});
