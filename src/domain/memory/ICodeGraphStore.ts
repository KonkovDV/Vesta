/**
 * ICodeGraphStore — Domain Port for Code Knowledge Graph.
 *
 * Provides structural code intelligence: AST-based knowledge graph,
 * hybrid search (BM25 + semantic via RRF), impact analysis,
 * community detection (Leiden), and process detection (BFS).
 *
 * Layer: Domain
 * Extracted from: GitNexus v1.4.0 (patterns only, original implementation)
 */

import type { TenantId, CorrelationId } from './session-types';

// ──────────────────────────────────────────────
// Node & Edge Types
// ──────────────────────────────────────────────

/** Code element types supported by the knowledge graph. */
export type CodeNodeLabel =
  | 'File' | 'Folder' | 'Module'
  | 'Function' | 'Class' | 'Method' | 'Interface'
  | 'Struct' | 'Enum' | 'Trait' | 'Impl'
  | 'Community' | 'Process';

/** Relationship types between code elements. */
export type CodeRelationType =
  | 'CONTAINS' | 'DEFINES' | 'IMPORTS' | 'CALLS'
  | 'EXTENDS' | 'IMPLEMENTS' | 'HAS_METHOD'
  | 'OVERRIDES' | 'MEMBER_OF' | 'STEP_IN_PROCESS'
  | 'CHANGED_TOGETHER';

/** Node in the code knowledge graph. */
export interface CodeGraphNode {
  readonly id: string;
  readonly label: CodeNodeLabel;
  readonly name: string;
  readonly filePath: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly isExported?: boolean;
  readonly content?: string;
  readonly properties?: Record<string, unknown>;
}

/** Edge in the code knowledge graph. */
export interface CodeGraphEdge {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: CodeRelationType;
  /** Resolution confidence [0, 1]. 0.95=same-file, 0.9=import, 0.5=global. */
  readonly confidence: number;
  readonly reason?: string;
  /** Step number for STEP_IN_PROCESS edges. */
  readonly step?: number;
}

// ──────────────────────────────────────────────
// Analysis Result Types
// ──────────────────────────────────────────────

/** Impact analysis risk level. */
export type ImpactRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Impact analysis result for a symbol change. */
export interface ImpactAnalysisResult {
  readonly target: CodeGraphNode;
  readonly risk: ImpactRiskLevel;
  readonly summary: {
    readonly directCallers: number;
    readonly affectedProcesses: number;
    readonly affectedModules: number;
  };
  readonly byDepth: ReadonlyMap<number, readonly CodeGraphNode[]>;
  readonly affectedProcesses: readonly string[];
}

/** Execution flow (process) detected in code. */
export interface CodeProcess {
  readonly id: string;
  readonly label: string;
  readonly processType: 'intra_community' | 'cross_community';
  readonly stepCount: number;
  readonly steps: readonly CodeGraphNode[];
  readonly entryPointId: string;
  readonly terminalId: string;
}

/** Functional cluster detected via Leiden algorithm. */
export interface CodeCommunity {
  readonly id: string;
  readonly label: string;
  readonly cohesion: number;
  readonly symbolCount: number;
  readonly keywords: readonly string[];
  readonly members: readonly string[];
  /** Shannon entropy of edge type distribution [0,1]. High = architectural rot. */
  readonly entropy?: number;
  /** Ratio of internal edges to total edges touching this community [0,1]. */
  readonly internalRatio?: number;
}

/** Evolutionary coupling between files (co-change analysis from Git history). */
export interface EvolutionaryCoupling {
  readonly fileA: string;
  readonly fileB: string;
  readonly coChangeCount: number;
  readonly confidence: number;
  readonly support: number;
}

/** Structural diff between two graph snapshots. */
export interface GraphDiff {
  readonly addedNodes: readonly string[];
  readonly removedNodes: readonly string[];
  readonly modifiedNodes: readonly string[];
  readonly addedEdges: ReadonlyArray<{ source: string; target: string; type: string }>;
  readonly removedEdges: ReadonlyArray<{ source: string; target: string; type: string }>;
  readonly conflicts: readonly string[];
}

/** Relocation suggestion for improving community cohesion. */
export interface RelocationSuggestion {
  readonly fileId: string;
  readonly currentFolder: string;
  readonly suggestedFolder: string;
  readonly reason: string;
  readonly confidence: number;
}

