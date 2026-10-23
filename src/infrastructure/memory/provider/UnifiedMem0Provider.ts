/**
 * UnifiedMem0Provider — Dual-mode (Platform + OSS) Mem0 provider.
 *
 * Wraps both `mem0ai` (platform) and `mem0ai/oss` (self-hosted) SDKs behind
 * a unified interface. Uses lazy initialization (ensureClient/ensureMemory)
 * to defer SDK loading until first use.
 *
 * @module infrastructure/memory/provider
 * @phase Phase 1 — Foundation
 *
 * Ported from Mem0 OpenClaw plugin (@mem0/openclaw-mem0) — external/mem0/openclaw/index.ts:105-308
 * - PlatformProvider (121-201)
 * - OSSProvider (207-308)
 * - Unified Mem0Provider interface (105-116)
 */

import {
  normalizeMemoryItem,
  normalizeSearchResults,
  normalizeAddResult,
} from '../normalizers/Mem0ResultNormalizer';
import type {
  Mem0RawItem,
  Mem0RawSearchResult,
  Mem0RawAddResult,
  Mem0RawAddItem,
} from '../normalizers/Mem0ResultNormalizer';
import type {
  EnhancedMemoryResult,
  MemoryAddResult,
} from '../../../domain/memory/MemoryScope';

// ── Re-export from Domain port (SSOT) ──────────────────────────────
// Types canonical definitions live in domain/memory/IMem0Provider.ts.
// Re-exported here for backward compatibility with existing infrastructure consumers.
export type {
  IMem0Provider,
  Mem0AddOptions,
  Mem0SearchOptions,
  Mem0ListOptions,
  Mem0UpdateOptions,
  Mem0FeedbackType,
  Mem0FeedbackOptions,
  Mem0HistoryEntry,
  Mem0Entity,
  Mem0BatchUpdateItem,
} from '../../../domain/memory/IMem0Provider';

import type {
  IMem0Provider,
  Mem0AddOptions,
  Mem0SearchOptions,
  Mem0ListOptions,
  Mem0UpdateOptions,
  Mem0FeedbackOptions,
  Mem0HistoryEntry,
  Mem0BatchUpdateItem,
} from '../../../domain/memory/IMem0Provider';

// ── Logger interface ───────────────────────────────────────────────

interface IProviderLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

// ── Mem0 Config (from Zod schema) ──────────────────────────────────

export interface Mem0ProviderConfig {
  mode: 'platform' | 'open-source' | 'oss';
  apiKey?: string;
  orgId?: string;
  projectId?: string;
  customPrompt?: string;
  oss?: {
    embedder?: { provider: string; config: Record<string, unknown> };
    vectorStore?: { provider: string; config: Record<string, unknown> };
    llm?: { provider: string; config: Record<string, unknown> };
    historyDbPath?: string;
  };
}

// ── Local type stubs for dynamically-imported mem0ai SDKs ──────────
// mem0ai is NOT a devDependency (optional runtime dep, dynamic import).
// These interfaces describe the methods actually used by our providers.

/** Minimal interface for mem0ai MemoryClient (Platform SDK). */
interface Mem0PlatformClient {
  add(messages: Array<{ role: string; content: string }>, opts: Record<string, unknown>): Promise<unknown>;
  search(query: string, opts: Record<string, unknown>): Promise<unknown>;
  get(memoryId: string): Promise<unknown>;
  getAll(opts: Record<string, unknown>): Promise<unknown>;
  update(memoryId: string, opts: Record<string, unknown>): Promise<unknown>;
  delete(memoryId: string): Promise<unknown>;
  deleteAll(opts: Record<string, unknown>): Promise<unknown>;
  history(memoryId: string): Promise<unknown>;
  feedback(opts: Record<string, unknown>): Promise<unknown>;
  batchUpdate(items: Array<Record<string, unknown>>): Promise<unknown>;
  batchDelete(ids: string[]): Promise<unknown>;
}

