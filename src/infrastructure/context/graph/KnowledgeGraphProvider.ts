/**
 * KnowledgeGraphProvider — Infrastructure adapter for Tier 4 (Knowledge Graph).
 *
 * Wraps KnowledgeGraphEngine.query() and serializes TraversalResult (nodes + edges)
 * into the IGraphContextProvider search result format consumed by SemanticPagingService.
 *
 * Deterministic retrieval: structural relationships are exact (not probabilistic),
 * so relevance scores are high (0.92 base) and decay slightly with graph distance.
 *
 * @layer Infrastructure/Context
 * @phase 5.5 — Agentic GraphRAG Integration
 * @see src/application/services/context/SemanticPagingService.ts — IGraphContextProvider port
 * @see src/infrastructure/context/graph/KnowledgeGraphEngine.ts — underlying engine
 */

import type { KnowledgeGraphEngine, KGNode, KGEdge } from './KnowledgeGraphEngine';
import type { IGraphContextProvider } from '../../../domain/context/ISemanticPagingService';

// ── Constants ───────────────────────────────────────────────────────

/** Base relevance score for deterministic graph results */
const BASE_RELEVANCE = 0.92;
/** Score decay per BFS hop from query root */
const HOP_DECAY = 0.05;
/** Rough token estimate: 1 token ≈ 4 characters */
const CHARS_PER_TOKEN = 4;
/** Maximum BFS depth for graph queries */
const DEFAULT_MAX_DEPTH = 2;

// ── Provider ────────────────────────────────────────────────────────

export class KnowledgeGraphProvider implements IGraphContextProvider {
  constructor(
    private readonly engine: KnowledgeGraphEngine,
    private readonly maxDepth: number = DEFAULT_MAX_DEPTH,
  ) {}

  /**
   * Search the knowledge graph for entities matching the query.
   *
   * Delegates to KnowledgeGraphEngine.query() which extracts entity names
   * (IFoo, PascalCase, DI_TOKENS.*) from the question, finds matching nodes,
   * performs BFS traversal, and returns a subgraph.
   *
   * The subgraph is serialized into markdown-formatted search results:
   * - Each distinct root entity becomes a separate result item
   * - Content includes node metadata + relationships (edges)
   * - Deterministic score: 0.92 − 0.05 × hops from root
   */
  async search(
    query: string,
    maxResults: number,
  ): Promise<ReadonlyArray<{ content: string; source: string; score: number; tokens: number }>> {
    const traversal = this.engine.query(query, this.maxDepth);

    if (traversal.nodes.length === 0) {
      return [];
    }

    // Group nodes by proximity — serialize as a single coherent context block
    const content = this.serializeTraversalResult(traversal.nodes, traversal.edges);
    const tokens = this.estimateTokens(content);
    const score = Math.max(0, BASE_RELEVANCE - HOP_DECAY * traversal.hops);

    // If content is large, split into chunks per root entity
    const chunks = this.chunkByEntities(traversal.nodes, traversal.edges, maxResults);

    if (chunks.length <= 1) {
      // Single coherent block
      return [{
        content,
        source: `knowledge_graph:${traversal.nodes.length}nodes/${traversal.edges.length}edges`,
        score,
        tokens,
      }];
    }

    // Multiple chunks — one per root entity cluster
    return chunks.slice(0, maxResults).map((chunk, idx) => ({
      content: chunk.content,
      source: `knowledge_graph:${chunk.rootId}`,
      score: Math.max(0, BASE_RELEVANCE - HOP_DECAY * idx),
      tokens: this.estimateTokens(chunk.content),
    }));
  }

  /**
   * Return the total number of nodes in the knowledge graph.
   */
  async getNodeCount(): Promise<number> {
    return this.engine.getStats().nodeCount;
  }

  // ── Serialization ─────────────────────────────────────────────────

  /**
   * Serialize a subgraph (nodes + edges) into a markdown-formatted string.
   *
   * Format:
   * ```
   * ## Knowledge Graph: 5 nodes, 7 edges
   *
   * ### Nodes
   * - [interface] IEventStore — Event persistence port
   * - [implementation] PostgresEventStore — PostgreSQL event store adapter
   *
   * ### Relationships
   * - PostgresEventStore →implements→ IEventStore
   * - EventBus →depends_on→ IEventStore
   * ```
   */
  private serializeTraversalResult(
    nodes: readonly KGNode[],
    edges: readonly KGEdge[],
  ): string {
    const lines: string[] = [
      `## Knowledge Graph: ${nodes.length} nodes, ${edges.length} edges`,
      '',
      '### Nodes',
    ];

    for (const node of nodes) {
      const meta = node.metadata;
      const details = typeof meta.path === 'string' ? ` (${meta.path})` : '';
      lines.push(`- [${node.type}] ${node.label}${details}`);
    }

    if (edges.length > 0) {
      lines.push('', '### Relationships');
      for (const edge of edges) {
        lines.push(`- ${this.shortId(edge.source)} →${edge.relation}→ ${this.shortId(edge.target)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Chunk nodes into clusters by root entity for multi-result output.
   * Each cluster contains one "root" node and its direct neighbors.
   */
  private chunkByEntities(
    nodes: readonly KGNode[],
    edges: readonly KGEdge[],
    maxChunks: number,
  ): Array<{ rootId: string; content: string }> {
    if (nodes.length <= 5) {
      // Small subgraph — return as single chunk
      return [{
        rootId: nodes[0]?.id ?? 'unknown',
        content: this.serializeTraversalResult(nodes, edges),
      }];
    }

    // Build adjacency map for clustering
    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
      if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
      adjacency.get(edge.source)!.add(edge.target);
      adjacency.get(edge.target)!.add(edge.source);
    }

    // Find high-degree nodes as cluster roots
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const roots = [...adjacency.entries()]
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, maxChunks)
      .map(([id]) => id);

    const chunks: Array<{ rootId: string; content: string }> = [];
    const claimed = new Set<string>();

    for (const rootId of roots) {
      if (claimed.has(rootId)) continue;
      claimed.add(rootId);

      const clusterNodes: KGNode[] = [];
      const clusterEdges: KGEdge[] = [];

      const rootNode = nodeMap.get(rootId);
      if (rootNode) clusterNodes.push(rootNode);

      // Add direct neighbors
      const neighbors = adjacency.get(rootId) ?? new Set();
      for (const nid of neighbors) {
        if (!claimed.has(nid)) {
          claimed.add(nid);
          const neighborNode = nodeMap.get(nid);
          if (neighborNode) clusterNodes.push(neighborNode);
        }
      }

      // Add edges within cluster
      const clusterIds = new Set(clusterNodes.map(n => n.id));
      for (const edge of edges) {
        if (clusterIds.has(edge.source) && clusterIds.has(edge.target)) {
          clusterEdges.push(edge);
        }
      }

      chunks.push({
        rootId: this.shortId(rootId),
        content: this.serializeTraversalResult(clusterNodes, clusterEdges),
      });
    }

    return chunks;
  }

  /**
   * Strip common prefixes (token:, interface:, impl:, module:) for readability.
   */
  private shortId(id: string): string {
    return id.replace(/^(?:token|interface|impl|module|mdc_rule|method|layer|test):/, '');
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }
}
