/**
 * SharedASTCacheAdapter — Infrastructure adapter for ISharedASTCache.
 *
 * Wraps InterfaceIndexer (regex, fast) and ast-checker (ts-morph, accurate)
 * into a unified cached provider. Lazy initialization: heavy ts-morph
 * parsing is only triggered on first import graph / layer check request.
 *
 * Cache strategy:
 * - Interface index: loaded once on first access (InterfaceIndexer.index())
 * - Import graphs: cached per-file on demand (ts-morph analyzeImportGraph)
 * - Layer violations: cached per-file on demand (ts-morph checkLayerViolationsAST)
 * - Hit/miss counters for observability
 *
 * @layer Infrastructure (MCP)
 * @pattern Shared Cache Adapter (SOTA 2026 — AST deduplication)
 * @see src/domain/mcp/ISharedASTCache.ts — domain port
 * @see src/infrastructure/mcp/audit/ast-checker.ts — ts-morph analysis
 * @see src/infrastructure/mcp/context/parsers/InterfaceIndexer.ts — regex parser
 */

import type {
  ISharedASTCache,
  CachedInterfaceInfo,
  CachedImportGraph,
  CachedImportEdge,
  CachedLayerViolation,
  ASTCacheStats,
} from '../../../domain/mcp/ISharedASTCache';
import {
  analyzeImportGraph,
  checkLayerViolationsAST,
  invalidateProjectCache,
  type ImportGraphResult,
  type ASTLayerCheckResult,
} from '../../mcp/audit/ast-checker';
import { InterfaceIndexer } from '../../mcp/context/parsers/InterfaceIndexer';

// ─── LRU Map ─────────────────────────────────────────────────────────────────

/**
 * Simple LRU Map using JS Map insertion-order semantics.
 * On access, entry is moved to end (most recently used).
 * When size exceeds maxSize, oldest entry (first in iteration order) is evicted.
 */
class LRUMap<K, V> {
  private readonly map = new Map<K, V>();
  public evictionCount = 0;

  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
      this.evictionCount++;
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  entries(): MapIterator<[K, V]> {
    return this.map.entries();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.map.entries();
  }

  resetStats(): void {
    this.evictionCount = 0;
  }
}

/** Default LRU cache sizes for AST data. */
const DEFAULT_MAX_IMPORT_GRAPHS = 500;
const DEFAULT_MAX_LAYER_VIOLATIONS = 500;

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class SharedASTCacheAdapter implements ISharedASTCache {
  private interfaceCache: ReadonlyMap<string, CachedInterfaceInfo> | null = null;
  private readonly importGraphCache: LRUMap<string, CachedImportGraph>;
  private readonly layerViolationCache: LRUMap<string, readonly CachedLayerViolation[]>;
  private hitCount = 0;
  private missCount = 0;
  private lastInvalidation: string | null = null;
  private readonly maxCacheSize: number;

  constructor(
    private readonly projectRoot: string,
    maxCacheSize: number = DEFAULT_MAX_IMPORT_GRAPHS,
  ) {
    this.maxCacheSize = maxCacheSize;
    this.importGraphCache = new LRUMap<string, CachedImportGraph>(maxCacheSize);
    this.layerViolationCache = new LRUMap<string, readonly CachedLayerViolation[]>(maxCacheSize);
  }

  getInterface(name: string): CachedInterfaceInfo | undefined {
    this.ensureInterfaceCache();
    const result = this.interfaceCache!.get(name);
    if (result) {
      this.hitCount++;
    } else {
      this.missCount++;
    }
    return result;
  }

  getAllInterfaces(): ReadonlyMap<string, CachedInterfaceInfo> {
    this.ensureInterfaceCache();
    this.hitCount++;
    return this.interfaceCache!;
  }

  getImportGraph(filePath: string): CachedImportGraph | undefined {
    const cached = this.importGraphCache.get(filePath);
    if (cached !== undefined) {
      this.hitCount++;
      return cached;
    }

    this.missCount++;
    try {
      const result: ImportGraphResult = analyzeImportGraph(this.projectRoot, filePath);
      const graph: CachedImportGraph = {
        file: result.file,
        imports: result.imports.map(e => ({
          from: e.from,
          to: e.to,
          symbols: [...e.symbols],
          line: e.line,
          typeOnly: e.typeOnly,
        } satisfies CachedImportEdge)),
        importedBy: result.importedBy.map(e => ({
          from: e.from,
          to: e.to,
          symbols: [...e.symbols],
          line: e.line,
          typeOnly: e.typeOnly,
        } satisfies CachedImportEdge)),
      };
      this.importGraphCache.set(filePath, graph);
      return graph;
    } catch {
      return undefined;
    }
  }

  checkLayerViolations(filePath: string): readonly CachedLayerViolation[] {
    const cached = this.layerViolationCache.get(filePath);
    if (cached !== undefined) {
      this.hitCount++;
      return cached;
    }

    this.missCount++;
    try {
      const result: ASTLayerCheckResult = checkLayerViolationsAST(this.projectRoot, filePath);
      const violations: CachedLayerViolation[] = result.violations.map(v => ({
        file: v.file,
        line: v.line,
        importPath: v.importPath,
        fromLayer: v.fromLayer,
        toLayer: v.toLayer,
        rule: v.rule,
      }));
      this.layerViolationCache.set(filePath, violations);
      return violations;
    } catch {
      return [];
    }
  }

  invalidate(filePath: string): void {
    this.importGraphCache.delete(filePath);
    this.layerViolationCache.delete(filePath);
    // Also invalidate entries that reference this file in importedBy
    for (const [key, graph] of this.importGraphCache) {
      if (graph.importedBy.some(e => e.from === filePath)) {
        this.importGraphCache.delete(key);
      }
    }
    // Reset interface cache (file could contain interface definitions)
    this.interfaceCache = null;
    InterfaceIndexer.invalidate();
    invalidateProjectCache();
    this.lastInvalidation = new Date().toISOString();
  }

  invalidateAll(): void {
    this.interfaceCache = null;
    this.importGraphCache.clear();
    this.layerViolationCache.clear();
    InterfaceIndexer.invalidate();
    invalidateProjectCache();
    this.hitCount = 0;
    this.missCount = 0;
    this.importGraphCache.resetStats();
    this.layerViolationCache.resetStats();
    this.lastInvalidation = new Date().toISOString();
  }

  getStats(): ASTCacheStats {
    this.ensureInterfaceCache();
    return {
      interfaceCount: this.interfaceCache!.size,
      importGraphCount: this.importGraphCache.size,
      hitCount: this.hitCount,
      missCount: this.missCount,
      evictionCount: this.importGraphCache.evictionCount + this.layerViolationCache.evictionCount,
      maxCacheSize: this.maxCacheSize,
      lastInvalidation: this.lastInvalidation,
    };
  }

  // ─── Private ───────────────────────────────────────────────────────

  private ensureInterfaceCache(): void {
    if (this.interfaceCache) return;

    const rawIndex = InterfaceIndexer.index(this.projectRoot);
    const mapped = new Map<string, CachedInterfaceInfo>();
    for (const [name, info] of rawIndex) {
      mapped.set(name, {
        name: info.name,
        file: info.file,
        line: info.line,
        methods: [...info.methods],
        dependencies: [...info.dependencies],
      });
    }
    this.interfaceCache = mapped;
  }
}
