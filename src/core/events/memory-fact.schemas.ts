/**
 * Payload of MemoryFactProposed.
 * Layer: Core
 *
 * The row in memory_facts is written only after this payload passes
 * the ASI06 gate in the domain policy.
 */

import { z } from 'zod';

export const MEMORY_FACT_PROPOSED = 'MemoryFactProposed' as const;

/** A fact below this confidence needs confirmed: true. */
export const MEMORY_FACT_MIN_CONFIDENCE = 0.7;

export const MEMORY_FACT_ID_MAX = 255;
export const MEMORY_FACT_ORIGIN_MAX = 512;
export const MEMORY_FACT_TEXT_MAX = 2_000;
export const MEMORY_FACT_EVIDENCE_MAX = 20_000;
export const MEMORY_FACT_OPEN_LIMIT_DEFAULT = 50;
export const MEMORY_FACT_OPEN_LIMIT_MAX = 200;

const canonicalInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

export const MemoryFactProposedPayloadSchema = z.object({
  tenantId: z.string().min(1).max(MEMORY_FACT_ID_MAX),
  userId: z.string().min(1).max(MEMORY_FACT_ID_MAX),
  source: z.string().min(1).max(MEMORY_FACT_TEXT_MAX),
  relationship: z.string().min(1).max(MEMORY_FACT_TEXT_MAX),
  destination: z.string().min(1).max(MEMORY_FACT_TEXT_MAX),
  confidence: z.number().min(0).max(1),
  weight: z.number().min(0).max(1),
  originEventId: z.string().min(1).max(MEMORY_FACT_ORIGIN_MAX),
  confirmed: z.boolean(),
  validFrom: canonicalInstant.nullable(),
  validTo: canonicalInstant.nullable(),
});

export type MemoryFactProposedPayload = z.infer<typeof MemoryFactProposedPayloadSchema>;
