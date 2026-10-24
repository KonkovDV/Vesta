import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { registerAgentRunRoutes } from '../../src/application/agents/register-agent-run-routes';
import { AgentRunService } from '../../src/application/agents/AgentRunService';
import { InMemoryEventStore } from '../../src/infrastructure/events/InMemoryEventStore';

const logger = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function app(store: InMemoryEventStore) {
  const service = new AgentRunService(
    { async complete() { return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }; } } as never,
    {} as never, { async evaluate() { return { allowed: true }; } } as never, store, logger as never,
  );
  const application = express();
  application.use(express.json());
  const users: Record<string, { userId: string; tenantId: string | null; scopes: string[] }> = {
    alice: { userId: 'alice', tenantId: 't1', scopes: ['agents.run'] },
    mallory: { userId: 'mallory', tenantId: 't1', scopes: ['agents.run'] },
  };
  const authMw: express.RequestHandler = (req, _res, next) => {
    (req as unknown as { authContext: unknown }).authContext = users[String(req.headers['x-user'])];
    next();
  };
  registerAgentRunRoutes({
    app: application,
    authMw,
    rateLimitMw: (_req, _res, next) => next(),
    events: {
      getEvents: (id: string) => store.getEvents(id),
      appendEvent: async (event) => { await store.saveEvents([event]); },
    },
    runs: service,
    sseTimeoutMs: 200,
    ssePollMs: 20,
  });
  return application;
}

async function withServer(application: express.Application, run: (base: string) => Promise<void>) {
  const server = application.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('another principal cannot read or cancel a run', async () => {
  const store = new InMemoryEventStore();
  await withServer(app(store), async (base) => {
    const created = await fetch(`${base}/api/agents/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'alice' }, body: JSON.stringify({ task: 'hi' }),
    });
    assert.equal(created.status, 201);
    const { runId } = await created.json() as { runId: string };

    const own = await fetch(`${base}/api/agents/runs/${runId}/events`, { headers: { 'x-user': 'alice' } });
    assert.equal(own.status, 200);
    assert.match(await own.text(), /AgentRunFinished/);

    const foreign = await fetch(`${base}/api/agents/runs/${runId}/events`, { headers: { 'x-user': 'mallory' } });
    assert.equal(foreign.status, 404);
    const cancel = await fetch(`${base}/api/agents/runs/${runId}/cancel`, { method: 'POST', headers: { 'x-user': 'mallory' } });
    assert.equal(cancel.status, 404);
  });
});

test('cancel of an unknown run writes nothing', async () => {
  const store = new InMemoryEventStore();
  await withServer(app(store), async (base) => {
    const response = await fetch(`${base}/api/agents/runs/does-not-exist/cancel`, { method: 'POST', headers: { 'x-user': 'alice' } });
    assert.equal(response.status, 404);
  });
  assert.equal((await store.getEvents('agent-run-does-not-exist')).length, 0);
});

test('a person approves a held call over HTTP; the decision is bound to the arguments hash', async () => {
  const store = new InMemoryEventStore();
  let paid = 0;
  let step = 0;
  const service = new AgentRunService(
    { async complete() {
      step += 1;
      return step === 1
        ? { message: { role: 'assistant', content: '', toolCalls: [{ id: 'pay-1', name: 'pay', argumentsJson: '{"amount":7}' }] }, finishReason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } }
        : { message: { role: 'assistant', content: 'paid' }, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    } } as never,
    { async execute() { paid += 1; return { ok: true }; } } as never,
    { async evaluate(request: { toolName: string }) { return request.toolName === 'pay' ? { allowed: true, requiresApproval: true } : { allowed: true }; } } as never,
    store, logger as never,
  );
  const application = express();
  application.use(express.json());
  const users: Record<string, { userId: string; tenantId: string | null; scopes: string[] }> = {
    alice: { userId: 'alice', tenantId: 't1', scopes: ['agents.run', 'agents.approve'] },
    bob: { userId: 'bob', tenantId: 't1', scopes: ['agents.run'] },
  };
  registerAgentRunRoutes({
    app: application,
    authMw: (req, _res, next) => { (req as unknown as { authContext: unknown }).authContext = users[String(req.headers['x-user'])]; next(); },
    rateLimitMw: (_req, _res, next) => next(),
    events: { getEvents: (id: string) => store.getEvents(id), appendEvent: async (event) => { await store.saveEvents([event]); } },
    runs: service,
  });
  await withServer(application, async (base) => {
    const post = (path: string, user: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify(body) });
    const started = await (await post('/api/agents/runs', 'alice', { task: 'pay 7' })).json() as { runId: string; reason: string; content: string };
    assert.equal(started.reason, 'awaiting_approval');
    const requested = (await store.getEvents(`agent-run-${started.runId}`)).find((event) => event.type === 'ToolApprovalRequested');
    const hash = (requested?.payload as { argumentsHash: string }).argumentsHash;
    const path = `/api/agents/runs/${started.runId}/approvals/pay-1`;

    assert.equal((await post(path, 'bob', { decision: 'approved', argumentsHash: hash })).status, 403, 'no agents.approve scope');
    assert.equal((await post(path, 'alice', { decision: 'approved', argumentsHash: 'sha256:other' })).status, 409, 'hash of other arguments');
    assert.equal(paid, 0);
    const approved = await post(path, 'alice', { decision: 'approved', argumentsHash: hash });
    assert.equal(approved.status, 200);
    assert.deepEqual(await approved.json(), { ok: true, runId: started.runId, reason: 'completed', content: 'paid' });
    assert.equal(paid, 1);
    assert.equal((await post(path, 'alice', { decision: 'denied', argumentsHash: hash })).status, 409, 'a decision cannot be changed');
    const decided = (await store.getEvents(`agent-run-${started.runId}`)).find((event) => event.type === 'ToolApprovalDecided');
    assert.equal((decided?.payload as { decidedBy?: string }).decidedBy, 'alice');
  });
});
