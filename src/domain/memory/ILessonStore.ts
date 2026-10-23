/**
 * ILessonStore — Durable persistence port for extracted lessons and wisdom.
 *
 * Stores S2I lessons and consolidated macro-principles for later retrieval,
 * promotion, and audit.
 *
 * @layer Domain
 */

import type { ExtractedLesson, SamuleLevel } from '../agents/IS2iLessonExtractor';
import type { ConsolidatedPrinciple } from './IWisdomConsolidator';

export interface ILessonStore {
  /** Persist an extracted lesson. */
  saveLesson(lesson: ExtractedLesson): Promise<void>;

  /** List stored lessons, optionally filtered by SAMULE level. */
  listLessons(level?: SamuleLevel): Promise<readonly ExtractedLesson[]>;

  /** Persist a consolidated macro-principle. */
  savePrinciple(principle: ConsolidatedPrinciple): Promise<void>;

  /** List stored principles, optionally filtered by root-cause category. */
  listPrinciples(rootCauseCategory?: string): Promise<readonly ConsolidatedPrinciple[]>;
}