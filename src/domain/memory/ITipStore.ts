/**
 * ITipStore — Durable persistence port for structured learning tips.
 *
 * Stores actionable guidance produced by the TIM pipeline so it can later be
 * retrieved for prompt injection and operator inspection.
 *
 * @layer Domain
 */

import type { StructuredTip, TipCategory } from './IContextualTipGenerator';

export interface TipStoreFilter {
  readonly category?: TipCategory;
  readonly taskDomain?: string;
  readonly minPriority?: number;
}

export interface TipFeedbackState {
  readonly tipId: string;
  readonly used: boolean;
  readonly helpful: boolean;
  readonly recordedAt: string;
}

export interface ITipStore {
  /** Persist a structured tip. */
  saveTip(tip: StructuredTip): Promise<void>;

  /** List stored tips using a lightweight query filter. */
  listTips(filter?: TipStoreFilter): Promise<readonly StructuredTip[]>;

  /** Persist the latest known usage/helpfulness state for a tip. */
  recordTipFeedback?(feedback: TipFeedbackState): Promise<void>;

  /** List the latest persisted usage/helpfulness state per tip. */
  listTipFeedback?(): Promise<readonly TipFeedbackState[]>;
}