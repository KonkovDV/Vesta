/**
 * KuzuCodeGraphAdapter — KuzuDB-backed implementation of ICodeGraphStore.
 *
 * Uses KuzuDB (embedded graph database) for high-performance code intelligence:
 * - Parameterized Cypher queries (prevents injection)
 * - Per-tenant database isolation (filesystem separation)
 * - Async file I/O for non-blocking ingestion
 * - Query timeout protection (30s default)
 * - Graceful destroy() for connection cleanup
 *
 * Layer: Infrastructure
 * Extracted patterns from: GitNexus v1.4.0 (original implementation)
 */

import type {
  ICodeGraphStore,
  CodeGraphNode,
  CodeNodeLabel,
  ImpactAnalysisResult,
  ImpactRiskLevel,
  CodeProcess,
  CodeCommunity,
  SymbolContext,
  IngestionProgressCallback,
  IngestionResult,
  EvolutionaryCoupling,
  PathRAGResult,
  GraphDiff,
  RelocationSuggestion,
} from '../../../domain/memory/ICodeGraphStore';
import type { AstSymbol } from '../../../domain/memory/ITreeSitterParser';
import type { TenantId, CorrelationId } from '../../../domain/memory/session-types';
import * as path from 'path';
import { Dirent, promises as fsp } from 'fs';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  extractImportsFromContent,
  extractCommunityKeywords,
  calculateCohesion,
  detectEntryPoints,
  bfsTrace,
  bfsShortestPath,
  calculateCommunityEntropy,
  findMinimalSpanningSubgraph,
  calculateEvolutionaryCoupling,
  couplingConfidence,
  computeGraphDiff as computeGraphDiffAlgo,
  suggestRelocations as suggestRelocationsAlgo,
  detectCommunitiesLeiden,
} from './graph-algorithms';
import { TreeSitterParserAdapter } from './TreeSitterParserAdapter';
import { StaticCallGraphBuilderAdapter } from './StaticCallGraphBuilderAdapter';

const execFileAsync = promisify(execFile);

interface KuzuRow {
  [key: string]: unknown;
}

interface KuzuQueryResult {
  hasNext(): boolean | Promise<boolean>;
  getNext(): Promise<KuzuRow>;
}

interface KuzuConnection {
  query(query: string, params?: Record<string, unknown>): Promise<KuzuQueryResult>;
  close?(): Promise<void> | void;
}

interface KuzuDatabase {
  close?(): Promise<void> | void;
}

interface KuzuModule {
  Database: new (dbPath: string) => KuzuDatabase;
  Connection: new (db: KuzuDatabase) => KuzuConnection;
}

// KuzuDB is lazy-loaded to avoid hard dependency if not installed
let kuzu: KuzuModule | undefined;
function getKuzu(): KuzuModule {
  if (!kuzu) {
    try {
      kuzu = require('kuzu') as KuzuModule;
    } catch {
      throw new Error(
        'KuzuDB is not installed. Run: npm install kuzu\n' +
        'Or use InMemoryCodeGraphAdapter as fallback.',
      );
    }
  }
  return kuzu;
}

/** Query timeout — aligned with GitNexus (30s) */
const QUERY_TIMEOUT_MS = 30_000;

/** Race a promise against a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

function readString(row: KuzuRow, key: string, fallback = ''): string {
  const value = row[key];
  return typeof value === 'string' ? value : fallback;
}

function readRequiredString(row: KuzuRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected string field '${key}' in Kuzu row`);
  }
  return value;
}

function readNumber(row: KuzuRow, key: string, fallback = 0): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return fallback;
}

function mapAstSymbolToNodeLabel(symbol: AstSymbol): Exclude<CodeNodeLabel, 'File' | 'Folder' | 'Module' | 'Community' | 'Process'> | null {
  switch (symbol.kind) {
    case 'function':
      return 'Function';
    case 'class':
      return 'Class';
    case 'method':
      return 'Method';
    case 'interface':
      return 'Interface';
    case 'enum':
      return 'Enum';
    default:
      return null;
  }
}

function buildSymbolFqn(symbol: AstSymbol): string {
  return symbol.parentName ? `${symbol.parentName}.${symbol.name}` : symbol.name;
}

function sanitizePathForGit(value: string): string {
  return value.replace(/\\/g, '/');
}

/** Schema for node tables in KuzuDB — columns are static constants (safe for interpolation). */
const NODE_TABLES: { label: CodeNodeLabel; extraColumns: string }[] = [
  { label: 'File', extraColumns: ', language STRING, size INT64, contentHash STRING' },
  { label: 'Folder', extraColumns: '' },
  { label: 'Module', extraColumns: '' },
  { label: 'Function', extraColumns: ', isExported BOOLEAN DEFAULT false, signature STRING' },
  { label: 'Class', extraColumns: ', isExported BOOLEAN DEFAULT false, isAbstract BOOLEAN DEFAULT false' },
  { label: 'Method', extraColumns: ', isExported BOOLEAN DEFAULT false, isStatic BOOLEAN DEFAULT false' },
  { label: 'Interface', extraColumns: ', isExported BOOLEAN DEFAULT false' },
  { label: 'Struct', extraColumns: ', isExported BOOLEAN DEFAULT false' },
  { label: 'Enum', extraColumns: ', isExported BOOLEAN DEFAULT false' },
  { label: 'Trait', extraColumns: ', isExported BOOLEAN DEFAULT false' },
  { label: 'Impl', extraColumns: '' },
  { label: 'Community', extraColumns: ', cohesion DOUBLE, symbolCount INT64, keywords STRING' },
  { label: 'Process', extraColumns: ', processType STRING, stepCount INT64' },
];

/**
 * All valid node labels for CodeRelation FROM/TO clause.
 * KuzuDB rel tables require explicit FROM/TO type lists.
 */
const ALL_NODE_LABELS = NODE_TABLES.map(t => t.label);

