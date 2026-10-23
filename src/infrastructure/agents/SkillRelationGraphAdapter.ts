/**
 * Skill Relation Graph Adapter — In-memory implementation of ISkillRelationGraph.
 *
 * Lightweight in-memory graph store for inter-skill relations. Used as fallback
 * in test environments; production uses PostgresSkillRelationGraphAdapter.
 *
 * @layer Infrastructure (Agents)
 * @pattern CC-037 Skill Relation Graph (FITNESS-K: 79)
 * @academic SkillNet (arXiv:2603.04448) — Donor #28 EXTRACT-K
 * @see src/domain/agents/ISkillRelationGraph.ts — domain port
 * @see src/infrastructure/agents/PostgresSkillRelationGraphAdapter.ts — production adapter
 */

import type {
  ISkillRelationGraph,
  SkillRelation,
  SkillRelationQuery,
  SkillGraphNode,
  SkillPathResult,
  SkillRelationType,
  SkillDivisionNode,
} from '../../domain/agents/ISkillRelationGraph';

export class SkillRelationGraphAdapter implements ISkillRelationGraph {
  /** Adjacency list: skillId → outgoing relations. */
  private readonly edges = new Map<string, SkillRelation[]>();

  /** Optional taxonomy paths per skill. */
  private readonly taxonomyPaths = new Map<string, readonly string[]>();

  /** Division taxonomy tree. */
  private readonly divisions = new Map<string, SkillDivisionNode>();

  /** Division → skill IDs mapping. */
  private readonly divisionSkills = new Map<string, Set<string>>();

  // ── Public API ────────────────────────────────────────────────────

  async getRelations(query: SkillRelationQuery): Promise<readonly SkillRelation[]> {
    const minConfidence = query.minConfidence ?? 0.5;
    const outgoing = this.edges.get(query.skillId) ?? [];

    let results = outgoing.filter((r) => r.confidence >= minConfidence);

    if (query.relationTypes && query.relationTypes.length > 0) {
      const types = new Set(query.relationTypes);
      results = results.filter((r) => types.has(r.relationType));
    }

    return results;
  }

  async addRelation(relation: SkillRelation): Promise<boolean> {
    const existing = this.edges.get(relation.sourceSkillId) ?? [];

    const duplicate = existing.some(
      (r) =>
        r.targetSkillId === relation.targetSkillId &&
        r.relationType === relation.relationType,
    );
    if (duplicate) return false;

    existing.push(relation);
    this.edges.set(relation.sourceSkillId, existing);

    // For symmetric relations (similar_to), add reverse edge
    if (relation.relationType === 'similar_to') {
      const reverse: SkillRelation = {
        sourceSkillId: relation.targetSkillId,
        targetSkillId: relation.sourceSkillId,
        relationType: relation.relationType,
        confidence: relation.confidence,
        metadata: relation.metadata,
      };
      const reverseExisting = this.edges.get(reverse.sourceSkillId) ?? [];
      const reverseDup = reverseExisting.some(
        (r) =>
          r.targetSkillId === reverse.targetSkillId &&
          r.relationType === reverse.relationType,
      );
      if (!reverseDup) {
        reverseExisting.push(reverse);
        this.edges.set(reverse.sourceSkillId, reverseExisting);
      }
    }

    return true;
  }

  async removeRelation(
    sourceSkillId: string,
    targetSkillId: string,
    relationType: SkillRelationType,
  ): Promise<boolean> {
    const edges = this.edges.get(sourceSkillId);
    if (!edges) return false;

    const idx = edges.findIndex(
      (r) => r.targetSkillId === targetSkillId && r.relationType === relationType,
    );
    if (idx === -1) return false;

    edges.splice(idx, 1);
    if (edges.length === 0) this.edges.delete(sourceSkillId);

    // For symmetric relations, remove reverse edge
    if (relationType === 'similar_to') {
      const reverseEdges = this.edges.get(targetSkillId);
      if (reverseEdges) {
        const reverseIdx = reverseEdges.findIndex(
          (r) => r.targetSkillId === sourceSkillId && r.relationType === relationType,
        );
        if (reverseIdx !== -1) {
          reverseEdges.splice(reverseIdx, 1);
          if (reverseEdges.length === 0) this.edges.delete(targetSkillId);
        }
      }
    }

    return true;
  }

