/**
 * LLMAdapterFactory - фабрика для создания LLM адаптеров
 * Layer: Infrastructure
 * 
 * Предоставляет единую точку создания адаптеров для различных LLM провайдеров.
 * Поддерживает OpenAI, Anthropic, Local models и другие провайдеры.
 */

import {
  ILLMAdapter,
  LLMAdapterError,
  BaseLLMAdapter,
  LLMGenerateOptions,
  LLMGenerationResult,
  LLMEmbeddingOptions,
  LLMEmbeddingResult,
  LLMModerationOptions,
  LLMModerationResult,
  LLMModelInfo,
  LLMMultimodalGenerateOptions,
  LLMStreamCallback,
} from '../../domain/ai/ILLMAdapter';
import { MultimodalChatMessage, MultimodalContentType } from '../../core/llm/multimodal-types';
import {
  OpenAILLMAdapter,
  OpenAILLMAdapterConfig,
} from '../adapters/OpenAILLMAdapter';
import { getConfig } from '../../config';
import { safeParseInt } from '../../core/config/safe-parse';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';

/**
 * Типы поддерживаемых провайдеров
 */
export type LLMProviderType = 'openai' | 'anthropic' | 'local' | 'custom';

/**
 * Возможности LLM-провайдера (минимальный набор).
 */
export type LLMProviderCapabilities = {
  supportsMultimodal?: boolean;
  supportedModalities?: MultimodalContentType[];
  maxImagesPerRequest?: number;
};

/**
 * Конфигурация для разных провайдеров
 */
export interface LLMProviderConfig {
  /** Тип провайдера */
  type: LLMProviderType;
  
  /** Конфигурация провайдера */
  config: Record<string, unknown>;
  
  /** Приоритет провайдера (чем выше, тем приоритетнее) */
  priority?: number;

  /** Метаданные о возможностях провайдера */
  capabilities?: LLMProviderCapabilities;
  
  /** Таймаут в миллисекундах */
  timeoutMs?: number;
  
  /** Максимальное количество ретраев */
  maxRetries?: number;
}

/**
 * Конфигурация фабрики
 */
export interface LLMAdapterFactoryConfig {
  /** Список провайдеров в порядке приоритета */
  providers: LLMProviderConfig[];
  
  /** Провайдер по умолчанию */
  defaultProvider?: LLMProviderType;
  
  /** Включить failover между провайдерами */
  enableFailover?: boolean;
  
  /** Максимальное количество попыток failover */
  maxFailoverAttempts?: number;
}

/**
 * Результат создания адаптера
 */
export interface AdapterCreationResult {
  /** Созданный адаптер */
  adapter: ILLMAdapter;
  
  /** Тип провайдера */
  providerType: LLMProviderType;
  
  /** Конфигурация провайдера */
  providerConfig: LLMProviderConfig;
}

/**
 * LLMAdapterFactory - фабрика для создания адаптеров
 */
export class LLMAdapterFactory {
  private adapters = new Map<LLMProviderType, ILLMAdapter>();
  private config: LLMAdapterFactoryConfig;

  private readonly logger?: IStructuredLogger;

  private constructor(config: LLMAdapterFactoryConfig, logger?: IStructuredLogger) {
    this.config = {
      enableFailover: true,
      maxFailoverAttempts: 3,
      ...config,
    };
    this.logger = logger;
  }

  /**
   * Создать фабрику с конфигурацией.
   * Инстанс создаётся через DI-токен 'LLMAdapterFactory' и не должен быть резолвится вручную.
   */
  static create(config: LLMAdapterFactoryConfig, logger?: IStructuredLogger): LLMAdapterFactory {
    return new LLMAdapterFactory(config, logger);
  }