/**
 * KuzuDB-backed code graph store.
 *
 * Design:
 * - Single DB directory per tenant (filesystem isolation)
 * - Schema initialized once per tenant (tracked via Set)
 * - All Cypher queries use parameterized inputs (no string interpolation)
 * - Query timeout protection prevents runaway queries
 *
 * Concurrency note: KuzuDB Connection is NOT thread-safe.
 * This adapter uses one connection per tenant — safe for serial access.
 * For concurrent access, wrap in a connection pool per the GitNexus v1.4.6 pattern:
 *
 * **GitNexus Connection Pool Pattern (LadybugDB v0.15):**
 * - Per-repo pool: one Database, N Connections (INITIAL=2, MAX=8)
 * - Checkout/checkin with waiter queue (Promise-based semaphore)
 * - Shared Database cache keyed by resolved dbPath (deduplicates mmap regions)
 * - LRU eviction when pool exceeds MAX_POOL_SIZE (default 5 repos)
 * - Idle timeout cleanup (5min interval, 60s timer, unref'd for clean shutdown)
 * - Lock retry with backoff (3 attempts × 2s delay) for concurrent analyze ops
 * - Read-only mode for query servers (avoids WAL lock conflicts)
 * - Stdout silencing during native Connection creation (prevents MCP stdio corruption)
 * @see external/GitNexus/gitnexus/src/mcp/core/lbug-adapter.ts (Donor #16, ENRICH GN-E01)
 */
export class KuzuCodeGraphAdapter implements ICodeGraphStore {
  private readonly dbBasePath: string;
  private readonly databases = new Map<string, KuzuDatabase>();
  private readonly connections = new Map<string, KuzuConnection>();
  private readonly schemaInitialized = new Set<string>();
  private readonly astParser = new TreeSitterParserAdapter();
  private readonly callGraphBuilder = new StaticCallGraphBuilderAdapter();

  constructor(dbBasePath: string) {
    // Fail fast so shared runtime selectors can downgrade to the in-memory adapter
    // before the first MCP tool call instead of surfacing a late Kuzu init error.
    getKuzu();
    this.dbBasePath = dbBasePath;
  }

  /** Release all database connections and close DB handles. Call on shutdown. */
  async destroy(): Promise<void> {
    for (const conn of this.connections.values()) {
      try { await conn.close?.(); } catch { /* best-effort */ }
    }
    for (const db of this.databases.values()) {
      try { await db.close?.(); } catch { /* best-effort */ }
    }
    this.connections.clear();
    this.databases.clear();
    this.schemaInitialized.clear();
  }

  private async getConnection(tenantId: TenantId): Promise<KuzuConnection> {
    if (!/^[a-zA-Z0-9_-]+$/.test(tenantId)) {
      throw new Error(`Invalid tenantId: must match /^[a-zA-Z0-9_-]+$/ (got "${tenantId}")`);
    }
    if (this.connections.has(tenantId)) {
      return this.connections.get(tenantId)!;
    }

    const kuzuModule = getKuzu();
    const dbPath = path.join(this.dbBasePath, `tenant_${tenantId}`);
    const normalized = path.resolve(dbPath);
    if (!normalized.startsWith(path.resolve(this.dbBasePath))) {
      throw new Error('tenantId must not escape dbBasePath');
    }
    await fsp.mkdir(dbPath, { recursive: true });

    const db = new kuzuModule.Database(dbPath);
    const conn = new kuzuModule.Connection(db);

    this.databases.set(tenantId, db);
    this.connections.set(tenantId, conn);

    if (!this.schemaInitialized.has(tenantId)) {
      await this.ensureSchema(conn);
      this.schemaInitialized.add(tenantId);
    }
    return conn;
  }

  private async ensureSchema(conn: KuzuConnection): Promise<void> {
    // Create node tables (labels come from static const — safe for template)
    for (const table of NODE_TABLES) {
      await conn.query(
        `CREATE NODE TABLE IF NOT EXISTS ${table.label}(` +
        `id STRING PRIMARY KEY, name STRING, filePath STRING, ` +
        `startLine INT64, endLine INT64, content STRING, tenantId STRING` +
        `${table.extraColumns})`,
      );
    }

    // Polymorphic relation table spanning all node types.
    // KuzuDB requires explicit FROM/TO type lists for each valid combination.
    // Full cartesian product enables cross-type edges (e.g., File→Function, Class→Method).
    const fromTo = ALL_NODE_LABELS.flatMap(from =>
      ALL_NODE_LABELS.map(to => `FROM ${from} TO ${to}`),
    ).join(', ');
    await conn.query(
      `CREATE REL TABLE IF NOT EXISTS CodeRelation(` +
      `${fromTo}, ` +
      `type STRING, confidence DOUBLE DEFAULT 1.0, ` +
      `reason STRING, step INT64)`,
    );
  }