  async findPath(
    fromSkillId: string,
    toSkillId: string,
    maxDepth = 5,
  ): Promise<SkillPathResult | null> {
    // BFS traversal
    const visited = new Set<string>();
    const queue: Array<{
      node: string;
      path: string[];
      confidence: number;
      relationTypes: import('../../domain/agents/ISkillRelationGraph').SkillRelationType[];
    }> = [{ node: fromSkillId, path: [fromSkillId], confidence: 1.0, relationTypes: [] }];

    visited.add(fromSkillId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.path.length - 1 > maxDepth) continue;

      const neighbors = this.edges.get(current.node) ?? [];
      for (const edge of neighbors) {
        if (edge.targetSkillId === toSkillId) {
          return {
            from: fromSkillId,
            to: toSkillId,
            path: [...current.path, toSkillId],
            totalConfidence: current.confidence * edge.confidence,
            relationTypes: [...current.relationTypes, edge.relationType],
          };
        }

        if (!visited.has(edge.targetSkillId) && current.path.length < maxDepth) {
          visited.add(edge.targetSkillId);
          queue.push({
            node: edge.targetSkillId,
            path: [...current.path, edge.targetSkillId],
            confidence: current.confidence * edge.confidence,
            relationTypes: [...current.relationTypes, edge.relationType],
          });
        }
      }
    }

    return null;
  }

  async getCompositionChain(skillId: string): Promise<readonly string[]> {
    const chain: string[] = [skillId];
    const visited = new Set<string>([skillId]);
    let current = skillId;

    // Follow compose_with edges forward
    while (true) {
      const edges = this.edges.get(current) ?? [];
      const composeEdge = edges.find(
        (r) => r.relationType === 'compose_with' && !visited.has(r.targetSkillId),
      );
      if (!composeEdge) break;

      chain.push(composeEdge.targetSkillId);
      visited.add(composeEdge.targetSkillId);
      current = composeEdge.targetSkillId;
    }

    return chain;
  }

  async getDependencies(
    skillId: string,
    maxDepth = 3,
  ): Promise<readonly SkillRelation[]> {
    const results: SkillRelation[] = [];
    const visited = new Set<string>([skillId]);
    const queue: Array<{ node: string; depth: number }> = [{ node: skillId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      const edges = (this.edges.get(current.node) ?? []).filter(
        (r) => r.relationType === 'depend_on',
      );

      for (const edge of edges) {
        results.push(edge);
        if (!visited.has(edge.targetSkillId)) {
          visited.add(edge.targetSkillId);
          queue.push({ node: edge.targetSkillId, depth: current.depth + 1 });
        }
      }
    }

    return results;
  }

  async findSimilar(
    skillId: string,
    minConfidence = 0.5,
  ): Promise<readonly SkillRelation[]> {
    const edges = this.edges.get(skillId) ?? [];
    return edges.filter(
      (r) => r.relationType === 'similar_to' && r.confidence >= minConfidence,
    );
  }

  async getNode(skillId: string): Promise<SkillGraphNode | null> {
    const relations = this.edges.get(skillId);
    if (!relations) return null;

    return {
      skillId,
      relations,
      taxonomyPath: this.taxonomyPaths.get(skillId),
    };
  }

  async getDivisionTree(): Promise<readonly SkillDivisionNode[]> {
    return Array.from(this.divisions.values()).map((node) => ({
      ...node,
      skillCount: this.getAggregatedSkillCount(node.divisionId),
    }));
  }

  async getByDivision(
    divisionId: string,
    includeSubDivisions = true,
  ): Promise<readonly string[]> {
    const divisionIds = includeSubDivisions
      ? this.collectDivisionIds(divisionId)
      : [divisionId];
    const result = new Set<string>();

    for (const currentDivisionId of divisionIds) {
      const currentSkills = this.divisionSkills.get(currentDivisionId);
      if (!currentSkills) continue;

      for (const skillId of currentSkills) {
        result.add(skillId);
      }
    }

    return Array.from(result);
  }

  // ── Setup helpers (not part of domain port) ───────────────────────

  /** Set taxonomy path for a skill (used during initialization). */
  setTaxonomyPath(skillId: string, path: readonly string[]): void {
    this.taxonomyPaths.set(skillId, path);
  }

  /** Register a division node in the taxonomy tree. */
  addDivisionNode(node: SkillDivisionNode): void {
    this.divisions.set(node.divisionId, node);
  }

  /** Associate a skill with a division. */
  addSkillToDivision(skillId: string, divisionId: string): void {
    const skills = this.divisionSkills.get(divisionId) ?? new Set<string>();
    skills.add(skillId);
    this.divisionSkills.set(divisionId, skills);
  }

  private collectDivisionIds(
    divisionId: string,
    visited = new Set<string>(),
  ): string[] {
    if (visited.has(divisionId)) return [];

    visited.add(divisionId);

    const division = this.divisions.get(divisionId);
    if (!division) return [divisionId];

    const collected = [divisionId];
    for (const childId of division.childDivisionIds) {
      collected.push(...this.collectDivisionIds(childId, visited));
    }

    return collected;
  }

  private getAggregatedSkillCount(divisionId: string): number {
    const divisionIds = this.collectDivisionIds(divisionId);
    const uniqueSkillIds = new Set<string>();

    for (const currentDivisionId of divisionIds) {
      const currentSkills = this.divisionSkills.get(currentDivisionId);
      if (!currentSkills) continue;

      for (const skillId of currentSkills) {
        uniqueSkillIds.add(skillId);
      }
    }

    return uniqueSkillIds.size;
  }
}
