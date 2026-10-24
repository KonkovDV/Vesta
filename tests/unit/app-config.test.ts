import { test } from 'node:test';
import assert from 'node:assert/strict';

test('readInt honours REDIS_PORT and REDIS_DB after the schema coerced them to numbers', async () => {
  process.env.REDIS_PORT = '56379';
  process.env.REDIS_DB = '3';
  const { readInt, readStr } = await import('../../src/core/config/app-config');
  assert.equal(readInt('REDIS_PORT', 6379), 56379);
  assert.equal(readInt('REDIS_DB', 0), 3);
  assert.equal(readStr('REDIS_PORT'), '56379');
});

test('getConfig caches outside tests and reloadConfig drops the cache', async () => {
  const { getConfig, reloadConfig } = await import('../../src/config');
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    reloadConfig();
    const first = getConfig();
    assert.equal(getConfig(), first);
    reloadConfig();
    assert.notEqual(getConfig(), first);
  } finally {
    process.env.NODE_ENV = previous;
    reloadConfig();
  }
});
