/**
 * IErrorGraphRepository — Domain port for GraphRAG-based error knowledge base.
 *
 * Replaces flat-file `KNOWN_BUGS.md` with a semantic graph of errors,
 * causes, AST patterns, and fixes. Enables JIT context injection:
 * when editing a file, only relevant bugs are surfaced to the AI agent.
 *
 * Graph model:
 *   ErrorNode → CausedBy → ASTPatternNode → FixNode
 *   ErrorNode → AffectsFile → FileNode
 *   ErrorNode → HasCategory → CategoryNode
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @vector V5: Predictive Auto-Traps (GraphRAG KNOWN_BUGS)
 * @horizon Q3 2026
 * @see PLANS/06_BLUEPRINTS/ERROR_DEBUGGING_EVOLUTION_SOTA_2026.md §6
 * @see KNOWN_BUGS.md — current flat-file registry (migration source)
 * @see scripts/auto-postmortem.ts — incident→ErrorNode pipeline
 */

import type { CorrelationId } from '@/ai-types';

// ── Graph Node Types ──────────────────────────────────────────────

/** Severity classification matching KNOWN_BUGS.md conventions. */
export type ErrorSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** Error category aligned with ErrorCatalog.ts and auto-postmortem.ts. */
export type ErrorCategory =
  | 'Architecture'
  | 'Security'
  | 'Cache'
  | 'Memory'
  | 'Config'
  | 'Concurrency'
  | 'TypeSystem'
  | 'Testing'
  | 'Performance'
  | 'DI'
  | 'EventSourcing';

/** Status of a known error. */
export type ErrorStatus = 'OPEN' | 'FIXED' | 'WONT_FIX' | 'MONITORING';

/** A node in the error knowledge graph. */
export interface ErrorGraphNode {
  /** Unique error ID (e.g. "A-001", "S-002", "SNG-001"). */
  readonly id: string;
  /** Human-readable summary. */
  readonly summary: string;
  /** Affected file paths (workspace-relative). */
  readonly affectedFiles: readonly string[];
  /** Root cause description. */
  readonly rootCause: string;
  /** The rule/invariant that was violated. */
  readonly rule: string;
  /** Test trap that catches this error (file + test name). */
  readonly testTrap?: string;
  /** Category for grouping. */
  readonly category: ErrorCategory;
  /** Severity level. */
  readonly severity: ErrorSeverity;
  /** Current status. */
  readonly status: ErrorStatus;
  /** ISO-8601 date of discovery. */
  readonly discoveredAt: string;
  /** ISO-8601 date of fix (if fixed). */
  readonly fixedAt?: string;
  /** Verification evidence (2-tool rule). */
  readonly verification?: string;
  /** Semantic embedding vector — text/rootCause based (for similarity search). */
  readonly embedding?: readonly number[];
  /**
   * Structural embedding vector — AST depth-first traversal path.
   * Captures code structure independent of variable names.
   * @see SOTA 2026: Multi-Vector AST Embeddings
   */
  readonly astEmbedding?: readonly number[];
  /**
   * Temporal embedding vector — bug lifecycle/recurrence pattern.
   * Encodes discovery frequency, fix duration, regression count.
   * @see SOTA 2026: Multi-Vector AST Embeddings
   */
  readonly temporalEmbedding?: readonly number[];
  /**
   * Number of times this bug has recurred (for non-linear epistemic decay).
   * Higher recurrence = slower forgetting (Spaced Repetition / Crystallized Intelligence).
   * Formula: λ(n) = λ_base / √n
   * @see SOTA 2026: Non-Linear Epistemic Decay
   */
  readonly recurrenceCount?: number;
}

/** An AST pattern that triggers an error. */
export interface ASTPatternNode {
  /** Pattern ID. */
  readonly id: string;
  /** The problematic code pattern (ESLint-compatible AST selector or regex). */
  readonly pattern: string;
  /** Description of why this pattern is dangerous. */
  readonly description: string;
  /** Related error IDs. */
  readonly errorIds: readonly string[];
}

/** A fix/remediation linked to an error. */
export interface FixNode {
  /** Fix ID. */
  readonly id: string;
  /** The error this fixes. */
  readonly errorId: string;
  /** Description of the fix. */
  readonly description: string;
  /** Optional AST transformation (ESLint fixer). */
  readonly astPatch?: string;
}

// ── Query Types ───────────────────────────────────────────────────

/** Query for finding relevant errors by file context. */
export interface ErrorContextQuery {
  /** File being edited (workspace-relative path). */
  readonly filePath: string;
  /** Optional: specific function/method name. */
  readonly symbolName?: string;
  /** Maximum number of results. Default: 5. */
  readonly limit?: number;
  /** Include only errors with these categories. */
  readonly categories?: readonly ErrorCategory[];
  /** Include only errors with these statuses. Default: all. */
  readonly statuses?: readonly ErrorStatus[];
  /**
   * Optional semantic embedding vector for hybrid similarity search (HNSW + cosine distance).
   * When provided, results are ranked by hybrid score: alpha * cosine_distance + (1-alpha) * severity.
   * @see arXiv: "Approximate Nearest Neighbor Search in High Dimensions" (2025)
   */
  readonly embedding?: readonly number[];
  /**
   * Optional AST structural embedding for code-structure-aware search.
   * Finds bugs with identical AST patterns even in different modules.
   * @see SOTA 2026: Multi-Vector AST Embeddings (CodeGraph)
   */
  readonly astEmbedding?: readonly number[];
  /**
   * Optional temporal embedding for lifecycle-aware search.
   * Matches bugs with similar recurrence/regression patterns.
   */
  readonly temporalEmbedding?: readonly number[];
}

/** Result of a contextual error query. */
export interface ErrorContextResult {
  /** Matched error nodes, ranked by relevance. */
  readonly errors: readonly ErrorGraphNode[];
  /** Related AST patterns for the queried file. */
  readonly patterns: readonly ASTPatternNode[];
  /** Relevant fixes. */
  readonly fixes: readonly FixNode[];
  /** Relevance score (0.0–1.0) for each error. */
  readonly scores: readonly number[];
}

// ── Port ──────────────────────────────────────────────────────────

/**
 * GraphRAG-based error knowledge repository.
 * Infrastructure implementations can use graphology, Neo4j, or in-memory graph.
 */
export interface IErrorGraphRepository {
  /**
   * Ingest an error node into the graph.
   * Idempotent: re-ingesting an existing ID updates it.
   */
  ingestError(node: ErrorGraphNode, correlationId: CorrelationId): Promise<void>;

  /**
   * Ingest an AST pattern node.
   */
  ingestPattern(pattern: ASTPatternNode, correlationId: CorrelationId): Promise<void>;

  /**
   * Ingest a fix node.
   */
  ingestFix(fix: FixNode, correlationId: CorrelationId): Promise<void>;

  /**
   * Query errors relevant to the given file context.
   * Uses graph traversal + optional embedding similarity.
   */
  queryByContext(query: ErrorContextQuery, correlationId: CorrelationId): Promise<ErrorContextResult>;

  /**
   * Get a specific error by ID.
   */
  getById(errorId: string): Promise<ErrorGraphNode | null>;

  /**
   * Get all errors affecting a specific file.
   */
  getByFile(filePath: string): Promise<readonly ErrorGraphNode[]>;

  /**
   * Get total count of errors by status.
   */
  getStats(): Promise<Record<ErrorStatus, number>>;
}
