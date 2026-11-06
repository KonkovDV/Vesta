/**
 * MP-K47: pg-pool resolves end() as soon as no client is listed, while each removed
 * client is still closing its socket. A server error in that window, such as an
 * administrator terminating the backend, is emitted on the pool. The kernel removed
 * its pool 'error' listener before end(), so that error became an uncaught exception.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PostgresAdapter } from '../../src/infrastructure/database/PostgresAdapter';
import { PostgreSQLOutbox } from '../../src/infrastructure/events/postgres-outbox';
import { createPostgreSQLEventStore } from '../../src/infrastructure/events/postgres-event-store';
import { PostgresMasExecutionStore } from '../../src/infrastructure/mas/PostgresMasExecutionStore';

/** Ends like pg-pool 3.10: end() resolves first, the sockets close a little later. */
class ClosingPool extends EventEmitter {
  totalCount = 2;
  ended = false;
  async end(): Promise<void> {
    this.ended = true;
    setTimeout(() => {
      this.emit('error', new Error('terminating connection due to administrator command'));
      this.totalCount = 0;
      this.emit('remove', {});
      this.emit('remove', {});
    }, 5);
  }
}

const unused = 'postgresql://user:pass@127.0.0.1:1/unused';

const owners: Array<[string, () => { close(): Promise<void> }]> = [
  ['PostgresAdapter', () => new PostgresAdapter({ connectionString: unused })],
  ['PostgreSQLOutbox', () => new PostgreSQLOutbox({ connection: { connectionString: unused } } as never, undefined, undefined as never)],
  ['PostgresEventStore', () => createPostgreSQLEventStore({ connection: { connectionString: unused } }) as unknown as { close(): Promise<void> }],
  ['PostgresMasExecutionStore', () => new PostgresMasExecutionStore({ connection: { connectionString: unused } })],
];

for (const [name, create] of owners) {
  test(`${name}.close() survives an error while its clients close and waits for them`, async () => {
    const owner = create();
    const original = (owner as unknown as { pool: { end(): Promise<void> } }).pool;
    await original.end();
    const pool = new ClosingPool();
    (owner as unknown as { pool: ClosingPool }).pool = pool;

    let removed = 0;
    pool.on('remove', () => { removed += 1; });
    await owner.close();
    assert.equal(pool.ended, true);
    assert.equal(removed, 2, 'close() returns after every client socket closed');
  });
}
