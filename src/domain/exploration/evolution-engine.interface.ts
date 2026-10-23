/**
 * Evolution Engine — Domain Interface (Port)
 *
 * Evolutionary program search — LLM generates mutations, fitness evaluator scores.
 * Inspired by OpenEvolve / AlphaEvolve (Ch.9).
 *
 * Best Practices Applied (March 2026):
 * - MAP-Elites quality-diversity with island-based subpopulations
 *   (OpenEvolve: 4 islands, migration interval 20, rate 0.1)
 * - Cascade evaluation: quick→medium→full saves ~70% eval time
 *   (Dria Research, Aug 2025 — 29 AlgoTune experiments)
 * - Pluggable ISelectionStrategy for custom selection operators
 * - Stagnation detection via fitness delta threshold
 * - Parallel evaluation is essential (serial degrades performance 47-50%)
 *   (Snell et al. 2024 — test-time compute scaling)
 * - fitnessEvaluator passed via method (explicit composition, not DI)
 *
 * Enriched (AE-E01..AE-E06, arXiv:2602.16928 — Li et al., DeepMind Feb 2026):
 * - Volatility-adaptive parameters: EWMA-based dynamic discounting (VAD-CFR)
 * - Asymmetric mutation boosting: reward profitable mutations more (×1.1)
 * - Warm-start schedule: delay fitness averaging until exploration stabilizes
 * - Hybrid selection blending: mix strategies with annealing blend factor
 * - Dynamic annealing: schedule that decays exploration→exploitation
 * - Train/eval config asymmetry: separate configs for search vs. reporting
 *
 * @see Book Ch.9 "Autonomous Code Generation"
 * @see OpenEvolve v0.2.26 — github.com/algorithmicsuperintelligence/openevolve
 * @see Gulli, "Agentic Design Patterns" (Springer 2026)
 * @see arXiv:2602.16928 — "Discovering Multiagent Learning Algorithms with LLMs"
 */
import type { CorrelationId } from '@/core/types/branded';
import type { IFitnessEvaluator } from './fitness-evaluator.interface';

export interface Candidate {
  readonly id: string;
  readonly code: string;
  readonly generation: number;
  readonly parentId?: string;
  readonly fitness?: number;
}

export interface EvolutionConfig {
  readonly populationSize: number;         // OpenEvolve default: 10
  readonly generations: number;            // OpenEvolve default: 5
  readonly mutationRate: number;           // 0–1
  readonly selectionStrategy: 'tournament' | 'roulette' | 'elitist';
  readonly customSelector?: ISelectionStrategy;
  readonly fitnessThreshold: number;       // stop early if fitness >= threshold
  readonly stagnationWindow?: number;      // generations without improvement → stop

  // --- AE-E01: Volatility-Adaptive Parameters (arXiv:2602.16928, VAD-CFR) ---
  /** EWMA decay factor for tracking fitness volatility (0–1, default 0.1). */
  readonly volatilityDecay?: number;
  /** Sensitivity multiplier — higher means faster parameter adaptation under volatility. */
  readonly volatilitySensitivity?: number;

  // --- AE-E02: Asymmetric Mutation Boosting ---
  /** Boost factor for mutations that improve fitness (default 1.1). */
  readonly positiveMutationBoost?: number;
  /** Attenuation factor for mutations that decrease fitness (default 0.9). */
  readonly negativeMutationAttenuation?: number;

  // --- AE-E03: Warm-Start Schedule ---
  /** Generations to skip before including fitness in averaging (default 0 = no warmup). */
  readonly warmStartGenerations?: number;

  // --- AE-E04: Hybrid Selection Blending ---
  /** Secondary selection strategy to blend with primary. */
  readonly secondarySelector?: ISelectionStrategy;
  /** Blend factor λ ∈ [0,1]: 0 = primary only, 1 = secondary only. */
  readonly blendFactor?: number;

  // --- AE-E05: Dynamic Annealing Schedule ---
  /** If true, blendFactor and diversityBonus anneal over generations. */
  readonly enableAnnealing?: boolean;
  /** Final blend factor after annealing (default 0.05). */
  readonly annealedBlendFactor?: number;
  /** Initial diversity bonus added to fitness (default 0, decays to 0). */
  readonly diversityBonus?: number;

  // --- AE-E06: Train/Eval Config Asymmetry ---
  /** Separate config overrides used only when reporting final fitness (not during search). */
  readonly evalConfigOverrides?: Partial<Pick<EvolutionConfig,
    'selectionStrategy' | 'blendFactor' | 'diversityBonus'
  >>;
}

/**
 * Pluggable selection strategy for custom selection operators.
 * No new DI token needed — passed via EvolutionConfig.customSelector.
 */
export interface ISelectionStrategy {
  select(population: readonly Candidate[], count: number): readonly Candidate[];
}

export interface EvolutionResult {
  readonly bestCandidate: Candidate;
  readonly generations: number;
  readonly totalEvaluations: number;
  readonly fitnessHistory: readonly number[];
  readonly converged: boolean;
  /** AE-E01: EWMA volatility trace per generation (if volatilityDecay configured). */
  readonly volatilityTrace?: readonly number[];
}

export interface IEvolutionEngine {
  /**
   * Run evolutionary search.
   * fitnessEvaluator passed explicitly (composition over injection)
   * because the caller decides which evaluator to use per task.
   */
  evolve(
    seedCode: string,
    objective: string,
    config: EvolutionConfig,
    fitnessEvaluator: IFitnessEvaluator,
    correlationId: CorrelationId,
  ): Promise<EvolutionResult>;
}
