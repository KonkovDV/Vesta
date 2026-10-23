/**
 * Deferred Tool Registry — lazy tool loading with manifests.
 *
 * Extends IToolRegistry with deferred loading capabilities: tools
 * are initially registered as lightweight manifests (id, description, tags)
 * and resolved on-demand to full IAgentTool instances.
 *
 * Achieves ~85% token savings by keeping only manifests in context
 * until a tool is actually needed.
 *
 * @layer Domain (port)
 * @module agents
 * @pattern CC-007 Deferred Tool Loading (FITNESS-K: 72.5)
 * @see src/domain/agents/tools.interface.ts — IToolRegistry base interface
 * @see src/domain/ai/IAgentTool.ts — full tool definition
 */

import type { IToolRegistry, IAgentTool } from './tools.interface';

// ── Deferred Tool Manifest ─────────────────────────────────────────

/**
 * Lightweight tool manifest — description and tags only, no execute function
 * or full JSON schema. Used for search and matching before full resolution.
 */
export interface DeferredToolManifest {
  /** Unique tool identifier. */
  readonly id: string;
  /** Human-readable tool name. */
  readonly name: string;
  /** Brief description for search matching. */
  readonly description: string;
  /** Tags for categorical filtering. */
  readonly tags: ReadonlyArray<string>;
  /** Whether this tool is deferred (always true for manifests). */
  readonly deferred: true;
  /** Optional input examples for improved matching (ENRICH T08). */
  readonly inputExamples?: ReadonlyArray<string>;
}

// ── Tool Resolution Result ─────────────────────────────────────────

/**
 * Result of resolving a deferred tool to a full IAgentTool.
 */
export interface ToolResolutionResult {
  /** Resolved tool (null if resolution failed). */
  readonly tool: IAgentTool | null;
  /** Resolution duration in milliseconds. */
  readonly resolutionMs: number;
  /** Whether the tool was loaded from cache. */
  readonly fromCache: boolean;
  /** Error message if resolution failed. */
  readonly error?: string;
}

// ── Domain Port ────────────────────────────────────────────────────

/**
 * Extended tool registry with deferred loading capabilities.
 *
 * Inherits all IToolRegistry methods and adds manifest-based
 * search and on-demand tool resolution.
 *
 * @pattern CC-007 PTC — ~85% token savings via manifest-only context
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface IDeferredToolRegistry extends IToolRegistry {
  /**
   * Search for tools matching a regex pattern against manifests.
   * Returns manifests only — full tool definitions are not loaded.
   * @param pattern - Regex pattern to match against name, description, and tags.
   * @returns Matching manifests sorted by relevance.
   */
  search(pattern: string): DeferredToolManifest[];

  /**
   * Check whether a tool is currently deferred (manifest-only) or fully loaded.
   * @param toolId - The tool identifier to check.
   * @returns true if the tool is registered but not yet resolved.
   */
  isDeferred(toolId: string): boolean;

  /**
   * Resolve a deferred tool to its full IAgentTool definition.
   * Loads the tool implementation on demand and caches it.
   * @param toolId - The tool identifier to resolve.
   * @returns Resolution result with the loaded tool or error.
   */
  resolve(toolId: string): Promise<ToolResolutionResult>;

  /**
   * Register a lightweight manifest without loading the full tool.
   * @param manifest - The manifest to register.
   */
  registerManifest(manifest: DeferredToolManifest): void;

  /**
   * Get all registered manifests (both deferred and resolved).
   * @returns All tool manifests in the registry.
   */
  listManifests(): DeferredToolManifest[];
}
