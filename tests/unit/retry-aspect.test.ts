import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIContainer } from '../../src/core/di/container';
import { AspectManager } from '../../src/core/aop/AspectManager';
import { RetryAspect, isTransientError } from '../../src/core/aop/RetryAspect';
import aspectConfig from '../../src/core/aop/aspect-config';

function withRetry(): DIContainer {
  const container = new DIContainer();
  container.register('RetryAspect', () => new RetryAspect({ attempts: 3, delayMs: 1 }), 'transient');
  const manager = new AspectManager(container);
  const retry = aspectConfig.aspects.find((aspect) => aspect.name === 'retry');
  assert.ok(retry);
  manager.registerAspect(retry);
  container.setAspectManager(manager);
  return container;
}

test('a write on an *Adapter is not repeated after a network error', async () => {
  const container = withRetry();
  let effects = 0;
  class DemoSettlementAdapter {
    async settle(): Promise<void> {
      effects += 1;
      throw Object.assign(new Error('socket hang up after the remote accepted'), { code: 'ECONNRESET' });
    }
  }
  container.register('Pay', () => new DemoSettlementAdapter());
  await assert.rejects(container.resolve<DemoSettlementAdapter>('Pay').settle());
  assert.equal(effects, 1);
});

test('a read on an *Adapter is repeated after a transient error, not after a logic error', async () => {
  const container = withRetry();
  let calls = 0;
  class DemoLookupAdapter {
    async getRate(kind: string): Promise<number> {
      calls += 1;
      if (kind === 'bad') throw new Error('validation failed');
      if (calls < 3) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      return 42;
    }
  }
  container.register('Lookup', () => new DemoLookupAdapter());
  assert.equal(await container.resolve<DemoLookupAdapter>('Lookup').getRate('ok'), 42);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(container.resolve<DemoLookupAdapter>('Lookup').getRate('bad'), /validation/);
  assert.equal(calls, 1);
});

test('AuthService is outside the retry pointcut', () => {
  const retry = aspectConfig.aspects.find((aspect) => aspect.name === 'retry');
  const classes = (retry?.pointcut as { classes: string[] }).classes;
  assert.equal(classes.includes('AuthService'), false);
});

test('isTransientError reads code, status, retryable and cause', () => {
  assert.equal(isTransientError({ code: '40001' }), true);
  assert.equal(isTransientError({ status: 503 }), true);
  assert.equal(isTransientError({ status: 400 }), false);
  assert.equal(isTransientError(new Error('x', { cause: { code: 'ECONNRESET' } })), true);
  assert.equal(isTransientError({ code: 'ECONNRESET', retryable: false }), false);
});

test('checkLimit-style methods that consume are not repeated', async () => {
  const container = withRetry();
  let consumed = 0;
  class DemoLimiterAdapter {
    async checkLimit(): Promise<boolean> {
      consumed += 1;
      throw Object.assign(new Error('redis timeout'), { code: 'ETIMEDOUT' });
    }
    async getaway(): Promise<void> {
      consumed += 1;
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    }
  }
  container.register('Limiter', () => new DemoLimiterAdapter());
  await assert.rejects(container.resolve<DemoLimiterAdapter>('Limiter').checkLimit());
  assert.equal(consumed, 1);
  consumed = 0;
  await assert.rejects(container.resolve<DemoLimiterAdapter>('Limiter').getaway());
  assert.equal(consumed, 1, 'getaway is not a get* method');
});
