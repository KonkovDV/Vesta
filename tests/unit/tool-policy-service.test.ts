import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { ToolPolicyService } from '../../src/application/security/ToolPolicyService';
import { ToolPolicyResolverImpl } from '../../src/infrastructure/security/ToolPolicyResolverImpl';
import { DIContainer } from '../../src/core/di/container';
import { applyKernelExtensions } from '../../src/kernel';

const logger = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const policy = (list?: string[]) => new ToolPolicyService(logger as never, new ToolPolicyResolverImpl(), list);

test('the contained shell tools are allowed for agent-run and need approval; reads do not', async () => {
  const service = policy();
  for (const tool of ['bash', 'python']) {
    assert.deepEqual(await service.evaluate({ toolName: tool, agentId: 'agent-run', arguments: {} }),
      { allowed: true, requiresApproval: true, approvalReason: `Tool '${tool}' has effects outside the conversation` });
  }
  assert.deepEqual(await service.evaluate({ toolName: 'read_file', agentId: 'agent-run', arguments: {} }), { allowed: true });
  assert.equal((await service.evaluate({ toolName: 'exec', agentId: 'agent-run', arguments: {} })).allowed, false, 'a tool literally named exec stays denied');
});

test('an empty approval list turns approval off', async () => {
  assert.deepEqual(await policy([]).evaluate({ toolName: 'bash', agentId: 'agent-run', arguments: {} }), { allowed: true });
});

test('a constraint can deny or ask, never allow what the kernel denies', async () => {
  const service = policy([]);
  service.addConstraint({ async evaluate(request) { return request.toolName === 'read_file' ? { allowed: true, requiresApproval: true, approvalReason: 'case data' } : { allowed: true }; } });
  service.addConstraint({ async evaluate(request) { return request.toolName === 'search_text' ? { allowed: false, reason: 'not in this product' } : { allowed: true }; } });
  service.addConstraint({ async evaluate() { return { allowed: true }; } });
  assert.deepEqual(await service.evaluate({ toolName: 'read_file', agentId: 'agent-run', arguments: {} }), { allowed: true, requiresApproval: true, approvalReason: 'case data' });
  assert.equal((await service.evaluate({ toolName: 'search_text', agentId: 'agent-run', arguments: {} })).allowed, false);
  assert.equal((await service.evaluate({ toolName: 'fs_write_file', agentId: 'agent-run', arguments: {} })).allowed, false, 'coding profile does not allow it; a permissive constraint cannot change that');
});

test('KernelExtension.toolPolicy is added to the kernel policy as a constraint', async () => {
  const container = new DIContainer();
  const service = policy([]);
  container.register('IToolExecutionPolicy', () => service);
  await applyKernelExtensions(container, [{
    name: 'cases',
    toolPolicy: { async evaluate(request) { return request.toolName === 'read_file' ? { allowed: true, requiresApproval: true } : { allowed: true }; } },
  }]);
  assert.equal((await service.evaluate({ toolName: 'read_file', agentId: 'agent-run', arguments: {} })).requiresApproval, true);
});
