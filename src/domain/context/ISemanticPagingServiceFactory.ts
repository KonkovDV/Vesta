/**
 * ISemanticPagingServiceFactory — Domain port for creating S-MMU instances.
 *
 * Provides a unified factory for creating SemanticPagingService instances
 * with consistent tier initialization. Used by:
 * - DI bootstrap (main app, all 4 tiers)
 * - Standalone MCP servers (subset of tiers, stdio transport)
 *
 * This eliminates the DEEP-01 architectural gap where standalone MCP servers
 * created S-MMU instances with ad-hoc factory functions, leading to tier
 * configuration drift between the main app and MCP servers.
 *
 * @layer Domain (Context)
 * @pattern Factory Port (DDD)
 * @see src/domain/context/ISemanticPagingService.ts — S-MMU port
 * @see PLANS/DOCS_AUDIT_2026/83_MCP_SYSTEM_SIMPLE_EXPLANATION.md — DEEP-01 analysis
 */

import type { ISemanticPagingService } from './ISemanticPagingService';

/**
 * Options for creating an S-MMU instance.
 * Each tier can be independently enabled/disabled.
 */
export interface SemanticPagingFactoryOptions {
  /** Enable Tier 1: Local MDC + CONTEXT_INDEX + AI_CHEATSHEET chunks */
  readonly enableTier1?: boolean;
  /** Enable Tier 2: IEventStore-based event history (core_recall) */
  readonly enableTier2?: boolean;
  /** Enable Tier 3: Vector archival (pgvector embeddings) */
  readonly enableTier3?: boolean;
  /** Enable Tier 4: AST-driven Knowledge Graph (GraphRAG) */
  readonly enableTier4?: boolean;
  /** Project root path override (defaults to workspace root) */
  readonly projectRoot?: string;
}

/**
 * ISemanticPagingServiceFactory — creates configured S-MMU instances.
 */
export interface ISemanticPagingServiceFactory {
  /**
   * Create a new SemanticPagingService with the requested tier configuration.
   *
   * @param options - Tier enablement flags. Omitted tiers default to true
   *   in the DI context and may default to false in standalone contexts.
   * @returns Fully initialized ISemanticPagingService
   */
  create(options?: SemanticPagingFactoryOptions): ISemanticPagingService;
}
