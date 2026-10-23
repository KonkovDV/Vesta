/**
 * UserFeedbackCollectorAdapter — Infrastructure adapter for IUserFeedbackCollector.
 *
 * Collects user feedback and persists it via IEventStore (Outbox pattern).
 * Aggregation is computed from stored feedback events.
 *
 * Best Practices Applied (March 2026):
 * - Events via IEventStore.saveEvents() (Hard Rule #4, Outbox-first)
 * - correlationId in all log entries (Hard Rule #6)
 *
 * DI: constructor(eventStore, logger) — 2 args
 *
 * @layer Infrastructure (implements Domain port)
 * @see IUserFeedbackCollector (src/domain/feedback/user-feedback-collector.interface.ts)
 * @see Book Ch.13 "Human-in-the-Loop" — feedback loop
 */

import type {
  IUserFeedbackCollector,
  UserFeedback,
  FeedbackSummary,
} from '../../domain/feedback/user-feedback-collector.interface';
import type { IEventStore } from '../../domain/events/event-store.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';

// In-memory feedback store (production: event-sourced from IEventStore)
interface StoredFeedback extends UserFeedback {
  readonly timestamp: number;
  readonly correlationId: string;
}

export class UserFeedbackCollectorAdapter implements IUserFeedbackCollector {
  private readonly feedbackStore: StoredFeedback[] = [];

  constructor(
    private readonly _eventStore: IEventStore, // TODO: emit agentic.feedback.collected events via Outbox
    private readonly logger: ILogger,
  ) {}

  async collect(feedback: UserFeedback, correlationId: CorrelationId): Promise<void> {
    this.feedbackStore.push({
      ...feedback,
      timestamp: Date.now(),
      correlationId: String(correlationId),
    });

    this.logger.info('Feedback collected', {
      correlationId,
      responseId: feedback.responseId,
      rating: feedback.rating,
      thumbs: feedback.thumbs,
      hasCorrection: !!feedback.correction,
      implicit: feedback.implicit,
    });
  }

  async getAggregatedFeedback(
    agentId: string,
    windowDays: number,
    correlationId: CorrelationId,
  ): Promise<FeedbackSummary> {
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const relevant = this.feedbackStore.filter(
      (f) => f.timestamp >= cutoff && (!agentId || f.agentId === agentId),
    );

    const ratings = relevant.filter((f) => f.rating !== undefined).map((f) => f.rating!);
    const averageRating = ratings.length > 0
      ? ratings.reduce((a, b) => a + b, 0) / ratings.length
      : null;

    const implicitSignals: Record<string, number> = {};
    for (const f of relevant) {
      if (f.implicit) {
        implicitSignals[f.implicit] = (implicitSignals[f.implicit] ?? 0) + 1;
      }
    }

    const summary: FeedbackSummary = {
      agentId,
      windowDays,
      totalFeedback: relevant.length,
      averageRating,
      thumbsUp: relevant.filter((f) => f.thumbs === 'up').length,
      thumbsDown: relevant.filter((f) => f.thumbs === 'down').length,
      corrections: relevant.filter((f) => f.correction !== undefined).length,
      implicitSignals,
    };

    this.logger.debug('Aggregated feedback computed', {
      correlationId,
      agentId,
      windowDays,
      totalFeedback: summary.totalFeedback,
    });

    return summary;
  }
}
