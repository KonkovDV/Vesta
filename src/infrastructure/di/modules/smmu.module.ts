/**
 * S-MMU (Semantic Memory Management Unit) DI Module
 *
 * Registers ISemanticPagingServiceFactory and ISemanticPagingService
 * into the DI container with all available tier dependencies.
 *
 * Tier wiring (graceful degradation — missing tiers are skipped):
 *   Tier 1: LocalMainContextProvider (MDC + CONTEXT_INDEX + AI_CHEATSHEET)
 *   Tier 2: IEventStore (event history)
 *   Tier 3: IArchivalMemory (vector archival)
 *   Tier 4: KnowledgeGraphProvider (GraphRAG, built lazily by factory)
 *
 * @layer Infrastructure (DI)
 * @see src/domain/context/ISemanticPagingServiceFactory.ts — domain port
 * @see src/infrastructure/context/SemanticPagingServiceFactory.ts — adapter
 */

import { container } from '../../../core/di/container';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import { SINGULARITY_TOKENS } from '../../../core/singularity/tokens';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import { SemanticPagingServiceFactory } from '../../context/SemanticPagingServiceFactory';
import type { ISemanticPagingServiceFactory } from '../../../domain/context/ISemanticPagingServiceFactory';
import type { ISemanticPagingService } from '../../../domain/context/ISemanticPagingService';
import type { IEventStore } from '../../../domain/events/event-store.interface';
import type { IArchivalMemory } from '../../../domain/memory/IArchivalMemory';
import type { IStructuredLogger } from '../../../core/logging/IStructuredLogger';
import type { IContextRelevanceJudge } from '../../../domain/context/IContextRelevanceJudge';
import type { IHybridRetrievalService } from '../../../domain/context/IHybridRetrievalService';
import type { IIncrementalMdcCompiler } from '../../../domain/context/IIncrementalMdcCompiler';
import type { ITokenBudgetManager } from '../../../domain/context/token-budget.interface';
import type { IContextQualityMetrics } from '../../../domain/context/IContextQualityMetrics';

const log = getBootstrapLogger('smmu-module');

/**
 * Safely resolve an optional DI token.
 * Returns undefined if the token is not registered (graceful degradation).
 */
function tryResolve<T>(token: string | symbol): T | undefined {
  try {
    if (container.isRegistered(token)) {
      return container.resolve<T>(token);
    }
  } catch {
    // Swallow — optional dependency not available
  }
  return undefined;
}

export function registerSmmuModule(): void {
  if (container.isRegistered(DI_TOKENS.ISemanticPagingServiceFactory)) {
    return; // Idempotent
  }

  try {
    const projectRoot = process.cwd();

    // Resolve available dependencies (all optional for the factory)
    const eventStore = tryResolve<IEventStore>(DI_TOKENS.IEventStore);
    const archival = tryResolve<IArchivalMemory>(DI_TOKENS.IArchivalMemory);
    const logger = tryResolve<IStructuredLogger>(DI_TOKENS.IStructuredLogger);

    // REC-089 adapters — registered only if their modules are loaded
    const relevanceJudge = tryResolve<IContextRelevanceJudge>(DI_TOKENS.IContextRelevanceJudge);
    const hybridRetrieval = tryResolve<IHybridRetrievalService>(DI_TOKENS.IHybridRetrievalService);
    const incrementalMdc = tryResolve<IIncrementalMdcCompiler>(DI_TOKENS.IIncrementalMdcCompiler);
    const tokenBudgetManager = tryResolve<ITokenBudgetManager>(SINGULARITY_TOKENS.TOKEN_BUDGET_MANAGER);
    const qualityMetrics = tryResolve<IContextQualityMetrics>(DI_TOKENS.IContextQualityMetrics);

    const factory = new SemanticPagingServiceFactory(
      projectRoot,
      eventStore,
      archival,
      logger,
      relevanceJudge,
      hybridRetrieval,
      incrementalMdc,
      tokenBudgetManager,
      qualityMetrics,
    );

    // Register the factory
    container.register<ISemanticPagingServiceFactory>(
      DI_TOKENS.ISemanticPagingServiceFactory,
      () => factory,
      {
        lifecycle: 'singleton',
        tags: ['context', 'smmu', 'factory'],
        description: 'S-MMU factory — creates SemanticPagingService with tier configuration',
      },
    );

    // Register the default all-tiers service instance
    container.register<ISemanticPagingService>(
      DI_TOKENS.ISemanticPagingService,
      () => factory.create(),
      {
        lifecycle: 'singleton',
        tags: ['context', 'smmu', 'orchestrator'],
        description: 'S-MMU orchestrator — 4-tier semantic memory (Tier 1 MDC, Tier 2 Events, Tier 3 Archival, Tier 4 GraphRAG)',
      },
    );

    log.info('S-MMU module registered', {
      tier1: true,
      tier2: !!eventStore,
      tier3: !!archival,
      tier4: true, // Built lazily by factory on first create()
    });
  } catch (error) {
    log.error('Failed to register S-MMU module', { error });
    throw error;
  }
}
