/**
 * KnowledgeGraphEngine — AST-driven knowledge graph for MicroPhoenix codebase.
 *
 * Wraps the `graphology` library to provide a typed, directed multi-graph
 * optimized for code-entity relationships: modules, DI tokens, interfaces,
 * implementations, methods, MDC rules, layers, and test files.
 *
 * Supports:
 * - BFS traversal with configurable max depth
 * - Typed node/edge queries
 * - Structural question answering ("What depends on IEventStore?")
 * - Serialization to CONTEXT_INDEX.json-compatible format
 *
 * @layer Infrastructure/Context
 * @phase 5 — V3 Context Engineering: Knowledge Graph + GraphRAG
 * @see microsoft/graphrag — Graph RAG reference architecture
 * @see graphology (npm) — underlying graph library by SciencesPo médialab
 */

import Graph from 'graphology';

// ── Types ───────────────────────────────────────────────────────────

export type NodeType =
  | 'module'
  | 'token'
  | 'interface'
  | 'implementation'
  | 'method'
  | 'mdc_rule'
  | 'layer'
  | 'test'
  | 'glossary_term';

export type EdgeRelation =
  | 'registers'
  | 'resolves'
  | 'implements'
  | 'depends_on'
  | 'applies_to'
  | 'references'
  | 'covers'
  | 'has_method'
  | 'belongs_to'
  | 'defines';

