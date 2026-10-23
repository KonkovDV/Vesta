/**
 * SemanticEmbeddingWorker — Background consumer for event vectorization.
 * Layer: Application (Workers)
 *
 * Reads un-vectorized events from the event store in batches,
 * generates embeddings via IEventVectorizer, and writes them back.
 * Runs as a non-blocking background loop that never blocks saveEvents().
 *
 * @since v2.9.0 — Этап 6 (Semantic Event Sourcing)
 * @see PLANS/05_NEXT_PHASES/PROMPT_PHASE_4_SEMANTIC.md
 */

import type { IEventStore, DomainEvent } from '../../domain/events/event-store.interface';
import type { IEventVectorizer, EventEmbeddingUpdate } from '../../domain/memory/IEventVectorizer';

export interface SemanticEmbeddingWorkerOptions {
  /** Batch size for vectorization (default: 20) */
  readonly batchSize: number;
  /** Interval between poll cycles in ms (default: 5000) */
  readonly pollIntervalMs: number;
  /** Feature flag — if false, worker does not start */
  readonly enabled: boolean;
}

/** Minimal logger interface (subset of IStructuredLogger). */
interface WorkerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Background worker that vectorizes events asynchronously.
 *
 * Architecture: Application layer depends only on domain ports
 * (IEventStore, IEventVectorizer). Infrastructure details
 * (ONNX Runtime, pgvector) are abstracted away.
 */
export class SemanticEmbeddingWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private lastProcessedGsn: number | null = null;
  private _stopped = false;

  // TODO(Этап 6.1): Persist lastProcessedGsn across restarts (e.g. via config table
  // or dedicated cursor store). Currently resets to null on restart, causing
  // re-vectorization of events that already have embeddings. Not harmful
  // (idempotent) but wastes compute. Also consider filtering by
  // `semantic_embedding IS NULL` in getEventsByGsnRange for efficiency.

  constructor(
    private readonly eventStore: IEventStore,
    private readonly vectorizer: IEventVectorizer,
    private readonly options: SemanticEmbeddingWorkerOptions,
    private readonly logger: WorkerLogger,
  ) {}

  /**
   * Start the background polling loop.
   * Initializes the vectorizer if not already ready.
   */
  async start(): Promise<void> {
    const opts = this.getOptions();
    if (!opts.enabled) {
      this.logger.info('[SemanticEmbeddingWorker] Disabled by feature flag');
      return;
    }

    if (!this.vectorizer.isReady) {
      await this.vectorizer.initialize();
    }

    this._stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, opts.pollIntervalMs);
    // Allow Node.js to exit even if timer is active
    this.timer.unref();

    this.logger.info('[SemanticEmbeddingWorker] Started', {
      batchSize: opts.batchSize,
      pollIntervalMs: opts.pollIntervalMs,
    });
  }

  /** Stop the background loop gracefully. */
  stop(): void {
    this._stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('[SemanticEmbeddingWorker] Stopped');
  }

  get isStopped(): boolean {
    return this._stopped;
  }

  /**
   * Process one batch of un-vectorized events.
   * Called by the timer; can also be called manually for testing.
   */
  async tick(): Promise<number> {
    if (this.processing || this._stopped) return 0;
    this.processing = true;

    try {
      const opts = this.getOptions();
      const events = await this.eventStore.getEventsByGsnRange(
        this.lastProcessedGsn,
        opts.batchSize,
      );

      if (events.length === 0) return 0;

      const texts = events.map((e) => this.eventToText(e));
      const startMs = Date.now();
      const vectors = await this.vectorizer.vectorizeBatch(texts);
      const durationMs = Date.now() - startMs;

      const updates: EventEmbeddingUpdate[] = events.map((e, i) => ({
        eventId: e.eventId,
        embedding: vectors[i],
      }));

      await this.eventStore.updateEventEmbeddings(updates);

      // Track last processed GSN for incremental polling
      const lastEvent = events[events.length - 1];
      if (lastEvent.gsn !== undefined) {
        this.lastProcessedGsn = lastEvent.gsn;
      }

      this.logger.info('[SemanticEmbeddingWorker] Batch vectorized', {
        batchSize: events.length,
        durationMs,
        dimension: this.vectorizer.dimensions,
        lastGsn: this.lastProcessedGsn,
      });

      return events.length;
    } catch (error) {
      this.logger.error('[SemanticEmbeddingWorker] Batch failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      this.processing = false;
    }
  }

  /**
   * Convert a domain event to a searchable text representation.
   * Format: "EventType: {serialized payload}"
   */
  private eventToText(event: DomainEvent): string {
    return `${event.type}: ${JSON.stringify(event.payload)}`;
  }

  private getOptions(): SemanticEmbeddingWorkerOptions {
    return this.options;
  }
}
