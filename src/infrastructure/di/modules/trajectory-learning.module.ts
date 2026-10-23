/**
 * Trajectory-Informed Memory (TIM) DI Module.
 *
 * Registers CC-033/034/035/036 adapters + LLM variant for the trajectory learning pipeline:
 *   ITrajectoryIntelligenceExtractor → IDecisionAttributionAnalyzer
 *   → IContextualTipGenerator → IAdaptiveMemoryRetrieval
 *   + ILlmTrajectoryIntelligenceExtractor (LLM-enhanced CC-033 variant)
 *
 * Phase 5K Integrations:
 *   - CC-035 ← ICrossModelShadowConsensus (CC-031) for tip validation
 *   - CC-035 ← IWisdomConsolidator (CC-027) for tip consolidation
 *   - CC-036 ← IDynamicCognitiveBudget (CC-028) for criticality-aware retrieval
 *   - CC-033 LLM ← IModelRouter (KC-025) for LLM-powered extraction
 *
 * SAGE Phase 6 Enhancements:
 *   - CC-035: Conformal Calibration R≥0.95 (arXiv:2602.21368) replaces binary gates
 *   - CC-027: Anti-Sycophancy Debater adversarial scrubbing (arXiv:2310.13548)
 *   - CC-036: 4-Tier Ebbinghaus Decay (Episodic/Semantic/Procedural/Meta-cognitive)
 *   - CC-033 LLM: Entropy-Driven Audit Triggers + PROBE (arXiv:2601.15690)
 *
 * @module infrastructure/di/modules
 * @phase TIM (arXiv:2603.10600)
 */

import { container } from '../../../core/di/container';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import type { IStructuredLogger } from '../../../core/logging/IStructuredLogger';
import { TrajectoryIntelligenceExtractorAdapter } from '../../memory/trajectory/TrajectoryIntelligenceExtractorAdapter';
import { DecisionAttributionAnalyzerAdapter } from '../../memory/trajectory/DecisionAttributionAnalyzerAdapter';
import { ContextualTipGeneratorAdapter } from '../../memory/trajectory/ContextualTipGeneratorAdapter';
import { AdaptiveMemoryRetrievalAdapter } from '../../memory/trajectory/AdaptiveMemoryRetrievalAdapter';
import { LlmTrajectoryIntelligenceAdapter } from '../../memory/trajectory/LlmTrajectoryIntelligenceAdapter';
import { WisdomExporterAdapter } from '../../memory/trajectory/WisdomExporterAdapter';
import type { ICrossModelShadowConsensus } from '../../../domain/evaluation/ICrossModelShadowConsensus';
import type { IWisdomConsolidator } from '../../../domain/memory/IWisdomConsolidator';
import type { IDynamicCognitiveBudget } from '../../../domain/agents/IDynamicCognitiveBudget';
import type { ILLMAdapterFactory } from '../../../domain/ai/ILLMAdapterFactory';
import type { IModelRouter } from '../../../domain/ai/IModelRouter';
import type { ILessonStore } from '../../../domain/memory/ILessonStore';
import type { ITrajectoryStore } from '../../../domain/memory/ITrajectoryStore';
import type { ITipStore } from '../../../domain/memory/ITipStore';

type ProbeLogger = Pick<IStructuredLogger, 'warn'>;

