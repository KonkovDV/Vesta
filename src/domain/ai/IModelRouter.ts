/**
 * IModelRouter — domain port for dynamic LLM model routing.
 *
 * Selects the optimal model+provider pair based on task characteristics,
 * cost constraints, required capabilities, and provider health.
 *
 * Extracted pattern: KiloCode KC-025 (Sprint 3, Tier 3 — PATTERN).
 * Layer: Domain
 *
 * @module domain/ai/IModelRouter
 */

import type { ModelCatalogEntry } from './model-catalog.types';

// ---------------------------------------------------------------------------
// Task complexity classification
// ---------------------------------------------------------------------------

/**
 * Task complexity hint — drives model selection strategy.
 *
 * - 'trivial': boilerplate, formatting, simple transforms → cheapest/fastest model
 * - 'standard': typical coding tasks, Q&A → balanced cost/quality
 * - 'complex': architectural decisions, multi-step reasoning → best reasoning model
 * - 'critical': security audit, production debugging → highest-capability model
 */
export type TaskComplexity = 'trivial' | 'standard' | 'complex' | 'critical';

/**
 * Required model capability flags for task-based routing.
 */
export type ModelCapability =
  | 'reasoning'          // Chain-of-thought / extended thinking
  | 'code_generation'    // Optimized for code output
  | 'vision'             // Image understanding (multimodal)
  | 'tool_use'           // Function calling / tool use
  | 'long_context'       // 128K+ context window
  | 'streaming'          // Streaming response support
  | 'prompt_cache'       // Prompt caching support
  | 'low_latency'        // Sub-second first token
  | 'cost_optimized';    // Budget-conscious selection

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

/**
 * Model selection request — describes what the caller needs.
 */
export interface ModelSelectionRequest {
  /** Task complexity hint (drives provider tier selection) */
  readonly taskComplexity: TaskComplexity;

  /** Required capabilities the model must support */
  readonly requiredCapabilities?: readonly ModelCapability[];

  /** Preferred providers (tried first, in order) */
  readonly preferredProviders?: readonly string[];

  /** Maximum cost per 1K input tokens (USD). Filters out expensive models. */
  readonly maxCostPer1kInputTokens?: number;

  /** Minimum context window (tokens). Filters out small-context models. */
  readonly contextWindowMin?: number;

  /** Whether extended reasoning / thinking is required */
  readonly reasoningRequired?: boolean;

  /** Caller-provided correlation ID for tracing */
  readonly correlationId?: string;
}

/**
 * Cost estimate for a single request (USD).
 */
export interface CostEstimate {
  readonly estimatedInputCostPer1k: number;
  readonly estimatedOutputCostPer1k: number;
  readonly provider: string;
  readonly modelId: string;
}

/**
 * Model info returned by routing decision.
 */
export interface RoutedModelInfo {
  readonly modelId: string;
  readonly provider: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number | null;
  readonly supportsReasoning: boolean;
  readonly supportsTools: boolean;
  readonly supportsImages: boolean;
  readonly catalogEntry?: ModelCatalogEntry;
}

/**
 * Result of model selection — the chosen model + fallback chain.
 */
export interface ModelSelection {
  /** Primary selected model */
  readonly model: RoutedModelInfo;

  /** Provider name (convenience alias for model.provider) */
  readonly provider: string;

  /** Cost estimate for the selected model */
  readonly estimatedCost: CostEstimate;

  /** Ordered fallback chain (tried if primary fails) */
  readonly fallbacks: readonly RoutedModelInfo[];

  /** Routing decision rationale (for observability) */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Domain port
// ---------------------------------------------------------------------------

/**
 * IModelRouter — domain port for intelligent LLM model selection.
 *
 * Implementation lives in Application layer (DynamicLLMRouterService).
 * Uses IModelCatalog for model metadata and ILLMAdapterFactory for health checks.
 */
export interface IModelRouter {
  /**
   * Select the best model for a request based on task complexity,
   * capabilities, cost, and provider availability.
   */
  selectModel(request: ModelSelectionRequest): Promise<ModelSelection>;

  /**
   * Get the fallback chain for a given model (ordered by priority).
   */
  getFallbackChain(provider: string, modelId: string): Promise<readonly RoutedModelInfo[]>;

  /**
   * Check if a specific provider is available and healthy.
   */
  isProviderAvailable(provider: string): Promise<boolean>;
}