export interface KGNode {
  readonly id: string;
  readonly type: NodeType;
  readonly label: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface KGEdge {
  readonly source: string;
  readonly target: string;
  readonly relation: EdgeRelation;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TraversalResult {
  readonly nodes: readonly KGNode[];
  readonly edges: readonly KGEdge[];
  readonly hops: number;
}

export interface GraphStats {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly nodesByType: Readonly<Record<string, number>>;
  readonly edgesByRelation: Readonly<Record<string, number>>;
}

// ── Constants ───────────────────────────────────────────────────────

const MAX_TRAVERSAL_DEPTH = 10;

// ── Engine ──────────────────────────────────────────────────────────

export class KnowledgeGraphEngine {
  private readonly graph: Graph;

  constructor() {
    this.graph = new Graph({ multi: true, type: 'directed' });
  }

  // ── Node Operations ─────────────────────────────────────────────

  /**
   * Add a node. Idempotent: duplicate IDs are silently ignored.
   */
  addNode(node: KGNode): void {
    if (!this.graph.hasNode(node.id)) {
      this.graph.addNode(node.id, {
        type: node.type,
        label: node.label,
        metadata: node.metadata,
      });
    }
  }

  /**
   * Add a directed edge. Creates missing endpoint stubs automatically.
   */
  addEdge(edge: KGEdge): void {
    // Ensure both endpoints exist (auto-stub unknown nodes)
    if (!this.graph.hasNode(edge.source)) {
      this.addNode({
        id: edge.source,
        type: 'token',
        label: edge.source,
        metadata: { stub: true },
      });
    }
    if (!this.graph.hasNode(edge.target)) {
      this.addNode({
        id: edge.target,
        type: 'token',
        label: edge.target,
        metadata: { stub: true },
      });
    }

    this.graph.addDirectedEdge(edge.source, edge.target, {
      relation: edge.relation,
      ...(edge.metadata ?? {}),
    });
  }

  hasNode(id: string): boolean {
    return this.graph.hasNode(id);
  }

  getNode(id: string): KGNode | undefined {
    if (!this.graph.hasNode(id)) return undefined;
    const attrs = this.graph.getNodeAttributes(id);
    return {
      id,
      type: attrs.type as NodeType,
      label: attrs.label as string,
      metadata: (attrs.metadata ?? {}) as Record<string, unknown>,
    };
  }

  getNodesByType(type: NodeType): KGNode[] {
    const result: KGNode[] = [];
    this.graph.forEachNode((id, attrs) => {
      if (attrs.type === type) {
        result.push({
          id,
          type: attrs.type as NodeType,
          label: (attrs.label as string) ?? id,
          metadata: (attrs.metadata ?? {}) as Record<string, unknown>,
        });
      }
    });
    return result;
  }

  // ── Traversal ─────────────────────────────────────────────────────

  /**
   * BFS traversal from startId within maxDepth hops.
   * Follows both outgoing and incoming edges (undirected traversal).
   */
  traverse(startId: string, maxDepth: number = 3): TraversalResult {
    const safeDepth = Math.min(maxDepth, MAX_TRAVERSAL_DEPTH);
    if (!this.graph.hasNode(startId)) {
      return { nodes: [], edges: [], hops: 0 };
    }

    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [
      { id: startId, depth: 0 },
    ];
    const resultNodes: KGNode[] = [];
    const resultEdges: KGEdge[] = [];
    let maxHop = 0;

    // FIX: PH-002 — head pointer BFS instead of Array.shift() to avoid O(n²)
    let head = 0;
    while (head < queue.length) {
      const { id, depth } = queue[head++];
      if (visited.has(id) || depth > safeDepth) continue;
      visited.add(id);
      maxHop = Math.max(maxHop, depth);

      const node = this.getNode(id);
      if (node) resultNodes.push(node);

      // Collect outgoing edges
      this.graph.forEachOutEdge(id, (_edge, attrs, _src, tgt) => {
        resultEdges.push({
          source: id,
          target: tgt,
          relation: attrs.relation as EdgeRelation,
        });
        if (!visited.has(tgt)) queue.push({ id: tgt, depth: depth + 1 });
      });

      // Collect incoming edges
      this.graph.forEachInEdge(id, (_edge, attrs, src) => {
        resultEdges.push({
          source: src,
          target: id,
          relation: attrs.relation as EdgeRelation,
        });
        if (!visited.has(src)) queue.push({ id: src, depth: depth + 1 });
      });
    }

    return { nodes: resultNodes, edges: resultEdges, hops: maxHop };
  }

  // ── Query ─────────────────────────────────────────────────────────

  /**
   * Answer a structural question about the codebase.
   *
   * Extracts entity references (IFoo, FooService, etc.) from the question,
   * traverses the graph from matched nodes, and returns relevant subgraph.
   */
  query(question: string, maxDepth: number = 2): TraversalResult {
    // Extract potential entity names from question
    const entityPatterns = [
      /I[A-Z]\w+/g,                         // Interfaces: IEventStore, IConfigLoader
      /[A-Z][a-z]+(?:[A-Z][a-z]+)+/g,       // PascalCase: EventStore, PromptInjectionScanner
      /DI_TOKENS\.\w+/g,                     // DI tokens: DI_TOKENS.IEventStore
    ];

    const candidates = new Set<string>();
    for (const pattern of entityPatterns) {
      const matches = question.match(pattern);
      if (matches) {
        for (const m of matches) {
          const cleaned = m.replace('DI_TOKENS.', '');
          candidates.add(cleaned);
        }
      }
    }

    // Find matching nodes and merge traversals
    const allNodes = new Map<string, KGNode>();
    const allEdges: KGEdge[] = [];
    let maxHop = 0;

    // Node IDs may be prefixed (e.g., 'token:IEventStore', 'interface:IEventStore')
    const prefixes = ['', 'token:', 'interface:', 'impl:', 'module:', 'mdc_rule:', 'method:', 'glossary_term:'];

    for (const candidate of candidates) {
      for (const prefix of prefixes) {
        const nodeId = `${prefix}${candidate}`;
        if (this.graph.hasNode(nodeId)) {
          const result = this.traverse(nodeId, maxDepth);
          for (const n of result.nodes) allNodes.set(n.id, n);
          allEdges.push(...result.edges);
          maxHop = Math.max(maxHop, result.hops);
        }
      }
    }

    // Deduplicate edges
    const edgeSet = new Set<string>();
    const uniqueEdges = allEdges.filter((e) => {
      const key = `${e.source}→${e.target}:${e.relation}`;
      if (edgeSet.has(key)) return false;
      edgeSet.add(key);
      return true;
    });

    return {
      nodes: Array.from(allNodes.values()),
      edges: uniqueEdges,
      hops: maxHop,
    };
  }

  // ── Statistics ────────────────────────────────────────────────────

  getStats(): GraphStats {
    const nodesByType: Record<string, number> = {};
    this.graph.forEachNode((_id, attrs) => {
      const type = (attrs.type as string) ?? 'unknown';
      nodesByType[type] = (nodesByType[type] ?? 0) + 1;
    });

    const edgesByRelation: Record<string, number> = {};
    this.graph.forEachEdge((_edge, attrs) => {
      const rel = (attrs.relation as string) ?? 'unknown';
      edgesByRelation[rel] = (edgesByRelation[rel] ?? 0) + 1;
    });

    return {
      nodeCount: this.graph.order,
      edgeCount: this.graph.size,
      nodesByType,
      edgesByRelation,
    };
  }

  // ── Serialization ─────────────────────────────────────────────────

  /**
   * Export graph summary in a format compatible with CONTEXT_INDEX.json enrichment.
   */
  toContextIndexFragment(): Record<string, unknown> {
    const stats = this.getStats();
    const modules = this.getNodesByType('module').map((n) => ({
      name: n.label,
      ...n.metadata,
    }));
    const tokens = this.getNodesByType('token').map((n) => n.label);

    return {
      generated_at: new Date().toISOString(),
      generated_by: 'KnowledgeGraphEngine',
      stats: {
        modules: modules.length,
        tokens: tokens.length,
        interfaces: stats.nodesByType['interface'] ?? 0,
        implementations: stats.nodesByType['implementation'] ?? 0,
        edges: stats.edgeCount,
      },
      modules,
    };
  }
}
