/**
 * CentralityScorerAdapter — Infrastructure implementation of ICentralityScorer.
 *
 * Implements PageRank, Degree Centrality, and Betweenness Centrality
 * algorithms for code knowledge graph analysis.
 *
 * PageRank: Power iteration method (Brin & Page, 1998).
 * Betweenness: Brandes' algorithm, O(VE) (Brandes, 2001).
 * Degree: Simple in-degree + out-degree count.
 *
 * Layer: Infrastructure
 * SOTA 2026: Pure TypeScript — no external graph library required.
 */

import type {
  ICentralityScorer,
  CentralityAlgorithm,
  CentralityResult,
  CentralityScore,
} from '../../../domain/memory/ICentralityScorer';
import type { ICodeGraphStore } from '../../../domain/memory/ICodeGraphStore';
import type { TenantId, CorrelationId } from '../../../domain/memory/session-types';

export class CentralityScorerAdapter implements ICentralityScorer {
  constructor(private readonly graphStore: ICodeGraphStore) {}

  async computeCentrality(input: {
    tenantId: TenantId;
    algorithm: CentralityAlgorithm;
    topK?: number;
    edgeTypes?: readonly string[];
    correlationId: CorrelationId;
  }): Promise<CentralityResult> {
    const start = Date.now();
    const topK = input.topK ?? 20;

    // Build adjacency from graph store via hybridSearch (get all nodes)
    const allNodes = await this.graphStore.hybridSearch({
      tenantId: input.tenantId,
      query: '',
      limit: 10_000,
      correlationId: input.correlationId,
    });

    // Build adjacency lists using symbol context
    const outEdges = new Map<string, string[]>();
    const inEdges = new Map<string, string[]>();
    const nodeNames = new Map<string, { name: string; filePath: string }>();
    let edgeCount = 0;

    for (const node of allNodes) {
      nodeNames.set(node.id, { name: node.name, filePath: node.filePath });
      if (!outEdges.has(node.id)) outEdges.set(node.id, []);
      if (!inEdges.has(node.id)) inEdges.set(node.id, []);
    }

    // Gather edges via symbol context for each node
    for (const node of allNodes) {
      try {
        const ctx = await this.graphStore.getSymbolContext({
          tenantId: input.tenantId,
          symbolId: node.id,
          correlationId: input.correlationId,
        });
        for (const callee of ctx.callees) {
          outEdges.get(node.id)?.push(callee.id);
          if (!inEdges.has(callee.id)) inEdges.set(callee.id, []);
          inEdges.get(callee.id)?.push(node.id);
          edgeCount++;
        }
      } catch {
        // Node may not have symbol context (e.g., File nodes)
      }
    }

    const nodeIds = [...nodeNames.keys()];
    let rawScores: Map<string, number>;

    switch (input.algorithm) {
      case 'pagerank':
        rawScores = this.pageRank(nodeIds, outEdges, inEdges);
        break;
      case 'betweenness':
        rawScores = this.betweennessCentrality(nodeIds, outEdges);
        break;
      case 'degree':
        rawScores = this.degreeCentrality(nodeIds, outEdges, inEdges);
        break;
    }

    // Normalize scores to [0, 1]
    const maxScore = Math.max(...rawScores.values(), 1e-10);
    const scores: CentralityScore[] = nodeIds
      .map(id => ({
        nodeId: id,
        name: nodeNames.get(id)?.name ?? '',
        filePath: nodeNames.get(id)?.filePath ?? '',
        score: (rawScores.get(id) ?? 0) / maxScore,
        rank: 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s, i) => ({ ...s, rank: i + 1 }));

    return {
      algorithm: input.algorithm,
      scores,
      nodeCount: nodeIds.length,
      edgeCount,
      durationMs: Date.now() - start,
    };
  }

  /**
   * PageRank via power iteration (Brin & Page, 1998).
   * Damping factor d=0.85, max 100 iterations, convergence threshold 1e-6.
   */
  private pageRank(
    nodeIds: string[],
    outEdges: Map<string, string[]>,
    inEdges: Map<string, string[]>,
  ): Map<string, number> {
    const n = nodeIds.length;
    if (n === 0) return new Map();

    const d = 0.85;
    const maxIter = 100;
    const tolerance = 1e-6;
    const initial = 1 / n;

    let scores = new Map<string, number>();
    for (const id of nodeIds) scores.set(id, initial);

    for (let iter = 0; iter < maxIter; iter++) {
      const next = new Map<string, number>();
      let diff = 0;

      // Collect dangling mass (nodes with no outgoing edges)
      let danglingMass = 0;
      for (const id of nodeIds) {
        if ((outEdges.get(id)?.length ?? 0) === 0) {
          danglingMass += scores.get(id) ?? 0;
        }
      }

      for (const id of nodeIds) {
        let inSum = 0;
        for (const inId of (inEdges.get(id) ?? [])) {
          const outCount = outEdges.get(inId)?.length ?? 1;
          inSum += (scores.get(inId) ?? 0) / outCount;
        }
        const newScore = (1 - d) / n + d * (inSum + danglingMass / n);
        next.set(id, newScore);
        diff += Math.abs(newScore - (scores.get(id) ?? 0));
      }

      scores = next;
      if (diff < tolerance) break;
    }

    return scores;
  }

  /**
   * Degree centrality: sum of in-degree + out-degree.
   * Simple but effective for identifying hub nodes.
   */
  private degreeCentrality(
    nodeIds: string[],
    outEdges: Map<string, string[]>,
    inEdges: Map<string, string[]>,
  ): Map<string, number> {
    const scores = new Map<string, number>();
    for (const id of nodeIds) {
      scores.set(id, (outEdges.get(id)?.length ?? 0) + (inEdges.get(id)?.length ?? 0));
    }
    return scores;
  }

  /**
   * Betweenness centrality via Brandes' algorithm (Brandes, 2001).
   * O(V*E) for unweighted graphs.
   *
   * Measures how often a node lies on shortest paths between all pairs.
   * High betweenness = architectural bottleneck / coupling mediator.
   */
  private betweennessCentrality(
    nodeIds: string[],
    outEdges: Map<string, string[]>,
  ): Map<string, number> {
    const scores = new Map<string, number>();
    for (const id of nodeIds) scores.set(id, 0);

    for (const s of nodeIds) {
      // BFS from source s
      const stack: string[] = [];
      const predecessors = new Map<string, string[]>();
      const sigma = new Map<string, number>();
      const dist = new Map<string, number>();
      const delta = new Map<string, number>();

      for (const id of nodeIds) {
        predecessors.set(id, []);
        sigma.set(id, 0);
        dist.set(id, -1);
        delta.set(id, 0);
      }

      sigma.set(s, 1);
      dist.set(s, 0);
      const queue: string[] = [s];

      while (queue.length > 0) {
        const v = queue.shift()!;
        stack.push(v);

        for (const w of (outEdges.get(v) ?? [])) {
          if (dist.get(w) === -1) {
            dist.set(w, (dist.get(v) ?? 0) + 1);
            queue.push(w);
          }
          if (dist.get(w) === (dist.get(v) ?? 0) + 1) {
            sigma.set(w, (sigma.get(w) ?? 0) + (sigma.get(v) ?? 0));
            predecessors.get(w)?.push(v);
          }
        }
      }

      // Accumulation
      while (stack.length > 0) {
        const w = stack.pop()!;
        for (const v of (predecessors.get(w) ?? [])) {
          const coeff = ((sigma.get(v) ?? 0) / (sigma.get(w) ?? 1)) * (1 + (delta.get(w) ?? 0));
          delta.set(v, (delta.get(v) ?? 0) + coeff);
        }
        if (w !== s) {
          scores.set(w, (scores.get(w) ?? 0) + (delta.get(w) ?? 0));
        }
      }
    }

    return scores;
  }
}