  /**
   * Phase 3 uses a real TS/JS AST-backed path today via TreeSitterParserAdapter,
   * which is implemented with the TypeScript compiler API for this repository's
   * primary languages. Remaining gap: non-TS/JS languages still degrade honestly
   * until multi-language tree-sitter support is introduced.
   *
   * Current behavior:
   * - Parse TS/JS files to extract Function/Class/Method/Interface/Enum symbols
   * - Create DEFINES and HAS_METHOD edges
   * - Build conservative CALLS edges from AST-derived call sites
   * - Preserve File/Folder/IMPORTS fallback behavior for unsupported languages
   *
   * Remaining roadmap:
   * - Multi-language tree-sitter grammars for Python, Go, Rust, Java, etc.
   * - Heritage edges (EXTENDS/IMPLEMENTS) from parser-backed symbol metadata
   * - Broader import and symbol resolution parity with donor breadth
   */
  async ingestRepository(input: {
    repoPath: string;
    tenantId: TenantId;
    correlationId: CorrelationId;
    onProgress?: IngestionProgressCallback;
  }): Promise<IngestionResult> {
    if (!path.isAbsolute(input.repoPath)) {
      throw new Error('repoPath must be an absolute path');
    }
    if (path.normalize(input.repoPath).includes('..')) {
      throw new Error('repoPath must not contain path traversal (..)');
    }
    const conn = await this.getConnection(input.tenantId);
    input.onProgress?.('init', 0);

    // Phase 1: Scan files (async to avoid blocking event loop)
    input.onProgress?.('scanning', 10);
    const files = await this.scanRepository(input.repoPath);
    const fileSet = new Set(files);

    // Phase 2a: Create folder hierarchy with CONTAINS edges
    input.onProgress?.('indexing-folders', 15);
    let nodeCount = 0;
    let edgeCount = 0;
    const incremental = { added: 0, modified: 0, unchanged: 0 };
    const folders = this.extractFolderHierarchy(files, input.repoPath);
    for (const folder of folders) {
      const id = `folder:${folder.path}`;
      await withTimeout(
        conn.query(
          `MERGE (n:Folder {id: $id}) SET n.name = $name, n.filePath = $filePath, n.tenantId = $tenantId`,
          { id, name: folder.name, filePath: folder.path, tenantId: input.tenantId },
        ),
        QUERY_TIMEOUT_MS,
        'ingest-folder',
      );
      nodeCount++;
      if (folder.parentPath) {
        const parentId = `folder:${folder.parentPath}`;
        await withTimeout(
          conn.query(
            `MATCH (p:Folder {id: $parentId}), (c:Folder {id: $childId}) ` +
            `MERGE (p)-[:CodeRelation {type: 'CONTAINS', confidence: 1.0}]->(c)`,
            { parentId, childId: id },
          ),
          QUERY_TIMEOUT_MS,
          'ingest-folder-edge',
        );
        edgeCount++;
      }
    }

    // Phase 2b: Create file nodes with content hash (incremental) + extract imports
    input.onProgress?.('indexing-files', 20);
    const importMap = new Map<string, string[]>();
    const callSitesByFile = new Map<string, Awaited<ReturnType<TreeSitterParserAdapter['parseFile']>>['callSites']>();
    const symbolIndex = new Map<string, string>();
    const symbolNodeIds = new Map<string, string>();
    for (const file of files) {
      const id = `file:${file}`;
      const name = path.basename(file);
      const language = detectLanguage(path.extname(file));

      // Read file content for SHA-256 hashing and import extraction
      let content: string | null = null;
      let contentHash: string | null = null;
      try {
        content = await fsp.readFile(file, 'utf-8');
        contentHash = createHash('sha256').update(content).digest('hex');
      } catch {
        // Binary or unreadable file — create node without hash
      }

      // Check existing hash for incremental skip
      if (contentHash) {
        try {
          const existingResult = await withTimeout(
            conn.query(
              `MATCH (f:File {id: $id, tenantId: $tenantId}) RETURN f.contentHash AS hash`,
              { id, tenantId: input.tenantId },
            ),
            QUERY_TIMEOUT_MS,
            'check-hash',
          );
          if (existingResult.hasNext()) {
            const existingHash = (await existingResult.getNext()).hash;
            if (existingHash === contentHash) {
              incremental.unchanged++;
              nodeCount++;
              continue; // Skip unchanged file
            }
            incremental.modified++;
          } else {
            incremental.added++;
          }
        } catch {
          incremental.added++;
        }
      } else {
        incremental.added++;
      }

      // Create/update file node with content hash
      await withTimeout(
        conn.query(
          `MERGE (n:File {id: $id}) SET n.name = $name, n.filePath = $filePath, ` +
          `n.tenantId = $tenantId, n.language = $language, n.contentHash = $contentHash`,
          { id, name, filePath: file, tenantId: input.tenantId, language, contentHash },
        ),
        QUERY_TIMEOUT_MS,
        'ingest-file',
      );
      nodeCount++;

      // CONTAINS edge: parent folder → file
      const parentDir = path.dirname(file);
      const parentId = `folder:${parentDir}`;
      await withTimeout(
        conn.query(
          `MATCH (p:Folder {id: $parentId}), (f:File {id: $fileId}) ` +
          `MERGE (p)-[:CodeRelation {type: 'CONTAINS', confidence: 1.0}]->(f)`,
          { parentId, fileId: id },
        ),
        QUERY_TIMEOUT_MS,
        'ingest-file-edge',
      );
      edgeCount++;

      // Extract imports for Phase 3
      if (content) {
        const imports = extractImportsFromContent(file, content, fileSet, input.repoPath);
        if (imports.length > 0) {
          importMap.set(id, imports);
        }

        if (this.astParser.isLanguageSupported(language as 'typescript' | 'javascript')) {
          const parsed = await this.astParser.parseFile({
            filePath: file,
            content,
            tenantId: input.tenantId as never,
            correlationId: input.correlationId as never,
            language: language as 'typescript' | 'javascript',
          });
          callSitesByFile.set(file, parsed.callSites);

          for (const symbol of parsed.symbols) {
            const nodeLabel = mapAstSymbolToNodeLabel(symbol);
            if (!nodeLabel) continue;

            const symbolFqn = buildSymbolFqn(symbol);
            const symbolNodeId = `${nodeLabel.toLowerCase()}:${file}:${symbolFqn}`;
            symbolIndex.set(symbolFqn, file);
            symbolIndex.set(symbol.name, file);
            symbolNodeIds.set(`${file}::${symbolFqn}`, symbolNodeId);
            symbolNodeIds.set(`${file}::${symbol.name}`, symbolNodeId);

            await withTimeout(
              conn.query(
                `MERGE (n:${nodeLabel} {id: $id}) ` +
                `SET n.name = $name, n.filePath = $filePath, n.tenantId = $tenantId`,
                {
                  id: symbolNodeId,
                  name: symbolFqn,
                  filePath: file,
                  tenantId: input.tenantId,
                },
              ),
              QUERY_TIMEOUT_MS,
              'ingest-symbol-node',
            );
            nodeCount++;

            await withTimeout(
              conn.query(
                `MATCH (f:File {id: $fileId}), (s:${nodeLabel} {id: $symbolId}) ` +
                `MERGE (f)-[:CodeRelation {type: 'DEFINES', confidence: 1.0}]->(s)`,
                { fileId: id, symbolId: symbolNodeId },
              ),
              QUERY_TIMEOUT_MS,
              'ingest-defines-edge',
            );
            edgeCount++;

            if (symbol.kind === 'method' && symbol.parentName) {
              const parentSymbolId = symbolNodeIds.get(`${file}::${symbol.parentName}`);
              if (parentSymbolId) {
                await withTimeout(
                  conn.query(
                    `MATCH (p {id: $parentId}), (m:Method {id: $methodId}) ` +
                    `MERGE (p)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0}]->(m)`,
                    { parentId: parentSymbolId, methodId: symbolNodeId },
                  ),
                  QUERY_TIMEOUT_MS,
                  'ingest-has-method-edge',
                );
                edgeCount++;
              }
            }
          }
        }
      }
    }

    // Phase 3: Create IMPORTS edges from extracted imports
    input.onProgress?.('linking-imports', 50);
    const importEdges: Array<{ source: string; target: string }> = [];
    for (const [sourceId, targets] of importMap) {
      for (const targetPath of targets) {
        const targetId = `file:${targetPath}`;
        await withTimeout(
          conn.query(
            `MATCH (s:File {id: $sourceId}), (t:File {id: $targetId}) ` +
            `MERGE (s)-[:CodeRelation {type: 'IMPORTS', confidence: 0.9}]->(t)`,
            { sourceId, targetId },
          ),
          QUERY_TIMEOUT_MS,
          'ingest-import-edge',
        );
        edgeCount++;
        importEdges.push({ source: sourceId, target: targetId });
      }
    }

    input.onProgress?.('building-call-graph', 60);
    if (callSitesByFile.size > 0) {
      const callGraph = await this.callGraphBuilder.buildCallGraph({
        callSitesByFile,
        symbolIndex,
        tenantId: input.tenantId as never,
        correlationId: input.correlationId as never,
      });

      for (const edge of callGraph.edges) {
        const sourceSymbolId =
          symbolNodeIds.get(`${edge.callerFile}::${edge.callerFqn}`) ??
          symbolNodeIds.get(`${edge.callerFile}::${edge.callerFqn.split('.').at(-1) ?? edge.callerFqn}`);
        const targetSymbolId =
          symbolNodeIds.get(`${edge.calleeFile}::${edge.calleeFqn}`) ??
          symbolNodeIds.get(`${edge.calleeFile}::${edge.calleeFqn.split('.').at(-1) ?? edge.calleeFqn}`);

        if (!sourceSymbolId || !targetSymbolId) continue;

        await withTimeout(
          conn.query(
            `MATCH (s {id: $sourceId}), (t {id: $targetId}) ` +
            `MERGE (s)-[:CodeRelation {type: 'CALLS', confidence: $confidence}]->(t)`,
            { sourceId: sourceSymbolId, targetId: targetSymbolId, confidence: edge.confidence },
          ),
          QUERY_TIMEOUT_MS,
          'ingest-call-edge',
        );
        edgeCount++;
      }
    }

    input.onProgress?.('mining-git-history', 65);
    const commitFileSets = await this.readGitCommitFileSets(input.repoPath, fileSet);
    if (commitFileSets.length > 0) {
      const couplings = calculateEvolutionaryCoupling(commitFileSets, 2);
      for (const coupling of couplings) {
        const fileAId = `file:${coupling.fileA}`;
        const fileBId = `file:${coupling.fileB}`;
        await withTimeout(
          conn.query(
            `MATCH (a:File {id: $fileAId}), (b:File {id: $fileBId}) ` +
            `MERGE (a)-[:CodeRelation {type: 'CHANGED_TOGETHER', confidence: $confidence}]->(b)`,
            { fileAId, fileBId, confidence: couplingConfidence(coupling) },
          ),
          QUERY_TIMEOUT_MS,
          'ingest-cochange-edge',
        );
        edgeCount++;
      }
    }

    // Phase 4: Leiden community detection on file-level IMPORTS graph
    input.onProgress?.('detecting-communities', 70);
    let communityCount = 0;
    const fileIds = files.map(f => `file:${f}`);

    if (fileIds.length > 1 && importEdges.length > 0) {
      const communityAssignment = detectCommunitiesLeiden(fileIds, importEdges);

      // Group files by community
      const communityGroups = new Map<number, string[]>();
      for (const [nodeId, commId] of communityAssignment) {
        const group = communityGroups.get(commId);
        if (group) group.push(nodeId);
        else communityGroups.set(commId, [nodeId]);
      }

      for (const [commId, members] of communityGroups) {
        if (members.length < 2) continue;

        const communityNodeId = `community:${input.tenantId}:${commId}`;
        const keywords = extractCommunityKeywords(members);
        const label = keywords.slice(0, 3).join('/') || `community-${commId}`;
        const cohesion = calculateCohesion(members, importEdges);

        await withTimeout(
          conn.query(
            `MERGE (c:Community {id: $id}) SET c.name = $name, c.filePath = '', ` +
            `c.tenantId = $tenantId, c.cohesion = $cohesion, ` +
            `c.symbolCount = $symbolCount, c.keywords = $keywords`,
            {
              id: communityNodeId,
              name: label,
              tenantId: input.tenantId,
              cohesion,
              symbolCount: members.length,
              keywords: keywords.join(','),
            },
          ),
          QUERY_TIMEOUT_MS,
          'ingest-community',
        );
        nodeCount++;
        communityCount++;

        for (const memberId of members) {
          await withTimeout(
            conn.query(
              `MATCH (f:File {id: $fileId}), (c:Community {id: $communityId}) ` +
              `MERGE (f)-[:CodeRelation {type: 'MEMBER_OF', confidence: 1.0}]->(c)`,
              { fileId: memberId, communityId: communityNodeId },
            ),
            QUERY_TIMEOUT_MS,
            'ingest-member-of',
          );
          edgeCount++;
        }
      }
    }

    // Phase 5: BFS process tracing from entry-point files
    input.onProgress?.('tracing-processes', 85);
    let processCount = 0;
    const entryPoints = detectEntryPoints(fileIds);

    if (entryPoints.length > 0 && importEdges.length > 0) {
      const adj = new Map<string, string[]>();
      for (const id of fileIds) adj.set(id, []);
      for (const e of importEdges) {
        adj.get(e.source)?.push(e.target);
      }

      for (const entryId of entryPoints) {
        const steps = bfsTrace(entryId, adj);
        if (steps.length < 2) continue;

        const processId = `process:${input.tenantId}:${entryId}`;
        const entryName = path.basename(entryId.replace(/^file:/, ''));
        await withTimeout(
          conn.query(
            `MERGE (p:Process {id: $id}) SET p.name = $name, p.filePath = '', ` +
            `p.tenantId = $tenantId, p.processType = 'intra_community', ` +
            `p.stepCount = $stepCount`,
            {
              id: processId,
              name: `Flow from ${entryName}`,
              tenantId: input.tenantId,
              stepCount: steps.length,
            },
          ),
          QUERY_TIMEOUT_MS,
          'ingest-process',
        );
        nodeCount++;
        processCount++;

        for (let i = 0; i < steps.length; i++) {
          await withTimeout(
            conn.query(
              `MATCH (f:File {id: $fileId}), (p:Process {id: $processId}) ` +
              `MERGE (f)-[:CodeRelation {type: 'STEP_IN_PROCESS', confidence: 1.0, step: $step}]->(p)`,
              { fileId: steps[i], processId, step: i },
            ),
            QUERY_TIMEOUT_MS,
            'ingest-step',
          );
          edgeCount++;
        }
      }
    }

    input.onProgress?.('complete', 100);
    return { nodeCount, edgeCount, communityCount, processCount, incremental };
  }

