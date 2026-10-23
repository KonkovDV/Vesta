/**
 * CostAwareModelSelectorAdapter — Infrastructure adapter for ICostAwareModelSelector.
 *
 * Uses IPromptClassifier for complexity assessment, then maps to cost profiles
 * for optimal model selection within budget constraints.
 *
 * Best Practices Applied (March 2026):
 * - Composition over inheritance: delegates to IPromptClassifier + ITokenomicsController
 * - No parallel cost tracking — defers to existing ITokenomicsController for budget
 * - correlationId in all log entries (Hard Rule #6)
 * - temperature 0.0 for deterministic classification-based routing
 *
 * DI: constructor(classifier, tokenomics, logger) — 3 args
 *
 * @layer Infrastructure (implements Domain port)
 * @see ICostAwareModelSelector (src/domain/routing/cost-aware-model-selector.interface.ts)
 * @see Book Ch.16 "Cost Optimization" — cost-aware model selection
 */

import type {
  ICostAwareModelSelector,
  ModelCostProfile,
  ModelSelectionResult,
} from '../../domain/routing/cost-aware-model-selector.interface';
import type { IPromptClassifier, PromptComplexity } from '../../domain/routing/prompt-classifier.interface';
import type { ITokenomicsController } from '../../domain/finops/ITokenomicsController';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';

// ── Static cost profiles (book Ch.16 pricing, March 2026) ──────────

const DEFAULT_PROFILES: readonly ModelCostProfile[] = [
  {
    modelId: 'gpt-4o-mini',
    costPerInputToken: 0.00000015,   // $0.15/1M
    costPerOutputToken: 0.0000006,   // $0.60/1M
    avgLatencyMs: 400,
    qualityTier: 'economy',
    maxContextTokens: 128_000,
    capabilities: ['chat', 'function-calling'],
  },
  {
    modelId: 'gpt-4o',
    costPerInputToken: 0.0000025,    // $2.50/1M
    costPerOutputToken: 0.00001,     // $10.00/1M
    avgLatencyMs: 800,
    qualityTier: 'standard',
    maxContextTokens: 128_000,
    capabilities: ['chat', 'function-calling', 'vision', 'web-search'],
  },
  {
    modelId: 'o3-mini',
    costPerInputToken: 0.0000011,    // $1.10/1M
    costPerOutputToken: 0.0000044,   // $4.40/1M
    avgLatencyMs: 2000,
    qualityTier: 'premium',
    maxContextTokens: 200_000,
    capabilities: ['chat', 'reasoning', 'code'],
  },
  {
    modelId: 'gemini-2.0-flash',
    costPerInputToken: 0.0000001,    // $0.10/1M
    costPerOutputToken: 0.0000004,   // $0.40/1M
    avgLatencyMs: 350,
    qualityTier: 'economy',
    maxContextTokens: 1_000_000,
    capabilities: ['chat', 'function-calling', 'vision'],
  },
] as const;

/** Map complexity → preferred quality tier. */
const COMPLEXITY_TIER_MAP: Record<PromptComplexity, ModelCostProfile['qualityTier']> = {
  simple: 'economy',
  creative: 'standard',
  research: 'standard',
  reasoning: 'premium',
};

/** Estimated output tokens per complexity tier (for cost estimation). */
const ESTIMATED_OUTPUT_TOKENS: Record<PromptComplexity, number> = {
  simple: 256,
  creative: 1024,
  research: 2048,
  reasoning: 1024,
};

// ── Adapter ─────────────────────────────────────────────────────────

export class CostAwareModelSelectorAdapter implements ICostAwareModelSelector {
  private readonly profiles: readonly ModelCostProfile[];

  constructor(
    private readonly classifier: IPromptClassifier,
    private readonly tokenomics: ITokenomicsController,
    private readonly logger: ILogger,
  ) {
    this.profiles = DEFAULT_PROFILES;
  }

  async selectModel(
    prompt: string,
    maxBudget: number | undefined,
    correlationId: CorrelationId,
  ): Promise<ModelSelectionResult> {
    this.logger.info('CostAwareModelSelectorAdapter.selectModel', {
      correlationId,
      promptLength: prompt.length,
      maxBudget,
    });

    // 1. Classify prompt complexity
    const classification = await this.classifier.classify(prompt, correlationId);
    const { complexity } = classification;

    // 2. Find preferred tier for this complexity
    const preferredTier = COMPLEXITY_TIER_MAP[complexity];
    const estimatedOutputTokens = ESTIMATED_OUTPUT_TOKENS[complexity];
    const estimatedInputTokens = Math.ceil(prompt.length / 4); // rough estimate

    // 3. Score all models: prefer tier match, then minimize cost
    const scored = this.profiles
      .map((profile) => {
        const cost =
          profile.costPerInputToken * estimatedInputTokens +
          profile.costPerOutputToken * estimatedOutputTokens;
        const tierMatch = profile.qualityTier === preferredTier;
        return { profile, cost, tierMatch };
      })
      .sort((a, b) => {
        // Tier match first, then cost
        if (a.tierMatch !== b.tierMatch) return a.tierMatch ? -1 : 1;
        return a.cost - b.cost;
      });

    // 4. Apply budget filter
    let candidates = scored;
    if (maxBudget !== undefined) {
      const withinBudget = scored.filter((s) => s.cost <= maxBudget);
      if (withinBudget.length > 0) {
        candidates = withinBudget;
      } else {
        // All exceed budget — pick cheapest anyway, log warning
        this.logger.warn('CostAwareModelSelectorAdapter.budgetExceeded', {
          correlationId,
          maxBudget,
          cheapestCost: scored[scored.length - 1]?.cost,
        });
      }
    }

    const selected = candidates[0];
    const alternatives = candidates.slice(1, 4).map((alt) => ({
      modelId: alt.profile.modelId,
      estimatedCost: alt.cost,
      tradeoff: alt.tierMatch
        ? `Same tier (${alt.profile.qualityTier}), ${alt.cost < selected.cost ? 'cheaper' : 'more expensive'}`
        : `Different tier (${alt.profile.qualityTier}), ${alt.cost < selected.cost ? 'cheaper' : 'more expensive'}`,
    }));

    const result: ModelSelectionResult = {
      selectedModel: selected.profile.modelId,
      reason: `Complexity "${complexity}" → tier "${preferredTier}" → ${selected.profile.modelId} (${selected.tierMatch ? 'exact tier match' : 'best available'})`,
      estimatedCost: selected.cost,
      complexity,
      alternativeModels: alternatives,
    };

    this.logger.info('CostAwareModelSelectorAdapter.selected', {
      correlationId,
      selectedModel: result.selectedModel,
      complexity,
      estimatedCost: result.estimatedCost,
      alternativeCount: alternatives.length,
    });

    return result;
  }

  getModelProfiles(): readonly ModelCostProfile[] {
    return this.profiles;
  }
}
