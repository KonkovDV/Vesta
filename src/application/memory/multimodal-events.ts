/**
 * Memory / Multimodal typed events facade.
 *
 * Layer: Application
 *
 * Scope (MEM-11.2):
 * - emits typed event "multimodal.content.processed" after successful multi-modal
 *   ingest into Session Memory;
 * - aligns with JSON Schema in
 *   05-PLUGIN_SYSTEM/14-typed-events-registry.md;
 * - uses EventStoreService (Outbox-first) as the only path to EventBus.
 */

import { RequestContext } from '../context/request-context';
import type { DomainEvent } from '../../domain/events/event-store.interface';
import { EventFactory } from '../../domain/events/event-store.interface';
import type {
  MultimodalContentType as MultimodalContentTypeCore,
  MultimodalContentProcessedPayloadV1,
} from '../../domain/events/typed-events';
import type { EventStoreService } from '../services/EventStoreService';

/**
 * Logical content type for multimodal.content.processed.
 *
 * Must stay in sync with JSON Schema enum "content_type"
 * in 05-PLUGIN_SYSTEM/14-typed-events-registry.md and
 * domain-level MultimodalContentType.
 */
export type MultimodalContentType = MultimodalContentTypeCore;

/**
 * TypeScript payload corresponding to multimodal.content.processed JSON Schema.
 * Reuses domain-level critical typed event payload.
 */
export type MultimodalContentProcessedEventPayload =
  MultimodalContentProcessedPayloadV1;

const MULTIMODAL_CONTENT_PROCESSED_TOPIC = 'multimodal.content.processed' as const;

async function persistMultimodalEvents(
  events: DomainEvent[],
  eventStoreService?: EventStoreService,
): Promise<void> {
  // Multimodal events are best-effort and must never break business logic.
  if (!eventStoreService) {
    return;
  }
  try {
    await eventStoreService.saveDomainEvents(events);
  } catch {
    // Intentionally swallow all errors (including DI misconfiguration).
  }
}

function resolveCorrelationId(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }

  try {
    const fromCtx = RequestContext.getCorrelationId();
    if (fromCtx) {
      return String(fromCtx);
    }
  } catch {
    // ignore – fall back to synthetic id below.
  }

  return `multimodal:${Date.now()}`;
}

export async function emitMultimodalContentProcessed(params: {
  /**
   * Aggregate id for EventStore (typically Memory SessionId).
   */
  aggregateId: string;
  /**
   * Logical identifier of processed content (usually message_id).
   */
  contentId: string;
  contentType: MultimodalContentType;
  processingResult: Record<string, unknown>;
  correlationId?: string;
  processingTimeMs?: number;
  modelUsed?: string;
  eventStoreService?: EventStoreService;
}): Promise<void> {
  try {
    const correlationId = resolveCorrelationId(params.correlationId);

    const payload: MultimodalContentProcessedEventPayload = {
      content_id: params.contentId,
      content_type: params.contentType,
      processing_result: params.processingResult,
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
      processing_time_ms: params.processingTimeMs,
      model_used: params.modelUsed,
    };

    const event = EventFactory.createBaseEvent(
      params.aggregateId,
      MULTIMODAL_CONTENT_PROCESSED_TOPIC,
      payload,
      correlationId,
    );

    await persistMultimodalEvents([event], params.eventStoreService);
  } catch {
    // best-effort
  }
}