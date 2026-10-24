import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIContainer } from '../../src/core/di/container';
import { applyKernelExtensions, KernelExtensionError, KernelStartError } from '../../src/kernel';

function kernelContainer(): DIContainer {
  const container = new DIContainer();
  // The global container allows overrides; the guard must not depend on that flag.
  container.setAllowOverrides(true);
  container.register('IToolExecutionPolicy', () => ({ decision: 'kernel' }), { lifecycle: 'singleton' });
  return container;
}

test('an extension cannot replace a kernel token even when overrides are allowed', async () => {
  const container = kernelContainer();
  await assert.rejects(
    applyKernelExtensions(container, [{
      name: 'evil',
      register(c) { c.register('IToolExecutionPolicy', () => ({ decision: 'extension' })); },
    }]),
    KernelExtensionError,
  );
  assert.deepEqual(container.resolve('IToolExecutionPolicy'), { decision: 'kernel' });
});

test('an extension cannot unregister or toggle overrides', async () => {
  for (const method of ['unregister', 'setAllowOverrides', 'clear', 'dispose', 'setAspectManager'] as const) {
    const container = kernelContainer();
    await assert.rejects(
      applyKernelExtensions(container, [{
        name: `evil-${method}`,
        register(c) { (c as unknown as Record<string, (arg?: unknown) => void>)[method]('IToolExecutionPolicy'); },
      }]),
      KernelExtensionError,
      method,
    );
    assert.deepEqual(container.resolve('IToolExecutionPolicy'), { decision: 'kernel' });
  }
});

test('a factory receives the guarded view, not the raw container', async () => {
  const container = kernelContainer();
  await applyKernelExtensions(container, [{
    name: 'lazy',
    register(c) { c.register('LazyThing', (inner) => { inner.unregister('IToolExecutionPolicy'); return 1; }); },
  }]);
  assert.throws(() => container.resolve('LazyThing'), KernelExtensionError);
  assert.deepEqual(container.resolve('IToolExecutionPolicy'), { decision: 'kernel' });
});

test('new tokens register and resolve; two extensions cannot claim the same token', async () => {
  const container = kernelContainer();
  await applyKernelExtensions(container, [{
    name: 'cases',
    register(c) { c.register('CaseRepository', () => ({ ready: true })); },
  }]);
  assert.deepEqual(container.resolve('CaseRepository'), { ready: true });
  await assert.rejects(
    applyKernelExtensions(container, [{ name: 'other', register(c) { c.register('CaseRepository', () => 2); } }]),
    KernelExtensionError,
  );
});

test('extension names are compared after trimming', async () => {
  await assert.rejects(applyKernelExtensions(kernelContainer(), [{ name: ' x ' }, { name: 'x' }]), /listed twice/);
  await assert.rejects(applyKernelExtensions(kernelContainer(), [{ name: '   ' }]), /name is empty/);
});

test('KernelStartError keeps the original error as cause', () => {
  const original = new Error('pg down');
  const wrapped = new KernelStartError('pg down', { cause: original });
  assert.equal(wrapped.cause, original);
});
