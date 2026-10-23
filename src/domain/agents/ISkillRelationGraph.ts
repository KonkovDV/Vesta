/**
 * Skill Relation Graph — Domain Port.
 *
 * Models inter-skill relationships (similar_to, compose_with, belong_to, depend_on)
 * enabling graph-based skill reasoning, composition chains, and dependency analysis.
 *
 * @layer Domain (Agents)
 * @pattern CC-037 Skill Relation Graph (FITNESS-K: 79)
 * @academic SkillNet (arXiv:2603.04448, Liang et al., 2026) — §3.5 Skill Connection
 * @donor Donor #28 (SkillNet, ACADEMIC_PAPER, EXTRACT-K)
 * @enriched-by agency-agents 15-division taxonomy + hierarchical sub-categories (Donor #30 ENRICH AA-E02)
 */

// ── Relation Types ─────────────────────────────────────────────────

/**
 * Four canonical skill relation types from SkillNet §3.5.
 *
 * - `similar_to`: Skills with overlapping functionality (symmetric)
 * - `compose_with`: Skills that can be chained sequentially (directed)
 * - `belong_to`: Skill is a specialization of a broader category (directed)
 * - `depend_on`: Skill requires another to function (directed)
 */
export type SkillRelationType =
  | 'similar_to'
  | 'compose_with'
  | 'belong_to'
  | 'depend_on';

// ── Core Interfaces ────────────────────────────────────────────────

/** Metadata attached to a relation edge. */
export interface SkillRelationMetadata {
  /** How the relation was inferred (embedding similarity, LLM, manual). */
  readonly inferenceMethod: 'embedding' | 'llm' | 'manual';
  /** Free-form evidence or justification for the relation. */
  readonly evidence?: string;
}

/** A directed edge between two skills in the relation graph. */
export interface SkillRelation {
  readonly sourceSkillId: string;
  readonly targetSkillId: string;
  readonly relationType: SkillRelationType;
  /** Confidence score 0.0–1.0. */
  readonly confidence: number;
  readonly metadata?: SkillRelationMetadata;
}

/** Query parameters for relation lookup. */
export interface SkillRelationQuery {
  readonly skillId: string;
  readonly relationTypes?: readonly SkillRelationType[];
  /** Minimum confidence threshold (default: 0.5). */
  readonly minConfidence?: number;
  /** Maximum traversal depth for transitive queries (default: 1). */
  readonly maxDepth?: number;
}

/** A node in the skill relation graph. */
export interface SkillGraphNode {
  readonly skillId: string;
  readonly relations: readonly SkillRelation[];
  /** Optional: taxonomy path from root (e.g. ["agent", "coding", "refactor"]). */
  readonly taxonomyPath?: readonly string[];
}

/** Result of a path-finding query between two skills. */
export interface SkillPathResult {
  readonly from: string;
  readonly to: string;
  readonly path: readonly string[];
  readonly totalConfidence: number;
  readonly relationTypes: readonly SkillRelationType[];
}

// ── Division Taxonomy (agency-agents 15-division hierarchy) ────────

/**
 * A node in the division taxonomy tree representing an organizational
 * grouping of agents/skills.
 *
 * Derived from agency-agents' 15 top-level divisions with hierarchical
 * sub-categories (e.g. game_development → cross_engine, unity, unreal_engine,
 * godot, blender, roblox_studio).
 *
 * @enriched-by Donor #30 ENRICH AA-E02 (agency-agents division taxonomy)
 */
export interface SkillDivisionNode {
  /** Division identifier (matches SkillDivision from CC-011). */
  readonly divisionId: string;
  /** Human-readable label (e.g. "Game Development"). */
  readonly label: string;
  /** Parent division ID (undefined for top-level divisions). */
  readonly parentDivisionId?: string;
  /** Child division IDs (empty for leaf divisions). */
  readonly childDivisionIds: readonly string[];
  /** Number of skills/agents in this division (including children). */
  readonly skillCount: number;
}

// ── Domain Port ────────────────────────────────────────────────────

/**
 * Skill Relation Graph — manages inter-skill relationships.
 *
 * Enables: composition chain discovery, dependency analysis,
 * similarity clustering, and taxonomy-based traversal.
 */
export interface ISkillRelationGraph {
  /**
   * Get all relations for a skill matching the query criteria.
   */
  getRelations(query: SkillRelationQuery): Promise<readonly SkillRelation[]>;

  /**
   * Add a relation edge to the graph.
   * Returns false if a duplicate edge already exists.
   */
  addRelation(relation: SkillRelation): Promise<boolean>;

  /**
   * Remove a relation edge from the graph.
   * For symmetric relations (similar_to), removes the reverse edge as well.
   * Returns true if the relation was found and removed, false otherwise.
   */
  removeRelation(
    sourceSkillId: string,
    targetSkillId: string,
    relationType: SkillRelationType,
  ): Promise<boolean>;

  /**
   * Find a path between two skills through the relation graph.
   * Returns null if no path exists within maxDepth.
   */
  findPath(
    fromSkillId: string,
    toSkillId: string,
    maxDepth?: number,
  ): Promise<SkillPathResult | null>;

  /**
   * Get the composition chain for a skill (all compose_with relations, ordered).
   */
  getCompositionChain(skillId: string): Promise<readonly string[]>;

  /**
   * Get dependency tree for a skill (transitive depend_on relations).
   */
  getDependencies(
    skillId: string,
    maxDepth?: number,
  ): Promise<readonly SkillRelation[]>;

  /**
   * Find skills similar to the given skill (similar_to relations above threshold).
   */
  findSimilar(
    skillId: string,
    minConfidence?: number,
  ): Promise<readonly SkillRelation[]>;

  /**
   * Get the full graph node for a skill (with all relations and taxonomy path).
   */
  getNode(skillId: string): Promise<SkillGraphNode | null>;

  /**
   * Get the division taxonomy tree (top-level divisions with their sub-categories).
   * Returns all division nodes in a flat array; hierarchy derived from parentDivisionId.
   *
   * @enriched-by Donor #30 ENRICH AA-E02 (agency-agents division taxonomy)
   */
  getDivisionTree(): Promise<readonly SkillDivisionNode[]>;

  /**
   * Get all skill IDs belonging to a division (including sub-divisions).
   *
   * @param divisionId - Division identifier to query
   * @param includeSubDivisions - Whether to include skills from child divisions (default: true)
   * @enriched-by Donor #30 ENRICH AA-E02 (agency-agents division taxonomy)
   */
  getByDivision(
    divisionId: string,
    includeSubDivisions?: boolean,
  ): Promise<readonly string[]>;
}
