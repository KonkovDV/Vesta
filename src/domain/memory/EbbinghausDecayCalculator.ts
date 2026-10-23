/**
 * EbbinghausDecayCalculator — Pure domain value object for Ebbinghaus 2.0 decay math.
 *
 * Encapsulates the exponential forgetting curve with sector-specific rates,
 * entropy mass modulation, and spaced-repetition reinforcement calculations.
 *
 * All methods are pure functions with no side effects — safe for use anywhere.
 *
 * Core formula:
 *   decayed_score = base_score × e^(-λ × effective_age)
 *   λ = ln(2) / halfLifeDays
 *   effective_age = age × (1 - entropy_mass)
 *
 * @module domain/memory
 * @phase Ebbinghaus 2.0
 * @layer Domain (pure computation, no I/O)
 */

import type { MemorySector, TemporalDecayOptions } from './ITemporalDecayStrategy';

// ── Sector-Specific Decay Constants ────────────────────────────────

/**
 * Lambda (decay rate per day) for each memory sector.
 * Lower λ = slower decay = longer retention.
 *
 * Half-life = ln(2) / λ
 */
export const SECTOR_LAMBDAS: Readonly<Record<MemorySector, number>> = {
  episodic: 0.015,    // ~46 days half-life
  semantic: 0.005,    // ~139 days half-life
  procedural: 0.008,  // ~87 days half-life
  emotional: 0.020,   // ~35 days half-life
  reflective: 0.001,  // ~693 days half-life
};

/** Default lambda for unclassified memories. */
export const DEFAULT_LAMBDA = 0.010; // ~69 days half-life

/** Default minimum score floor. */
export const DEFAULT_MIN_FLOOR = 0.1;

/** Reinforcement boost per access (spaced repetition). */
export const REINFORCEMENT_BOOST = 0.1;

/** Recurrence threshold for sector promotion (episodic → semantic). */
export const CONSOLIDATION_THRESHOLD = 3;

/** Recurrence threshold for deep promotion (→ reflective). */
export const DEEP_CONSOLIDATION_THRESHOLD = 5;

// ── Pure Calculation Functions ─────────────────────────────────────

/**
 * Convert half-life in days to decay constant λ.
 */
export function halfLifeToLambda(halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 0;
  return Math.LN2 / halfLifeDays;
}

/**
 * Convert decay constant λ to half-life in days.
 */
export function lambdaToHalfLife(lambda: number): number {
  if (lambda <= 0) return Infinity;
  return Math.LN2 / lambda;
}

/**
 * Calculate the decay multiplier for a given age.
 *
 * @param ageDays - Age of the memory in fractional days
 * @param halfLifeDays - Half-life in days (0 disables decay → returns 1.0)
 * @param minFloor - Minimum multiplier (prevents complete erasure)
 * @returns Multiplier in range [minFloor, 1.0]
 */
export function calculateDecayMultiplier(
  ageDays: number,
  halfLifeDays: number,
  minFloor: number = DEFAULT_MIN_FLOOR,
): number {
  if (halfLifeDays <= 0 || ageDays <= 0) return 1.0;

  const lambda = halfLifeToLambda(halfLifeDays);
  const multiplier = Math.exp(-lambda * ageDays);

  return Math.max(multiplier, minFloor);
}

/**
 * Calculate effective age modulated by entropy mass.
 *
 * High entropy mass (1.0) = high information density → age reduced to near-zero.
 * Low entropy mass (0.0) = trivial/redundant → full age applied.
 *
 * @param ageDays - Raw age in days
 * @param entropyMass - Information density (0-1)
 * @returns Effective age, always ≥ 0
 */
export function calculateEffectiveAge(
  ageDays: number,
  entropyMass: number,
): number {
  const clampedMass = Math.max(0, Math.min(1, entropyMass));
  return ageDays * (1 - clampedMass);
}

/**
 * Calculate the age of a memory in fractional days.
 *
 * @param createdAt - ISO-8601 timestamp or undefined
 * @param now - Reference time (for testability)
 * @returns Age in fractional days, or 0 if createdAt is invalid/missing
 */
export function calculateAgeDays(
  createdAt: string | undefined,
  now: Date = new Date(),
): number {
  if (!createdAt) return 0;

  const created = new Date(createdAt);
  if (isNaN(created.getTime())) return 0;

  const diffMs = now.getTime() - created.getTime();
  return diffMs > 0 ? diffMs / (1000 * 60 * 60 * 24) : 0;
}

/**
 * Resolve decay options to a concrete lambda value.
 *
 * Priority: explicit halfLifeDays > sector lookup > default.
 */
export function resolveLambda(options: TemporalDecayOptions): number {
  if (options.halfLifeDays > 0) {
    return halfLifeToLambda(options.halfLifeDays);
  }
  if (options.sector) {
    return SECTOR_LAMBDAS[options.sector] ?? DEFAULT_LAMBDA;
  }
  return DEFAULT_LAMBDA;
}

/**
 * Apply reinforcement boost (spaced repetition).
 *
 * @param currentSalience - Current salience score (0-1)
 * @param boost - Boost amount (default: REINFORCEMENT_BOOST)
 * @returns New salience, capped at 1.0
 */
export function applyReinforcement(
  currentSalience: number,
  boost: number = REINFORCEMENT_BOOST,
): number {
  return Math.min(1.0, currentSalience + boost);
}

/**
 * Calculate days until a memory reaches archive threshold.
 *
 * @param currentSalience - Current salience (0-1)
 * @param archiveThreshold - Threshold below which memory is archived
 * @param lambda - Decay constant
 * @returns Days until archive, or 0 if already below threshold
 */
export function timeToArchive(
  currentSalience: number,
  archiveThreshold: number = DEFAULT_MIN_FLOOR,
  lambda: number = DEFAULT_LAMBDA,
): number {
  if (currentSalience <= archiveThreshold || lambda <= 0) return 0;
  return -Math.log(archiveThreshold / currentSalience) / lambda;
}

/**
 * Determine if a memory should be consolidated (promoted to a slower-decay sector).
 *
 * @param currentSector - Current memory sector
 * @param recurrenceCount - Number of times this memory pattern has recurred
 * @returns Target sector and new lambda, or null if no consolidation needed
 */
export function shouldConsolidate(
  currentSector: MemorySector,
  recurrenceCount: number,
): { targetSector: MemorySector; newLambda: number } | null {
  // Already at max retention
  if (currentSector === 'reflective' || currentSector === 'semantic') {
    return null;
  }

  if (recurrenceCount >= DEEP_CONSOLIDATION_THRESHOLD) {
    return { targetSector: 'reflective', newLambda: SECTOR_LAMBDAS.reflective };
  }

  if (recurrenceCount >= CONSOLIDATION_THRESHOLD) {
    return { targetSector: 'semantic', newLambda: SECTOR_LAMBDAS.semantic };
  }

  return null;
}
