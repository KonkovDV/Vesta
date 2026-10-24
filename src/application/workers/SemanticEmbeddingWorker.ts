/**
 * SemanticEmbeddingWorker — Background consumer for event vectorization.
 * Layer: Application (Workers)
 *
 * Reads events from the event store in batches, generates embeddings via
 * IEventVectorizer, and writes them back. Runs as a non-blocking background loop
 * that never blocks saveEvents().
 *
 * When the store reads in commit order (ICommitOrderReader), the worker follows a
 * (tx_id, gsn) cursor and keeps it in IConsumerCursorStore after each written
 * batch, so it neither skips an event that committed late (MP-K23) nor starts
 * over after a restart. A store without that reader falls back to a gsn cursor
 * held in memory, which can skip such an event.
 *
 * @since v2.9.0 — Этап 6 (Semantic Event Sourcing)
 * @see PLANS/05_NEXT_PHASES/PROMPT_PHASE_4_SEMANTIC.md
 */

import type { IEventStore, DomainEvent } from '../../domain/events/event-store.interface';
import type { IEventVectorizer, EventEmbeddingUpdate } from '../../domain/memory/IEventVectorizer';
import {
  isCommitOrderReader,
  type CommitCursor,
  type IConsumerCursorStore,
} from '../../domain/events/commit-order.port';

export interface SemanticEmbeddingWorkerOptions {
  /** Batch size for vectorization (default: 20) */
  readonly batchSize: number;
  /** Interval between poll cycles in ms (default: 5000) */
  readonly pollIntervalMs: number;
  /** Feature flag — if false, worker does not start */
  readonly enabled: boolean;
  /** Name under which the cursor is stored (default: semantic-embedding) */
  readonly consumerName?: string;
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
  private cursor: CommitCursor | null = null;
  private cursorLoaded = false;
  private _stopped = false;

  constructor(
    private readonly eventStore: IEventStore,
    private readonly vectorizer: IEventVectorizer,
    private readonly options: SemanticEmbeddingWorkerOptions,
    private readonly logger: WorkerLogger,
    private readonly cursorStore?: IConsumerCursorStore,
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
      reader: isCommitOrderReader(this.eventStore) ? 'commit-order' : 'gsn',
      durableCursor: this.cursorStore !== undefined,
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
      const { events, next } = await this.readBatch(opts.batchSize);

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

      // Advance only after the embeddings are written: a crash in between repeats
      // the batch, which is harmless because the update is idempotent.
      if (next !== undefined) {
        if (next) await this.cursorStore?.saveConsumerCursor(this.consumerName, next);
        this.cursor = next;
      } else {
        const lastEvent = events[events.length - 1];
        if (lastEvent.gsn !== undefined) {
          this.lastProcessedGsn = lastEvent.gsn;
        }
      }

      this.logger.info('[SemanticEmbeddingWorker] Batch vectorized', {
        batchSize: events.length,
        durationMs,
        dimension: this.vectorizer.dimensions,
        ...(next !== undefined ? { cursor: this.cursor } : { lastGsn: this.lastProcessedGsn }),
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

  /** `next` is undefined when the store has no commit-order reader. */
  private async readBatch(limit: number): Promise<{ events: DomainEvent[]; next?: CommitCursor | null }> {
    if (!isCommitOrderReader(this.eventStore)) {
      return { events: await this.eventStore.getEventsByGsnRange(this.lastProcessedGsn, limit) };
    }
    if (!this.cursorLoaded) {
      this.cursor = (await this.cursorStore?.loadConsumerCursor(this.consumerName)) ?? null;
      this.cursorLoaded = true;
    }
    const page = await this.eventStore.getCommittedEventsAfter(this.cursor, limit);
    return { events: page.events, next: page.cursor };
  }

  private get consumerName(): string {
    return this.options.consumerName ?? 'semantic-embedding';
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
