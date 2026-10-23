/**
 * Model catalog types for multi-provider LLM support.
 * Extracted from KiloCode (Apache-2.0) — KC-001..KC-007.
 * Layer: Domain
 */

/**
 * Pricing information for a model (per 1M tokens).
 */
export interface ModelPricing {
  /** Input token price per 1M tokens (USD) */
  readonly inputPrice?: number;
  /** Output token price per 1M tokens (USD) */
  readonly outputPrice?: number;
  /** Cache write price per 1M tokens (USD) */
  readonly cacheWritesPrice?: number;
  /** Cache read price per 1M tokens (USD) */
  readonly cacheReadsPrice?: number;
}

/**
 * Model capabilities flags.
 */
export interface ModelCapabilities {
  readonly supportsImages?: boolean;
  readonly supportsPromptCache: boolean;
  readonly supportsNativeTools?: boolean;
  readonly supportsReasoningBudget?: boolean;
  readonly preserveReasoning?: boolean;
  readonly supportsTemperature?: boolean;
}

/**
 * Single model entry in a provider catalog.
 * Deliberately minimal — pure data, no behavior.
 */
export interface ModelCatalogEntry extends ModelPricing, ModelCapabilities {
  /** Maximum output tokens */
  readonly maxTokens: number | null;
  /** Context window size in tokens */
  readonly contextWindow: number;
  /** Human-readable description */
  readonly description?: string;
  /** Default temperature for this model */
  readonly defaultTemperature?: number;
}

/**
 * A provider's complete model catalog.
 */
export interface ProviderCatalog {
  /** Provider identifier (e.g. 'deepseek', 'groq') */
  readonly provider: string;
  /** Default model ID for this provider */
  readonly defaultModelId: string;
  /** All models keyed by model ID */
  readonly models: Readonly<Record<string, ModelCatalogEntry>>;
}

/**
 * IModelCatalog — domain port for querying model metadata across providers.
 */
export interface IModelCatalog {
  /** Get a specific model's metadata */
  getModel(provider: string, modelId: string): ModelCatalogEntry | undefined;
  /** List all models for a provider */
  listModels(provider: string): ReadonlyArray<{ id: string; entry: ModelCatalogEntry }>;
  /** List all registered provider names */
  listProviders(): readonly string[];
  /** Get the default model for a provider */
  getDefaultModelId(provider: string): string | undefined;
}
