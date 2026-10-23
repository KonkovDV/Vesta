/**
 * ISharedASTCache — Domain port for shared AST parsing cache across MCP servers.
 *
 * Eliminates AST parsing duplication between MCP servers:
 * - Context Server: InterfaceIndexer (regex-based, fast)
 * - Docs Server: buildKnowledgeGraph (AstGraphBuilder + InterfaceIndexer)
 * - Audit Server: ast-checker.ts (ts-morph, full AST)
 *
 * Provides a unified cache that stores parsed interface info, import graphs,
 * and knowledge graph data. Servers request parsed data through this port
 * instead of independently re-parsing the codebase.
 *
 * Cache invalidation:
 * - `invalidate(filePath)`: targeted invalidation when a specific file changes
 * - `invalidateAll()`: full cache reset (e.g., after branch switch)
 *
 * @layer Domain (MCP)
 * @pattern Shared Cache Port (SOTA 2026 — AST deduplication)
 * @see PLANS/DOCS_AUDIT_2026/85_MCP_ATOMIC_CODE_REVIEW_MARCH_2026.md — AST analysis
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Parsed interface information (from InterfaceIndexer or ts-morph). */
export interface CachedInterfaceInfo {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly methods: readonly string[];
  readonly dependencies: readonly string[];
}

/** Import edge between two files (from ast-checker or AstGraphBuilder). */
export interface CachedImportEdge {
  readonly from: string;
  readonly to: string;
  readonly symbols: readonly string[];
  readonly line: number;
  readonly typeOnly: boolean;
}

/** Import graph for a single file. */
export interface CachedImportGraph {
  readonly file: string;
  readonly imports: readonly CachedImportEdge[];
  readonly importedBy: readonly CachedImportEdge[];
}

/** Layer violation detected by AST analysis. */
export interface CachedLayerViolation {
  readonly file: string;
  readonly line: number;
  readonly importPath: string;
  readonly fromLayer: string;
  readonly toLayer: string;
  readonly rule: string;
}

/** Cache statistics for monitoring. */
export interface ASTCacheStats {
  readonly interfaceCount: number;
  readonly importGraphCount: number;
  readonly hitCount: number;
  readonly missCount: number;
  readonly evictionCount: number;
  readonly maxCacheSize: number;
  readonly lastInvalidation: string | null;
}

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * ISharedASTCache — shared AST parsing results cache.
 *
 * All methods return cached results when available, or trigger parsing
 * on cache miss (lazy initialization pattern).
 */
export interface ISharedASTCache {
  /**
   * Get parsed interface information by name.
   * Returns from cache if available, parses on miss.
   */
  getInterface(name: string): CachedInterfaceInfo | undefined;

  /**
   * Get all parsed interfaces (cached).
   */
  getAllInterfaces(): ReadonlyMap<string, CachedInterfaceInfo>;

  /**
   * Get the import graph for a specific file.
   * Uses ts-morph for accurate resolution on cache miss.
   */
  getImportGraph(filePath: string): CachedImportGraph | undefined;

  /**
   * Check a file for layer dependency violations.
   * Uses cached AST data for fast checking.
   */
  checkLayerViolations(filePath: string): readonly CachedLayerViolation[];

  /**
   * Invalidate cache entries related to a specific file.
   * Called when a file is modified.
   */
  invalidate(filePath: string): void;

  /**
   * Invalidate the entire cache.
   * Called on branch switch or full rebuild.
   */
  invalidateAll(): void;

  /**
   * Get cache statistics for monitoring.
   */
  getStats(): ASTCacheStats;
}
