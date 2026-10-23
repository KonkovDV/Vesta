/**
 * ProposeMemoryFact — the only application path that stores a memory fact.
 * Layer: Application
 *
 * The gate runs before the event is appended. The store runs it again and is
 * the only writer of memory_facts. A rejected proposal does not touch either.
 */

import { MEMORY_FACT_PROPOSED } from '../../core/events/memory-fact.schemas';
import {
  GEN_AI_MEMORY_RECORD_COUNT,
  GEN_AI_MEMORY_RECORD_ID,
} from '../../monitoring/genai-semconv';
import { markGenAiResult, withCreateMemorySpan } from '../../monitoring';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';
import { EventFactory } from '../../domain/events/event-store.interface';
import type { IEventStore } from '../../domain/events/event-store.interface';
import type {
  IMemoryFactStore,
  MemoryFactGateReason,
  MemoryFactProposalInput,
  MemoryFactRecord,
} from '../../domain/memory/IMemoryFactStore';
import { assessMemoryFactProposal } from '../../domain/memory/memory-fact-policy';

export type MemoryFactDecision =
  | {
      accepted: true;
      eventId: string;
      fact: MemoryFactRecord;
      supersededId: string | null;
    }
  | {
      accepted: false;
      reason: MemoryFactGateReason | 'persist_failed';
      eventId?: string;
    };

export class ProposeMemoryFact {
  constructor(
    private readonly eventStore: Pick<IEventStore, 'saveEvents'>,
    private readonly facts: IMemoryFactStore,
    private readonly logger?: Pick<IStructuredLogger, 'warn'>,
  ) {}

  async execute(input: MemoryFactProposalInput): Promise<MemoryFactDecision> {
    return withCreateMemorySpan(async (span) => {
      span.setAttribute(GEN_AI_MEMORY_RECORD_COUNT, 1);
      const assessed = assessMemoryFactProposal(input);
      if (!assessed.ok) {
        markGenAiResult(span, assessed.reason);
        return { accepted: false, reason: assessed.reason };
      }

      const payload: Record<string, unknown> = { ...assessed.value };
      const event = EventFactory.createBaseEvent(
        `memory-fact:${assessed.value.tenantId}:${assessed.value.userId}`,
        MEMORY_FACT_PROPOSED,
        payload,
        input.correlationId,
        assessed.value.originEventId,
      );

      try {
        const saved = await this.eventStore.saveEvents([event]);
        if (saved.errors && saved.errors.length > 0) {
          this.warnPersist(event.eventId, saved.errors[0]?.error ?? 'event store rejected the proposal');
          markGenAiResult(span, 'persist_failed');
          return { accepted: false, reason: 'persist_failed', eventId: event.eventId };
        }

        const recorded = await this.facts.recordProposed(event);
        if (!recorded.written) {
          this.warnPersist(event.eventId, recorded.reason);
          markGenAiResult(span, recorded.reason);
          return { accepted: false, reason: recorded.reason, eventId: event.eventId };
        }

        span.setAttribute(GEN_AI_MEMORY_RECORD_ID, recorded.fact.id);
        markGenAiResult(span);
        return {
          accepted: true,
          eventId: event.eventId,
          fact: recorded.fact,
          supersededId: recorded.supersededId,
        };
      } catch (error) {
        this.warnPersist(event.eventId, error instanceof Error ? error.message : String(error));
        markGenAiResult(span, 'persist_failed');
        return { accepted: false, reason: 'persist_failed', eventId: event.eventId };
      }
    });
  }

  private warnPersist(eventId: string, error: string): void {
    this.logger?.warn('Memory fact was not stored', { eventId, error });
  }
}
