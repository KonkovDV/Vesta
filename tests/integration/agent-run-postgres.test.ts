/**
 * The tool-call claim on the real event store: two executors in two "processes"
 * (two service instances, two pools) resume the same approved run.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { AgentRunService, AgentRunConflictError } from '../../src/application/agents/AgentRunService';
import { createPostgreSQLEventStore } from '../../src/infrastructure/events/postgres-event-store';
import { CORE_MIGRATIONS_DIR, runMigrations } from '../../src/infrastructure/database/migration-runner';

const baseUrl = process.env.TEST_DATABASE_URL;
const dbName = `mp_agentrun_${process.pid}_${Date.now()}`;
let url = '';
const logger = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

async function admin(sql: string): Promise<void> {
  const client = new Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

before(async () => {
  if (!baseUrl) return;
  await admin(`CREATE DATABASE ${dbName}`);
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${dbName}`;
  url = parsed.toString();
  const result = await runMigrations({ client: new Client({ connectionString: url }), dirs: [CORE_MIGRATIONS_DIR], log: () => undefined });
  assert.equal(result.failed, 0);
});

after(async () => {
  if (baseUrl) await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

test('two executors on PostgreSQL run an approved side effect once', { skip: !baseUrl }, async () => {
  const storeA = createPostgreSQLEventStore({ connection: { connectionString: url } });
  const storeB = createPostgreSQLEventStore({ connection: { connectionString: url } });
  let payments = 0;
  const tools = { async execute() { await new Promise((resolve) => setTimeout(resolve, 50)); payments += 1; return { ok: true }; } };
  const policy = { async evaluate() { return { allowed: true, requiresApproval: true }; } };
  let step = 0;
  const model = {
    async complete() {
      step += 1;
      return step === 1
        ? { message: { role: 'assistant', content: '', toolCalls: [{ id: 'pay-1', name: 'pay', argumentsJson: '{"amount":10}' }] }, finishReason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } }
        : { message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const a = new AgentRunService(model as never, tools as never, policy as never, storeA, logger as never);
  const b = new AgentRunService(model as never, tools as never, policy as never, storeB, logger as never);
  const correlationId = 'corr_pg_claim_01';
  assert.equal((await a.start({ messages: [{ role: 'user', content: 'pay' }], correlationId, runId: 'pg-run-1' })).reason, 'awaiting_approval');
  await a.decideApproval('pg-run-1', 'pay-1', 'approved', correlationId, { decidedBy: 'ops' });

  const results = await Promise.allSettled([a.resume('pg-run-1', { correlationId }), b.resume('pg-run-1', { correlationId })]);
  assert.equal(payments, 1);
  for (const result of results) {
    if (result.status === 'rejected') {
      assert.ok(result.reason instanceof AgentRunConflictError, String(result.reason));
    } else {
      assert.equal(result.value.reason, 'completed');
    }
  }
  // One writer per stream: the loser neither calls the model again nor finishes twice.
  const events = await storeA.getEvents('agent-run-pg-run-1');
  assert.equal(events.filter((event) => event.type === 'ModelCalled').length, 2);
  assert.equal(events.filter((event) => event.type === 'AgentRunFinished').length, 1);
  await (storeA as unknown as { close(): Promise<void> }).close();
  await (storeB as unknown as { close(): Promise<void> }).close();
});
