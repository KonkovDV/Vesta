/**
 * IPromptClassifier — Domain port for prompt complexity classification.
 *
 * Classifies incoming prompts by complexity level to enable intelligent
 * model routing: simple → cheap model, reasoning → strong model, etc.
 *
 * @layer Domain (port contract)
 * @see Book Ch.2 "Prompt Engineering" — Prompt Complexity Classifier (pp.28-45)
 * @see Book Ch.16 "Cost Optimization" — cost-aware model selection
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Prompt complexity classification levels.
 * Determines which model tier and tooling is appropriate.
 */
export type PromptComplexity = 'simple' | 'reasoning' | 'creative' | 'research';

/**
 * Classification result with confidence score and model suggestion.
 */
export interface ClassificationResult {
  /** Determined complexity category. */
  readonly complexity: PromptComplexity;
  /** Confidence in the classification (0-1). */
  readonly confidence: number;
  /** Suggested model identifier (e.g., "gpt-4o", "o3-mini"). */
  readonly suggestedModel?: string;
  /** Whether the prompt likely requires tool/function calls. */
  readonly requiresTools: boolean;
  /** Explanation of why this classification was chosen. */
  readonly reasoning: string;
  /** Estimated response tokens (for budget planning). */
  readonly estimatedTokens?: number;
}

/**
 * Optional context for user-aware classification.
 * Enables ICostAwareModelSelector (Phase 7) to factor in user budget/tier.
 */
export interface ClassifyOptions {
  /** User subscription tier — affects model cost tolerance. */
  readonly userTier?: 'free' | 'pro' | 'enterprise';
  /** Tokens already consumed in the current session. */
  readonly sessionTokensUsed?: number;
  /** User's preferred model (may override suggestion). */
  readonly preferredModel?: string;
}

// ── Interface ──────────────────────────────────────────────────────

/**
 * Classifies prompt complexity for intelligent model routing.
 *
 * Used by:
 *   - ICostAwareModelSelector (Ch.16) — cost-aware routing
 *   - ADK conditional routing (Ch.2) — complexity-based orchestration
 *
 * @see DI_TOKENS.IPromptClassifier
 */
export interface IPromptClassifier {
  /**
   * Classify a prompt by complexity, suggesting appropriate model and tools.
   *
   * @param prompt        — the user prompt to classify
   * @param correlationId — request correlation ID for tracing
   * @param options       — optional user context for cost-aware routing
   * @returns Classification result with complexity, confidence, and model suggestion
   */
  classify(
    prompt: string,
    correlationId: CorrelationId,
    options?: ClassifyOptions,
  ): Promise<ClassificationResult>;
}
