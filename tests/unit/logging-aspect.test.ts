import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoggingAspect } from '../../src/core/aop/LoggingAspect';

function recorder() {
  const lines: Array<[string, string]> = [];
  const logger = Object.fromEntries(['log', 'info', 'debug', 'warn', 'error'].map((level) => [level, (message: string) => lines.push([level, message])]));
  return { lines, logger };
}

function context(proceed: () => Promise<unknown>) {
  return {
    target: {}, methodName: 'authenticateRequest', args: [], metadata: {}, container: {},
    joinPoint: { className: 'AuthService', methodName: 'authenticateRequest' },
    setAttribute() {}, getAttribute() { return undefined; }, proceed, proceedOriginal: proceed,
  } as never;
}

test('calls log at debug; a 4xx failure is a warning, a fault is an error', async () => {
  const { lines, logger } = recorder();
  const aspect = new LoggingAspect(logger as never);
  await aspect.around(context(async () => 'ok'));
  assert.deepEqual(lines.map(([level]) => level), ['debug', 'debug']);

  lines.length = 0;
  await assert.rejects(aspect.around(context(async () => { throw Object.assign(new Error('API token is required'), { status: 401 }); })));
  assert.deepEqual(lines.map(([level]) => level), ['debug', 'warn']);

  lines.length = 0;
  await assert.rejects(aspect.around(context(async () => { throw new Error('pool exhausted'); })));
  assert.deepEqual(lines.map(([level]) => level), ['debug', 'error']);
});
