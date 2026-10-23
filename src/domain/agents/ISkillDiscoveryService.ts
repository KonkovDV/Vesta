/**
 * Skill Discovery Service — monorepo-aware lazy skill loading.
 *
 * Provides manifest-based skill discovery with keyword search and
 * on-demand full loading. Separated from ISkillScanner (security scanning)
 * per Interface Segregation Principle.
 *
 * @layer Domain (port)
 * @module agents
 * @pattern CC-011 Skill Discovery in Monorepos (FITNESS-K: 71.5)
 * @enriched-by SkillNet 3-layer ontology (arXiv:2603.04448 §3.2, Donor #28 ENRICH T1)
 * @enriched-by agency-agents frontmatter schema + division taxonomy (Donor #30 ENRICH AA-E01)
 * @see src/domain/security/skill-scanner.port.ts — ISkillScanner (security, separate concern)
 */

// ── Skill Manifest ─────────────────────────────────────────────────

/**
 * Lightweight skill manifest — always in context, low token cost.
 * Full skill definitions are loaded on demand.
 */
export interface SkillManifest {
  /** Unique skill identifier. */
  readonly id: string;
  /** Human-readable skill name. */
  readonly name: string;
  /** Brief description for search matching. */
  readonly description: string;
  /** Tags for categorical filtering. */
  readonly tags: ReadonlyArray<string>;
  /** File path to the skill definition (relative to workspace root). */
  readonly filePath: string;
  /** Estimated token budget for full skill loading. */
  readonly estimatedTokens: number;
  /**
   * Division that this skill belongs to (e.g. 'engineering', 'testing', 'design').
   * Maps to the 15-division taxonomy from agency-agents.
   * @enriched-by Donor #30 ENRICH AA-E01 (agency-agents division taxonomy)
   */
  readonly division?: SkillDivision;
}

// ── Agent Template Frontmatter (agency-agents §CONTRIBUTING.md) ────

/**
 * Standardized YAML frontmatter for agent personality templates.
 * Captures the 7-field schema used across 144 agents in agency-agents.
 *
 * @enriched-by Donor #30 ENRICH AA-E01 (agency-agents template pattern)
 */
export interface AgentTemplateFrontmatter {
  /** Agent display name (e.g. "Backend Architect"). */
  readonly name: string;
  /** One-line agent description. */
  readonly description: string;
  /** Theme color — named CSS color or hex code (e.g. "blue", "#4285F4"). */
  readonly color: string;
  /** Representative emoji for the agent (e.g. "🏗️"). */
  readonly emoji: string;
  /** Brief personality/purpose statement. */
  readonly vibe: string;
  /** Comma-separated tool names the agent can use (optional). */
  readonly tools?: string;
  /** Services the agent integrates with (optional). */
  readonly services?: string;
}

/**
 * Canonical sections of an agent personality template body.
 * Derived from the common structure across 144 agency-agents templates.
 *
 * @enriched-by Donor #30 ENRICH AA-E01 (agency-agents template pattern)
 */
export type AgentTemplateSection =
  | 'identity_and_memory'
  | 'core_mission'
  | 'critical_rules'
  | 'technical_deliverables'
  | 'workflow_process'
  | 'success_metrics'
  | 'communication_style';

/**
 * 15-division taxonomy from agency-agents repository.
 * Each division groups related agent specializations.
 *
 * @enriched-by Donor #30 ENRICH AA-E01 (agency-agents division taxonomy)
 */
export type SkillDivision =
  | 'academic'
  | 'design'
  | 'engineering'
  | 'game_development'
  | 'integrations'
  | 'marketing'
  | 'paid_media'
  | 'product'
  | 'project_management'
  | 'sales'
  | 'spatial_computing'
  | 'specialized'
  | 'strategy'
  | 'support'
  | 'testing';

// ── Skill Definition ───────────────────────────────────────────────

/**
 * Full skill definition — loaded on demand from manifest.
 */
export interface SkillDefinition {
  /** Manifest that this definition expands. */
  readonly manifest: SkillManifest;
  /** Full instruction content of the skill. */
  readonly content: string;
  /** YAML frontmatter parsed from the skill file. */
  readonly frontmatter: Record<string, unknown>;
  /** Actual token count of the full content. */
  readonly actualTokens: number;
  /** Loading duration in milliseconds. */
  readonly loadDurationMs: number;
}

// ── Skill Discovery Filter ─────────────────────────────────────────

/**
 * Filter criteria for manifest discovery.
 */
export interface SkillDiscoveryFilter {
  /** Filter by tags (OR logic). */
  readonly tags?: ReadonlyArray<string>;
  /** Maximum estimated token budget. */
  readonly maxTokens?: number;
  /** Maximum number of results. */
  readonly limit?: number;
}

// ── Skill Load Result ──────────────────────────────────────────────

/**
 * Result of loading a full skill definition.
 */
export interface SkillLoadResult {
  /** The loaded definition (null if loading failed). */
  readonly definition: SkillDefinition | null;
  /** Whether the result was served from cache. */
  readonly fromCache: boolean;
  /** Error message if loading failed. */
  readonly error?: string;
}

// ── Skill Taxonomy & Ontology (SkillNet arXiv:2603.04448 §3.2) ─────

/**
 * Hierarchical taxonomy level in SkillNet's 3-layer ontology:
 *   Taxonomy Layer → Relation Graph → Skill Package Library.
 *
 * @enriched-by Donor #28 ENRICH T1 (SkillNet 3-layer ontology)
 */
export type SkillTaxonomyLevel = 'category' | 'subcategory' | 'skill';

/**
 * Ontology metadata for a skill — extends SkillManifest with
 * hierarchical classification and package bundling provenance.
 *
 * @enriched-by Donor #28 ENRICH T1 (SkillNet 3-layer ontology)
 */
export interface SkillOntologyMetadata {
  /** Taxonomy path from root category to skill (e.g. ["coding", "refactoring", "extract-method"]). */
  readonly taxonomyPath: ReadonlyArray<string>;
  /** Taxonomy level of this node. */
  readonly level: SkillTaxonomyLevel;
  /** Optional: skill package this skill belongs to. */
  readonly packageId?: string;
}

// ── Domain Port ────────────────────────────────────────────────────

/**
 * Domain port for monorepo-aware skill discovery.
 *
 * Manifests are always available in context (low token cost).
 * Full definitions are loaded on demand with budget enforcement.
 *
 * @pattern CC-011 — manifest scanning + keyword search + budget-bounded invocation
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface ISkillDiscoveryService {
  /**
   * Get all skill manifests, optionally filtered.
   * @param filter - Optional filter criteria.
   * @returns Matching manifests sorted by relevance.
   */
  getManifests(filter?: SkillDiscoveryFilter): SkillManifest[];

  /**
   * Load the full definition of a skill on demand.
   * Caches results for subsequent calls.
   * @param skillId - The skill identifier from its manifest.
   * @returns Load result with definition or error.
   */
  loadFull(skillId: string): Promise<SkillLoadResult>;

  /**
   * Search manifests by keyword (matched against name, description, tags).
   * @param keyword - Keyword to search for.
   * @returns Matching manifests sorted by relevance.
   */
  searchByKeyword(keyword: string): SkillManifest[];

  /**
   * Get the estimated token budget for loading a skill.
   * @param skillId - The skill identifier.
   * @returns Estimated token count, or 0 if skill not found.
   */
  getTokenBudget(skillId: string): number;
}
