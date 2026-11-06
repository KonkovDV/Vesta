import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLMAdapterFactoryFromEnv } from '../../src/infrastructure/factories/LLMAdapterFactory';

test('USE_MOCK_AI=true builds a factory that does not need a provider key', async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.USE_MOCK_AI = 'true';
  process.env.OPENAI_API_KEY = '';
  try {
    const factory = createLLMAdapterFactoryFromEnv();
    const { adapter, provider } = await factory.createAdapterWithFailover();
    assert.equal(provider, 'local');
    const result = await adapter.generateText('hello');
    assert.equal(result.metadata?.mock, true);
    assert.equal(result.text, '');
  } finally {
    process.env.USE_MOCK_AI = 'true';
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('without USE_MOCK_AI and without a key the factory still refuses to start', () => {
  const previousMock = process.env.USE_MOCK_AI;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.USE_MOCK_AI = 'false';
  process.env.OPENAI_API_KEY = '';
  try {
    assert.throws(() => createLLMAdapterFactoryFromEnv(), /No LLM providers configured/);
  } finally {
    if (previousMock === undefined) delete process.env.USE_MOCK_AI;
    else process.env.USE_MOCK_AI = previousMock;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
