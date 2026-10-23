/**
 * Shared Use Case utilities.
 * Layer: Application
 *
 * SSOT for shared types and helpers used across all Use Case files.
 * Eliminates copy-paste of getCorrelationId, UseCaseResult, publishAggregateEvents.
 */

import { DomainEvent } from '../../../domain/events/event-store.interface';
import { EventStoreService } from '../../services/EventStoreService';
import { RequestContext } from '../../context/request-context';

/**
 * Safe correlationId extraction from ambient RequestContext.
 * Returns undefined when no context is available (e.g. background jobs).
 */
export function getCorrelationId(): string | undefined {
  try {
    return RequestContext.getCorrelationId();
  } catch {
    return undefined;
  }
}

/**
 * Unified result type for Application Use Cases.
 *
 * Convention:
 * - ok=true  → data is present
 * - ok=false → error is present with machine-readable code + human message
 */
export interface UseCaseResult<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/**
 * Publish domain events via Outbox-aware EventStoreService.
 *
 * Invariants (AGENTS.md Hard Invariant #4):
 * - All events go through EventStoreService → Outbox → EventBus worker.
 * - Direct EventBus publish is forbidden for domain ES events.
 */
export async function publishAggregateEvents(
  events: DomainEvent[],
  eventStore: EventStoreService,
): Promise<void> {
  if (!events || events.length === 0) return;
  await eventStore.saveDomainEvents(events);
}
