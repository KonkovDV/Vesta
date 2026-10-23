/**
 * EbbinghausDecayAdapter — Infrastructure implementation of ITemporalDecayStrategy.
 *
 * Applies Ebbinghaus 2.0 temporal decay to memory search results using the pure
 * calculation functions from EbbinghausDecayCalculator (domain layer).
 *
 * Supports two modes:
 * 1. **Application-level decay** (default) — decay applied in JS after query.
 *    Works with any IVectorStore implementation.
 * 2. **SQL-level decay** (PgVectorStore) — decay computed in PostgreSQL query.
 *    More efficient for large result sets (planned extension).
 *
 * @module infrastructure/memory/temporal
 * @phase Ebbinghaus 2.0
 * @layer Infrastructure
 */

import type {
  ITemporalDecayStrategy,
  DecayAwareSearchResult,
  TemporalDecayOptions,
  ReinforcementParams,
} from '../../../domain/memory/ITemporalDecayStrategy';
import {
  calculateDecayMultiplier,
  calculateEffectiveAge,
  resolveLambda,
  lambdaToHalfLife,
  DEFAULT_MIN_FLOOR,
  REINFORCEMENT_BOOST,
} from '../../../domain/memory/EbbinghausDecayCalculator';
import { logger } from '../../logging/logger';

const log = logger.child({ component: 'EbbinghausDecayAdapter' });

/**
 * In-memory reinforcement store for tracking access counts.
 * Production deployments should persist this to database.
 */
interface ReinforcementEntry {
  lastAccessedAt: Date;
  accessCount: number;
  salienceBoost: number;
}

/**
 * Infrastructure adapter implementing Ebbinghaus 2.0 temporal decay.
 */
export class EbbinghausDecayAdapter implements ITemporalDecayStrategy {
  /**
   * In-memory reinforcement tracking.
   * Key: `${memoryId}:${namespace ?? 'default'}`
   */
  private readonly reinforcements = new Map<string, ReinforcementEntry>();

  applyDecay(
    results: DecayAwareSearchResult[],
    options: TemporalDecayOptions,
  ): DecayAwareSearchResult[] {
    const lambda = resolveLambda(options);

    if (lambda <= 0) {
      return results;
    }

    const halfLifeDays = lambdaToHalfLife(lambda);
    const minFloor = options.minScoreFloor ?? DEFAULT_MIN_FLOOR;
    const useEntropy = options.useEntropyMass ?? true;

    const decayed = results.map((result) => {
      const entropyMass = useEntropy
        ? this.extractEntropyMass(result.metadata)
        : 0;

      const effectiveAge = calculateEffectiveAge(result.ageDays, entropyMass);
      const multiplier = calculateDecayMultiplier(effectiveAge, halfLifeDays, minFloor);

      // Factor in reinforcement: boosted memories resist decay
      const key = this.reinforcementKey(result.id, result.namespace);
      const reinforcement = this.reinforcements.get(key);
      const finalMultiplier = reinforcement
        ? Math.min(1.0, multiplier + reinforcement.salienceBoost)
        : multiplier;

      return {
        ...result,
        score: result.originalScore * finalMultiplier,
        decayMultiplier: finalMultiplier,
        effectiveAgeDays: effectiveAge,
        accessCount: reinforcement?.accessCount ?? result.accessCount,
      };
    });

    // Re-sort by decayed score (highest first)
    decayed.sort((a, b) => b.score - a.score);

    return decayed;
  }

  calculateMultiplier(
    ageDays: number,
    options: TemporalDecayOptions,
  ): number {
    const lambda = resolveLambda(options);
    if (lambda <= 0) return 1.0;

    const halfLifeDays = lambdaToHalfLife(lambda);
    const minFloor = options.minScoreFloor ?? DEFAULT_MIN_FLOOR;

    return calculateDecayMultiplier(ageDays, halfLifeDays, minFloor);
  }

  async reinforce(params: ReinforcementParams): Promise<void> {
    const key = this.reinforcementKey(params.memoryId, params.namespace);
    const existing = this.reinforcements.get(key);
    const boost = params.boost ?? REINFORCEMENT_BOOST;

    if (existing) {
      existing.lastAccessedAt = new Date();
      existing.accessCount += 1;
      existing.salienceBoost = Math.min(1.0, existing.salienceBoost + boost);
    } else {
      this.reinforcements.set(key, {
        lastAccessedAt: new Date(),
        accessCount: 1,
        salienceBoost: boost,
      });
    }

    log.debug('Memory reinforced', {
      memoryId: params.memoryId,
      namespace: params.namespace,
      boost,
      newAccessCount: this.reinforcements.get(key)?.accessCount,
    });
  }

  private reinforcementKey(memoryId: string, namespace?: string): string {
    return `${memoryId}:${namespace ?? 'default'}`;
  }

  private extractEntropyMass(metadata?: Record<string, unknown>): number {
    if (!metadata?.entropy_mass) return 0;
    const num = Number(metadata.entropy_mass);
    if (isNaN(num)) return 0;
    return Math.max(0, Math.min(1, num));
  }
}