export function registerTrajectoryLearningModule(): void {
  if (container.isRegistered(DI_TOKENS.ITrajectoryIntelligenceExtractor)) return;

  // CC-033: Trajectory Intelligence Extractor
  container.register(
    DI_TOKENS.ITrajectoryIntelligenceExtractor,
    () => new TrajectoryIntelligenceExtractorAdapter({
      store: container.isRegistered(DI_TOKENS.ITrajectoryStore)
        ? container.resolve<ITrajectoryStore>(DI_TOKENS.ITrajectoryStore)
        : undefined,
    }),
    { lifecycle: 'singleton', tags: ['memory', 'trajectory', 'intelligence'] },
  );

  // CC-034: Decision Attribution Analyzer
  container.register(
    DI_TOKENS.IDecisionAttributionAnalyzer,
    () => new DecisionAttributionAnalyzerAdapter(),
    { lifecycle: 'singleton', tags: ['memory', 'trajectory', 'attribution'] },
  );

  // CC-035: Contextual Tip Generator (with optional CC-031 validation + CC-027 consolidation)
  // NOTE: When ITipStore is wired, adapter hydrates persisted tips asynchronously.
  // Consumers needing deterministic startup state should call whenReady() after DI resolution.
  container.register(
    DI_TOKENS.IContextualTipGenerator,
    () => {
      const consensus = container.isRegistered(DI_TOKENS.ICrossModelShadowConsensus)
        ? container.resolve<ICrossModelShadowConsensus>(DI_TOKENS.ICrossModelShadowConsensus)
        : undefined;
      const consolidator = container.isRegistered(DI_TOKENS.IWisdomConsolidator)
        ? container.resolve<IWisdomConsolidator>(DI_TOKENS.IWisdomConsolidator)
        : undefined;
      const tipStore = container.isRegistered(DI_TOKENS.ITipStore)
        ? container.resolve<ITipStore>(DI_TOKENS.ITipStore)
        : undefined;
      return new ContextualTipGeneratorAdapter({ consensus, consolidator, tipStore });
    },
    { lifecycle: 'singleton', tags: ['memory', 'trajectory', 'tips'] },
  );

  // CC-036: Adaptive Memory Retrieval (with optional CC-028 dynamic budget)
  container.register(
    DI_TOKENS.IAdaptiveMemoryRetrieval,
    () => {
      const budget = container.isRegistered(DI_TOKENS.IDynamicCognitiveBudget)
        ? container.resolve<IDynamicCognitiveBudget>(DI_TOKENS.IDynamicCognitiveBudget)
        : undefined;
      const tipStore = container.isRegistered(DI_TOKENS.ITipStore)
        ? container.resolve<ITipStore>(DI_TOKENS.ITipStore)
        : undefined;
      const lessonStore = container.isRegistered(DI_TOKENS.ILessonStore)
        ? container.resolve<ILessonStore>(DI_TOKENS.ILessonStore)
        : undefined;
      return new AdaptiveMemoryRetrievalAdapter({ budget, tipStore, lessonStore });
    },
    { lifecycle: 'singleton', tags: ['memory', 'trajectory', 'retrieval'] },
  );

  // CC-033 LLM variant: LLM-enhanced Trajectory Intelligence (with optional IModelRouter)
  container.register(
    DI_TOKENS.ILlmTrajectoryIntelligenceExtractor,
    () => {
      const modelRouter = container.isRegistered(DI_TOKENS.IModelRouter)
        ? container.resolve<IModelRouter>(DI_TOKENS.IModelRouter)
        : undefined;
      const llmFactory = container.isRegistered(DI_TOKENS.LLMAdapterFactory)
        ? container.resolve<ILLMAdapterFactory>(DI_TOKENS.LLMAdapterFactory)
        : undefined;
      const trajectoryStore = container.isRegistered(DI_TOKENS.ITrajectoryStore)
        ? container.resolve<ITrajectoryStore>(DI_TOKENS.ITrajectoryStore)
        : undefined;
      const logger = container.isRegistered(DI_TOKENS.IStructuredLogger)
        ? container.resolve<ProbeLogger>(DI_TOKENS.IStructuredLogger)
        : undefined;
      return new LlmTrajectoryIntelligenceAdapter({ modelRouter, llmFactory, trajectoryStore, logger });
    },
    { lifecycle: 'singleton', tags: ['memory', 'trajectory', 'intelligence', 'llm'] },
  );

  // TIM Wisdom Exporter: Tier 3-4 wisdom → LSP diagnostic rules
  container.register(
    DI_TOKENS.IWisdomExporter,
    () => new WisdomExporterAdapter({
      lessonStore: container.isRegistered(DI_TOKENS.ILessonStore)
        ? container.resolve<ILessonStore>(DI_TOKENS.ILessonStore)
        : undefined,
    }),
    { lifecycle: 'singleton', tags: ['memory', 'trajectory', 'export', 'lsp'] },
  );
}
