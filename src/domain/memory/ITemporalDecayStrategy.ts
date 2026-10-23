/**
 * ITemporalDecayStrategy — Domain port for Ebbinghaus 2.0 temporal decay in memory search.
 *
 * Provides a Clean Architecture abstraction for applying time-based decay (Ebbinghaus
 * forgetting curve) to vector/memory search results. Implementations live in Infrastructure.
 *
 * Core formula: decayed_score = base_score × e^(-λ × effective_age)
 * Where:
 *   - base_score = 1 / (1 + distance) (vector similarity normalized)
 *   - λ = ln(2) / halfLifeDays (decay constant)
 *   - effective_age = age × (1 - entropy_mass) (semantic importance modulation)
 *
 * Academic basis:
 *   - Ebbinghaus (1885) — exponential forgetting curve: R = e^(-t/S)
 *   - SAGE (Spaced-Repetition Augmented Generation) — reinforcement on access
 *   - Sector-specific decay rates (OpenMemory HMD v2 architecture)
 *
 * @module domain/memory
 * @phase Ebbinghaus 2.0
 * @see infrastructure/memory/temporal/TemporalDecayScoring.ts
 * @see memory/session/DecayService.ts
 */

// ── Decay Configuration ────────────────────────────────────────────

/**
 * Memory sector classification for sector-specific decay rates.
 * Each sector has a biologically-inspired decay rate mimicking human memory.
 */
export type MemorySector =
  | 'episodic'    // Events/experiences — fast decay (half-life ~46 days)
  | 'semantic'    // Facts/knowledge — slow decay (half-life ~139 days)
  | 'procedural'  // How-to/processes — medium decay (half-life ~87 days)
  | 'emotional'   // Feelings/sentiments — fastest decay (half-life ~35 days)
  | 'reflective'; // Meta-cognition/insights — near-permanent (half-life ~693 days)

/**
 * Configuration for temporal decay calculation.
 */
export interface TemporalDecayOptions {
  /** Half-life in days. 0 = decay disabled. */
  halfLifeDays: number;
  /** Minimum score floor (prevents complete erasure). Default: 0.1 */
  minScoreFloor?: number;
  /** Whether to use entropy mass modulation. Default: true */
  useEntropyMass?: boolean;
  /** Memory sector for sector-specific decay rates. Overrides halfLifeDays if provided. */
  sector?: MemorySector;
}

/**
 * Result of a decay-aware search, extending base search with temporal metadata.
 */
export interface DecayAwareSearchResult {
  id: string;
  /** Final score after decay: base_score × decay_multiplier */
  score: number;
  /** Original similarity score before decay. */
  originalScore: number;
  /** Decay multiplier applied (0 to 1). */
  decayMultiplier: number;
  /** Age of the memory in days at time of scoring. */
  ageDays: number;
  /** Effective age after entropy mass modulation. */
  effectiveAgeDays: number;
  /** Number of times this memory was accessed (for reinforcement). */
  accessCount: number;
  metadata?: Record<string, unknown>;
  namespace?: string;
}

/**
 * Parameters for reinforcement (spaced repetition boost on access).
 */
export interface ReinforcementParams {
  /** Memory ID to reinforce. */
  memoryId: string;
  /** Reinforcement boost amount. Default: 0.1 */
  boost?: number;
  /** Namespace scope. */
  namespace?: string;
}

// ── Domain Port ────────────────────────────────────────────────────

/**
 * Domain port for temporal decay-aware memory operations.
 *
 * Unifies TemporalDecayScoring (post-query JS decay) and DecayService
 * (sector-based session memory) into a single Clean Architecture port
 * that supports both SQL-level and application-level decay.
 *
 * Implementations:
 * - PgVectorDecayAdapter — SQL-level decay in PostgreSQL/pgvector
 * - SqliteVectorDecayAdapter — JS-level decay for SQLite/sqlite-vec
 */
export interface ITemporalDecayStrategy {
  /**
   * Apply temporal decay to a set of search results.
   *
   * @param results - Raw search results with base scores
   * @param options - Decay configuration
   * @returns Results with decayed scores, sorted by final score descending
   */
  applyDecay(
    results: DecayAwareSearchResult[],
    options: TemporalDecayOptions,
  ): DecayAwareSearchResult[];

  /**
   * Calculate the decay multiplier for a given age and configuration.
   *
   * Pure function, no side effects — usable for preview/estimation.
   *
   * @param ageDays - Age of the memory in days
   * @param options - Decay configuration
   * @returns Multiplier between minScoreFloor and 1.0
   */
  calculateMultiplier(
    ageDays: number,
    options: TemporalDecayOptions,
  ): number;

  /**
   * Reinforce a memory on access (spaced repetition).
   *
   * Resets decay timer and/or boosts salience, implementing the
   * spacing effect from Ebbinghaus' research: repeated retrieval
   * strengthens memory traces.
   *
   * @param params - Reinforcement parameters
   */
  reinforce(params: ReinforcementParams): Promise<void>;
}
