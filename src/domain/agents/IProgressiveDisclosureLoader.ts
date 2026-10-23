/**
 * IProgressiveDisclosureLoader — Domain port for 3-level progressive content loading.
 *
 * AS-001 Progressive Disclosure Architecture: manages staged disclosure of agent
 * skills, tools, and context materials to minimize context window consumption.
 * Content is loaded in three levels: metadata (always available, ~100 tokens),
 * instructions (loaded on trigger, <5K tokens), resources (loaded on demand,
 * unlimited).
 *
 * SOTA 2026 Basis: Anthropic Agent Skills architecture uses progressive
 * disclosure to manage 100+ skills efficiently — metadata-only at startup,
 * SKILL.md body loaded when triggered by query relevance, bundled files/scripts
 * loaded only when actively invoked.
 *
 * Sub-capabilities:
 *   1. Staged Loading — content loaded at metadata/instructions/resources levels
 *   2. Token Budget Estimation — per-level token cost before loading
 *   3. Disclosure State Tracking — current level + total tokens consumed
 *   4. Relevance-Driven Recommendation — query determines optimal loading level
 *   5. Manifest Registration — declarative definition of content layers
 *
 * Distinct from CC-007 (IDeferredToolRegistry): CC-007 handles binary
 * manifest-based tool loading (loaded or not), while AS-001 manages a 3-level
 * graduated loading strategy with token budget awareness per level.
 *
 * @layer Domain (Agents)
 * @pattern AS-001 Progressive Disclosure (FITNESS-K: 82)
 * @see src/domain/agents/IDeferredToolRegistry.ts — binary manifest loading (CC-007)
 * @see src/domain/context/context-compactor.interface.ts — context budget management
 * @see src/domain/agents/ISemanticToolFilter.ts — relevance-driven filtering (CC-006)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Three-level progressive disclosure tiers.
 * - metadata: name + description only (~100 tokens, always loaded)
 * - instructions: SKILL.md body (<5K tokens, loaded on trigger)
 * - resources: bundled files/scripts (unlimited, loaded on demand)
 */
export type DisclosureLevel = 'metadata' | 'instructions' | 'resources';

// ─── Manifest ────────────────────────────────────────────────────────────────

/**
 * Declarative manifest defining the three disclosure layers for a content item.
 * Each manifest describes what is available at each loading level and
 * its estimated token cost.
 */
export interface DisclosureManifest {
  /** Unique content identifier. */
  readonly contentId: string;
  /** Human-readable name (max 64 chars, lowercase + hyphens). */
  readonly name: string;
  /** Description for discovery (max 1024 chars). */
  readonly description: string;
  /** Estimated tokens for Level 1 (metadata). */
  readonly metadataTokens: number;
  /** Path to instructions content (Level 2 — SKILL.md body). */
  readonly instructionsPath: string;
  /** Paths to resource files (Level 3 — bundled files/scripts). */
  readonly resourcePaths: readonly string[];
  /** Estimated tokens for Level 2 (instructions). */
  readonly estimatedInstructionTokens: number;
}

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * Current disclosure state for a content item.
 * Tracks what level has been loaded and cumulative token consumption.
 */
export interface DisclosureState {
  /** Content identifier. */
  readonly contentId: string;
  /** Highest level currently loaded. */
  readonly currentLevel: DisclosureLevel;
  /** ISO timestamp when this level was loaded. */
  readonly loadedAt: string;
  /** Total tokens consumed across all loaded levels. */
  readonly totalTokensConsumed: number;
}

// ─── Disclosed Content ───────────────────────────────────────────────────────

/**
 * Result of loading content at a disclosure level.
 */
export interface DisclosedContent {
  /** Content identifier. */
  readonly contentId: string;
  /** Level that was loaded. */
  readonly level: DisclosureLevel;
  /** The loaded textual content. */
  readonly content: string;
  /** Actual token count after loading. */
  readonly actualTokens: number;
  /** Time taken to load in milliseconds. */
  readonly loadDurationMs: number;
}

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * IProgressiveDisclosureLoader — 3-level progressive content loading.
 *
 * Workflow:
 * 1. register() content manifests at startup (metadata always available)
 * 2. estimateTokensForLevel() before loading to check budget
 * 3. loadAtLevel() to progressively load deeper content
 * 4. recommendLevel() to determine optimal depth based on query relevance
 * 5. getDisclosureState() to check what is currently loaded
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface IProgressiveDisclosureLoader {
  /**
   * Load content at specified disclosure level.
   * If a higher level is already loaded, returns cached content.
   * Levels are cumulative: loading 'instructions' includes 'metadata'.
   *
   * @param contentId - Content item identifier
   * @param level - Target disclosure level
   * @returns Loaded content with actual token count
   */
  loadAtLevel(contentId: string, level: DisclosureLevel): Promise<DisclosedContent>;

  /**
   * Estimate token cost for loading a given level.
   * Returns the estimated tokens from the manifest without performing actual load.
   *
   * @param contentId - Content item identifier
   * @param level - Target disclosure level
   * @returns Estimated token count, or -1 if contentId not registered
   */
  estimateTokensForLevel(contentId: string, level: DisclosureLevel): number;

  /**
   * Get current disclosure state for a content item.
   *
   * @param contentId - Content item identifier
   * @returns Current state, or undefined if not yet loaded
   */
  getDisclosureState(contentId: string): DisclosureState | undefined;

  /**
   * Register content with its disclosure manifest.
   * Metadata becomes immediately available after registration.
   *
   * @param manifest - Declarative content manifest
   */
  register(manifest: DisclosureManifest): void;

  /**
   * Determine optimal disclosure level based on query relevance.
   * Uses description matching to decide whether metadata is sufficient
   * or deeper loading is warranted.
   *
   * @param contentId - Content item identifier
   * @param query - User query for relevance assessment
   * @returns Recommended disclosure level
   */
  recommendLevel(contentId: string, query: string): DisclosureLevel;
}
