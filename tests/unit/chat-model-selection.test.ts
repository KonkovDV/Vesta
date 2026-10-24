import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAiCompatibleBase, selectChatModel } from '../../src/infrastructure/adapters/llm/select-chat-model';

test('a local OpenAI-compatible URL gets /v1 and the configured model name', () => {
  const choice = selectChatModel({
    NODE_ENV: 'development',
    USE_MOCK_AI: 'false',
    SELF_LLM_URL: 'http://127.0.0.1:11434/',
    SELF_LLM_MODEL: 'qwen1650',
  });
  assert.equal(choice.kind, 'openai-compatible');
  if (choice.kind !== 'openai-compatible') return;
  assert.equal(choice.baseURL, 'http://127.0.0.1:11434/v1');
  assert.equal(choice.model, 'qwen1650');
  assert.equal(choice.timeoutMs, 180_000);
});

test('an empty local model name is refused', () => {
  assert.throws(
    () => selectChatModel({ NODE_ENV: 'development', SELF_LLM_URL: 'http://127.0.0.1:11434', SELF_LLM_MODEL: ' ' }),
    /SELF_LLM_MODEL/,
  );
});

test('mock mode does not select the local server', () => {
  assert.equal(selectChatModel({
    NODE_ENV: 'development',
    USE_MOCK_AI: 'true',
    SELF_LLM_URL: 'http://127.0.0.1:11434',
    SELF_LLM_MODEL: 'qwen1650',
  }).kind, 'mock');
});

test('unit tests do not select a live model from SELF_LLM_URL', () => {
  assert.equal(selectChatModel({
    NODE_ENV: 'test',
    USE_MOCK_AI: 'true',
    SELF_LLM_URL: 'http://127.0.0.1:11434',
    SELF_LLM_MODEL: 'qwen1650',
  }).kind, 'unset');
});

test('/v1 is not appended twice', () => {
  assert.equal(openAiCompatibleBase('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1');
});
