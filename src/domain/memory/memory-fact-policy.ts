/**
 * Gate for MemoryFactProposed (roadmap 6.3, OWASP ASI06).
 * Layer: Domain
 *
 * A fact is accepted only with an upstream source, enough confidence
 * (or an explicit confirmation), and no untrusted marker unless that
 * confirmation is present. Evidence is examined and not returned.
 */

import {
  MEMORY_FACT_EVIDENCE_MAX,
  MEMORY_FACT_ID_MAX,
  MEMORY_FACT_MIN_CONFIDENCE,
  MEMORY_FACT_OPEN_LIMIT_DEFAULT,
  MEMORY_FACT_OPEN_LIMIT_MAX,
  MEMORY_FACT_ORIGIN_MAX,
  MEMORY_FACT_PROPOSED,
  MEMORY_FACT_TEXT_MAX,
  MemoryFactProposedPayloadSchema,
  type MemoryFactProposedPayload,
} from '../../core/events/memory-fact.schemas';
import type { DomainEvent } from '../events/event-store.interface';
import type { MemoryFactGateReason, MemoryFactProposalInput } from './IMemoryFactStore';

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const UNTRUSTED_MARKER = /(?:<\s*\/?\s*untrusted\b|&lt;\s*\/?\s*untrusted\b)/i;

export type MemoryFactAssessment =
  | { ok: true; value: MemoryFactProposedPayload }
  | { ok: false; reason: MemoryFactGateReason };

export function containsUntrustedMarker(text: string): boolean {
  return UNTRUSTED_MARKER.test(text);
}

export function memoryFactOpenLimit(limit: number | undefined): number {
  if (limit == null) return MEMORY_FACT_OPEN_LIMIT_DEFAULT;
  if (!Number.isFinite(limit)) return 0;
  const whole = Math.floor(limit);
  if (whole <= 0) return 0;
  return Math.min(whole, MEMORY_FACT_OPEN_LIMIT_MAX);
}

export function assessMemoryFactProposal(input: MemoryFactProposalInput): MemoryFactAssessment {
  const tenantId = readBounded(input.tenantId, MEMORY_FACT_ID_MAX);
  const userId = readBounded(input.userId, MEMORY_FACT_ID_MAX);
  const source = readBounded(input.source, MEMORY_FACT_TEXT_MAX);
  const relationship = readBounded(input.relationship, MEMORY_FACT_TEXT_MAX);
  const destination = readBounded(input.destination, MEMORY_FACT_TEXT_MAX);
  const origin = readOrigin(input.originEventId);
  const confidence = readUnitInterval(input.confidence);
  const confirmed = readConfirmed(input.confirmed);
  const evidence = readEvidence(input.evidence);
  const weight = input.weight == null ? confidence : readUnitInterval(input.weight);
  const validFrom = readInstant(input.validFrom);
  const validTo = readInstant(input.validTo);

  if (
    tenantId == null
    || userId == null
    || source == null
    || relationship == null
    || destination == null
    || confidence == null
    || confirmed == null
    || evidence === undefined
    || weight == null
    || validFrom === undefined
    || validTo === undefined
    || (validFrom != null && validTo != null && validTo < validFrom)
  ) {
    return { ok: false, reason: 'invalid_payload' };
  }

  if (!origin.ok) {
    return { ok: false, reason: origin.reason };
  }

  const marked = [tenantId, userId, source, relationship, destination, origin.value, evidence ?? '']
    .some((part) => containsUntrustedMarker(part));

  if (marked && !confirmed) {
    return { ok: false, reason: 'untrusted_unconfirmed' };
  }

  if (!confirmed && confidence < MEMORY_FACT_MIN_CONFIDENCE) {
    return { ok: false, reason: 'low_confidence' };
  }

  const value: MemoryFactProposedPayload = {
    tenantId,
    userId,
    source,
    relationship,
    destination,
    confidence,
    weight,
    originEventId: origin.value,
    confirmed,
    validFrom,
    validTo,
  };

  const parsed = MemoryFactProposedPayloadSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_payload' };
  }

  return { ok: true, value: parsed.data };
}

export function assessMemoryFactEvent(event: DomainEvent): MemoryFactAssessment {
  const eventType = event.type || event.eventType;
  if (eventType !== MEMORY_FACT_PROPOSED) {
    return { ok: false, reason: 'invalid_payload' };
  }

  const parsed = MemoryFactProposedPayloadSchema.safeParse(event.payload);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_payload' };
  }

  return assessMemoryFactProposal(parsed.data);
}

function readBounded(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function readOrigin(
  value: unknown,
): { ok: true; value: string } | { ok: false; reason: 'missing_source' | 'invalid_payload' } {
  if (value == null) return { ok: false, reason: 'missing_source' };
  if (typeof value !== 'string') return { ok: false, reason: 'invalid_payload' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'missing_source' };
  if (trimmed.length > MEMORY_FACT_ORIGIN_MAX) return { ok: false, reason: 'invalid_payload' };
  return { ok: true, value: trimmed };
}

function readUnitInterval(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return null;
  }
  return value;
}

/** undefined and false are not confirmed. Any other type is invalid. */
function readConfirmed(value: unknown): boolean | null {
  if (value == null) return false;
  if (typeof value !== 'boolean') return null;
  return value;
}

/** null means there is no evidence. undefined means the evidence is unusable. */
function readEvidence(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  if (value.length > MEMORY_FACT_EVIDENCE_MAX) return undefined;
  return value;
}

/** null means absent. undefined means the instant is not usable. */
function readInstant(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== 'string' || !INSTANT.test(value.trim())) return undefined;
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}
