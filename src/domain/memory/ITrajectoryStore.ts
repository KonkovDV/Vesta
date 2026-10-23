/**
 * ITrajectoryStore — Durable persistence port for learning trajectories.
 *
 * Provides authoritative storage for TIM intelligence results and contrastive
 * success/failure trajectory entries. Implemented in Infrastructure.
 *
 * @layer Domain
 */

import type { ContrastiveTrajectoryEntry } from './IContrastiveLessonLearner';
import type { TrajectoryIntelligenceResult } from './ITrajectoryIntelligenceExtractor';

export interface ITrajectoryStore {
  /** Persist a TIM trajectory intelligence result. */
  saveIntelligence(result: TrajectoryIntelligenceResult): Promise<void>;

  /** List stored TIM intelligence results, newest first. */
  listIntelligence(limit?: number): Promise<readonly TrajectoryIntelligenceResult[]>;

  /** Persist a contrastive trajectory entry. */
  saveContrastiveTrajectory(entry: ContrastiveTrajectoryEntry): Promise<void>;

  /** List stored contrastive trajectory entries for one root-cause category. */
  listContrastiveByCategory(rootCauseCategory: string): Promise<readonly ContrastiveTrajectoryEntry[]>;
}