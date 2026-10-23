/**
 * ICostAwareModelSelector — Domain port for cost-aware model selection.
 *
 * Selects optimal LLM model based on prompt complexity, cost constraints,
 * and quality requirements. Composes IPromptClassifier for complexity assessment,
 * then maps to cost profiles for optimal model routing.
 *
 * @layer Domain (port contract)
 * @see Book Ch.16 "Cost Optimization" — cost-aware model selection
 * @see IPromptClassifier (src/domain/routing/prompt-classifier.interface.ts) — complexity input
 */

import type { CorrelationId } from '../../core/types/branded';
import type { PromptComplexity } from './prompt-classifier.interface';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Cost and capability profile for a single model.
 * Sourced from IModelMetadataRegistry or static configuration.
 */
export interface ModelCostProfile {
  readonly modelId: string;
  readonly costPerInputToken: number;     // USD per token
  readonly costPerOutputToken: number;    // USD per token
  readonly avgLatencyMs: number;
  readonly qualityTier: 'economy' | 'standard' | 'premium';
  readonly maxContextTokens: number;
  readonly capabilities: readonly string[];
}

/**
 * Result of model selection — chosen model with reasoning and alternatives.
 */
export interface ModelSelectionResult {
  readonly selectedModel: string;
  readonly reason: string;
  readonly estimatedCost: number;
  readonly complexity: PromptComplexity;
  readonly alternativeModels: readonly {
    readonly modelId: string;
    readonly estimatedCost: number;
    readonly tradeoff: string;
  }[];
}

// ── Interface ──────────────────────────────────────────────────────

/**
 * Selects optimal model based on prompt complexity, cost constraints, and quality needs.
 *
 * Composition with existing infrastructure:
 *   - `IPromptClassifier` (Phase 1) — complexity classification
 *   - `ITokenomicsController` (existing) — budget checks, no parallel cost tracking
 *
 * @see DI_TOKENS.ICostAwareModelSelector
 */
export interface ICostAwareModelSelector {
  /**
   * Select the optimal model for a given prompt within budget constraints.
   *
   * @param prompt        — the user prompt to route
   * @param maxBudget     — optional maximum cost in USD (undefined = no limit)
   * @param correlationId — request correlation ID for tracing
   * @returns Selection result with model choice, reasoning, and alternatives
   */
  selectModel(
    prompt: string,
    maxBudget: number | undefined,
    correlationId: CorrelationId,
  ): Promise<ModelSelectionResult>;

  /**
   * Get all available model cost profiles.
   * @returns Array of model cost profiles sorted by cost (ascending)
   */
  getModelProfiles(): readonly ModelCostProfile[];
}
