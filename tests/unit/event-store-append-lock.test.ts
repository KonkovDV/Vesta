import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { EventFactory } from '../../src/domain/events/event-store.interface';
import { PostgresEventStore } from '../../src/infrastructure/events/postgres-event-store';

test('an append locks the aggregate and reads the maximum version', async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes('MAX(aggregate_version)')) return { rows: [{ v: 3 }], rowCount: 1 };
      if (sql.includes('INSERT')) return { rows: [{ gsn: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const store = new PostgresEventStore({ connection: { host: '127.0.0.1', port: 1, connectionTimeoutMillis: 200 } });
  const realPool = (store as unknown as { pool: Pool }).pool;
  (store as unknown as { pool: { connect(): Promise<typeof client> } }).pool = {
    async connect() { return client; },
  };
  try {
    const event = EventFactory.createBaseEvent('agg-1', 'Noted', { n: 1 }, 'corr-1');
    const saved = await store.saveEvents([event], { expectedAggregateVersion: 3 });
    assert.equal(saved.success, true);
    assert.equal(saved.aggregateVersion, 4);
    const text = queries.join('\n');
    assert.match(text, /BEGIN/);
    assert.match(text, /pg_advisory_xact_lock\(hashtextextended/);
    assert.match(text, /COALESCE\(MAX\(aggregate_version\), 0\)/);
    assert.equal(text.includes('SERIALIZABLE'), false);
    assert.equal(text.includes('FOR UPDATE'), false);
    assert.match(text, /COMMIT/);
  } finally {
    await realPool.end();
  }
});