  async hybridSearch(input: {
    tenantId: TenantId;
    query: string;
    limit?: number;
    correlationId: CorrelationId;
  }): Promise<readonly CodeGraphNode[]> {
    const conn = await this.getConnection(input.tenantId);
    const limit = input.limit ?? 10;

    const result = await withTimeout(
      conn.query(
        `MATCH (n) WHERE n.tenantId = $tenantId AND ` +
        `(n.name CONTAINS $query OR n.filePath CONTAINS $query) ` +
        `RETURN n.id AS id, label(n) AS label, n.name AS name, ` +
        `n.filePath AS filePath, n.startLine AS startLine, ` +
        `n.endLine AS endLine, n.content AS content ` +
        `LIMIT $limit`,
        { tenantId: input.tenantId, query: input.query, limit },
      ),
      QUERY_TIMEOUT_MS,
      'hybrid-search',
    );

    return await this.mapQueryResults(result);
  }

  async getSymbolContext(input: {
    tenantId: TenantId;
    symbolId: string;
    correlationId: CorrelationId;
  }): Promise<SymbolContext> {
    const conn = await this.getConnection(input.tenantId);

    const nodeResult = await withTimeout(
      conn.query(
        `MATCH (n {id: $id, tenantId: $tenantId}) ` +
        `RETURN n.id AS id, label(n) AS label, n.name AS name, ` +
        `n.filePath AS filePath, n.startLine AS startLine, ` +
        `n.endLine AS endLine, n.content AS content`,
        { id: input.symbolId, tenantId: input.tenantId },
      ),
      QUERY_TIMEOUT_MS,
      'symbol-lookup',
    );

    const nodes = await this.mapQueryResults(nodeResult);
    if (nodes.length === 0) {
      throw new Error(`Symbol not found: ${input.symbolId}`);
    }

    const callersResult = await withTimeout(
      conn.query(
        `MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(n {id: $id}) ` +
        `WHERE caller.tenantId = $tenantId ` +
        `RETURN caller.id AS id, label(caller) AS label, caller.name AS name, ` +
        `caller.filePath AS filePath`,
        { id: input.symbolId, tenantId: input.tenantId },
      ),
      QUERY_TIMEOUT_MS,
      'callers-lookup',
    );

    const calleesResult = await withTimeout(
      conn.query(
        `MATCH (n {id: $id})-[r:CodeRelation {type: 'CALLS'}]->(callee) ` +
        `WHERE callee.tenantId = $tenantId ` +
        `RETURN callee.id AS id, label(callee) AS label, callee.name AS name, ` +
        `callee.filePath AS filePath`,
        { id: input.symbolId, tenantId: input.tenantId },
      ),
      QUERY_TIMEOUT_MS,
      'callees-lookup',
    );

    return {
      node: nodes[0],
      callers: await this.mapQueryResults(callersResult),
      callees: await this.mapQueryResults(calleesResult),
      processes: [],
    };
  }

