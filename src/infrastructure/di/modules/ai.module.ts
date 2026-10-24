/**
 * AI & Research DI module.
 * Registers AI clients, research assistants and chat runtime wiring.
 * Layer: Infrastructure/DI
 */
import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { container } from '../../../core/di/container';
import { getConfig } from '../../../config';
import { createOpenAIAdapterFromEnv } from '../../ai/OpenAIAdapter';
import { AnthropicChatModel } from '../../adapters/llm/AnthropicChatModel';
import { OpenAICompatibleChatModel } from '../../adapters/llm/OpenAICompatibleChatModel';
import { PluginBasedArticleFinder } from '../../research/PluginBasedArticleFinder';
import { ArticleFinderResearchService } from '../../research/ArticleFinderResearchService';
import { LLMArticleSummarizer } from '../../research/LLMArticleSummarizer';
import { LLMTrendAnalyzer } from '../../research/LLMTrendAnalyzer';
import { RateLimiter } from '../../../core/utils/RateLimiter';
import type { ILogger } from '../../../core/decorators/ILogger';
import type { ILLMAdapterFactory } from '../../../ai/llm/interfaces/llm-adapter-factory.interface';
import type { IContextCompactor } from '../../../domain/context/context-compactor.interface';
import type { IAdaptiveMemoryRetrieval } from '../../../domain/memory/IAdaptiveMemoryRetrieval';
import type { IContextualTipGenerator } from '../../../domain/memory/IContextualTipGenerator';
import type { IHookPipeline } from '../../../domain/plugins/hook-pipeline.interface';
import type { IUnifiedPluginRegistry } from '../../../application/plugins/unified-plugin-registry';
import type { MultimodalIngestUseCase } from '../../../application/memory/multimodal-ingest.usecase';
import type { IArticleFinder, IArticleSummarizer, ITrendAnalyzer } from '../../../domain/research';
import { SINGULARITY_TOKENS } from '../../../core/singularity/tokens';
import { DirectiveParser } from '../../../application/interaction/directive-parser';

export function registerAIServices(): void {
  try {
    const config = getConfig();
    const useMockAI = config.NODE_ENV === 'test' || config.USE_MOCK_AI === 'true';

    if (useMockAI) {
      console.log('🤖 Registering MOCK AI Client (Skeleton Mode)');
      container.register(
        'IAIClient',
        () => ({
          complete: async () => ({ content: 'This is a MOCK response from Skeleton Mode.', usage: { totalTokens: 0 } }),
          embed: async () => [[0.0, 0.0, 0.0]], // Mock embedding
          isAvailable: async () => true,
        }),
        {
          lifecycle: 'singleton',
          tags: ['ai', 'mock', 'skeleton'],
          description: 'Mock AI client for tests or Skeleton Mode',
        },
      );
    } else {
      container.register(
        'IAIClient',
        () => createOpenAIAdapterFromEnv(),
        {
          lifecycle: 'singleton',
          tags: ['ai', 'external', 'openai'],
          description: 'OpenAI API client for text generation and embeddings',
          aspectOptions: {
            annotations: ['llm'],
            metadata: {
              integrationName: 'openai',
            },
          },
        },
      );
    }

    const selfLlmUrl = (config.SELF_LLM_URL || '').trim();
    const anthropicBaseUrl = (config.ANTHROPIC_BASE_URL || '').trim();
    if (useMockAI && config.NODE_ENV !== 'test') {
      // Skeleton mode stubs the agent loop's model too. Before, USE_MOCK_AI=true left
      // IChatCompletionModel to ANTHROPIC_BASE_URL / SELF_LLM_URL / provider keys, so
      // a "mock" run could call a real endpoint.
      container.register(
        DI_TOKENS.IChatCompletionModel,
        () => ({
          complete: async () => ({
            message: { role: 'assistant' as const, content: 'This is a MOCK response from Skeleton Mode.' },
            finishReason: 'stop' as const,
            usage: { inputTokens: 0, outputTokens: 0 },
            model: 'mock',
          }),
        }),
        {
          lifecycle: 'singleton',
          tags: ['ai', 'chat', 'mock', 'skeleton'],
          description: 'Mock chat completion model for Skeleton Mode',
        },
      );
    } else if (anthropicBaseUrl && config.NODE_ENV !== 'test') {
      container.register(
        DI_TOKENS.IChatCompletionModel,
        () => new AnthropicChatModel({
          apiKey: config.ANTHROPIC_API_KEY || 'session-self',
          baseURL: anthropicBaseUrl.replace(/\/+$/, ''),
          model: 'session-anthropic',
          timeoutMs: 90_000,
        }),
        {
          lifecycle: 'singleton',
          tags: ['ai', 'chat', 'anthropic', 'self'],
          description: 'Anthropic chat completion model pointed at ANTHROPIC_BASE_URL',
        },
      );
    } else if (selfLlmUrl && config.NODE_ENV !== 'test') {
      const normalizedBase = selfLlmUrl.replace(/\/+$/, '');
      const baseURL = normalizedBase.endsWith('/v1') ? normalizedBase : `${normalizedBase}/v1`;
      container.register(
        DI_TOKENS.IChatCompletionModel,
        () => new OpenAICompatibleChatModel({
          apiKey: 'session-self',
          baseURL,
          model: 'session-self',
          timeoutMs: 90_000,
        }),
        {
          lifecycle: 'singleton',
          tags: ['ai', 'chat', 'self'],
          description: 'Chat completion model backed by the local session bridge',
        },
      );
    } else if (config.OPENAI_API_KEY) {
      container.register(
        DI_TOKENS.IChatCompletionModel,
        () => new OpenAICompatibleChatModel({
          apiKey: config.OPENAI_API_KEY as string,
          baseURL: config.OPENAI_BASE_URL || 'https://api.openai.com/v1',
          model: (process.env.OPENAI_MODEL ?? '').trim() || 'gpt-4o-mini',
        }),
        {
          lifecycle: 'singleton',
          tags: ['ai', 'chat', 'openai-compatible'],
          description: 'Chat completion model with tool-role history',
        },
      );
    } else if (config.ANTHROPIC_API_KEY) {
      container.register(
        DI_TOKENS.IChatCompletionModel,
        () => new AnthropicChatModel({
          apiKey: config.ANTHROPIC_API_KEY as string,
          baseURL: 'https://api.anthropic.com',
          model: (process.env.ANTHROPIC_MODEL ?? '').trim() || 'claude-sonnet-4-5',
        }),
        {
          lifecycle: 'singleton',
          tags: ['ai', 'chat', 'anthropic'],
          description: 'Anthropic chat completion model with tool_use history',
        },
      );
    }

    container.register('OpenAIClient', () => container.resolve(DI_TOKENS.IAIClient), {
      lifecycle: 'singleton',
      tags: ['ai', 'alias'],
      description: 'Alias token for OpenAI client'
    });

    container.register('DirectiveParser', (c) => new DirectiveParser(
      c.resolve('HybridSearchService'),
      c.resolve(DI_TOKENS.ILogger)
    ), {
      lifecycle: 'singleton',
      tags: ['interaction', 'directive', 'parser'],
      description: 'Parser for slash commands (directives)'
    });

    container.register('AnthropicClient', () => ({
      isAvailable: async () => true
    }), {
      lifecycle: 'singleton',
      tags: ['ai', 'stub', 'anthropic'],
      description: 'Anthropic client stub for tests'
    });
    console.log('✓ AI services registered');
  } catch (error) {
    console.error('✗ Failed to register AI services:', error);
    throw error;
  }
}

