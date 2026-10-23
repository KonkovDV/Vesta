/**
 * ICognitiveLoadGovernor — Domain port for proactivity throttling via cognitive load monitoring.
 *
 * CC-025 Cognitive Load Governor: addresses the Proactivity Calibration Gap identified
 * in PROBE (arXiv:2510.19771, v3 Feb 2026) and the lifecycle intent analysis from
 * Taming OpenClaw (arXiv:2603.11619, Mar 2026). PUA v5.0-Alpha (PUA-4) monitors
 * token budget and iteration depth but not the *frequency of agent-initiated actions*
 * relative to task complexity — leading to Cognitive Energy Exhaustion when agents
 * exhibit excessive proactivity that overwhelms the verification pipeline.
 *
 * The Cognitive Load Governor introduces a formal throttling mechanism:
 *   1. Tracks cumulative cognitive load across action types (search, edit, verify, propose)
 *   2. Enforces per-phase load budgets (PROBE capability mapping: Search/Identify/Resolve)
 *   3. Emits throttle signals when load exceeds configurable thresholds
 *   4. Supports Intent-Based Contextual Decay — load decays faster for aligned actions
 *
 * Integration Points:
 *   - IAutonomousExecutionLoop (CC-009) — bounded loop respects governor signals
 *   - IStallDetector — stall detection feeds load accumulation
 *   - IS2iLessonExtractor (CC-023) — lesson extraction frequency governed
 *   - PUA-4 Cognitive Energy Model — $R_t$, $D_i$ now supplemented by $L_c$ (cognitive load)
 *
 * Academic Basis:
 *   - PROBE (arXiv:2510.19771, v3 Feb 2026) — proactive bottleneck resolution benchmark
 *   - Taming OpenClaw (arXiv:2603.11619, Mar 2026) — lifecycle intent security
 *   - Kwa et al. (arXiv:2503.14499, NeurIPS 2025) — error recovery as capability driver
 *   - Park et al. (arXiv:2511.12001, Nov 2025) — CoT confidence tone suppresses error detection
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern CC-025 Cognitive Load Governor (PUA v5.1 → codified)
 * @see .github/instructions/pua-exhaustive-debugging.instructions.md — PUA-4 Cognitive Energy Model
 */

// ── Types ──────────────────────────────────────────────────────────

/** Classification of agent action types for load accounting. */
export type AgentActionType =
  | 'search'       // File/grep/semantic search operations
  | 'read'         // File reads, context gathering
  | 'edit'         // File modifications
  | 'verify'       // Test runs, architecture checks, preflight
  | 'propose'      // Amendment proposals, suggestions to user
  | 'delegate'     // Subagent delegation
  | 'communicate'; // User-facing messages, questions

/** PROBE capability phase for load budgeting. */
export type ProbePhase = 'search' | 'identify' | 'resolve';

/** A single cognitive load measurement entry. */
export interface CognitiveLoadEntry {
  /** Action type performed. */
  readonly actionType: AgentActionType;
  /** PROBE phase this action belongs to. */
  readonly probePhase: ProbePhase;
  /** Load weight (0.0-1.0). Higher = more cognitively expensive. */
  readonly weight: number;
  /** Timestamp of the action. */
  readonly timestamp: string;
  /** Whether this action was aligned with the user's stated intent. */
  readonly intentAligned: boolean;
}

/** Throttle signal emitted when load exceeds thresholds. */
export interface ThrottleSignal {
  /** Whether throttling is active. */
  readonly active: boolean;
  /** Current cumulative load (0.0 - ∞, threshold typically 1.0). */
  readonly currentLoad: number;
  /** Maximum allowed load for the current phase. */
  readonly phaseLimit: number;
  /** PROBE phase currently in effect. */
  readonly currentPhase: ProbePhase;
  /** Recommended action: continue, slow_down, pause, or escalate. */
  readonly recommendation: 'continue' | 'slow_down' | 'pause' | 'escalate';
  /** Human-readable reason for throttle state. */
  readonly reason: string;
}

/** Configuration for cognitive load budgets per PROBE phase. */
export interface CognitiveLoadConfig {
  /** Load budget for Search phase (default: 0.3). */
  readonly searchBudget: number;
  /** Load budget for Identify phase (default: 0.3). */
  readonly identifyBudget: number;
  /** Load budget for Resolve phase (default: 0.4). */
  readonly resolveBudget: number;
  /** Decay factor for intent-aligned actions (0.0-1.0, default: 0.5). */
  readonly intentAlignedDecay: number;
  /** Decay factor for misaligned actions (0.0-1.0, default: 0.9). */
  readonly misalignedDecay: number;
}

/** Default load config aligned with PROBE 70/40 gap (Search is easier than Resolve). */
export const DEFAULT_COGNITIVE_LOAD_CONFIG: CognitiveLoadConfig = {
  searchBudget: 0.3,
  identifyBudget: 0.3,
  resolveBudget: 0.4,
  intentAlignedDecay: 0.5,
  misalignedDecay: 0.9,
};

/** Cognitive load summary statistics. */
export interface CognitiveLoadStats {
  /** Total accumulated load across all phases. */
  readonly totalLoad: number;
  /** Load per PROBE phase. */
  readonly loadByPhase: Record<ProbePhase, number>;
  /** Load per action type. */
  readonly loadByActionType: Record<AgentActionType, number>;
  /** Number of actions recorded. */
  readonly actionCount: number;
  /** Number of throttle events emitted. */
  readonly throttleCount: number;
  /** Bottleneck Deflection Rate — proportion of successfully deflected bottlenecks. */
  readonly bottleneckDeflectionRate: number;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Cognitive Load Governor — proactivity throttling via structured load monitoring.
 *
 * Implements the Proactivity Calibration concept from PROBE benchmarking,
 * providing a formal mechanism to prevent Cognitive Energy Exhaustion
 * while maintaining sufficient initiative for effective task resolution.
 */
export interface ICognitiveLoadGovernor {
  /**
   * Record a cognitive load entry for an agent action.
   *
   * @param entry - The action to record
   */
  recordAction(entry: CognitiveLoadEntry): void;

  /**
   * Check the current throttle state.
   *
   * @param config - Load configuration (defaults to DEFAULT_COGNITIVE_LOAD_CONFIG)
   * @returns Current throttle signal
   */
  checkThrottle(config?: CognitiveLoadConfig): ThrottleSignal;

  /**
   * Transition to a new PROBE phase. Resets phase-specific load counters.
   *
   * @param phase - The PROBE phase to enter
   */
  enterPhase(phase: ProbePhase): void;

  /**
   * Record a bottleneck that was successfully deflected (proactively resolved).
   * Used for Bottleneck Deflection Rate (BDR) calculation.
   */
  recordDeflection(): void;

  /**
   * Record a bottleneck that was NOT deflected (required reactive handling).
   */
  recordMiss(): void;

  /**
   * Get cumulative cognitive load statistics.
   *
   * @returns Aggregated load metrics
   */
  getStats(): CognitiveLoadStats;

  /**
   * Reset all load counters. Used at task boundary transitions.
   */
  reset(): void;
}