/** Path-RAG result: minimal subgraph connecting relevant symbols. */
export interface PathRAGResult {
  readonly nodes: readonly string[];
  readonly paths: ReadonlyArray<readonly string[]>;
  readonly totalPathLength: number;
}

/** 360-degree symbol context. */
export interface SymbolContext {
  readonly node: CodeGraphNode;
  readonly callers: readonly CodeGraphNode[];
  readonly callees: readonly CodeGraphNode[];
  readonly processes: readonly CodeProcess[];
}

/** Ingestion progress callback. */
export type IngestionProgressCallback = (phase: string, percent: number) => void;

/** Result of repository ingestion with optional incremental stats. */
export interface IngestionResult {
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** Community count (created during ingestion via Leiden). */
  readonly communityCount?: number;
  /** Process count (created during ingestion via BFS). */
  readonly processCount?: number;
  /** Present for incremental ingestion runs (SHA-256 content hashing). */
  readonly incremental?: {
    readonly added: number;
    readonly modified: number;
    readonly unchanged: number;
  };
}

// ──────────────────────────────────────────────
// Domain Port
// ──────────────────────────────────────────────

/**
 * Code Knowledge Graph Store — Domain Port (L3).
 *
 * Provides structural code intelligence for AI agent context.
 * Implementations: KuzuCodeGraphAdapter (production), InMemoryCodeGraphAdapter (dev/test).
 */
export interface ICodeGraphStore {
  /** Ingest a repository into the knowledge graph. */
  ingestRepository(input: {
    repoPath: string;
    tenantId: TenantId;
    correlationId: CorrelationId;
    onProgress?: IngestionProgressCallback;
  }): Promise<IngestionResult>;

  /** Hybrid search: BM25 + semantic, merged via RRF. */
  hybridSearch(input: {
    tenantId: TenantId;
    query: string;
    limit?: number;
    correlationId: CorrelationId;
  }): Promise<readonly CodeGraphNode[]>;

  /** 360-degree symbol context: callers, callees, process participation. */
  getSymbolContext(input: {
    tenantId: TenantId;
    symbolId: string;
    correlationId: CorrelationId;
  }): Promise<SymbolContext>;

  /** Impact analysis: blast radius of changing a symbol. */
  analyzeImpact(input: {
    tenantId: TenantId;
    targetId: string;
    direction: 'upstream' | 'downstream';
    maxDepth?: number;
    minConfidence?: number;
    correlationId: CorrelationId;
  }): Promise<ImpactAnalysisResult>;

  /** Detect functional communities via Leiden algorithm. */
  getCommunities(input: {
    tenantId: TenantId;
    correlationId: CorrelationId;
  }): Promise<readonly CodeCommunity[]>;

  /** Detect execution flows (processes). */
  getProcesses(input: {
    tenantId: TenantId;
    correlationId: CorrelationId;
  }): Promise<readonly CodeProcess[]>;

  /**
   * Calculate evolutionary coupling from commit history.
   * Reference: Zimmermann et al. 2005, "Mining Version Histories" (ICSE)
   */
  getEvolutionaryCoupling(input: {
    tenantId: TenantId;
    correlationId: CorrelationId;
    minSupport?: number;
  }): Promise<readonly EvolutionaryCoupling[]>;

  /**
   * Path-RAG: find minimal subgraph connecting target symbols.
   * Returns Steiner tree approximation for context retrieval.
   * Reference: arXiv:2601.10492 — Neuro-Symbolic GraphRAG
   */
  getPathContext(input: {
    tenantId: TenantId;
    targetIds: string[];
    correlationId: CorrelationId;
  }): Promise<PathRAGResult>;

  /**
   * Compute structural diff between current graph and a snapshot.
   * Detects added/removed/modified nodes and structural conflicts.
   */
  computeGraphDiff(input: {
    tenantId: TenantId;
    snapshotNodes: ReadonlySet<string>;
    snapshotEdges: ReadonlyArray<{ source: string; target: string; type: string }>;
    correlationId: CorrelationId;
  }): Promise<GraphDiff>;

  /**
   * Suggest file relocations based on community-folder mismatch.
   * Files logically in one community but physically in another folder.
   */
  suggestRelocations(input: {
    tenantId: TenantId;
    correlationId: CorrelationId;
  }): Promise<readonly RelocationSuggestion[]>;

  /** Health check for the graph store. */
  healthCheck(): Promise<boolean>;
}
