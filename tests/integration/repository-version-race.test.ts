/**
 * MP-K40: two saves decided on one version must not both commit.
 * The repositories compare the read-model version, but both transactions could
 * read it before either committed. The second then overwrote the read model and
 * the outbox numbered its events after the first writer's.
 * Ten pairs race at once, so the test does not depend on one interleaving.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { CORE_MIGRATIONS_DIR, runMigrations } from '../../src/infrastructure/database/migration-runner';
import { PostgresAdapter } from '../../src/infrastructure/database/PostgresAdapter';
import { PostgresConversationRepository } from '../../src/infrastructure/database/PostgresConversationRepository';
import { PostgresResearchReportRepository } from '../../src/infrastructure/database/PostgresResearchReportRepository';
import { PostgreSQLOutbox } from '../../src/infrastructure/events/postgres-outbox';
import { createPostgreSQLEventStore } from '../../src/infrastructure/events/postgres-event-store';
import { Conversation } from '../../src/domain/conversation/Conversation';
import { ConversationId } from '../../src/domain/conversation/ConversationId';
import { Article, ResearchReport, ResearchTopic } from '../../src/domain/research/ResearchReport';
import { ResearcherId, ResearchReportId } from '../../src/domain/research/ResearchIdentifiers';

const baseUrl = process.env.TEST_DATABASE_URL;
const dbName = `mp_race_${process.pid}_${Date.now()}`;
const PAIRS = 10;
let url = '';

async function admin(sql: string): Promise<void> {
  const client = new Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

async function rows<T>(sql: string, params: unknown[]): Promise<T[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return (await client.query(sql, params)).rows as T[]; } finally { await client.end(); }
}

function connections() {
  const db = new PostgresAdapter({ connectionString: url, max: PAIRS * 2 + 2 });
  const outbox = new PostgreSQLOutbox({ connection: { connectionString: url } } as never, undefined, undefined as never);
  const eventStore = createPostgreSQLEventStore({ connection: { connectionString: url } });
  const closeStore = (eventStore as unknown as { close(): Promise<void> }).close.bind(eventStore);
  return { db, outbox, eventStore, close: () => Promise.allSettled([db.close(), outbox.close(), closeStore()]) };
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
  if (!baseUrl) return;
  await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

test('two saves of one conversation version: one commits, the other is a conflict', { skip: !baseUrl }, async () => {
  const { db, outbox, close } = connections();
  const repo = new PostgresConversationRepository(db, outbox);
  try {
    const ids: string[] = [];
    for (let i = 0; i < PAIRS; i += 1) {
      const created = Conversation.create({ createdBy: 'user_alice', participantIds: ['user_bob'] });
      assert.equal((await repo.save(created)).success, true);
      ids.push(created.conversationId.toValue());
    }
    const pairs = await Promise.all(ids.map(async (id) => {
      const [left, right] = await Promise.all([repo.findById(ConversationId.fromString(id)), repo.findById(ConversationId.fromString(id))]);
      assert.ok(left.success && right.success);
      left.data.addMessage({ content: 'from alice', authorId: 'user_alice' });
      right.data.addMessage({ content: 'from bob', authorId: 'user_bob' });
      return Promise.all([repo.save(left.data), repo.save(right.data)]);
    }));
    const committed = pairs.map((results) => results.filter((result) => result.success).length);
    assert.deepEqual(committed, Array(PAIRS).fill(1), 'saves committed per pair');
    const lost = pairs.map((results) => results.find((result) => !result.success));
    assert.deepEqual(lost.map((result) => (result && !result.success ? result.error.type : undefined)), Array(PAIRS).fill('CONFLICT'));
    const journal = await rows<{ aggregate_id: string; versions: number[] }>(
      `SELECT aggregate_id, array_agg(aggregate_version ORDER BY aggregate_version) AS versions
         FROM event_store.events WHERE aggregate_id = ANY($1::text[]) GROUP BY aggregate_id`,
      [ids],
    );
    assert.equal(journal.length, PAIRS);
    for (const row of journal) assert.deepEqual(row.versions, [1, 2], row.aggregate_id);
    const messages = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE conversation_id = ANY($1::text[])`,
      [ids],
    );
    assert.equal(messages[0].n, PAIRS);
  } finally {
    await close();
  }
});

test('two saves of one research report version: one commits, the other is a conflict', { skip: !baseUrl }, async () => {
  const { db, outbox, eventStore, close } = connections();
  const repo = new PostgresResearchReportRepository(db, outbox, eventStore);
  const topic = ResearchTopic.fromString('event sourcing outbox');
  const article = (id: string) => Article.create({
    id,
    title: `event sourcing outbox ${id}`,
    abstract: 'event sourcing with an outbox',
    source: 'probe',
  });
  try {
    const ids: string[] = [];
    for (let i = 0; i < PAIRS; i += 1) {
      const created = ResearchReport.create(topic, ResearcherId.fromString('researcher_probe'));
      assert.equal((await repo.save(created)).success, true);
      ids.push(created.id.toValue());
    }
    const pairs = await Promise.all(ids.map(async (id) => {
      const [left, right] = await Promise.all([repo.findById(ResearchReportId.fromString(id)), repo.findById(ResearchReportId.fromString(id))]);
      assert.ok(left.success && right.success);
      left.data.addArticle(article(`${id}-a`));
      right.data.addArticle(article(`${id}-b`));
      return Promise.all([repo.save(left.data), repo.save(right.data)]);
    }));
    const committed = pairs.map((results) => results.filter((result) => result.success).length);
    assert.deepEqual(committed, Array(PAIRS).fill(1), 'saves committed per pair');
    const lost = pairs.map((results) => results.find((result) => !result.success));
    assert.deepEqual(lost.map((result) => (result && !result.success ? result.error.type : undefined)), Array(PAIRS).fill('CONFLICT'));
    const journal = await rows<{ aggregate_id: string; versions: number[] }>(
      `SELECT aggregate_id, array_agg(aggregate_version ORDER BY aggregate_version) AS versions
         FROM event_store.events WHERE aggregate_id = ANY($1::text[]) GROUP BY aggregate_id`,
      [ids],
    );
    assert.equal(journal.length, PAIRS);
    for (const row of journal) assert.deepEqual(row.versions, [1, 2], row.aggregate_id);
  } finally {
    await close();
  }
});


test('findById and find rebuild a saved research report from the journal (MP-K44)', { skip: !baseUrl }, async () => {
  const { db, outbox, eventStore, close } = connections();
  const repo = new PostgresResearchReportRepository(db, outbox, eventStore);
  try {
    const report = ResearchReport.create(ResearchTopic.fromString('commit order reader'), ResearcherId.fromString('researcher_find'));
    report.addArticle(Article.create({ id: 'find-a', title: 'commit order reader', abstract: 'a commit order reader', source: 'probe' }));
    assert.equal((await repo.save(report)).success, true);

    const found = await repo.findById(ResearchReportId.fromString(report.id.toValue()));
    assert.ok(found.success, found.success ? '' : found.error.message);
    assert.equal(found.data.version, report.version);
    assert.equal(found.data.topic.value, 'commit order reader');

    const listed = await repo.find({ researcherId: 'researcher_find' });
    assert.ok(listed.success, listed.success ? '' : listed.error.message);
    assert.deepEqual(listed.data.reports.map((item) => item.id.toValue()), [report.id.toValue()]);
  } finally {
    await close();
  }
});
