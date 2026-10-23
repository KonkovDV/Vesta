/**
 * Debugging DI module.
 *
 * Registers infrastructure adapters for the Error Debugging Evolution
 * domain interfaces (Ticket #67, SOTA March 2026).
 *
 * Phase 1 (current): PgErrorGraphRepository (V5: Predictive Auto-Traps)
 * Phase 2 (current): AutoTrapGenerator, ByzantineFaultArbitrator adapters
 * Phase 3 (current): JITContextInjectorAdapter (V5: JIT Context Injection)
 *
 * @see src/domain/debugging/IErrorGraphRepository.ts
 * @see src/domain/debugging/IAutoTrapGenerator.ts
 * @see src/domain/debugging/IBFTErrorRouter.ts
 * @see src/domain/debugging/IJITContextInjector.ts
 * @see src/infrastructure/debugging/PgErrorGraphRepository.ts
 * @see src/infrastructure/debugging/AutoTrapGenerator.ts
 * @see src/infrastructure/debugging/ByzantineFaultArbitrator.ts
 * @see src/infrastructure/debugging/JITContextInjectorAdapter.ts
 * @see PLANS/06_BLUEPRINTS/ERROR_DEBUGGING_EVOLUTION_SOTA_2026.md
 * @see PLANS/SOTA_BUG_CATCHING_2026/02_Agentic_JIT_Context_Injection.md
 */

import { container } from '../../../core/di/container';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import type { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';
import { PgErrorGraphRepository } from '../../debugging/PgErrorGraphRepository';
import { AutoTrapGenerator } from '../../debugging/AutoTrapGenerator';
import { ByzantineFaultArbitrator } from '../../debugging/ByzantineFaultArbitrator';
import { JITContextInjectorAdapter } from '../../debugging/JITContextInjectorAdapter';
import { RuntimeErrorCaptureAdapter } from '../../debugging/RuntimeErrorCaptureAdapter';
import { ErrorLessonCaptureAdapter } from '../../debugging/ErrorLessonCaptureAdapter';
import type { IErrorGraphRepository } from '../../../domain/debugging/IErrorGraphRepository';
import type { ILessonStore } from '../../../domain/memory/ILessonStore';
import type { IWisdomConsolidator } from '../../../domain/memory/IWisdomConsolidator';
import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { StructuredLogger } from '../../logging/StructuredLogger';

/** Minimal logger subset compatible with all debugging adapters. */
interface IAdapterLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const log = getBootstrapLogger('debugging');

export function registerDebuggingModule(): void {
  // Guard all three tokens to avoid re-registration
  if (container.isRegistered(DI_TOKENS.IErrorGraphRepository)) return;

  try {
    container.register(DI_TOKENS.IErrorGraphRepository, () => {
      const db = container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection);
      // Logger is optional — will be undefined in test/in-memory modes
      const logger = container.isRegistered(DI_TOKENS.IStructuredLogger)
        ? container.resolve<IAdapterLogger>(DI_TOKENS.IStructuredLogger)
        : undefined;
      const repository = new PgErrorGraphRepository(db, logger);
      void repository.ensureHnswIndex().catch(() => undefined);
      return repository;
    }, {
      lifecycle: 'singleton',
      tags: ['debugging', 'graphrag', 'repository', 'pgvector'],
      description: 'PostgreSQL + pgvector ErrorGraphRepository (V5: Predictive Auto-Traps)',
    });

    // Phase 2: AutoTrapGenerator — LLM-assisted ESLint rule generation
    container.register(DI_TOKENS.IAutoTrapGenerator, () => {
      // LLM client is optional — resolves to undefined if not registered
      const llmClient = container.isRegistered(DI_TOKENS.LLMAdapterFactory)
        ? container.resolve<{ generateText: (p: string, o?: unknown) => Promise<string> }>(DI_TOKENS.LLMAdapterFactory)
        : undefined;
      const logger = container.isRegistered(DI_TOKENS.IStructuredLogger)
        ? container.resolve<IAdapterLogger>(DI_TOKENS.IStructuredLogger)
        : undefined;
      return new AutoTrapGenerator(
        llmClient,
        logger,
      );
    }, {
      lifecycle: 'singleton',
      tags: ['debugging', 'auto-trap', 'eslint', 'llm'],
      description: 'LLM-assisted ESLint trap rule generator (V5: Predictive Auto-Traps)',
    });

    // Phase 2: ByzantineFaultArbitrator — BFT consensus + approval tokens
    container.register(DI_TOKENS.IBFTErrorRouter, () => {
      const logger = container.isRegistered(DI_TOKENS.IStructuredLogger)
        ? container.resolve<IAdapterLogger>(DI_TOKENS.IStructuredLogger)
        : undefined;
      return new ByzantineFaultArbitrator(
        [], // Judges are registered at runtime by consuming services
        undefined, // Ephemeral HMAC secret (development mode)
        logger,
      );
    }, {
      lifecycle: 'singleton',
      tags: ['debugging', 'bft', 'consensus', 'security'],
      description: 'Byzantine Fault Tolerant error router with cryptographic approval tokens',
    });

    // Phase 3: JITContextInjectorAdapter — file-aware bug context injection
    container.register(DI_TOKENS.IJITContextInjector, () => {
      const errorGraph = container.resolve<IErrorGraphRepository>(DI_TOKENS.IErrorGraphRepository);
      const logger = container.isRegistered(DI_TOKENS.IStructuredLogger)
        ? container.resolve<IAdapterLogger>(DI_TOKENS.IStructuredLogger)
        : undefined;
      return new JITContextInjectorAdapter(errorGraph, logger);
    }, {
      lifecycle: 'singleton',
      tags: ['debugging', 'jit', 'context-injection'],
      description: 'JIT Context Injector — file-aware bug context injection (V5: Predictive Auto-Traps)',
    });

    const logger = container.isRegistered(DI_TOKENS.IStructuredLogger)
      ? container.resolve<IAdapterLogger>(DI_TOKENS.IStructuredLogger)
      : undefined;

    const runtimeCapture = new RuntimeErrorCaptureAdapter(
      container.resolve<IErrorGraphRepository>(DI_TOKENS.IErrorGraphRepository),
      {
        lessonCapture: new ErrorLessonCaptureAdapter({
          lessonStore: () => (
            container.isRegistered(DI_TOKENS.ILessonStore)
              ? container.resolve<ILessonStore>(DI_TOKENS.ILessonStore)
              : undefined
          ),
          wisdomConsolidator: () => (
            container.isRegistered(DI_TOKENS.IWisdomConsolidator)
              ? container.resolve<IWisdomConsolidator>(DI_TOKENS.IWisdomConsolidator)
              : undefined
          ),
          logger,
        }),
      },
    );
    StructuredLogger.setErrorCaptureSink((record) => runtimeCapture.capture(record));

    log.info('✓ Debugging module registered (IErrorGraphRepository, IAutoTrapGenerator, IBFTErrorRouter, IJITContextInjector, RuntimeErrorCaptureSink, RuntimeErrorLessons)');
  } catch (error) {
    log.error('✗ Failed to register debugging module:', { error });
    throw error;
  }
}
