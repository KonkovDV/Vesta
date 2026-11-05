/**
 * T2.3 step 1: a typed token is the same string at run time, so typed and string
 * calls share one registration, and an extension cannot use provide() to replace a
 * kernel token any more than register() (C9).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIContainer } from '../../src/core/di/container';
import { createToken } from '../../src/core/di/injection-token';
import { KernelTokens } from '../../src/kernel-tokens';
import { DI_TOKENS } from '../../src/core/di/DI_TOKENS';
import { createExtensionContainer, KernelExtensionError } from '../../src/kernel';

interface Clock {
  now(): number;
}

test('a typed token and its string name are one registration', () => {
  const container = new DIContainer();
  const CLOCK = createToken<Clock>('TestClock');
  assert.equal(CLOCK, 'TestClock');
  container.provide(CLOCK, () => ({ now: () => 42 }), 'singleton');
  assert.equal(container.inject(CLOCK).now(), 42);
  assert.equal(container.resolve<Clock>('TestClock'), container.inject(CLOCK));
  assert.throws(() => createToken<Clock>(' '), /non-empty name/);
});

test('kernel tokens name the strings the kernel registers', () => {
  for (const [name, token] of Object.entries(KernelTokens)) {
    assert.equal(token, (DI_TOKENS as Record<string, string>)[name], name);
  }
});

test('an extension cannot replace a kernel token through provide()', () => {
  const container = new DIContainer();
  container.register(DI_TOKENS.IToolExecutionPolicy, () => ({ evaluate: async () => ({ allowed: true }) }));
  const guarded = createExtensionContainer(container, 'probe');
  assert.throws(
    () => guarded.provide(KernelTokens.IToolExecutionPolicy, () => ({ evaluate: async () => ({ allowed: true }) }) as never),
    (error: unknown) => error instanceof KernelExtensionError && /cannot replace/.test(error.message),
  );
  const OWN = createToken<Clock>('ProbeOwnClock');
  guarded.provide(OWN, () => ({ now: () => 7 }));
  assert.equal(container.inject(OWN).now(), 7, 'a new token of the extension is accepted');
});
