/**
 * IUserFeedbackCollector — Domain interface for structured user feedback collection.
 *
 * Collects explicit and implicit user feedback on agent responses:
 * - Explicit: thumbs up/down, 1-5 rating, text corrections
 * - Implicit: regeneration (≈ negative), copy (≈ positive), follow-up (≈ insufficient)
 * - Preference: user edits agent output → diff = training signal
 *
 * Feedback is persisted via IEventStore (Outbox pattern) as `agentic.feedback.collected` events.
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @see Book Ch.13 "Human-in-the-Loop" — feedback loop
 * @see Anthropic Guide "Ground Truth / Evaluation" principle
 * @see CC-12 (Master Plan §8.12)
 */

import type { CorrelationId } from '@/ai-types';

/**
 * User feedback payload for a single response.
 */
export interface UserFeedback {
  readonly responseId: string;
  /** Agent ID that produced the response (required for aggregation). */
  readonly agentId?: string;
  readonly rating?: number;              // 1-5
  readonly thumbs?: 'up' | 'down';
  readonly correction?: string;          // user-edited text
  readonly implicit?: 'regenerated' | 'copied' | 'follow_up';
}

/**
 * Aggregated feedback summary for an agent over a time window.
 */
export interface FeedbackSummary {
  readonly agentId: string;
  readonly windowDays: number;
  readonly totalFeedback: number;
  readonly averageRating: number | null;
  readonly thumbsUp: number;
  readonly thumbsDown: number;
  readonly corrections: number;
  readonly implicitSignals: Readonly<Record<string, number>>;
}

/**
 * Structured user feedback collector.
 * Lifecycle: singleton.
 */
export interface IUserFeedbackCollector {
  /** Collect a feedback entry and persist as event. */
  collect(feedback: UserFeedback, correlationId: CorrelationId): Promise<void>;

  /** Get aggregated feedback for an agent over a time window. */
  getAggregatedFeedback(
    agentId: string,
    windowDays: number,
    correlationId: CorrelationId,
  ): Promise<FeedbackSummary>;
}