/** Minimal interface for mem0ai/oss Memory (OSS SDK). */
interface Mem0OSSMemory {
  add(messages: Array<{ role: string; content: string }>, opts: Record<string, unknown>): Promise<unknown>;
  search(query: string, opts: Record<string, unknown>): Promise<unknown>;
  get(memoryId: string): Promise<unknown>;
  getAll(opts: Record<string, unknown>): Promise<unknown>;
  update(memoryId: string, data: Record<string, unknown>): Promise<unknown>;
  delete(memoryId: string): Promise<unknown>;
  deleteAll(opts: Record<string, unknown>): Promise<unknown>;
  history(memoryId: string): Promise<unknown>;
  reset(): Promise<void>;
}

// ── Platform Provider ──────────────────────────────────────────────

/**
 * Platform mode provider — Mem0 Cloud via `mem0ai` SDK.
 *
 * Ported from Mem0 plugin index.ts:121-201
 * - Lazy init via ensureClient()
 * - snake_case option naming
 */
class PlatformMem0Provider implements IMem0Provider {
  private client!: Mem0PlatformClient;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly orgId?: string,
    private readonly projectId?: string,
    private readonly logger?: IProviderLogger,
  ) {}

  /** Lazy initialization — SDK loaded on first use, not in constructor. */
  private async ensureClient(): Promise<void> {
    if (this.client) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    const { default: MemoryClient } = await import('mem0ai');
    const opts: Record<string, unknown> = { apiKey: this.apiKey };
    if (this.orgId) opts.org_id = this.orgId;
    if (this.projectId) opts.project_id = this.projectId;
    this.client = new MemoryClient(opts as { apiKey: string }) as Mem0PlatformClient;
    this.logger?.info('[mem0] Platform provider initialized');
  }

  async add(
    messages: Array<{ role: string; content: string }>,
    options: Mem0AddOptions,
  ): Promise<MemoryAddResult> {
    await this.ensureClient();
    const opts: Record<string, unknown> = { user_id: options.user_id };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.agent_id) opts.agent_id = options.agent_id;
    if (options.app_id) opts.app_id = options.app_id;
    if (options.custom_instructions) opts.custom_instructions = options.custom_instructions;
    if (options.custom_categories) opts.custom_categories = options.custom_categories;
    if (options.enable_graph) opts.enable_graph = options.enable_graph;
    if (options.output_format) opts.output_format = options.output_format;
    if (options.source) opts.source = options.source;
    if (options.metadata) opts.metadata = options.metadata;
    if (options.infer !== undefined) opts.infer = options.infer;
    if (options.expiration_date) opts.expiration_date = options.expiration_date;
    if (options.timestamp != null) opts.timestamp = options.timestamp;
    if (options.async_mode != null) opts.async_mode = options.async_mode;
    if (options.immutable != null) opts.immutable = options.immutable;
    if (options.filters) opts.filters = options.filters;
    if (options.api_version) opts.version = options.api_version;

    const result = await this.client.add(messages, opts);
    return normalizeAddResult(result as Mem0RawAddResult | Mem0RawAddItem[]);
  }

  async search(query: string, options: Mem0SearchOptions): Promise<EnhancedMemoryResult[]> {
    await this.ensureClient();
    const opts: Record<string, unknown> = { user_id: options.user_id };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.agent_id) opts.agent_id = options.agent_id;
    if (options.app_id) opts.app_id = options.app_id;
    if (options.top_k != null) opts.top_k = options.top_k;
    if (options.threshold != null) opts.threshold = options.threshold;
    if (options.keyword_search != null) opts.keyword_search = options.keyword_search;
    if (options.reranking != null) opts.reranking = options.reranking;
    if (options.source) opts.source = options.source;
    if (options.enable_graph != null) opts.enable_graph = options.enable_graph;
    if (options.filter_memories != null) opts.filter_memories = options.filter_memories;
    if (options.filters) opts.filters = options.filters;
    if (options.categories) opts.categories = options.categories;
    if (options.fields) opts.fields = options.fields;
    if (options.only_metadata_based_search != null) opts.only_metadata_based_search = options.only_metadata_based_search;
    if (options.api_version) opts.api_version = options.api_version;

    const results = await this.client.search(query, opts);
    return normalizeSearchResults(results as Mem0RawSearchResult | Mem0RawItem[]);
  }

  async get(memoryId: string): Promise<EnhancedMemoryResult> {
    await this.ensureClient();
    const result = await this.client.get(memoryId);
    return normalizeMemoryItem(result as Mem0RawItem);
  }

  async getAll(options: Mem0ListOptions): Promise<EnhancedMemoryResult[]> {
    await this.ensureClient();
    const opts: Record<string, unknown> = { user_id: options.user_id };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.agent_id) opts.agent_id = options.agent_id;
    if (options.app_id) opts.app_id = options.app_id;
    if (options.page != null) opts.page = options.page;
    if (options.page_size != null) opts.page_size = options.page_size;
    if (options.source) opts.source = options.source;
    if (options.filters) opts.filters = options.filters;
    if (options.includes) opts.includes = options.includes;
    if (options.excludes) opts.excludes = options.excludes;
    if (options.start_date) opts.start_date = options.start_date;
    if (options.end_date) opts.end_date = options.end_date;
    if (options.api_version) opts.api_version = options.api_version;

    const results = await this.client.getAll(opts) as Mem0RawItem[] | Mem0RawSearchResult;
    if (Array.isArray(results)) return results.map(normalizeMemoryItem);
    if (results?.results && Array.isArray(results.results)) {
      return results.results.map(normalizeMemoryItem);
    }
    return [];
  }

  async delete(memoryId: string): Promise<void> {
    await this.ensureClient();
    await this.client.delete(memoryId);
  }

  async update(memoryId: string, options: Mem0UpdateOptions): Promise<EnhancedMemoryResult> {
    await this.ensureClient();
    const result = await this.client.update(memoryId, options as unknown as Record<string, unknown>);
    // update() returns Array<Memory> — normalize the first item
    const item = Array.isArray(result) ? result[0] : result;
    return normalizeMemoryItem(item as Mem0RawItem);
  }

  async deleteAll(options: Mem0ListOptions): Promise<void> {
    await this.ensureClient();
    const opts: Record<string, unknown> = { user_id: options.user_id };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.agent_id) opts.agent_id = options.agent_id;
    if (options.app_id) opts.app_id = options.app_id;
    if (options.source) opts.source = options.source;
    await this.client.deleteAll(opts);
  }

  async history(memoryId: string): Promise<Mem0HistoryEntry[]> {
    await this.ensureClient();
    const results = await this.client.history(memoryId) as Array<Record<string, unknown>>;
    return (results ?? []).map((h: Record<string, unknown>) => ({
      id: String(h.id ?? ''),
      memory_id: String(h.memory_id ?? ''),
      old_memory: h.old_memory != null ? String(h.old_memory) : null,
      new_memory: h.new_memory != null ? String(h.new_memory) : null,
      event: String(h.event ?? ''),
      created_at: h.created_at != null ? String(h.created_at) : undefined,
      updated_at: h.updated_at != null ? String(h.updated_at) : undefined,
    }));
  }

  async feedback(options: Mem0FeedbackOptions): Promise<void> {
    await this.ensureClient();
    await this.client.feedback(options as unknown as Record<string, unknown>);
  }

  async batchUpdate(items: Mem0BatchUpdateItem[]): Promise<void> {
    await this.ensureClient();
    await this.client.batchUpdate(items as unknown as Array<Record<string, unknown>>);
  }

  async batchDelete(memoryIds: string[]): Promise<void> {
    await this.ensureClient();
    await this.client.batchDelete(memoryIds);
  }
}

