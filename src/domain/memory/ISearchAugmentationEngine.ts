/**
 * ISearchAugmentationEngine — Domain Port for Search Result Augmentation.
 *
 * Intercepts grep/glob/semantic search results and enriches them with
 * structural context from the Code Knowledge Graph: callers, callees,
 * process participation, community membership, and impact radius.
 *
 * Layer: Domain
 * Pattern source: GitNexus v1.4.0 augmentation/engine.ts (U6, patterns only)
 * License: PolyForm-Noncommercial — original implementation
 */

import type { TenantId, CorrelationId } from './session-types';
import type { CodeGraphNode, CodeProcess, CodeCommunity } from './ICodeGraphStore';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/** Source tool that produced the original search results. */
export type SearchSource = 'grep' | 'glob' | 'semantic' | 'ast' | 'manual';

/** A raw search hit before augmentation. */
export interface RawSearchHit {
  readonly filePath: string;
  readonly line?: number;
  readonly snippet?: string;
  readonly score?: number;
  readonly source: SearchSource;
}

/** An augmented search result with graph context. */
export interface AugmentedSearchResult {
  readonly hit: RawSearchHit;
  /** Symbols (functions, classes) at the matched location. */
  readonly symbols: readonly CodeGraphNode[];
  /** Direct callers of matched symbols. */
  readonly callers: readonly CodeGraphNode[];
  /** Direct callees of matched symbols. */
  readonly callees: readonly CodeGraphNode[];
  /** Processes (execution flows) that pass through matched symbols. */
  readonly processes: readonly CodeProcess[];
  /** Community (functional cluster) the symbol belongs to. */
  readonly community?: CodeCommunity;
  /** Estimated blast radius if this code changes. */
  readonly impactScore: number;
}

/** Configuration for augmentation behavior. */
export interface AugmentationConfig {
  /** Max callers/callees to include per symbol (default: 5). */
  readonly maxRelations?: number;
  /** Max processes to include per symbol (default: 3). */
  readonly maxProcesses?: number;
  /** Whether to include community info (default: true). */
  readonly includeCommunity?: boolean;
  /** Whether to compute impact score (default: true). */
  readonly includeImpact?: boolean;
}

// ──────────────────────────────────────────────
// Domain Port
// ──────────────────────────────────────────────

/**
 * Search Augmentation Engine — Domain Port (L3).
 *
 * Enriches raw search results with structural code intelligence from
 * the knowledge graph. Transparent to the calling agent — search results
 * come back with context that would otherwise require manual investigation.
 *
 * Implementations: SearchAugmentationAdapter (infrastructure).
 */
export interface ISearchAugmentationEngine {
  /** Augment a batch of raw search hits with graph context. */
  augment(input: {
    tenantId: TenantId;
    hits: readonly RawSearchHit[];
    config?: AugmentationConfig;
    correlationId: CorrelationId;
  }): Promise<readonly AugmentedSearchResult[]>;
}
