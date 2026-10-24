import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicMessages } from '../../src/infrastructure/adapters/llm/AnthropicChatModel';
import type { ChatMessage } from '../../src/domain/ai/IChatCompletionModel';

const conversation: ChatMessage[] = [
  { role: 'system', content: 'stable rules' },
  { role: 'user', content: 'do it' },
  { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read', argumentsJson: '{"path":"/a"}' }, { id: 't2', name: 'read', argumentsJson: '{broken' }] },
  { role: 'tool', toolCallId: 't1', content: 'one' },
  { role: 'tool', toolCallId: 't2', content: 'two' },
  { role: 'system', content: 'function_results index step 2' },
];

test('a late system message does not change the cached system prefix', () => {
  const step2 = toAnthropicMessages(conversation);
  const step3 = toAnthropicMessages([...conversation.slice(0, -1), { role: 'system', content: 'function_results index step 3' }]);
  assert.deepEqual(step2.system, step3.system);
  assert.equal(step2.system?.[0].text, 'stable rules');
  assert.deepEqual(step2.system?.[0].cache_control, { type: 'ephemeral' });
});

test('the catalog rides on the last user turn after the tool results, and that block is the cache breakpoint', () => {
  const { messages } = toAnthropicMessages(conversation);
  const last = messages.at(-1)!;
  assert.equal(last.role, 'user');
  const blocks = last.content as Array<{ type: string; text?: string; cache_control?: unknown }>;
  assert.deepEqual(blocks.map((block) => block.type), ['tool_result', 'tool_result', 'text']);
  assert.match(blocks[2].text ?? '', /function_results index step 2/);
  assert.deepEqual(blocks[2].cache_control, { type: 'ephemeral' });
});

test('malformed tool arguments in history do not throw', () => {
  const { messages } = toAnthropicMessages(conversation);
  const assistant = messages[1].content as Array<{ type: string; input?: unknown }>;
  assert.deepEqual(assistant[1].input, { invalid_json: '{broken' });
});
