/**
 * Mem0OptionsBuilder — Application port for Mem0 SDK option building.
 *
 * Contains configuration types and pure helper functions for building Mem0 SDK options.
 * Used by AutoRecallService and AutoCaptureService for option construction.
 *
 * Extracted from infrastructure/memory/helpers/Mem0OptionsBuilder.ts
 * to enforce Clean Architecture layer boundaries (Application→Domain, not Application→Infrastructure).
 *
 * @module application/ports
 * @layer Domain
 */

import type { Mem0AddOptions, Mem0SearchOptions } from './IMem0Provider';

// ── Config shape (from Zod schema) ─────────────────────────────────

/** Subset of Mem0Config needed by option builders */
export interface Mem0BuilderConfig {
  mode: 'platform' | 'open-source' | 'oss';
  userId: string;
  source: string;
  searchThreshold: number;
  topK: number;
  customInstructions?: string;
  customCategories?: Record<string, string>;
  enableGraph: boolean;
  /** Default agent_id for multi-agent scoping. */
  agentId?: string;
  /** Default app_id for multi-app scoping. */
  appId?: string;
  /** Enable server-side filter_memories on search. Platform only. */
  filterMemories?: boolean;
  /** Enable graph search in search operations. Platform only. */
  enableGraphSearch?: boolean;
  /**
   * Temporal decay half-life in days for chrono-ranking.
   * Older memories lose relevance exponentially. Default: 30 days. Set 0 to disable.
   * @phase Horizon 0 — Vector 9 (Chrono-Degradation)
   */
  decayHalfLifeDays?: number;
  /**
   * Minimum score floor for temporal decay (0-1). Default: 0.1.
   * Prevents ancient memories from becoming completely invisible.
   */
  decayMinScoreFloor?: number;
  /**
   * Enable entropy mass modulation for temporal decay. Default: true.
   * Memories with high entropy_mass metadata decay slower.
   * @phase Horizon 1 — Semantic Forgetting Curve
   */
  entropyMassEnabled?: boolean;
}

// ── categoriesToArray ──────────────────────────────────────────────

/**
 * Convert Record<string, string> categories to the array format that
 * the mem0ai SDK expects.
 *
 * @example
 * categoriesToArray({ identity: "Name, age...", preferences: "Likes..." })
 * // → [{ identity: "Name, age..." }, { preferences: "Likes..." }]
 */
export function categoriesToArray(
  cats: Record<string, string>,
): Array<Record<string, string>> {
  return Object.entries(cats).map(([key, value]) => ({ [key]: value }));
}

// ── buildAddOptions ────────────────────────────────────────────────

/**
 * Build centralized add options for all store/capture operations.
 *
 * - Always sets `user_id` and `source`
 * - Platform mode: adds custom_instructions, custom_categories, enable_graph,
 *   output_format, metadata, infer, expiration_date, timestamp, async_mode, immutable
 * - OSS mode: user_id, source, run_id, metadata, infer
 */
export function buildAddOptions(
  config: Mem0BuilderConfig,
  userIdOverride?: string,
  runId?: string,
  extra?: {
    metadata?: Record<string, unknown>;
    infer?: boolean;
    expiration_date?: string;
    timestamp?: number;
    async_mode?: boolean;
    immutable?: boolean;
    agent_id?: string;
    app_id?: string;
  },
): Mem0AddOptions {
  const opts: Mem0AddOptions = {
    user_id: userIdOverride || config.userId,
    source: config.source,
  };
  if (runId) opts.run_id = runId;

  // Entity scoping from config or per-call override
  const agentId = extra?.agent_id || config.agentId;
  const appId = extra?.app_id || config.appId;
  if (agentId) opts.agent_id = agentId;
  if (appId) opts.app_id = appId;

  // Metadata and control parameters (both platform & OSS)
  if (extra?.metadata) opts.metadata = extra.metadata;
  if (extra?.infer !== undefined) opts.infer = extra.infer;

  // Platform mode gets additional options
  if (config.mode === 'platform') {
    if (config.customInstructions) opts.custom_instructions = config.customInstructions;
    if (config.customCategories) {
      opts.custom_categories = categoriesToArray(config.customCategories);
    }
    opts.enable_graph = config.enableGraph;
    opts.output_format = 'v1.1'; // Structured AddResult with event tracking

    // Platform-only extras
    if (extra?.expiration_date) opts.expiration_date = extra.expiration_date;
    if (extra?.timestamp != null) opts.timestamp = extra.timestamp;
    if (extra?.async_mode != null) opts.async_mode = extra.async_mode;
    if (extra?.immutable != null) opts.immutable = extra.immutable;
  }

  return opts;
}

// ── buildSearchOptions ─────────────────────────────────────────────

/**
 * Build centralized search options for all search/recall operations.
 *
 * Always enables:
 * - `keyword_search: true` — hybrid BM25 + semantic search
 * - `reranking: true` — result re-ranking
 * - `source` — filter by origin
 * - `threshold` — minimum similarity score
 *
 * Platform mode additionally supports:
 * - `filter_memories` — server-side precision filtering
 * - `enable_graph` — entity graph search
 * - `categories` — category filtering
 * - `filters` — v2 JSON compound filters
 */
export function buildSearchOptions(
  config: Mem0BuilderConfig,
  userIdOverride?: string,
  limit?: number,
  runId?: string,
  extra?: {
    filter_memories?: boolean;
    enable_graph?: boolean;
    categories?: string[];
    fields?: string[];
    filters?: Record<string, unknown>;
    agent_id?: string;
    app_id?: string;
    api_version?: string;
  },
): Mem0SearchOptions {
  const opts: Mem0SearchOptions = {
    user_id: userIdOverride || config.userId,
    top_k: limit ?? config.topK,
    limit: limit ?? config.topK,
    threshold: config.searchThreshold,
    keyword_search: true,
    reranking: true,
    source: config.source,
  };
  if (runId) opts.run_id = runId;

  // Entity scoping from config or per-call override
  const agentId = extra?.agent_id || config.agentId;
  const appId = extra?.app_id || config.appId;
  if (agentId) opts.agent_id = agentId;
  if (appId) opts.app_id = appId;

  // Platform-mode search enhancements
  if (config.mode === 'platform') {
    // filter_memories from per-call override or config default
    const filterMemories = extra?.filter_memories ?? config.filterMemories;
    if (filterMemories != null) opts.filter_memories = filterMemories;

    // Graph search from per-call override or config default
    const graphSearch = extra?.enable_graph ?? config.enableGraphSearch;
    if (graphSearch != null) opts.enable_graph = graphSearch;

    if (extra?.categories) opts.categories = extra.categories;
    if (extra?.fields) opts.fields = extra.fields;
    if (extra?.filters) opts.filters = extra.filters;
    if (extra?.api_version) opts.api_version = extra.api_version;
  }

  return opts;
}
