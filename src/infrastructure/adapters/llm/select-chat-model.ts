/**
 * Chooses the agent-loop chat model from configuration.
 * Layer: Infrastructure
 */

export interface ChatModelConfig {
  NODE_ENV?: string;
  USE_MOCK_AI?: string;
  SELF_LLM_URL?: string;
  SELF_LLM_MODEL?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  OPENAI_DEFAULT_MODEL?: string;
}

export type ChatModelChoice =
  | { kind: 'mock' }
  | { kind: 'anthropic'; apiKey: string; baseURL: string; model: string; timeoutMs: number }
  | { kind: 'openai-compatible'; apiKey: string; baseURL: string; model: string; timeoutMs: number }
  | { kind: 'unset' };

/** OpenAI-compatible servers mount chat completions under /v1. */
export function openAiCompatibleBase(url: string): string {
  const normalized = url.trim().replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

export function selectChatModel(config: ChatModelConfig): ChatModelChoice {
  const nodeEnv = config.NODE_ENV ?? '';
  const mockRequested = nodeEnv === 'test' || config.USE_MOCK_AI === 'true';
  if (mockRequested && nodeEnv !== 'test') {
    return { kind: 'mock' };
  }

  const anthropicBase = (config.ANTHROPIC_BASE_URL ?? '').trim();
  if (anthropicBase && nodeEnv !== 'test') {
    return {
      kind: 'anthropic',
      apiKey: config.ANTHROPIC_API_KEY || 'session-self',
      baseURL: anthropicBase.replace(/\/+$/, ''),
      model: (config.ANTHROPIC_MODEL ?? '').trim() || 'session-anthropic',
      timeoutMs: 90_000,
    };
  }

  const selfUrl = (config.SELF_LLM_URL ?? '').trim();
  if (selfUrl && nodeEnv !== 'test') {
    const model = (config.SELF_LLM_MODEL ?? '').trim();
    if (!model) {
      throw new Error('SELF_LLM_URL is set and SELF_LLM_MODEL is empty');
    }
    return {
      kind: 'openai-compatible',
      apiKey: 'local',
      baseURL: openAiCompatibleBase(selfUrl),
      model,
      timeoutMs: 180_000,
    };
  }

  const openaiKey = (config.OPENAI_API_KEY ?? '').trim();
  if (openaiKey) {
    const model = (config.OPENAI_DEFAULT_MODEL ?? '').trim()
      || (config.OPENAI_MODEL ?? '').trim()
      || 'gpt-4o-mini';
    return {
      kind: 'openai-compatible',
      apiKey: openaiKey,
      baseURL: openAiCompatibleBase(config.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
      model,
      timeoutMs: 30_000,
    };
  }

  const anthropicKey = (config.ANTHROPIC_API_KEY ?? '').trim();
  if (anthropicKey) {
    return {
      kind: 'anthropic',
      apiKey: anthropicKey,
      baseURL: 'https://api.anthropic.com',
      model: (config.ANTHROPIC_MODEL ?? '').trim() || 'claude-sonnet-4-5',
      timeoutMs: 90_000,
    };
  }

  return { kind: 'unset' };
}