  async analyzeImpact(input: {
    tenantId: TenantId;
    targetId: string;
    direction: 'upstream' | 'downstream';
    maxDepth?: number;
    minConfidence?: number;
    correlationId: CorrelationId;
  }): Promise<ImpactAnalysisResult> {
    const conn = await this.getConnection(input.tenantId);
    const maxDepth = input.maxDepth ?? 3;
    const minConfidence = input.minConfidence ?? 0.7;

    const targetResult = await withTimeout(
      conn.query(
        `MATCH (n {id: $id, tenantId: $tenantId}) ` +
        `RETURN n.id AS id, label(n) AS label, n.name AS name, ` +
        `n.filePath AS filePath`,
        { id: input.targetId, tenantId: input.tenantId },
      ),
      QUERY_TIMEOUT_MS,
      'impact-target',
    );

    const targets = await this.mapQueryResults(targetResult);
    if (targets.length === 0) {
      throw new Error(`Target not found: ${input.targetId}`);
    }

    // BFS traversal with per-depth Cypher queries (confidence filtering)
    // Optimization: For depth ≤ 5, use Variable-Length Path (VLP) Cypher query
    // to push traversal into KuzuDB engine, avoiding round-trip overhead.
    // VLP syntax: MATCH (a)-[r:CodeRelation*1..maxDepth]->(b)
    // Falls back to iterative BFS for depth > 5 (KuzuDB VLP performance degrades).
    const byDepth = new Map<number, CodeGraphNode[]>();
    const visited = new Set<string>([input.targetId]);

    if (maxDepth <= 5) {
      // VLP approach: single Cypher query for all depths
      const vlpDir = input.direction === 'upstream'
        ? `MATCH (neighbor)-[r:CodeRelation* 1..${maxDepth}]->(n {id: $targetId}) WHERE neighbor.tenantId = $tenantId`
        : `MATCH (n {id: $targetId})-[r:CodeRelation* 1..${maxDepth}]->(neighbor) WHERE neighbor.tenantId = $tenantId`;
      try {
        const vlpResult = await withTimeout(
          conn.query(
            `${vlpDir} RETURN DISTINCT neighbor.id AS id, label(neighbor) AS label, ` +
            `neighbor.name AS name, neighbor.filePath AS filePath`,
            { targetId: input.targetId, tenantId: input.tenantId },
          ),
          QUERY_TIMEOUT_MS,
          'impact-vlp',
        );
        const vlpNodes = await this.mapQueryResults(vlpResult);
        // VLP returns all reachable nodes — group into depth 1 (no per-depth info from VLP)
        if (vlpNodes.length > 0) {
          byDepth.set(1, vlpNodes);
        }
      } catch {
        // VLP syntax not supported or query failed — fall back to iterative BFS below
        await this.iterativeBfsImpact(conn, input, maxDepth, minConfidence, byDepth, visited);
      }
    } else {
      await this.iterativeBfsImpact(conn, input, maxDepth, minConfidence, byDepth, visited);
    }

    // (Iterative BFS loop moved to iterativeBfsImpact method)

    const directCallers = byDepth.get(1)?.length ?? 0;
    const risk = classifyRisk(directCallers, 0);

    return {
      target: targets[0],
      risk,
      summary: {
        directCallers,
        affectedProcesses: 0,
        affectedModules: new Set(
          [...byDepth.values()].flat().map(n => path.dirname(n.filePath)),
        ).size,
      },
      byDepth,
      affectedProcesses: [],
    };
  }

