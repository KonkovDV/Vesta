/**
 * Mem0ResultNormalizer — Unified result normalization for Mem0 SDK responses.
 *
 * Handles differences between Platform (snake_case) and OSS (camelCase) SDKs,
 * normalizing all results into a consistent internal format.
 *
 * @module infrastructure/memory/normalizers
 * @phase Phase 1 — Foundation
 *
 * Ported from OpenClaw external/mem0/openclaw/index.ts:313-370
 */

import type {
  EnhancedMemoryResult,
  MemoryAddResult,
  MemoryAddResultItem,
} from '../../../domain/memory/MemoryScope';

// ── Raw SDK types (duck-typed shapes from mem0ai Platform & OSS SDKs) ──

/** Raw memory item shape — union of Platform (snake_case) and OSS (camelCase) fields. */
export interface Mem0RawItem {
  id?: string;
  memory_id?: string;
  memory?: string;
  text?: string;
  content?: string;
  score?: number;
  categories?: string[];
  source?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
  event?: string;
  status?: string;
}

/** Raw search result — Platform returns flat array; OSS wraps in { results }. */
export interface Mem0RawSearchResult {
  results?: Mem0RawItem[];
}

/** Raw add result item — extends Mem0RawItem with event tracking fields. */
export interface Mem0RawAddItem extends Mem0RawItem {
  metadata?: { event?: string } & Record<string, unknown>;
}

/** Raw add result — either { results: [...] } or flat array. */
export interface Mem0RawAddResult {
  results?: Mem0RawAddItem[];
}

// ── Normalizers ────────────────────────────────────────────────────

/**
 * Normalize a single raw memory item from either Platform or OSS SDK.
 *
 * Handles field name differences:
 * - id / memory_id
 * - memory / text / content
 * - user_id / userId
 * - created_at / createdAt
 * - updated_at / updatedAt
 *
 * Ported from Mem0 plugin index.ts:314-325
 */
export function normalizeMemoryItem(raw: Mem0RawItem): EnhancedMemoryResult {
  return {
    id: raw.id ?? raw.memory_id ?? '',
    content: raw.memory ?? raw.text ?? raw.content ?? '',
    score: raw.score,
    categories: raw.categories,
    source: raw.source,
    metadata: raw.metadata,
    createdAt: raw.created_at ?? raw.createdAt,
    updatedAt: raw.updated_at ?? raw.updatedAt,
  };
}

/**
 * Normalize search results from either SDK format.
 *
 * Platform API returns a flat array; OSS returns `{ results: [...] }`.
 *
 * Ported from Mem0 plugin index.ts:327-333
 */
export function normalizeSearchResults(raw: Mem0RawSearchResult | Mem0RawItem[]): EnhancedMemoryResult[] {
  if (Array.isArray(raw)) return raw.map(normalizeMemoryItem);
  if (raw?.results && Array.isArray(raw.results)) {
    return raw.results.map(normalizeMemoryItem);
  }
  return [];
}

/**
 * Normalize add/store result with event tracking.
 *
 * Handles:
 * - `{ results: [...] }` shape (both SDKs)
 * - Flat array (platform without output_format)
 * - Event detection: ADD / UPDATE / DELETE / NOOP
 * - PENDING status → treated as ADD
 *
 * Ported from Mem0 plugin index.ts:335-370
 */
export function normalizeAddResult(raw: Mem0RawAddResult | Mem0RawAddItem[]): MemoryAddResult {
  // Shape: { results: [...] }
  if (!Array.isArray(raw) && raw?.results && Array.isArray(raw.results)) {
    return {
      results: raw.results.map((r: Mem0RawAddItem): MemoryAddResultItem => ({
        id: r.id ?? r.memory_id ?? '',
        memory: r.memory ?? r.text ?? '',
        event: (r.event ?? r.metadata?.event ?? 'ADD') as MemoryAddResultItem['event'],
      })),
    };
  }

  // Shape: flat array (platform without output_format)
  if (Array.isArray(raw)) {
    return {
      results: raw.map((r: Mem0RawAddItem): MemoryAddResultItem => ({
        id: r.id ?? r.memory_id ?? '',
        memory: r.memory ?? r.text ?? '',
        event: (r.event ?? r.metadata?.event ?? 'ADD') as MemoryAddResultItem['event'],
      })),
    };
  }

  return { results: [] };
}
