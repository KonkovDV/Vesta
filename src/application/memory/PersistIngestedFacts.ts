/**
 * Turns an ingestion into one journal event and a fact proposal per line.
 * Layer: Application
 *
 * Text supplied by the caller is a user source. URL, PDF, and image text is
 * wrapped as untrusted and stored only when the caller sets confirmed.
 * An open fact with the same triple is left as it is.
 */

import { MEMORY_FACT_TEXT_MAX } from '../../core/events/memory-fact.schemas';
import { EventFactory } from '../../domain/events/event-store.interface';
import type { IEventStore } from '../../domain/events/event-store.interface';
import type { IMemoryFactStore } from '../../domain/memory/IMemoryFactStore';
import type {
  IngestedFactDecision,
  IngestedFactRecorder,
  IngestibleContentType,
} from '../../memory/ingestion/types';
import type { ProposeMemoryFact } from './ProposeMemoryFact';

export const CONTENT_INGESTED = 'ContentIngested';

const RELATIONSHIP = 'stated';

export class PersistIngestedFacts implements IngestedFactRecorder {
  constructor(
    private readonly events: Pick<IEventStore, 'saveEvents'>,
    private readonly proposals: Pick<ProposeMemoryFact, 'execute'>,
    private readonly facts: Pick<IMemoryFactStore, 'findOpen'>,
  ) {}

  async begin(input: {
    tenantId: string;
    userId: string;
    contentType: IngestibleContentType;
    contentHash: string;
    correlationId?: string;
  }): Promise<{ originEventId: string }> {
    const event = EventFactory.createBaseEvent(
      `content-ingest:${input.tenantId}:${input.userId}`,
      CONTENT_INGESTED,
      {
        tenantId: input.tenantId,
        userId: input.userId,
        contentType: input.contentType,
        contentHash: input.contentHash,
      },
      input.correlationId,
    );
    const saved = await this.events.saveEvents([event]);
    if (saved.errors && saved.errors.length > 0) {
      throw new Error(saved.errors[0]?.error ?? 'ingestion event was not stored');
    }
    return { originEventId: event.eventId };
  }

  async propose(input: {
    tenantId: string;
    userId: string;
    originEventId: string;
    fact: string;
    confidence: number;
    confirmed?: boolean;
    untrusted: boolean;
    correlationId?: string;
  }): Promise<IngestedFactDecision> {
    const source = input.userId;
    const destination = input.untrusted ? wrapUntrusted(input.fact) : input.fact.trim();
    if (destination.length === 0 || destination.length > MEMORY_FACT_TEXT_MAX) {
      return { accepted: false, reason: 'invalid_payload' };
    }

    const open = await this.facts.findOpen({
      tenantId: input.tenantId,
      userId: input.userId,
      entity: destination,
      limit: 50,
    });
    const existing = open.some((fact) =>
      fact.source === source
      && fact.relationship === RELATIONSHIP
      && fact.destination === destination,
    );
    if (existing) {
      return { accepted: true, alreadyStored: true };
    }

    const decision = await this.proposals.execute({
      tenantId: input.tenantId,
      userId: input.userId,
      source,
      relationship: RELATIONSHIP,
      destination,
      originEventId: input.originEventId,
      confidence: input.confidence,
      confirmed: input.untrusted ? input.confirmed === true : input.confirmed,
      correlationId: input.correlationId,
    });
    if (!decision.accepted) {
      return { accepted: false, reason: decision.reason };
    }
    return { accepted: true };
  }
}

function wrapUntrusted(fact: string): string {
  const room = MEMORY_FACT_TEXT_MAX - '<untrusted>\n\n</untrusted>'.length;
  const inner = fact.trim().slice(0, Math.max(0, room));
  return `<untrusted>\n${inner}\n</untrusted>`;
}