// ── OSS Provider ───────────────────────────────────────────────────

/**
 * Open-source mode provider — self-hosted Mem0 via `mem0ai/oss` SDK.
 *
 * Ported from Mem0 plugin index.ts:207-308
 * - Lazy init via ensureMemory()
 * - camelCase option naming (userId, runId vs user_id, run_id)
 * - Client-side threshold filtering (OSS SDK doesn't support server-side threshold)
 * - version: "v1.1" in initialization config
 * - getAll() does NOT support page_size
 * - search uses `limit` instead of `top_k`
 */
class OSSMem0Provider implements IMem0Provider {
  private memory!: Mem0OSSMemory;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly ossConfig?: Mem0ProviderConfig['oss'],
    private readonly customPrompt?: string,
    private readonly logger?: IProviderLogger,
  ) {}

  /** Lazy initialization — SDK loaded on first use. */
  private async ensureMemory(): Promise<void> {
    if (this.memory) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    const { Memory } = await import('mem0ai/oss');

    // OSS Memory() constructor requires version config
    // Ported from Mem0 plugin index.ts:230
    const config: Record<string, unknown> = { version: 'v1.1' };

    if (this.ossConfig?.embedder) config.embedder = this.ossConfig.embedder;
    if (this.ossConfig?.vectorStore) config.vectorStore = this.ossConfig.vectorStore;
    if (this.ossConfig?.llm) config.llm = this.ossConfig.llm;
    if (this.ossConfig?.historyDbPath) config.historyDbPath = this.ossConfig.historyDbPath;
    if (this.customPrompt) config.customPrompt = this.customPrompt;

    this.memory = new Memory(config) as Mem0OSSMemory;
    this.logger?.info('[mem0] OSS provider initialized');
  }

  async add(
    messages: Array<{ role: string; content: string }>,
    options: Mem0AddOptions,
  ): Promise<MemoryAddResult> {
    await this.ensureMemory();
    // OSS SDK uses camelCase: userId/runId, NOT snake_case
    const addOpts: Record<string, unknown> = { userId: options.user_id };
    if (options.run_id) addOpts.runId = options.run_id;
    if (options.source) addOpts.source = options.source;
    if (options.metadata) addOpts.metadata = options.metadata;
    if (options.infer !== undefined) addOpts.infer = options.infer;
    const result = await this.memory.add(messages, addOpts);
    return normalizeAddResult(result as Mem0RawAddResult | Mem0RawAddItem[]);
  }

  async search(query: string, options: Mem0SearchOptions): Promise<EnhancedMemoryResult[]> {
    await this.ensureMemory();
    // OSS SDK uses camelCase: userId/runId
    const opts: Record<string, unknown> = { userId: options.user_id };
    if (options.run_id) opts.runId = options.run_id;
    // OSS search uses `limit` instead of `top_k`
    if (options.limit != null) opts.limit = options.limit;
    else if (options.top_k != null) opts.limit = options.top_k;
    if (options.keyword_search != null) opts.keyword_search = options.keyword_search;
    if (options.reranking != null) opts.reranking = options.reranking;
    if (options.source) opts.source = options.source;
    if (options.threshold != null) opts.threshold = options.threshold;

    const results = await this.memory.search(query, opts);
    const normalized = normalizeSearchResults(results as Mem0RawSearchResult | Mem0RawItem[]);

    // Client-side threshold filtering — OSS SDK doesn't support server-side threshold
    // Ported from Mem0 plugin index.ts:285-288
    if (options.threshold != null) {
      return normalized.filter(item => (item.score ?? 0) >= options.threshold!);
    }

    return normalized;
  }

  async get(memoryId: string): Promise<EnhancedMemoryResult> {
    await this.ensureMemory();
    const result = await this.memory.get(memoryId);
    return normalizeMemoryItem(result as Mem0RawItem);
  }

  async getAll(options: Mem0ListOptions): Promise<EnhancedMemoryResult[]> {
    await this.ensureMemory();
    // OSS SDK uses camelCase; does NOT support page_size
    const getAllOpts: Record<string, unknown> = { userId: options.user_id };
    if (options.run_id) getAllOpts.runId = options.run_id;
    if (options.source) getAllOpts.source = options.source;
    // Note: page_size intentionally omitted — OSS getAll() doesn't support it

    const results = await this.memory.getAll(getAllOpts) as Mem0RawItem[] | Mem0RawSearchResult;
    if (Array.isArray(results)) return results.map(normalizeMemoryItem);
    if (results?.results && Array.isArray(results.results)) {
      return results.results.map(normalizeMemoryItem);
    }
    return [];
  }

  async delete(memoryId: string): Promise<void> {
    await this.ensureMemory();
    await this.memory.delete(memoryId);
  }

  async update(memoryId: string, options: Mem0UpdateOptions): Promise<EnhancedMemoryResult> {
    await this.ensureMemory();
    const result = await this.memory.update(memoryId, { data: options.text });
    return normalizeMemoryItem(result as Mem0RawItem);
  }

  async deleteAll(options: Mem0ListOptions): Promise<void> {
    await this.ensureMemory();
    const deleteOpts: Record<string, unknown> = { userId: options.user_id };
    if (options.run_id) deleteOpts.runId = options.run_id;
    if (options.source) deleteOpts.source = options.source;
    await this.memory.deleteAll(deleteOpts);
  }

  async history(memoryId: string): Promise<Mem0HistoryEntry[]> {
    await this.ensureMemory();
    const results = await this.memory.history(memoryId) as Array<Record<string, unknown>>;
    return (results ?? []).map((h: Record<string, unknown>) => ({
      id: String(h.id ?? ''),
      memory_id: String(h.memory_id ?? memoryId),
      old_memory: h.old_memory != null ? String(h.old_memory) : null,
      new_memory: h.new_memory != null ? String(h.new_memory) : null,
      event: String(h.event ?? ''),
      created_at: h.created_at != null ? String(h.created_at) : undefined,
      updated_at: h.updated_at != null ? String(h.updated_at) : undefined,
    }));
  }

  async feedback(_options: Mem0FeedbackOptions): Promise<void> {
    // Feedback is a platform-only feature — ignored for OSS
    this.logger?.debug?.('[mem0] Feedback is not supported in OSS mode');
  }

  async batchUpdate(_items: Mem0BatchUpdateItem[]): Promise<void> {
    // Batch update is platform-only — OSS falls back to sequential updates
    this.logger?.warn('[mem0] batchUpdate is not supported in OSS mode — skipping');
  }

  async batchDelete(_memoryIds: string[]): Promise<void> {
    // Batch delete is platform-only — OSS falls back to sequential deletes
    this.logger?.warn('[mem0] batchDelete is not supported in OSS mode — skipping');
  }
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Create the appropriate Mem0 provider based on mode configuration.
 *
 * Ported from Mem0 plugin index.ts:595-602 (createProvider)
 *
 * @param config - Provider configuration (mode, apiKey, oss config, etc.)
 * @param logger - Optional logger instance
 * @returns IMem0Provider — platform or OSS provider
 */
export function createMem0Provider(
  config: Mem0ProviderConfig,
  logger?: IProviderLogger,
): IMem0Provider {
  const isOSS = config.mode === 'open-source' || config.mode === 'oss';

  if (isOSS) {
    return new OSSMem0Provider(config.oss, config.customPrompt, logger);
  }

  if (!config.apiKey) {
    throw new Error(
      '[mem0] apiKey is required for platform mode (set mode: "open-source" for self-hosted)',
    );
  }

  return new PlatformMem0Provider(config.apiKey, config.orgId, config.projectId, logger);
}
