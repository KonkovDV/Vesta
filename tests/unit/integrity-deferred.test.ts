import { test } from 'node:test';
import assert from 'node:assert/strict';
import { container } from '../../src/core/di/container';
import { DatabaseCheck } from '../../src/core/bootstrap/checks/database-check';
import { RedisCheck } from '../../src/core/bootstrap/checks/redis-check';
import { SystemIntegrityChecker } from '../../src/core/bootstrap/system-integrity-checker';

test('database and redis config without a client is deferred and startup still succeeds', async () => {
  const previousDatabase = process.env.DATABASE_URL;
  const previousRedis = process.env.REDIS_HOST;
  process.env.DATABASE_URL = 'postgres://127.0.0.1:1/none';
  process.env.REDIS_HOST = '127.0.0.1';
  try {
    assert.equal(container.isRegistered('DatabaseConnection'), false);
    assert.equal(container.isRegistered('RedisClient'), false);
    const database = await new DatabaseCheck().check();
    const redis = await new RedisCheck().check();
    assert.equal(database.passed, false);
    assert.equal(database.details?.status, 'deferred');
    assert.equal(redis.passed, false);
    assert.equal(redis.details?.status, 'deferred');

    const checker = new SystemIntegrityChecker({ debug() {}, info() {}, warn() {}, error() {} });
    checker.register(new DatabaseCheck());
    checker.register(new RedisCheck());
    const result = await checker.runAll();
    assert.equal(result.success, true);
    assert.deepEqual(result.failedCritical, []);
    assert.equal(result.checks.length, 2);
    assert.equal(result.checks.every((check) => check.deferred && !check.passed), true);
  } finally {
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
    if (previousRedis === undefined) delete process.env.REDIS_HOST;
    else process.env.REDIS_HOST = previousRedis;
  }
});