  /**
   * Создать адаптер для провайдера
   */
  createAdapter(providerType: LLMProviderType, config?: LLMProviderConfig): ILLMAdapter {
    // Проверяем кэш
    const existingAdapter = this.adapters.get(providerType);
    if (existingAdapter) {
      return existingAdapter;
    }

    // Если конфиг не передан, пытаемся найти его в настройках фабрики
    if (!config) {
      config = this.getProviderConfig(providerType);
    }

    let adapter: ILLMAdapter;

    switch (providerType) {
      case 'openai':
        adapter = this.createOpenAIAdapter(config);
        break;
      
      case 'anthropic':
        adapter = this.createAnthropicAdapter(config);
        break;
      
      case 'local':
        adapter = this.createLocalAdapter(config);
        break;
      
      case 'custom':
        adapter = this.createCustomAdapter(config);
        break;
      
      default:
        throw new LLMAdapterError(
          'Unsupported provider type',
          providerType,
          'create_adapter'
        );
    }

    // Кэшируем адаптер
    this.adapters.set(providerType, adapter);
    return adapter;
  }

  /**
   * Создать адаптер по умолчанию
   */
  createDefaultAdapter(): ILLMAdapter {
    const defaultProvider = this.config.defaultProvider || 'openai';
    return this.createAdapter(defaultProvider);
  }

  /**
   * Создать адаптер с failover логикой
   */
  async createAdapterWithFailover(
    preferredProvider?: LLMProviderType,
    options?: LLMMultimodalGenerateOptions
  ): Promise<{ adapter: ILLMAdapter; provider: LLMProviderType }> {
    const providersInPriorityOrder = this.getProvidersInOrder(preferredProvider);
    let providersToTry = providersInPriorityOrder;

    const expectedModalities = options?.expectedModality;
    if (expectedModalities && expectedModalities.length > 0) {
      const expectedSet = new Set<MultimodalContentType>(expectedModalities);
      const multimodalCandidates: LLMProviderConfig[] = [];
      const fallbackCandidates: LLMProviderConfig[] = [];

      for (const provider of providersInPriorityOrder) {
        const caps = provider.capabilities;
        const supportsExpected =
          !!caps?.supportsMultimodal &&
          !!caps.supportedModalities &&
          caps.supportedModalities.some(modality => expectedSet.has(modality));

        if (supportsExpected) {
          multimodalCandidates.push(provider);
        } else {
          fallbackCandidates.push(provider);
        }
      }

      if (multimodalCandidates.length > 0) {
        providersToTry = [...multimodalCandidates, ...fallbackCandidates];
      }
    }
    
    for (const providerConfig of providersToTry) {
      try {
        const adapter = this.createAdapter(providerConfig.type, providerConfig);
        
        // Проверяем доступность провайдера
        if (await adapter.isAvailable()) {
          return {
            adapter,
            provider: providerConfig.type,
          };
        }
      } catch (error) {
        this.logger?.warn(`Failed to create adapter for provider ${providerConfig.type}:`, { error: String(error) });
        continue;
      }
    }

    throw new LLMAdapterError(
      'No available LLM providers found',
      'unknown',
      'create_adapter_with_failover'
    );
  }

  /**
   * Получить список провайдеров в порядке приоритета
   */
  private getProvidersInOrder(preferred?: LLMProviderType): LLMProviderConfig[] {
    const allProviders = [...this.config.providers];
    
    // Если указан предпочтительный провайдер, ставим его первым
    if (preferred) {
      allProviders.sort((a, b) => {
        if (a.type === preferred) return -1;
        if (b.type === preferred) return 1;
        return (b.priority || 0) - (a.priority || 0);
      });
    } else {
      // Сортируем по приоритету
      allProviders.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }
    
    return allProviders;
  }

