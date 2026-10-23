/**
 * Domain port: Static Call Graph Builder.
 *
 * Constructs a static call graph from AST-extracted call sites.
 * Integrates with ITreeSitterParser for call site extraction and
 * ICodeGraphStore for persisting the call graph into the knowledge graph.
 *
 * The call graph enables:
 * - Precise "who calls X?" queries (upstream traversal)
 * - Dead code detection (unreachable functions)
 * - BFS process tracing (execution flow reconstruction)
 * - More accurate impact analysis (vs regex-approximated edges)
 *
 * Academic foundation:
 * - Call graph construction: Grove et al. (1997) — "A Framework for Call Graph Construction Algorithms"
 * - Static analysis for JavaScript/TypeScript: Feldthaus et al. (2013) — approximate call graphs
 * - GitHub Code Navigation: uses tree-sitter + call graph for "Find all references"
 * - Sourcegraph SCIP: cross-repo call graph construction
 *
 * @module domain/memory/IStaticCallGraphBuilder
 * Layer: Domain
 * DI Token: DI_TOKENS.IStaticCallGraphBuilder
 */

import type { CorrelationId, TenantId } from '@/core/types/branded';
import type { AstCallSite } from './ITreeSitterParser';

/** A resolved call edge with source and target locations. */
export interface CallGraphEdge {
  /** Caller function/method fully qualified name. */
  readonly callerFqn: string;
  /** Callee function/method fully qualified name. */
  readonly calleeFqn: string;
  /** Source file of the caller. */
  readonly callerFile: string;
  /** Source file of the callee (null if unresolved/external). */
  readonly calleeFile: string | null;
  /** Confidence of the edge (1.0 = exact, <1.0 = heuristic). */
  readonly confidence: number;
  /** Whether this is a cross-module call. */
  readonly isCrossModule: boolean;
}

/** Result of call graph construction. */
export interface CallGraphResult {
  /** All resolved call graph edges. */
  readonly edges: readonly CallGraphEdge[];
  /** Number of unresolved call sites (external/dynamic). */
  readonly unresolvedCount: number;
  /** Files processed. */
  readonly fileCount: number;
  /** Total call sites analyzed. */
  readonly totalCallSites: number;
  /** Build duration in ms. */
  readonly durationMs: number;
}

/** Input for call graph construction. */
export interface BuildCallGraphInput {
  /** Call sites extracted from AST parsing. Keyed by file path. */
  readonly callSitesByFile: ReadonlyMap<string, readonly AstCallSite[]>;
  /** Symbol resolution map: name → file path (from AST symbols). */
  readonly symbolIndex: ReadonlyMap<string, string>;
  /** Tenant ID for multi-tenant isolation. */
  readonly tenantId: TenantId;
  /** Correlation ID for tracing. */
  readonly correlationId: CorrelationId;
}

/**
 * IStaticCallGraphBuilder — constructs a static call graph from AST call sites.
 *
 * Takes raw call sites from ITreeSitterParser output and resolves them into
 * a call graph with edges linking caller → callee with file locations.
 */
export interface IStaticCallGraphBuilder {
  /**
   * Build a static call graph from AST-extracted call sites.
   *
   * @param input - Call sites by file + symbol resolution map
   * @returns Resolved call graph with edges and metrics
   */
  buildCallGraph(input: BuildCallGraphInput): Promise<CallGraphResult>;
}
