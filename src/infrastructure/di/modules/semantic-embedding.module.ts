/**
 * Semantic Event Sourcing DI Module (Этап 6).
 *
 * Registers IEventVectorizer adapter and SemanticEmbeddingWorker.
 * Controlled by `embedding.enabled` config flag (default: false).
 *
 * @module infrastructure/di/modules
 * @phase semantic-event-sourcing
 */

import { container } from '../../../core/di/container';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import { EventVectorizerAdapter } from '../../memory/embedding/EventVectorizerAdapter';
import { SemanticEmbeddingWorker } from '../../../application/workers/SemanticEmbeddingWorker';
import type { IEventStore } from '../../../domain/events/event-store.interface';
import type { IEventVectorizer } from '../../../domain/memory/IEventVectorizer';
import { isConsumerCursorStore } from '../../../domain/events/commit-order.port';

/**
 * Initialize and start the SemanticEmbeddingWorker background process.
 * Called from bootstrap() after all DI registrations are complete.
 * Safe to call even when disabled — worker respects `enabled` flag.
 */
export async function initializeSemanticEmbeddingWorker(): Promise<void> {
  if (!container.isRegistered('SemanticEmbeddingWorker')) return;

  try {
    const worker = container.resolve<SemanticEmbeddingWorker>('SemanticEmbeddingWorker');
    await worker.start();
  } catch (error) {
    console.warn('⚠ SemanticEmbeddingWorker initialization failed, continuing without semantic search:',
      error instanceof Error ? error.message : String(error));
  }
}

export function registerSemanticEmbeddingModule(): void {
  if (container.isRegistered(DI_TOKENS.IEventVectorizer)) return;

  container.register(
    DI_TOKENS.IEventVectorizer,
    () => new EventVectorizerAdapter(
      {
        cacheDir: process.env.TRANSFORMERS_CACHE_DIR,
        model: process.env.EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
        dimension: Number(process.env.EMBEDDING_DIMENSION ?? 384),
      },
    ),
    { lifecycle: 'singleton', tags: ['semantic', 'embedding', 'memory'] },
  );

  container.register(
    'SemanticEmbeddingWorker',
    (c) => {
      const eventStore = c.resolve<IEventStore>(DI_TOKENS.IEventStore);
      return new SemanticEmbeddingWorker(
        eventStore,
        c.resolve<IEventVectorizer>(DI_TOKENS.IEventVectorizer),
        {
          batchSize: Number(process.env.EMBEDDING_BATCH_SIZE ?? 20),
          pollIntervalMs: Number(process.env.EMBEDDING_WORKER_INTERVAL_MS ?? 5000),
          enabled: process.env.SEMANTIC_SEARCH_ENABLED === 'true',
        },
        console,
        isConsumerCursorStore(eventStore) ? eventStore : undefined,
      );
    },
    { lifecycle: 'singleton', tags: ['semantic', 'worker', 'background'] },
  );
}