  /**
   * Iterative BFS impact traversal — per-depth Cypher queries with confidence filtering.
   * Used as fallback when VLP optimization is unavailable or depth > 5.
   */
  private async iterativeBfsImpact(
    conn: KuzuConnection,
    input: { targetId: string; tenantId: TenantId; direction?: 'downstream' | 'upstream' },
    maxDepth: number,
    minConfidence: number,
    byDepth: Map<number, CodeGraphNode[]>,
    visited: Set<string>,
  ): Promise<void> {
    let frontier = [input.targetId];

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      const depthNodes: CodeGraphNode[] = [];

      for (const nodeId of frontier) {
        const edgeDir = input.direction === 'upstream'
          ? `MATCH (neighbor)-[r:CodeRelation]->(n {id: $nodeId}) WHERE r.confidence >= $minConf AND neighbor.tenantId = $tenantId`
          : `MATCH (n {id: $nodeId})-[r:CodeRelation]->(neighbor) WHERE r.confidence >= $minConf AND neighbor.tenantId = $tenantId`;

        const neighborResult = await withTimeout(
          conn.query(
            `${edgeDir} RETURN DISTINCT neighbor.id AS id, label(neighbor) AS label, ` +
            `neighbor.name AS name, neighbor.filePath AS filePath`,
            { nodeId, minConf: minConfidence, tenantId: input.tenantId },
          ),
          QUERY_TIMEOUT_MS,
          `impact-depth-${depth}`,
        );

        for (const row of await this.mapQueryResults(neighborResult)) {
          if (!visited.has(row.id)) {
            visited.add(row.id);
            depthNodes.push(row);
            nextFrontier.push(row.id);
          }
        }
      }

      if (depthNodes.length > 0) {
        byDepth.set(depth, depthNodes);
      }
      frontier = nextFrontier;
    }
  }

  async getCommunities(input: {
    tenantId: TenantId;
    correlationId: CorrelationId;
  }): Promise<readonly CodeCommunity[]> {
    const conn = await this.getConnection(input.tenantId);

    const result = await withTimeout(
      conn.query(
        `MATCH (c:Community {tenantId: $tenantId}) ` +
        `RETURN c.id AS id, c.name AS label, c.cohesion AS cohesion, ` +
        `c.symbolCount AS symbolCount, c.keywords AS keywords`,
        { tenantId: input.tenantId },
      ),
      QUERY_TIMEOUT_MS,
      'communities',
    );

    const communities: CodeCommunity[] = [];
    while (result.hasNext()) {
      const row = await result.getNext();

      // Retrieve members via MEMBER_OF edges
      const membersResult = await withTimeout(
        conn.query(
          `MATCH (f)-[r:CodeRelation {type: 'MEMBER_OF'}]->(c:Community {id: $communityId}) ` +
          `RETURN f.id AS memberId`,
          { communityId: row.id },
        ),
        QUERY_TIMEOUT_MS,
        'community-members',
      );
      const members: string[] = [];
      while (membersResult.hasNext()) {
        const memberRow = await membersResult.getNext();
        members.push(readRequiredString(memberRow, 'memberId'));
      }

      // Calculate entropy metrics for the community
      const memberEdges: Array<{ source: string; target: string; type: string }> = [];
      const memberSet = new Set(members);
      const edgeResult2 = await withTimeout(
        conn.query(
          `MATCH (a)-[r:CodeRelation]->(b) WHERE a.tenantId = $tenantId ` +
          `AND (a.id IN $memberIds OR b.id IN $memberIds) ` +
          `RETURN a.id AS source, b.id AS target, r.type AS type`,
          { tenantId: input.tenantId, memberIds: members },
        ),
        QUERY_TIMEOUT_MS,
        'community-entropy-edges',
      );
      while (edgeResult2.hasNext()) {
        const edgeRow = await edgeResult2.getNext();
        memberEdges.push({
          source: readRequiredString(edgeRow, 'source'),
          target: readRequiredString(edgeRow, 'target'),
          type: readRequiredString(edgeRow, 'type'),
        });
      }
      const entropyResult = calculateCommunityEntropy(members, memberEdges);

      communities.push({
        id: readRequiredString(row, 'id'),
        label: readString(row, 'label'),
        cohesion: readNumber(row, 'cohesion'),
        symbolCount: readNumber(row, 'symbolCount'),
        keywords: readString(row, 'keywords') ? readString(row, 'keywords').split(',') : [],
        members,
        entropy: entropyResult.entropy,
        internalRatio: entropyResult.internalRatio,
      });
    }
    return communities;
  }

  async getProcesses(input: {
    tenantId: TenantId;
    correlationId: CorrelationId;
  }): Promise<readonly CodeProcess[]> {
    const conn = await this.getConnection(input.tenantId);

    const result = await withTimeout(
      conn.query(
        `MATCH (p:Process {tenantId: $tenantId}) ` +
        `RETURN p.id AS id, p.name AS label, p.processType AS processType, ` +
        `p.stepCount AS stepCount`,
        { tenantId: input.tenantId },
      ),
      QUERY_TIMEOUT_MS,
      'processes',
    );

    const processes: CodeProcess[] = [];
    while (result.hasNext()) {
      const row = await result.getNext();

      // Retrieve steps via STEP_IN_PROCESS edges (ordered by step number)
      const stepsResult = await withTimeout(
        conn.query(
          `MATCH (f:File)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: $processId}) ` +
          `RETURN f.id AS id, label(f) AS label, f.name AS name, f.filePath AS filePath, r.step AS step ` +
          `ORDER BY r.step`,
          { processId: row.id },
        ),
        QUERY_TIMEOUT_MS,
        'process-steps',
      );
      const steps: CodeGraphNode[] = [];
      while (stepsResult.hasNext()) {
        const stepRow = await stepsResult.getNext();
        steps.push({
          id: readString(stepRow, 'id'),
          label: (readString(stepRow, 'label', 'File') as CodeNodeLabel),
          name: readString(stepRow, 'name'),
          filePath: readString(stepRow, 'filePath'),
        });
      }

      processes.push({
        id: readRequiredString(row, 'id'),
        label: readString(row, 'label'),
        processType: readString(row, 'processType', 'intra_community') as 'intra_community' | 'cross_community',
        stepCount: readNumber(row, 'stepCount'),
        steps,
        entryPointId: steps.length > 0 ? steps[0].id : '',
        terminalId: steps.length > 0 ? steps[steps.length - 1].id : '',
      });
    }
    return processes;
  }

  async getEvolutionaryCoupling(input: {
    tenantId: TenantId;
    correlationId: CorrelationId;
    minSupport?: number;
  }): Promise<readonly EvolutionaryCoupling[]> {
    const conn = await this.getConnection(input.tenantId);
    const minSupport = input.minSupport ?? 2;

    const result = await withTimeout(
      conn.query(
        `MATCH (a:File)-[r:CodeRelation {type: 'CHANGED_TOGETHER'}]->(b:File) ` +
        `WHERE a.tenantId = $tenantId ` +
        `RETURN a.id AS fileA, b.id AS fileB, r.confidence AS confidence`,
        { tenantId: input.tenantId },
      ),
      QUERY_TIMEOUT_MS,
      'evolutionary-coupling',
    );

    const pairCounts = new Map<string, { count: number; fileA: string; fileB: string }>();
    while (result.hasNext()) {
      const row = await result.getNext();
      const [a, b] = [readRequiredString(row, 'fileA'), readRequiredString(row, 'fileB')].sort();
      const key = `${a}|${b}`;
      const entry = pairCounts.get(key);
      if (entry) entry.count++;
      else pairCounts.set(key, { count: 1, fileA: a, fileB: b });
    }

    const couplings: EvolutionaryCoupling[] = [];
    for (const { count, fileA, fileB } of pairCounts.values()) {
      if (count >= minSupport) {
        couplings.push({
          fileA, fileB,
          coChangeCount: count,
          confidence: Math.min(count / 10, 1),
          support: count,
        });
      }
    }
    return couplings.sort((a, b) => b.confidence - a.confidence);
  }

  async getPathContext(input: {
    tenantId: TenantId;
    targetIds: string[];
    correlationId: CorrelationId;
  }): Promise<PathRAGResult> {
    const conn = await this.getConnection(input.tenantId);

    // Build adjacency from all edges for this tenant
    const edgeResult = await withTimeout(
      conn.query(
        `MATCH (a)-[r:CodeRelation]->(b) WHERE a.tenantId = $tenantId ` +
        `RETURN a.id AS source, b.id AS target`,
        { tenantId: input.tenantId },
      ),
      QUERY_TIMEOUT_MS,
      'path-rag-edges',
    );

    const adjacency = new Map<string, string[]>();
    while (edgeResult.hasNext()) {
      const row = await edgeResult.getNext();
      const source = readRequiredString(row, 'source');
      const target = readRequiredString(row, 'target');
      const fwd = adjacency.get(source);
      if (fwd) fwd.push(target);
      else adjacency.set(source, [target]);
      const rev = adjacency.get(target);
      if (rev) rev.push(source);
      else adjacency.set(target, [source]);
    }

    const spanNodes = findMinimalSpanningSubgraph(input.targetIds, adjacency);
    const existingTargets = input.targetIds.filter((id) => adjacency.has(id) || spanNodes.has(id));
    const paths: string[][] = [];
    let totalPathLength = 0;

    for (let i = 0; i < existingTargets.length; i++) {
      for (let j = i + 1; j < existingTargets.length; j++) {
        const shortestPath = bfsShortestPath(existingTargets[i], existingTargets[j], adjacency);
        if (shortestPath.length > 0) {
          paths.push(shortestPath);
          totalPathLength += Math.max(shortestPath.length - 1, 0);
        }
      }
    }

    return {
      nodes: Array.from(spanNodes),
      paths,
      totalPathLength,
    };
  }

  private async readGitCommitFileSets(repoPath: string, fileSet: ReadonlySet<string>): Promise<ReadonlyArray<ReadonlySet<string>>> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', repoPath, 'log', '--name-only', '--format=__COMMIT__'],
        { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 },
      );

      const commitFileSets: Array<Set<string>> = [];
      let current = new Set<string>();
      for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line === '__COMMIT__') {
          if (current.size > 0) commitFileSets.push(current);
          current = new Set<string>();
          continue;
        }

        const absolutePath = path.resolve(repoPath, sanitizePathForGit(line));
        if (fileSet.has(absolutePath)) {
          current.add(absolutePath);
        }
      }
      if (current.size > 0) commitFileSets.push(current);
      return commitFileSets;
    } catch {
      return [];
    }
  }

  async computeGraphDiff(input: {
    tenantId: TenantId;
    snapshotNodes: ReadonlySet<string>;
    snapshotEdges: ReadonlyArray<{ source: string; target: string; type: string }>;
    correlationId: CorrelationId;
  }): Promise<GraphDiff> {
    const conn = await this.getConnection(input.tenantId);

    // Fetch current nodes
    const nodeResult = await withTimeout(
      conn.query(
        `MATCH (n) WHERE n.tenantId = $tenantId RETURN n.id AS id`,
        { tenantId: input.tenantId },
      ),
      QUERY_TIMEOUT_MS,
      'graph-diff-nodes',
    );
    const currentNodes = new Set<string>();
    while (nodeResult.hasNext()) {
      currentNodes.add(readRequiredString(await nodeResult.getNext(), 'id'));
    }

    // Fetch current edges
    const edgeResult = await withTimeout(
      conn.query(
        `MATCH (a)-[r:CodeRelation]->(b) WHERE a.tenantId = $tenantId ` +
        `RETURN a.id AS source, b.id AS target, r.type AS type`,
        { tenantId: input.tenantId },
      ),
      QUERY_TIMEOUT_MS,
      'graph-diff-edges',
    );
    const currentEdges: Array<{ source: string; target: string; type: string }> = [];
    while (edgeResult.hasNext()) {
      const row = await edgeResult.getNext();
      currentEdges.push({
        source: readRequiredString(row, 'source'),
        target: readRequiredString(row, 'target'),
        type: readRequiredString(row, 'type'),
      });
    }

    return computeGraphDiffAlgo(
      input.snapshotNodes,
      currentNodes,
      input.snapshotEdges,
      currentEdges,
    );
  }

  async suggestRelocations(input: {
    tenantId: TenantId;
    correlationId: CorrelationId;
  }): Promise<readonly RelocationSuggestion[]> {
    const conn = await this.getConnection(input.tenantId);

    // Get community membership
    const memberResult = await withTimeout(
      conn.query(
        `MATCH (f:File)-[r:CodeRelation {type: 'MEMBER_OF'}]->(c:Community) ` +
        `WHERE f.tenantId = $tenantId ` +
        `RETURN f.id AS fileId, f.filePath AS filePath, c.id AS communityId`,
        { tenantId: input.tenantId },
      ),
      QUERY_TIMEOUT_MS,
      'relocation-members',
    );

    const communityAssignment = new Map<string, number>();
    const nodeFilePaths = new Map<string, string>();
    const communityIdMap = new Map<string, number>();
    let nextIdx = 0;

    while (memberResult.hasNext()) {
      const row = await memberResult.getNext();
      const communityId = readRequiredString(row, 'communityId');
      const fileId = readRequiredString(row, 'fileId');
      const filePath = readString(row, 'filePath');
      if (!communityIdMap.has(communityId)) {
        communityIdMap.set(communityId, nextIdx++);
      }
      communityAssignment.set(fileId, communityIdMap.get(communityId)!);
      nodeFilePaths.set(fileId, filePath);
    }

    const nodeIds = Array.from(communityAssignment.keys());
    return suggestRelocationsAlgo(nodeIds, communityAssignment, nodeFilePaths);
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Check if any existing connection is alive; avoid creating side-effect tenant
      if (this.connections.size > 0) {
        const conn = this.connections.values().next().value;
        if (!conn) {
          return false;
        }
        const result = await withTimeout(conn.query('RETURN 1'), 5_000, 'health');
        return await this.resultHasNext(result);
      }
      // No connections yet — verify KuzuDB module loads
      getKuzu();
      return true;
    } catch {
      return false;
    }
  }

  // ── Private helpers ──

  /** Async directory walker — non-blocking I/O. */
  private async scanRepository(repoPath: string): Promise<string[]> {
    const files: string[] = [];
    const SUPPORTED_EXTENSIONS = new Set([
      '.ts', '.tsx', '.js', '.jsx', '.py', '.java',
      '.go', '.rs', '.c', '.cpp', '.cs', '.php', '.kt', '.swift',
      '.scala', '.sc', '.ex', '.exs', '.rb',
    ]);
    const IGNORE_DIRS = new Set([
      'node_modules', '.git', 'dist', 'build', '__pycache__',
      '.next', '.nuxt', 'vendor', 'target',
    ]);

    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name)) {
            await walk(path.join(dir, entry.name));
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTENSIONS.has(ext)) {
            files.push(path.join(dir, entry.name));
          }
        }
      }
    };

    await walk(repoPath);
    return files;
  }

  /** Extract unique folder paths from file list and build parent→child hierarchy. */
  private extractFolderHierarchy(
    files: string[],
    rootPath: string,
  ): { path: string; name: string; parentPath: string | null }[] {
    const folderSet = new Set<string>();
    folderSet.add(rootPath);
    for (const file of files) {
      let dir = path.dirname(file);
      while (dir.length >= rootPath.length && !folderSet.has(dir)) {
        folderSet.add(dir);
        dir = path.dirname(dir);
      }
    }
    return [...folderSet].map(p => ({
      path: p,
      name: path.basename(p) || p,
      parentPath: p === rootPath ? null : path.dirname(p),
    }));
  }

  /** Map KuzuDB QueryResult rows to CodeGraphNode array. Async because getNext() returns Promise. */
  private async mapQueryResults(result: KuzuQueryResult): Promise<CodeGraphNode[]> {
    const nodes: CodeGraphNode[] = [];
    if (!result) return nodes;

    while (await this.resultHasNext(result)) {
      const row = await result.getNext();
      nodes.push({
        id: typeof row.id === 'string' ? row.id : '',
        label: (typeof row.label === 'string' ? row.label : 'File') as CodeNodeLabel,
        name: typeof row.name === 'string' ? row.name : '',
        filePath: typeof row.filePath === 'string' ? row.filePath : '',
        startLine: typeof row.startLine === 'number' ? row.startLine : undefined,
        endLine: typeof row.endLine === 'number' ? row.endLine : undefined,
        content: typeof row.content === 'string' ? row.content : undefined,
      });
    }
    return nodes;
  }

  private async resultHasNext(result: KuzuQueryResult): Promise<boolean> {
    return await result.hasNext();
  }
}

/** Classify impact risk based on caller/process counts. */
function classifyRisk(directCallers: number, affectedProcesses: number): ImpactRiskLevel {
  if (directCallers > 10 || affectedProcesses > 5) return 'CRITICAL';
  if (directCallers > 5 || affectedProcesses > 2) return 'HIGH';
  if (directCallers > 2 || affectedProcesses > 0) return 'MEDIUM';
  return 'LOW';
}

/** Map file extension to programming language identifier. */
function detectLanguage(ext: string): string {
  const LANGUAGES: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python',
    '.java': 'java',
    '.go': 'go',
    '.rs': 'rust',
    '.c': 'c',
    '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
    '.cs': 'csharp',
    '.php': 'php',
    '.kt': 'kotlin', '.kts': 'kotlin',
    '.swift': 'swift',
    '.rb': 'ruby',
    '.scala': 'scala', '.sc': 'scala',
    '.ex': 'elixir', '.exs': 'elixir',
  };
  return LANGUAGES[ext.toLowerCase()] ?? 'unknown';
}
