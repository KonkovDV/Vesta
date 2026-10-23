/**
 * IDynamicCognitiveBudget — Domain port for task-criticality-aware cognitive budget allocation.
 *
 * CC-028 Dynamic Cognitive Budget: extends CC-025 (CognitiveLoadGovernor) by replacing
 * static phase budgets (0.3/0.3/0.4) with dynamic thresholds that automatically adjust
 * based on the criticality of the current operation. Critical system files (bootstrap.ts,
 * DI_TOKENS.ts, event schemas) receive tighter budgets to prevent "hallucinatory overheat",
 * while research/exploration tasks receive expanded budgets for creative flexibility.
 *
 * Key Innovation: Task Criticality Scoring (TCS)
 *   - Each file/operation is scored 0.0-1.0 for criticality
 *   - Higher criticality → lower budget thresholds (more conservative)
 *   - Lower criticality → higher budget thresholds (more exploratory)
 *   - Criticality derived from: architecture layer (0-9), file importance, change impact
 *
 * Budget Calculation:
 *   effectiveBudget = baseBudget × (1 - criticalityScore × compressionFactor)
 *   For bootstrap.ts (criticality=0.95): budget shrinks to ~30% of base
 *   For research notes (criticality=0.1): budget expands to ~95% of base
 *
 * Integration Points:
 *   - ICognitiveLoadGovernor (CC-025) — supplies base budgets; this port modulates them
 *   - IIntentMisalignmentDetector (CC-026) — criticality feeds intent analysis
 *   - IToolExecutionPolicy (CC-012) — high-criticality operations may require confirmation
 *
 * Academic Basis:
 *   - Epistemic Stability (arXiv:2603.10047, Mar 2026) — M3 Single-Task Agent Specialization
 *   - Epistemic Context Learning (arXiv:2601.21742, Jan 2026) — calibrated trust modeling
 *   - PROBE (arXiv:2510.19771, v3 Feb 2026) — gap between search (70%) and resolve (40%)
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-028 Dynamic Cognitive Budget (PUA v5.2)
 * @see src/domain/agents/ICognitiveLoadGovernor.ts — CC-025 base governor
 */

// ── Types ──────────────────────────────────────────────────────────

/** Classification of task criticality zones. */
export type CriticalityZone =
  | 'system_core'    // bootstrap, orchestrator, DI_TOKENS (layer 0-1)
  | 'domain_logic'   // domain ports, events, value objects (layer 2-3)
  | 'application'    // use cases, controllers (layer 4-5)
  | 'infrastructure' // adapters, external integrations (layer 6-7)
  | 'testing'        // test files (layer 8)
  | 'documentation'  // docs, configs (layer 9)
  | 'research';      // exploration, investigation, no file changes

/** A criticality assessment for a specific file or operation. */
export interface CriticalityAssessment {
  /** Full file path (or 'research' for non-file operations). */
  readonly target: string;
  /** Criticality zone classification. */
  readonly zone: CriticalityZone;
  /** Criticality score (0.0 = trivial, 1.0 = maximum criticality). */
  readonly score: number;
  /** Architecture layer (0-9, -1 for non-file). */
  readonly architectureLayer: number;
  /** Whether this file is in the entry chain. */
  readonly isEntryChain: boolean;
  /** Whether this file defines DI tokens. */
  readonly isDiDefinition: boolean;
  /** Rationale for the criticality assessment. */
  readonly rationale: string;
}

/** Dynamic budget computed from criticality assessment. */
export interface DynamicBudget {
  /** Base budget before criticality adjustment. */
  readonly baseBudget: number;
  /** Effective budget after criticality compression. */
  readonly effectiveBudget: number;
  /** Criticality score used for compression. */
  readonly criticalityScore: number;
  /** Compression factor applied. */
  readonly compressionFactor: number;
  /** Zone that determined the budget. */
  readonly zone: CriticalityZone;
  /** Whether hallucination guard is active (criticality > 0.7). */
  readonly hallucinationGuardActive: boolean;
  /** Human-readable summary. */
  readonly summary: string;
}

/** Configuration for dynamic budget calculation. */
export interface DynamicBudgetConfig {
  /** Compression factor — how much criticality reduces budget (default: 0.7). */
  readonly compressionFactor: number;
  /** Threshold above which hallucination guard activates (default: 0.7). */
  readonly hallucinationGuardThreshold: number;
  /** Minimum effective budget ratio — floor for budget compression (default: 0.2). */
  readonly minBudgetRatio: number;
  /** Maximum budget expansion for research tasks (default: 1.5). */
  readonly maxResearchExpansion: number;
}

/** Default configuration for dynamic budgeting. */
export const DEFAULT_DYNAMIC_BUDGET_CONFIG: DynamicBudgetConfig = {
  compressionFactor: 0.7,
  hallucinationGuardThreshold: 0.7,
  minBudgetRatio: 0.2,
  maxResearchExpansion: 1.5,
};

/** Statistics about dynamic budget usage. */
export interface DynamicBudgetStats {
  /** Total assessments performed. */
  readonly totalAssessments: number;
  /** Assessments by zone. */
  readonly assessmentsByZone: Record<CriticalityZone, number>;
  /** Number of times hallucination guard activated. */
  readonly hallucinationGuardActivations: number;
  /** Average effective-to-base budget ratio. */
  readonly avgBudgetRatio: number;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Dynamic Cognitive Budget — criticality-aware budget allocation for cognitive load.
 *
 * Extends the static budgets of CC-025 CognitiveLoadGovernor with dynamic
 * adjustment based on the criticality of the files/operations being performed.
 */
export interface IDynamicCognitiveBudget {
  /**
   * Assess the criticality of a file or operation.
   *
   * @param filePath - File path to assess (or 'research' for non-file ops)
   * @returns Criticality assessment with zone and score
   */
  assessCriticality(filePath: string): CriticalityAssessment;

  /**
   * Calculate the effective budget for a given base budget and file.
   *
   * @param baseBudget - Original budget from CognitiveLoadConfig
   * @param filePath - File being operated on
   * @param config - Dynamic budget configuration
   * @returns Dynamic budget with effective threshold
   */
  calculateBudget(
    baseBudget: number,
    filePath: string,
    config?: DynamicBudgetConfig,
  ): DynamicBudget;

  /**
   * Get statistics about dynamic budget usage.
   *
   * @returns Budget usage statistics
   */
  getStats(): DynamicBudgetStats;

  /** Reset all state. */
  reset(): void;
}