  /**
   * Создать OpenAI адаптер
   */
  private createOpenAIAdapter(config?: LLMProviderConfig): ILLMAdapter {
    const openaiConfig = (config?.config || {}) as Partial<OpenAILLMAdapterConfig>;
    const appConfig = getConfig();
    const envApiKey = appConfig.OPENAI_API_KEY;

    if (!openaiConfig?.apiKey && (!envApiKey || envApiKey.length === 0)) {
      throw new LLMAdapterError(
        'OpenAI API key is required',
        'openai',
        'create_adapter',
      );
    }

    const timeoutFromConfig =
      config?.timeoutMs ??
      openaiConfig?.timeoutMs ??
      safeParseInt(appConfig.OPENAI_TIMEOUT_MS, undefined);

    const maxRetriesFromConfig =
      config?.maxRetries ??
      openaiConfig?.maxRetries ??
      safeParseInt(appConfig.OPENAI_MAX_RETRIES, undefined);

    return new OpenAILLMAdapter({
      apiKey: openaiConfig?.apiKey ?? envApiKey ?? '',
      organization: openaiConfig?.organization ?? appConfig.OPENAI_ORG_ID,
      baseURL: openaiConfig?.baseURL ?? appConfig.OPENAI_BASE_URL,
      timeoutMs: timeoutFromConfig,
      maxRetries: maxRetriesFromConfig,
      defaultModel: openaiConfig?.defaultModel ?? appConfig.OPENAI_DEFAULT_MODEL,
      defaultEmbeddingModel:
        openaiConfig?.defaultEmbeddingModel ?? appConfig.OPENAI_DEFAULT_EMBEDDING_MODEL,
      defaultModerationModel:
        openaiConfig?.defaultModerationModel ?? appConfig.OPENAI_DEFAULT_MODERATION_MODEL,
    });
  }

  /**
   * Создать Anthropic адаптер (заглушка)
   */
  private createAnthropicAdapter(config?: LLMProviderConfig): ILLMAdapter {
    const providerConfig = (config?.config || {});
    const appConfig = getConfig();
    const envApiKey = appConfig.ANTHROPIC_API_KEY;

    const hasApiKey = Boolean(
      (providerConfig['apiKey'] as string | undefined) || envApiKey,
    );

    if (!hasApiKey) {
      throw new LLMAdapterError(
        'Anthropic provider requires ANTHROPIC_API_KEY (env or config.apiKey).',
        'anthropic',
        'create_adapter',
      );
    }

    return new UnavailableLLMAdapter(
      'anthropic',
      'Anthropic адаптер пока не реализован. Используйте failover-провайдер.',
    );
  }

  /**
   * Создать локальный адаптер (заглушка)
   */
  private createLocalAdapter(config?: LLMProviderConfig): ILLMAdapter {
    const providerConfig = (config?.config || {});
    const modelPath = (
      (providerConfig['modelPath'] as string | undefined) ||
      (providerConfig['binaryPath'] as string | undefined)
    );

    if (!modelPath) {
      throw new LLMAdapterError(
        'Local adapter requires either modelPath or binaryPath in config.',
        'local',
        'create_adapter'
      );
    }

    return new UnavailableLLMAdapter(
      'local',
      `Local поддержка placeholder; указан путь ${modelPath}.`
    );
  }

  /**
   * Создать кастомный адаптер (заглушка)
   */
  private createCustomAdapter(config?: LLMProviderConfig): ILLMAdapter {
    const providerConfig = (config?.config || {});

    if (Object.keys(providerConfig).length === 0) {
      throw new LLMAdapterError(
        'Custom adapter requires provider-specific configuration.',
        'custom',
        'create_adapter'
      );
    }

    const label = (
      (providerConfig['adapterName'] as string | undefined) ||
      (providerConfig['name'] as string | undefined) ||
      'custom'
    );

    return new UnavailableLLMAdapter(
      'custom',
      `Кастомный адаптер "${label}" поставляется как заглушка.`
    );
  }

  /**
   * Получить все доступные провайдеры
   */
  getAvailableProviders(): LLMProviderType[] {
    return this.config.providers.map(p => p.type);
  }

  /**
   * Проверить поддержку провайдера
   */
  isProviderSupported(providerType: LLMProviderType): boolean {
    return this.config.providers.some(p => p.type === providerType);
  }

  /**
   * Получить конфигурацию провайдера
   */
  getProviderConfig(providerType: LLMProviderType): LLMProviderConfig | undefined {
    return this.config.providers.find(p => p.type === providerType);
  }

  /**
   * Добавить провайдер в runtime
   */
  addProvider(config: LLMProviderConfig): void {
    const existingIndex = this.config.providers.findIndex(p => p.type === config.type);
    
    if (existingIndex >= 0) {
      // Обновляем существующий
      this.config.providers[existingIndex] = config;
    } else {
      // Добавляем новый
      this.config.providers.push(config);
    }
    
    // Удаляем кэшированный адаптер
    this.adapters.delete(config.type);
  }

