/**
 * DecayService — implements exponential memory salience decay.
 * 
 * Based on OpenMemory HMD v2 architecture with sector-specific decay rates.
 * 
 * Formula: salience(t) = initial_salience × e^(-λ × days)
 * 
 * Layer: Memory
 */

import type { HSGPrimarySector } from '../../domain/memory/session-types';

/**
 * Decay configuration per memory sector.
 * Lambda values represent decay rate per day.
 * Lower values = slower decay (longer memory retention).
 */
export interface DecayConfig {
  lambda: number;
  /** Human-readable description */
  description: string;
  /** Approximate half-life in days */
  halfLifeDays: number;
}

/**
 * Decay lambdas per sector.
 * Source: OpenMemory ARCHITECTURE.md
 */
export const SECTOR_DECAY_CONFIG: Record<HSGPrimarySector, DecayConfig> = {
  episodic: {
    lambda: 0.015,
    description: 'Events and experiences',
    halfLifeDays: 46,
  },
  semantic: {
    lambda: 0.005,
    description: 'Facts and knowledge',
    halfLifeDays: 139,
  },
  procedural: {
    lambda: 0.008,
    description: 'How-to and processes',
    halfLifeDays: 87,
  },
  emotional: {
    lambda: 0.020,
    description: 'Feelings and sentiments',
    halfLifeDays: 35,
  },
  reflective: {
    lambda: 0.001,
    description: 'Meta-cognition and insights',
    halfLifeDays: 693,
  },
};

/**
 * Default decay lambda for unknown or unclassified memories.
 */
export const DEFAULT_DECAY_LAMBDA = 0.010;

/**
 * Minimum salience threshold. Memories below this are candidates for archival.
 */
export const SALIENCE_ARCHIVE_THRESHOLD = 0.1;

/**
 * Reinforcement boost applied when memory is accessed.
 */
export const REINFORCEMENT_BOOST = 0.1;

export interface DecayCalculationInput {
  /** Initial salience value (typically importance score) */
  initialSalience: number;
  /** Memory sector for sector-specific decay */
  sector?: HSGPrimarySector;
  /** ISO8601 timestamp of last access */
  lastSeenAt: string;
  /** Current timestamp (defaults to now) */
  currentTime?: Date;
}

export interface DecayCalculationResult {
  /** Decayed salience value */
  salience: number;
  /** Days since last seen */
  daysSinceLastSeen: number;
  /** Lambda used for decay */
  lambda: number;
  /** Whether memory is below archive threshold */
  shouldArchive: boolean;
}

export class DecayService {
  /**
   * Calculate the decayed salience value for a memory.
   * 
   * Uses exponential decay: salience(t) = S₀ × e^(-λ × t)
   */
  calculateDecay(input: DecayCalculationInput): DecayCalculationResult {
    const { initialSalience, sector, lastSeenAt, currentTime = new Date() } = input;

    // Get sector-specific lambda or default
    const lambda = sector
      ? SECTOR_DECAY_CONFIG[sector]?.lambda ?? DEFAULT_DECAY_LAMBDA
      : DEFAULT_DECAY_LAMBDA;

    // Calculate days since last seen
    const lastSeenDate = new Date(lastSeenAt);
    const diffMs = currentTime.getTime() - lastSeenDate.getTime();
    const daysSinceLastSeen = Math.max(0, diffMs / (1000 * 60 * 60 * 24));

    // Apply exponential decay
    const salience = initialSalience * Math.exp(-lambda * daysSinceLastSeen);

    return {
      salience: Math.max(0, Math.min(1, salience)), // Clamp to [0, 1]
      daysSinceLastSeen,
      lambda,
      shouldArchive: salience < SALIENCE_ARCHIVE_THRESHOLD,
    };
  }

  /**
   * Apply reinforcement boost when memory is accessed.
   * Increases salience by REINFORCEMENT_BOOST, capped at 1.0.
   */
  reinforce(currentSalience: number): number {
    return Math.min(1.0, currentSalience + REINFORCEMENT_BOOST);
  }

  /**
   * Get decay configuration for a sector.
   */
  getSectorConfig(sector: HSGPrimarySector): DecayConfig {
    return SECTOR_DECAY_CONFIG[sector];
  }

  /**
   * Calculate time until memory reaches archive threshold.
   */
  timeToArchive(input: {
    currentSalience: number;
    sector?: HSGPrimarySector;
  }): number {
    const { currentSalience, sector } = input;
    const lambda = sector
      ? SECTOR_DECAY_CONFIG[sector]?.lambda ?? DEFAULT_DECAY_LAMBDA
      : DEFAULT_DECAY_LAMBDA;

    if (currentSalience <= SALIENCE_ARCHIVE_THRESHOLD) {
      return 0;
    }

    // Solve for t: threshold = salience × e^(-λ × t)
    // t = -ln(threshold / salience) / λ
    return -Math.log(SALIENCE_ARCHIVE_THRESHOLD / currentSalience) / lambda;
  }
}

/**
 * Singleton instance for convenience.
 */
export const decayService = new DecayService();
