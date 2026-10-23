/**
 * SemanticPagingServiceFactory — Infrastructure adapter for ISemanticPagingServiceFactory.
 *
 * Creates SemanticPagingService instances with configurable tier initialization.
 * Resolves the DEEP-01 architectural gap by providing a single factory used by both
 * the DI container (bootstrap.ts) and standalone MCP servers (stdio transport).
 *
 * Tier initialization follows graceful degradation: if a tier fails to initialize,
 * it is skipped and logged, without breaking the overall S-MMU creation.
 *
 * @layer Infrastructure (Context)
 * @pattern Factory Adapter (DDD)
 * @see src/domain/context/ISemanticPagingServiceFactory.ts — domain port
 * @see src/application/services/context/SemanticPagingService.ts — S-MMU orchestrator
 */

import * as path from 'node:path';

import type {
  ISemanticPagingServiceFactory,
  SemanticPagingFactoryOptions,
} from '../../domain/context/ISemanticPagingServiceFactory';
import type { ISemanticPagingService } from '../../domain/context/ISemanticPagingService';
import type { IArchivalMemory } from '../../domain/memory/IArchivalMemory';
import {
  SemanticPagingService,
  type IMainContextProvider,
  type IGraphContextProvider,
} from './SemanticPagingService';
import type { IEventStore } from '../../domain/events/event-store.interface';
import type { IContextRelevanceJudge } from '../../domain/context/IContextRelevanceJudge';
import type { IHybridRetrievalService } from '../../domain/context/IHybridRetrievalService';
import type { IIncrementalMdcCompiler } from '../../domain/context/IIncrementalMdcCompiler';
import type { ITokenBudgetManager } from '../../domain/context/token-budget.interface';
import type { IContextQualityMetrics } from '../../domain/context/IContextQualityMetrics';
import { LocalMainContextProvider } from '../mcp/docs/providers/LocalMainContextProvider';
import { ContextIndexLoader } from '../mcp/context/loaders/ContextIndexLoader';
import { MdcCompiler } from '../context/compilers/MdcCompiler';
import { buildKnowledgeGraph } from '../context/graph/buildKnowledgeGraph';
import { KnowledgeGraphProvider } from '../context/graph/KnowledgeGraphProvider';
import type { KnowledgeGraphEngine } from '../context/graph/KnowledgeGraphEngine';
import { isHybridRetrievalEnabled } from '../../core/config/app-config';

// ─── Minimal Logger ──────────────────────────────────────────────────

interface MinimalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ─── Factory ─────────────────────────────────────────────────────────

export class SemanticPagingServiceFactory implements ISemanticPagingServiceFactory {
  /** Cached KnowledgeGraphEngine instance — shared across S-MMU instances to avoid double build. */
  private knowledgeGraphEngine: KnowledgeGraphEngine | undefined;

  constructor(
    private readonly defaultProjectRoot: string,
    private readonly eventStore?: IEventStore,
    private readonly archivalProvider?: IArchivalMemory,
    private readonly logger?: MinimalLogger,
    private readonly relevanceJudge?: IContextRelevanceJudge,
    private readonly hybridRetrieval?: IHybridRetrievalService,
    private readonly incrementalMdcCompiler?: IIncrementalMdcCompiler,
    private readonly tokenBudgetManager?: ITokenBudgetManager,
    private readonly contextQualityMetrics?: IContextQualityMetrics,
  ) {}

  /**
   * Create a new SemanticPagingService with the requested tier configuration.
   *
   * Default behavior (no options): all tiers enabled.
   * Standalone MCP context: pass { enableTier2: false, enableTier3: false }
   * to create a Tier 1 + Tier 4 only instance.
   */
  create(options?: SemanticPagingFactoryOptions): ISemanticPagingService {
    const opts: Required<SemanticPagingFactoryOptions> = {
      enableTier1: options?.enableTier1 ?? true,
      enableTier2: options?.enableTier2 ?? true,
      enableTier3: options?.enableTier3 ?? true,
      enableTier4: options?.enableTier4 ?? true,
      projectRoot: options?.projectRoot ?? this.defaultProjectRoot,
    };

    const projectRoot = opts.projectRoot;

    // Tier 1: LocalMainContextProvider
    let mainCtxProvider: IMainContextProvider | undefined;
    if (opts.enableTier1) {
      try {
        const contextIndex = ContextIndexLoader.load(projectRoot);
        const mdcCompiler = new MdcCompiler(projectRoot);
        // REC-089-04: If IIncrementalMdcCompiler is present and all files are clean,
        // the compiler's internal cache is valid — no redundant work.
        // When files are dirty, forceRecompileAll() clears the cache first.
        if (this.incrementalMdcCompiler) {
          const stats = this.incrementalMdcCompiler.getStats();
          if (stats.dirtyFiles > 0) {
            this.incrementalMdcCompiler.forceRecompileAll();
          }
        }
        const mdcChunks = mdcCompiler.compileAll();
        const cheatsheet = ContextIndexLoader.readTextFile(
          path.join(projectRoot, 'AI_CHEATSHEET.md'),
        );
        mainCtxProvider = new LocalMainContextProvider(mdcChunks, contextIndex, cheatsheet);
        this.logger?.info('S-MMU Factory Tier 1: LocalMainContextProvider initialized', {
          chunkCount: mdcChunks.length,
          incrementalTracking: !!this.incrementalMdcCompiler,
        });
      } catch (err) {
        this.logger?.warn('S-MMU Factory Tier 1: Failed to initialize', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Tier 2: IEventStore (core_recall) — passed via constructor
    const eventStore = opts.enableTier2 ? this.eventStore : undefined;

    // Tier 3: VectorArchivalProvider — passed via constructor
    const archival = opts.enableTier3 ? this.archivalProvider : undefined;

    // Tier 4: KnowledgeGraphProvider (GraphRAG)
    let graphProvider: IGraphContextProvider | undefined;
    if (opts.enableTier4) {
      try {
        if (!this.knowledgeGraphEngine) {
          this.knowledgeGraphEngine = buildKnowledgeGraph(projectRoot);
        }
        const stats = this.knowledgeGraphEngine.getStats();
        graphProvider = new KnowledgeGraphProvider(this.knowledgeGraphEngine);
        this.logger?.info('S-MMU Factory Tier 4: KnowledgeGraphProvider initialized', {
          nodeCount: stats.nodeCount,
          edgeCount: stats.edgeCount,
        });
      } catch (err) {
        this.logger?.warn('S-MMU Factory Tier 4: Failed to initialize', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // SemanticPagingServiceFactory: assemble S-MMU with requested tiers + REC-089 adapters
    return new SemanticPagingService(
      eventStore,
      mainCtxProvider,
      archival,
      graphProvider,
      this.logger,
      this.relevanceJudge,
      this.hybridRetrieval,
      this.tokenBudgetManager,
      this.contextQualityMetrics,
      isHybridRetrievalEnabled(),
    );
  }

  /**
   * Get the cached KnowledgeGraphEngine instance.
   * Used by standalone IGraphContextProvider DI registration to avoid double build.
   */
  getKnowledgeGraphEngine(): KnowledgeGraphEngine | undefined {
    return this.knowledgeGraphEngine;
  }
}