export function registerResearchServices(): void {
  try {
    container.register<IArticleFinder>(
      'IArticleFinder',
      (c) => {
        const pluginRegistry = c.resolve<IUnifiedPluginRegistry>(DI_TOKENS.IUnifiedPluginRegistry);
        return new PluginBasedArticleFinder(pluginRegistry);
      },
      {
        lifecycle: 'singleton',
        tags: ['research', 'articles', 'finder'],
        description: 'Plugin-based article finder for research assistance',
      },
    );

    container.register<IArticleSummarizer>(
      'IArticleSummarizer',
      (c) => {
        const llmFactory = c.resolve<ILLMAdapterFactory>(DI_TOKENS.LLMAdapterFactory);
        const cfg = getConfig();

        const maxTokensRaw = cfg.LLM_RESEARCH_RATE_LIMIT_MAX_TOKENS;
        const refillRateRaw = cfg.LLM_RESEARCH_RATE_LIMIT_REFILL_RATE;

        const maxTokens =
          maxTokensRaw && maxTokensRaw.length > 0
            ? Number.parseInt(maxTokensRaw, 10)
            : 10;

        const refillRate =
          refillRateRaw && refillRateRaw.length > 0
            ? Number.parseFloat(refillRateRaw)
            : 2;

        const safeMaxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 10;
        const safeRefillRate = Number.isFinite(refillRate) && refillRate > 0 ? refillRate : 2;

        const limiter = new RateLimiter(safeMaxTokens, safeRefillRate);

        return new LLMArticleSummarizer(llmFactory, limiter);
      },
      {
        lifecycle: 'singleton',
        tags: ['research', 'articles', 'summarizer', 'llm'],
        description: 'LLM-based article summarizer with local rate limiting',
      },
    );

    container.register<ITrendAnalyzer>(
      'ITrendAnalyzer',
      (c) => {
        const llmFactory = c.resolve<ILLMAdapterFactory>(DI_TOKENS.LLMAdapterFactory);
        const cfg = getConfig();

        const maxTokensRaw = cfg.LLM_RESEARCH_RATE_LIMIT_MAX_TOKENS;
        const refillRateRaw = cfg.LLM_RESEARCH_RATE_LIMIT_REFILL_RATE;

        const maxTokens =
          maxTokensRaw && maxTokensRaw.length > 0
            ? Number.parseInt(maxTokensRaw, 10)
            : 10;

        const refillRate =
          refillRateRaw && refillRateRaw.length > 0
            ? Number.parseFloat(refillRateRaw)
            : 2;

        const safeMaxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 10;
        const safeRefillRate = Number.isFinite(refillRate) && refillRate > 0 ? refillRate : 2;

        const limiter = new RateLimiter(safeMaxTokens, safeRefillRate);

        return new LLMTrendAnalyzer(llmFactory, limiter);
      },
      {
        lifecycle: 'singleton',
        tags: ['research', 'trends', 'llm'],
        description: 'LLM-based research trends analyzer with local rate limiting',
      },
    );

    container.register(
      DI_TOKENS.IResearchService,
      (c) => new ArticleFinderResearchService(c.resolve<IArticleFinder>('IArticleFinder')),
      {
        lifecycle: 'singleton',
        tags: ['research', 'search', 'facade'],
        description: 'IResearchService facade over IArticleFinder for deep-research search',
      },
    );

    console.log('✓ Research services registered');
  } catch (error) {
    console.error('✗ Failed to register research services:', error);
    throw error;
  }
}

