/**
 * InMemoryCodeGraphAdapter — In-memory implementation of ICodeGraphStore.
 *
 * Used for development, testing, and environments without KuzuDB.
 * Stores nodes and edges in Maps with tenant isolation.
 *
 * Layer: Infrastructure
 */

import type {
  ICodeGraphStore,
  CodeGraphNode,
  CodeGraphEdge,
  CodeNodeLabel,
  CodeRelationType,
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
import type { TenantId, CorrelationId } from '../../../domain/memory/session-types';
import * as path from 'path';
import {
  calculateCommunityEntropy,
  bfsShortestPath,
  findMinimalSpanningSubgraph,
  computeGraphDiff as computeGraphDiffAlgo,
  suggestRelocations as suggestRelocationsAlgo,
} from './graph-algorithms';

interface TenantGraph {
  nodes: Map<string, CodeGraphNode>;
  edges: Map<string, CodeGraphEdge>;
}

/**
 * In-memory code graph store for dev/test.
 * Thread-safe per tenant (Map isolation).
 */
export class InMemoryCodeGraphAdapter implements ICodeGraphStore {
  private readonly graphs = new Map<string, TenantGraph>();

  private getOrCreateGraph(tenantId: TenantId): TenantGraph {
    let graph = this.graphs.get(tenantId);
    if (!graph) {
      graph = { nodes: new Map(), edges: new Map() };
      this.graphs.set(tenantId, graph);
    }
    return graph;
  }

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
      throw new Error('repoPath must not contain path traversal (..)');    }
    const graph = this.getOrCreateGraph(input.tenantId);
    input.onProgress?.('init', 0);

    // In-memory adapter: create a root File node representing the repo
    const rootId = `file:${input.repoPath}`;
    graph.nodes.set(rootId, {
      id: rootId,
      label: 'Folder',
      name: input.repoPath.split(/[/\\]/).pop() ?? 'root',
      filePath: input.repoPath,
    });

    input.onProgress?.('complete', 100);
    return { nodeCount: graph.nodes.size, edgeCount: graph.edges.size };
  }

  async hybridSearch(input: {
    tenantId: TenantId;
    query: string;
    limit?: number;
    correlationId: CorrelationId;
  }): Promise<readonly CodeGraphNode[]> {
    const graph = this.getOrCreateGraph(input.tenantId);
    const query = input.query.toLowerCase();
    const limit = input.limit ?? 10;

    const results: CodeGraphNode[] = [];
    for (const node of graph.nodes.values()) {
      if (
        node.name.toLowerCase().includes(query) ||
        node.filePath.toLowerCase().includes(query) ||
        node.content?.toLowerCase().includes(query)
      ) {
        results.push(node);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  async getSymbolContext(input: {
    tenantId: TenantId;
    symbolId: string;
    correlationId: CorrelationId;
  }): Promise<SymbolContext> {
    const graph = this.getOrCreateGraph(input.tenantId);
    const node = graph.nodes.get(input.symbolId);
    if (!node) {
      throw new Error(`Symbol not found: ${input.symbolId}`);
    }

    const callers: CodeGraphNode[] = [];
    const callees: CodeGraphNode[] = [];

    for (const edge of graph.edges.values()) {
      if (edge.type === 'CALLS') {
        if (edge.targetId === input.symbolId) {
          const caller = graph.nodes.get(edge.sourceId);
          if (caller) callers.push(caller);
        }
        if (edge.sourceId === input.symbolId) {
          const callee = graph.nodes.get(edge.targetId);
          if (callee) callees.push(callee);
        }
      }
    }

    return { node, callers, callees, processes: [] };
  }

  async analyzeImpact(input: {
    tenantId: TenantId;
    targetId: string;
    direction: 'upstream' | 'downstream';
    maxDepth?: number;
    minConfidence?: number;
    correlationId: CorrelationId;
  }): Promise<ImpactAnalysisResult> {
    const graph = this.getOrCreateGraph(input.tenantId);
    const target = graph.nodes.get(input.targetId);
    if (!target) {
      throw new Error(`Target not found: ${input.targetId}`);
    }

    const maxDepth = input.maxDepth ?? 3;
    const minConfidence = input.minConfidence ?? 0.7;
    const byDepth = new Map<number, CodeGraphNode[]>();
    const visited = new Set<string>([input.targetId]);

    let frontier = [input.targetId];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      const depthNodes: CodeGraphNode[] = [];

      for (const nodeId of frontier) {
        for (const edge of graph.edges.values()) {
          if (edge.confidence < minConfidence) continue;

          const matchId = input.direction === 'upstream' ? edge.targetId : edge.sourceId;
          const neighborId = input.direction === 'upstream' ? edge.sourceId : edge.targetId;

          if (matchId === nodeId && !visited.has(neighborId)) {
            visited.add(neighborId);
            const neighbor = graph.nodes.get(neighborId);
            if (neighbor) {
              depthNodes.push(neighbor);
              nextFrontier.push(neighborId);
            }
          }
        }
      }

      if (depthNodes.length > 0) {
        byDepth.set(depth, depthNodes);
      }
      frontier = nextFrontier;
    }

    const directCallers = byDepth.get(1)?.length ?? 0;
    const risk = classifyRisk(directCallers, 0);

    return {
      target,
      risk,
      summary: { directCallers, affectedProcesses: 0, affectedModules: 0 },
      byDepth,
      affectedProcesses: [],
    };
  }

  /**
   * Community detection via directory-based grouping.
   * Groups File nodes by their directory path — files in the same directory
   * are assigned to the same community. Cohesion based on internal edge density.
   */
  async getCommunities(input: {
    tenantId: TenantId;
    correlationId: CorrelationId;
  }): Promise<readonly CodeCommunity[]> {
    const graph = this.getOrCreateGraph(input.tenantId);

    // Group File nodes by directory
    const dirGroups = new Map<string, string[]>();
    for (const [id, node] of graph.nodes) {
      if (node.label === 'File') {
        const dir = path.dirname(node.filePath);
        const group = dirGroups.get(dir);
        if (group) group.push(id);
        else dirGroups.set(dir, [id]);
      }
    }

    const communities: CodeCommunity[] = [];
    let idx = 0;
    for (const [dir, members] of dirGroups) {
      if (members.length < 2) continue;

      // Calculate cohesion from internal edges
      const memberSet = new Set(members);
      let internalEdges = 0;
      for (const edge of graph.edges.values()) {
        if (memberSet.has(edge.sourceId) && memberSet.has(edge.targetId)) {
          internalEdges++;
        }
      }
      const possibleEdges = members.length * (members.length - 1) / 2;

      // Calculate entropy metrics for the community
      const memberSet2 = new Set(members);
      const memberEdges: Array<{ source: string; target: string; type: string }> = [];
      for (const edge of graph.edges.values()) {
        if (memberSet2.has(edge.sourceId) || memberSet2.has(edge.targetId)) {
          memberEdges.push({ source: edge.sourceId, target: edge.targetId, type: edge.type });
        }
      }
      const entropyResult = calculateCommunityEntropy(members, memberEdges);

      communities.push({
        id: `community:${idx}`,
        label: path.basename(dir) || dir,
        cohesion: possibleEdges > 0 ? Math.min(internalEdges / possibleEdges, 1) : 0,
        symbolCount: members.length,
        keywords: [path.basename(dir)],
        members,
        entropy: entropyResult.entropy,
        internalRatio: entropyResult.internalRatio,
      });
      idx++;
    }

    return communities;
  }

  /**
   * Process detection via BFS from entry-point files.
   * Entry points: files named index, main, app, server, bootstrap, orchestrator.
   * Traces IMPORTS edges to discover execution flows.
   */
  async getProcesses(input: {
    tenantId: TenantId;
    correlationId: CorrelationId;
  }): Promise<readonly CodeProcess[]> {
    const graph = this.getOrCreateGraph(input.tenantId);
    const ENTRY_RE = /(?:^|[/\\])(?:index|main|app|server|bootstrap|orchestrator)\.[^/\\]+$/i;

    // Find entry-point File nodes
    const entryPoints: CodeGraphNode[] = [];
    for (const node of graph.nodes.values()) {
      if (node.label === 'File' && ENTRY_RE.test(node.filePath)) {
        entryPoints.push(node);
      }
    }

    // Build adjacency from IMPORTS edges
    const adj = new Map<string, string[]>();
    for (const edge of graph.edges.values()) {
      if (edge.type === 'IMPORTS') {
        const list = adj.get(edge.sourceId);
        if (list) list.push(edge.targetId);
        else adj.set(edge.sourceId, [edge.targetId]);
      }
    }

    const processes: CodeProcess[] = [];
    for (const entry of entryPoints) {
      // BFS from entry point
      const visited = new Set<string>();
      const steps: CodeGraphNode[] = [];
      const queue = [entry.id];
      visited.add(entry.id);

      while (queue.length > 0) {
        const current = queue.shift()!;
        const node = graph.nodes.get(current);
        if (node) steps.push(node);

        for (const n of adj.get(current) ?? []) {
          if (!visited.has(n)) {
            visited.add(n);
            queue.push(n);
          }
        }
      }

      if (steps.length < 2) continue;

      processes.push({
        id: `process:${entry.id}`,
        label: `Flow from ${entry.name}`,
        processType: 'intra_community',
        stepCount: steps.length,
        steps,
        entryPointId: entry.id,
        terminalId: steps[steps.length - 1].id,
      });
    }

    return processes;
  }

  async getEvolutionaryCoupling(input: {
    tenantId: TenantId;
    correlationId: CorrelationId;
    minSupport?: number;
  }): Promise<readonly EvolutionaryCoupling[]> {
    const graph = this.getOrCreateGraph(input.tenantId);
    const minSupport = input.minSupport ?? 2;
    const results: EvolutionaryCoupling[] = [];

    // Extract CHANGED_TOGETHER edges as coupling signals
    const pairCounts = new Map<string, { count: number; fileA: string; fileB: string }>();
    for (const edge of graph.edges.values()) {
      if (edge.type === 'CHANGED_TOGETHER') {
        const [a, b] = [edge.sourceId, edge.targetId].sort();
        const key = `${a}|${b}`;
        const entry = pairCounts.get(key);
        if (entry) entry.count++;
        else pairCounts.set(key, { count: 1, fileA: a, fileB: b });
      }
    }

    for (const { count, fileA, fileB } of pairCounts.values()) {
      if (count >= minSupport) {
        results.push({
          fileA, fileB,
          coChangeCount: count,
          confidence: Math.min(count / 10, 1),
          support: count,
        });
      }
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  }

  async getPathContext(input: {
    tenantId: TenantId;
    targetIds: string[];
    correlationId: CorrelationId;
  }): Promise<PathRAGResult> {
    const graph = this.getOrCreateGraph(input.tenantId);

    // Build adjacency for Path-RAG
    const adjacency = new Map<string, string[]>();
    for (const edge of graph.edges.values()) {
      const fwd = adjacency.get(edge.sourceId);
      if (fwd) fwd.push(edge.targetId);
      else adjacency.set(edge.sourceId, [edge.targetId]);
      const rev = adjacency.get(edge.targetId);
      if (rev) rev.push(edge.sourceId);
      else adjacency.set(edge.targetId, [edge.sourceId]);
    }

    const existingTargets = input.targetIds.filter(id => graph.nodes.has(id));
    const spanNodes = findMinimalSpanningSubgraph(existingTargets, adjacency);
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

  async computeGraphDiff(input: {
    tenantId: TenantId;
    snapshotNodes: ReadonlySet<string>;
    snapshotEdges: ReadonlyArray<{ source: string; target: string; type: string }>;
    correlationId: CorrelationId;
  }): Promise<GraphDiff> {
    const graph = this.getOrCreateGraph(input.tenantId);
    const currentNodes = new Set(graph.nodes.keys());
    const currentEdges = Array.from(graph.edges.values()).map(e => ({
      source: e.sourceId, target: e.targetId, type: e.type,
    }));

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
    const graph = this.getOrCreateGraph(input.tenantId);

    // Build community assignment from directory grouping
    const communityAssignment = new Map<string, number>();
    const nodeFilePaths = new Map<string, string>();
    let communityIdx = 0;
    const dirToCommunity = new Map<string, number>();

    for (const [id, node] of graph.nodes) {
      if (node.label === 'File') {
        nodeFilePaths.set(id, node.filePath);
        const dir = path.dirname(node.filePath);
        if (!dirToCommunity.has(dir)) {
          dirToCommunity.set(dir, communityIdx++);
        }
        communityAssignment.set(id, dirToCommunity.get(dir)!);
      }
    }

    const nodeIds = Array.from(communityAssignment.keys());
    return suggestRelocationsAlgo(nodeIds, communityAssignment, nodeFilePaths);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  /** Release all graph data. */
  async destroy(): Promise<void> {
    this.graphs.clear();
  }

  // ── Test helpers (not part of ICodeGraphStore) ──

  /** Add a node directly (test helper). */
  addNode(tenantId: TenantId, node: CodeGraphNode): void {
    this.getOrCreateGraph(tenantId).nodes.set(node.id, node);
  }

  /** Add an edge directly (test helper). */
  addEdge(tenantId: TenantId, edge: CodeGraphEdge): void {
    this.getOrCreateGraph(tenantId).edges.set(edge.id, edge);
  }

  /** Clear all data for a tenant (test helper). */
  clear(tenantId: TenantId): void {
    this.graphs.delete(tenantId);
  }
}

/** Classify impact risk based on caller/process counts. */
function classifyRisk(directCallers: number, affectedProcesses: number): ImpactRiskLevel {
  if (directCallers > 10 || affectedProcesses > 5) return 'CRITICAL';
  if (directCallers > 5 || affectedProcesses > 2) return 'HIGH';
  if (directCallers > 2 || affectedProcesses > 0) return 'MEDIUM';
  return 'LOW';
}
