/**
 * The embedding worker follows a commit-order cursor and keeps it across restarts (MP-K23).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventStore } from '../../src/infrastructure/events/InMemoryEventStore';
import { SemanticEmbeddingWorker } from '../../src/application/workers/SemanticEmbeddingWorker';
import type { DomainEvent, IEventStore } from '../../src/domain/events/event-store.interface';
import type { CommittedEventsPage } from '../../src/domain/events/commit-order.port';
import type { IEventVectorizer } from '../../src/domain/memory/IEventVectorizer';
import { getOrCreateGauge } from '../../src/monitoring';

const options = { batchSize: 2, pollIntervalMs: 60_000, enabled: true };
const quiet = { info: () => undefined, error: () => undefined };

function vectorizer(seen: string[]): IEventVectorizer {
  return {
    isReady: true,
    dimensions: 3,
    initialize: async () => undefined,
    vectorize: async () => [0, 0, 1],
    vectorizeBatch: async (texts: string[]) => {
      seen.push(...texts);
      return texts.map(() => [0, 0, 1]);
    },
  } as unknown as IEventVectorizer;
}

function event(id: string): DomainEvent {
  return {
    eventId: id,
    type: 'Probe',
    aggregateId: id,
    aggregateVersion: 1,
    correlationId: 'corr_worker_0001',
    timestamp: new Date(),
    payload: { id },
  } as unknown as DomainEvent;
}

test('a restarted worker continues after the stored cursor', async () => {
  const store = new InMemoryEventStore();
  await store.saveEvents([event('a')]);
  await store.saveEvents([event('b')]);
  await store.saveEvents([event('c')]);

  const seen: string[] = [];
  const first = new SemanticEmbeddingWorker(store, vectorizer(seen), options, quiet, store);
  assert.equal(await first.tick(), 2);
  assert.deepEqual(await store.loadConsumerCursor('semantic-embedding'), { txId: '0', gsn: 2 });

  const restarted = new SemanticEmbeddingWorker(store, vectorizer(seen), options, quiet, store);
  assert.equal(await restarted.tick(), 1);
  assert.equal(await restarted.tick(), 0);
  assert.equal(seen.length, 3, 'no event is vectorized twice');
});

test('a batch whose embeddings were not written is read again', async () => {
  const store = new InMemoryEventStore();
  await store.saveEvents([event('a')]);
  let failures = 1;
  const original = store.updateEventEmbeddings.bind(store);
  store.updateEventEmbeddings = async (updates) => {
    if (failures-- > 0) throw new Error('database went away');
    return original(updates);
  };

  const worker = new SemanticEmbeddingWorker(store, vectorizer([]), options, quiet, store);
  assert.equal(await worker.tick(), 0);
  assert.equal(await store.loadConsumerCursor('semantic-embedding'), null);
  assert.equal(await worker.tick(), 1);
  assert.deepEqual(await store.loadConsumerCursor('semantic-embedding'), { txId: '0', gsn: 1 });
});

test('a stored cursor does not move back', async () => {
  const store = new InMemoryEventStore();
  await store.saveConsumerCursor('c', { txId: '0', gsn: 5 });
  await store.saveConsumerCursor('c', { txId: '0', gsn: 3 });
  assert.deepEqual(await store.loadConsumerCursor('c'), { txId: '0', gsn: 5 });
});

test('a store without commit-order reading is not read by gsn', async () => {
  let gsnReads = 0;
  const errors: string[] = [];
  const store = {
    async getEventsByGsnRange() { gsnReads += 1; return [event('a')]; },
    async updateEventEmbeddings() { return undefined; },
  } as unknown as IEventStore;
  const logger = { info: () => undefined, error: (message: string) => { errors.push(message); } };
  const worker = new SemanticEmbeddingWorker(store, vectorizer([]), options, logger);
  await worker.start();
  assert.equal(await worker.tick(), 0);
  worker.stop();
  assert.equal(gsnReads, 0, 'a gsn cursor skips an event that commits late');
  assert.match(errors.join('\n'), /commit order/);
});

test('the worker reports the age of the oldest event it has not processed', async () => {
  const lag = getOrCreateGauge('event_consumer_lag_seconds', 'probe', ['consumer']);
  const read = async () => (await lag.get()).values.find((value) => value.labels.consumer === 'lag-probe')?.value;
  const pages: CommittedEventsPage[] = [
    { events: [], cursor: null, heldSince: new Date(Date.now() - 5_000) },
    { events: [], cursor: null },
  ];
  const store = {
    async getCommittedEventsAfter() { return pages.shift() ?? { events: [], cursor: null }; },
    async updateEventEmbeddings() { return undefined; },
  } as unknown as IEventStore;
  const worker = new SemanticEmbeddingWorker(store, vectorizer([]), { ...options, consumerName: 'lag-probe' }, quiet);

  assert.equal(await worker.tick(), 0);
  const held = await read();
  assert.ok(held !== undefined && held >= 4 && held < 60, `held lag ${held}`);
  assert.equal(await worker.tick(), 0);
  assert.equal(await read(), 0, 'nothing waits, so the lag is zero');
});