export function registerChatRuntime(): void {
  const cfg = getConfig();
  const env = (cfg.NODE_ENV || '').toLowerCase();
  const selfLlmUrl = (cfg.SELF_LLM_URL || '').trim();
  if (selfLlmUrl && env !== 'test') {
    const { SelfChatService } = require('../../ai/SelfChatService') as typeof import('../../ai/SelfChatService');
    container.register(
      'chatService',
      () => new SelfChatService(selfLlmUrl),
      {
        lifecycle: 'singleton',
        tags: ['application', 'service', 'chat', 'self'],
        description: 'ChatService that asks the local session model, without an external API key',
      },
    );
    console.log('[ChatRuntime] SelfChatService registered');
    return;
  }
  const flag = (cfg.CHAT_LLM_ENABLED || '').toLowerCase();
  const mode = (cfg.CHAT_LLM_MODE || '').toLowerCase();

  const enabled =
    env === 'production' &&
    (flag === 'true' || mode === 'production');

  if (!enabled) {
    return;
  }

  if (!container.isRegistered(DI_TOKENS.LLMAdapterFactory)) {
    console.warn(
      '[ChatRuntime] CHAT_LLM_ENABLED is set but llmAdapterFactory is not registered; falling back to stub ChatService',
    );
    return;
  }

  try {
    // Lazy import to avoid hard application ↔ infrastructure cycles.
     
    const { LLMBackedChatService } =
      require('../../../application/services/LLMBackedChatService') as typeof import('../../../application/services/LLMBackedChatService');

    container.register(
      'chatService',
      (c) => {
        const factory = c.resolve<ILLMAdapterFactory>(DI_TOKENS.LLMAdapterFactory);
        const ingestUseCase = c.resolve<MultimodalIngestUseCase>('MultimodalIngestUseCase');
        const contextCompactor = c.resolve<IContextCompactor>(SINGULARITY_TOKENS.CONTEXT_COMPACTOR);
        const directiveParser = c.resolve<DirectiveParser>(DI_TOKENS.DirectiveParser);
        const logger = c.isRegistered(DI_TOKENS.ILogger)
          ? c.resolve<ILogger>(DI_TOKENS.ILogger)
          : undefined;
        const adaptiveMemoryRetrieval = c.isRegistered(DI_TOKENS.IAdaptiveMemoryRetrieval)
          ? c.resolve<IAdaptiveMemoryRetrieval>(DI_TOKENS.IAdaptiveMemoryRetrieval)
          : undefined;
        const tipGenerator = c.isRegistered(DI_TOKENS.IContextualTipGenerator)
          ? c.resolve<IContextualTipGenerator>(DI_TOKENS.IContextualTipGenerator)
          : undefined;
        const hookPipeline = c.isRegistered(DI_TOKENS.IHookPipeline)
          ? c.resolve<IHookPipeline>(DI_TOKENS.IHookPipeline)
          : undefined;
        const ChatRuntimeImpl = LLMBackedChatService;
        return new ChatRuntimeImpl(
          factory,
          ingestUseCase,
          contextCompactor,
          directiveParser,
          logger,
          adaptiveMemoryRetrieval,
          tipGenerator,
          hookPipeline,
        );
      },
      {
        lifecycle: 'singleton',
        tags: ['application', 'service', 'chat', 'llm'],
        description:
          'LLM-backed ChatService resolved via LLMAdapterFactory (feature-flagged, overrides stub ChatService)',
      },
    );

    console.log('[ChatRuntime] LLMBackedChatService registered (CHAT_LLM_ENABLED=true)');
  } catch (error) {
    console.error('[ChatRuntime] Failed to register LLMBackedChatService:', error);
  }
}