  /**
   * Удалить провайдер
   */
  removeProvider(providerType: LLMProviderType): boolean {
    const index = this.config.providers.findIndex(p => p.type === providerType);
    
    if (index >= 0) {
      this.config.providers.splice(index, 1);
      this.adapters.delete(providerType);
      return true;
    }
    
    return false;
  }

  /**
   * Очистить кэш адаптеров
   */
  clearCache(): void {
    this.adapters.clear();
  }
}

/**
 * Заглушка для провайдеров, которые пока не интегрированы.
 */
class UnavailableLLMAdapter extends BaseLLMAdapter {
  constructor(
    private readonly providerType: LLMProviderType,
    private readonly reason: string,
    private readonly available = false
  ) {
    super();
  }

  private fail(operation: string): never {
    throw new LLMAdapterError(
      `LLM провайдер "${this.providerType}" пока не поддерживается: ${this.reason}`,
      this.providerType,
      operation
    );
  }

  async generateText(prompt: string, options?: LLMGenerateOptions): Promise<LLMGenerationResult> {
    return this.fail('generate_text');
  }

  async generateTextStream(
    prompt: string,
    callback: LLMStreamCallback,
    options?: LLMGenerateOptions
  ): Promise<LLMGenerationResult> {
    return this.fail('generate_text_stream');
  }

  async generateMultimodalChat(
    messages: MultimodalChatMessage[],
    options?: LLMMultimodalGenerateOptions
  ): Promise<LLMGenerationResult> {
    return this.fail('generate_multimodal_chat');
  }
 
  async generateEmbeddings(texts: string[], options?: LLMEmbeddingOptions): Promise<LLMEmbeddingResult> {
    return this.fail('generate_embeddings');
  }

  async moderateContent(content: string, options?: LLMModerationOptions): Promise<LLMModerationResult> {
    return this.fail('moderate_content');
  }

  async getAvailableModels(): Promise<LLMModelInfo[]> {
    return [];
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  getProviderInfo() {
    return {
      name: this.providerType,
      version: '0.0.1',
      capabilities: [],
    };
  }
}

/**
 * Фабричная функция для создания фабрики из конфигурации приложения
 */
export function createLLMAdapterFactoryFromEnv(): LLMAdapterFactory {
  const providers: LLMProviderConfig[] = [];
  const config = getConfig();

  const openaiApiKey = config.OPENAI_API_KEY;

  if (openaiApiKey && openaiApiKey.length > 0) {
    const timeoutMs = safeParseInt(config.OPENAI_TIMEOUT_MS, undefined);

    const maxRetries = safeParseInt(config.OPENAI_MAX_RETRIES, undefined);

    providers.push({
      type: 'openai',
      config: {
        apiKey: openaiApiKey,
        organization: config.OPENAI_ORG_ID,
        baseURL: config.OPENAI_BASE_URL,
        defaultModel: config.OPENAI_DEFAULT_MODEL,
        defaultEmbeddingModel: config.OPENAI_DEFAULT_EMBEDDING_MODEL,
        defaultModerationModel: config.OPENAI_DEFAULT_MODERATION_MODEL,
      },
      priority: 10,
      capabilities: {
        supportsMultimodal: true,
        supportedModalities: ['image'],
        maxImagesPerRequest: 1,
      },
      timeoutMs,
      maxRetries,
    });
  }

  if (providers.length === 0) {
    throw new Error(
      'No LLM providers configured. Please set OPENAI_API_KEY or other provider credentials.',
    );
  }

  const enableFailover = config.LLM_ENABLE_FAILOVER === 'true';

  const maxFailoverAttemptsRaw = config.LLM_MAX_FAILOVER_ATTEMPTS;
  const maxFailoverAttempts = safeParseInt(maxFailoverAttemptsRaw, 3);

  return LLMAdapterFactory.create({
    providers,
    defaultProvider: 'openai',
    enableFailover,
    maxFailoverAttempts,
  });
}

/**
 * Быстрое создание адаптера по умолчанию
 */
export async function createDefaultLLMAdapter(): Promise<ILLMAdapter> {
  const factory = createLLMAdapterFactoryFromEnv();
  const { adapter } = await factory.createAdapterWithFailover();
  return adapter;
}