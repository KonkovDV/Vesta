/**
 * SemanticEmbeddingWorker — Background consumer for event vectorization.
 * Layer: Application (Workers)
 *
 * Reads events from the event store in batches, generates embeddings via
 * IEventVectorizer, and writes them back. Runs as a non-blocking background loop
 * that never blocks saveEvents().
 *
 * The worker reads in commit order (ICommitOrderReader): it follows a (tx_id, gsn)
 * cursor and keeps it in IConsumerCursorStore after each written batch, so it
 * neither skips an event that committed late (MP-K23) nor starts over after a
 * restart. A store that cannot read in commit order is not read at all: a gsn
 * cursor would skip such an event.
 *
 * `event_consumer_lag_seconds{consumer}` is the age of the oldest committed event
 * the worker has not processed, measured from that event's timestamp. It counts
 * an event that an open transaction holds back, so a long transaction anywhere in
 * the cluster shows up as lag. Zero means nothing waits.
 *
 * @since v2.9.0 — Этап 6 (Semantic Event Sourcing)
 * @see PLANS/05_NEXT_PHASES/PROMPT_PHASE_4_SEMANTIC.md
 */

import type { IEventStore, DomainEvent } from '../../domain/events/event-store.interface';
import type { IEventVectorizer, EventEmbeddingUpdate } from '../../domain/memory/IEventVectorizer';
import {
  isCommitOrderReader,
  type CommitCursor,
  type CommittedEventsPage,
  type IConsumerCursorStore,
} from '../../domain/events/commit-order.port';
import { getOrCreateGauge } from '../../monitoring';

const CONSUMER_LAG_SECONDS = getOrCreateGauge(
  'event_consumer_lag_seconds',
  'Age of the oldest committed event a journal consumer has not processed, in seconds; 0 when nothing waits',
  ['consumer'],
);

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
  private cursor: CommitCursor | null = null;
  private cursorLoaded = false;
  private _stopped = false;
  private unsupportedReported = false;

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

    if (!isCommitOrderReader(this.eventStore)) {
      this.reportUnsupportedStore();
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
      reader: 'commit-order',
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
    if (!isCommitOrderReader(this.eventStore)) {
      this.reportUnsupportedStore();
      return 0;
    }
    this.processing = true;

    try {
      const opts = this.getOptions();
      const page = await this.readBatch(opts.batchSize);
      this.recordLag(page);
      const { events } = page;

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
      if (page.cursor) await this.cursorStore?.saveConsumerCursor(this.consumerName, page.cursor);
      this.cursor = page.cursor;

      this.logger.info('[SemanticEmbeddingWorker] Batch vectorized', {
        batchSize: events.length,
        durationMs,
        dimension: this.vectorizer.dimensions,
        cursor: this.cursor,
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

  private async readBatch(limit: number): Promise<CommittedEventsPage> {
    const reader = this.eventStore as IEventStore & {
      getCommittedEventsAfter: (cursor: CommitCursor | null, limit?: number) => Promise<CommittedEventsPage>;
    };
    if (!this.cursorLoaded) {
      this.cursor = (await this.cursorStore?.loadConsumerCursor(this.consumerName)) ?? null;
      this.cursorLoaded = true;
    }
    return reader.getCommittedEventsAfter(this.cursor, limit);
  }

  /** The first returned event is the oldest unprocessed one; a held event waits behind it. */
  private recordLag(page: CommittedEventsPage): void {
    const oldest = page.events[0]?.timestamp ?? page.heldSince;
    const ageMs = oldest ? Date.now() - new Date(oldest).getTime() : 0;
    try {
      CONSUMER_LAG_SECONDS.set({ consumer: this.consumerName }, Math.max(0, ageMs) / 1000);
    } catch {
      // Metrics must never stop the worker.
    }
  }

  private reportUnsupportedStore(): void {
    if (this.unsupportedReported) return;
    this.unsupportedReported = true;
    this.logger.error(
      '[SemanticEmbeddingWorker] Not started: the event store cannot read in commit order, and a gsn cursor skips an event that commits late (MP-K23)',
    );
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
