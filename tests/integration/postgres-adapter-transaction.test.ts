/**
 * MP-K45: PostgresAdapter.transaction sent SET TRANSACTION ISOLATION LEVEL before
 * BEGIN, where it has no effect, and SET statement_timeout before BEGIN, where it
 * stays on the pooled connection after the transaction ends.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { PostgresAdapter } from '../../src/infrastructure/database/PostgresAdapter';

const baseUrl = process.env.TEST_DATABASE_URL;
const dbName = `mp_tx_${process.pid}_${Date.now()}`;
let url = '';

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
});

after(async () => {
  if (!baseUrl) return;
  await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

test('a transaction runs at the isolation level it asked for', { skip: !baseUrl }, async () => {
  const db = new PostgresAdapter({ connectionString: url, max: 1 });
  try {
    for (const [requested, expected] of [
      ['SERIALIZABLE', 'serializable'],
      ['REPEATABLE_READ', 'repeatable read'],
      ['READ_COMMITTED', 'read committed'],
    ] as const) {
      const observed = await db.transaction(async () => {
        const row = await db.queryOne<{ transaction_isolation: string }>('SHOW transaction_isolation');
        return row?.transaction_isolation;
      }, { isolationLevel: requested });
      assert.equal(observed, expected, requested);
    }
  } finally {
    await db.close();
  }
});

test('a transaction timeout ends with that transaction', { skip: !baseUrl }, async () => {
  // One pooled connection, so the second transaction reuses the first one's session.
  const db = new PostgresAdapter({ connectionString: url, max: 1 });
  try {
    const inside = await db.transaction(async () => {
      const row = await db.queryOne<{ statement_timeout: string }>('SHOW statement_timeout');
      return row?.statement_timeout;
    }, { timeoutMs: 1234 });
    assert.equal(inside, '1234ms');
    const next = await db.transaction(async () => {
      const row = await db.queryOne<{ statement_timeout: string }>('SHOW statement_timeout');
      return row?.statement_timeout;
    });
    assert.equal(next, '0');
  } finally {
    await db.close();
  }
});
