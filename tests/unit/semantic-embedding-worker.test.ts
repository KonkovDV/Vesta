/**
 * The embedding worker follows a commit-order cursor and keeps it across restarts (MP-K23).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventStore } from '../../src/infrastructure/events/InMemoryEventStore';
import { SemanticEmbeddingWorker } from '../../src/application/workers/SemanticEmbeddingWorker';
import type { DomainEvent } from '../../src/domain/events/event-store.interface';
import type { IEventVectorizer } from '../../src/domain/memory/IEventVectorizer';

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
