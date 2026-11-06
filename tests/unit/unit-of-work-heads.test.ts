import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidedJournalHeads } from '../../src/infrastructure/database/PostgresUnitOfWork';
import type { DomainEvent } from '../../src/domain/events/event-store.interface';

const event = (aggregateId: string, aggregateVersion: number) => ({ aggregateId, aggregateVersion }) as DomainEvent;

test('a run of decided versions names the head it was decided on; 0 or a gap leaves the aggregate unchecked', () => {
  assert.deepEqual(decidedJournalHeads([
    event('a', 4), event('b', 1), event('a', 5),
    event('any', 0), event('any', 0),
    event('gap', 2), event('gap', 4),
    event('mixed', 3), event('mixed', 0),
  ]), { a: 3, b: 0 });
  assert.deepEqual(decidedJournalHeads([]), {});
});
