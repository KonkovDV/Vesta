/**
 * Agentic Design Patterns DI Module.
 * Registers services derived from "Agentic Design Patterns" (Gulli, Springer 2026).
 *
 * Layer: Infrastructure/DI
 *
 * Sub-modules (one per implementation phase):
 *   registerAgenticFoundation()   -> Wave A (Phase 1): ILlmJudge, IReflectionLoop, IPromptClassifier
 *   registerAgenticReasoning()    -> Wave B (Phase 2): IStructuredReasoningProtocol, ISelfCorrectionAgent
 *   registerAgenticEvaluation()   -> Wave C (Phase 3): Guardrails, Evaluators, IIterativeRefiner
 *   registerAgenticPlanning()     -> Wave D (Phase 4): ITaskPrioritizer, IEvolutionEngine
 *   registerAgenticChains()       -> Wave E (Phase 5): IPromptChainExecutor, IDeepResearchService
 *   registerAgenticInterAgent()   -> Wave F (Phase 6): IMcpToolConsumer, IA2ATaskRunner
 *   registerAgenticAdvanced()     -> Wave G (Phase 7): ICostAwareModelSelector, IReviewerPanel
 *   registerAgenticCrossCutting() -> Wave H (all phases): Cross-cutting concerns
 *   registerAgenticSingularity()  -> Wave I (Phase 8): IPqcCryptoProvider, IFormalProofEngine
 *
 * @see PLANS/implementation-phases/00_MASTER_PLAN.md -> Master deployment plan
 * @see PLANS/extraction-reports/FINAL_MASTER_EXTRACTION_REPORT.md -> 48 patterns + 12 gap
 */

import { container } from '../../../core/di/container';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import type { IToolExecutionPolicy } from '../../../domain/security/tool-execution-policy.interface';

// Wave A
import { LlmJudgeAdapter } from '../../evaluation/LlmJudgeAdapter';
import { ReflectionLoopAdapter } from '../../reasoning/ReflectionLoopAdapter';
import { PromptClassifierAdapter } from '../../routing/PromptClassifierAdapter';
// Wave B
import { StructuredReasoningAdapter } from '../../reasoning/StructuredReasoningAdapter';
import { SelfCorrectionAgentAdapter } from '../../reasoning/SelfCorrectionAgentAdapter';
import { InMemoryCoTScratchpad } from '../../reasoning/InMemoryCoTScratchpad';
import type { IEventStore } from '../../../domain/events/event-store.interface';
// Wave C
import { GoalEvaluatorAdapter } from '../../evaluation/GoalEvaluatorAdapter';
import { ResponseEvaluatorAdapter } from '../../evaluation/ResponseEvaluatorAdapter';
import { InputGuardrailPipelineAdapter } from '../../guardrails/InputGuardrailPipelineAdapter';
import { OutputGuardrailPipelineAdapter } from '../../guardrails/OutputGuardrailPipelineAdapter';
import { IterativeRefinerAdapter } from '../../evaluation/IterativeRefinerAdapter';
// Wave D
import { TaskPrioritizerAdapter } from '../../scheduling/TaskPrioritizerAdapter';
import { EvolutionEngineAdapter } from '../../exploration/EvolutionEngineAdapter';
import { FitnessEvaluatorAdapter } from '../../exploration/FitnessEvaluatorAdapter';
// Wave E
import { PromptChainExecutorAdapter } from '../../chains/PromptChainExecutorAdapter';
import { DeepResearchAdapter } from '../../research/DeepResearchAdapter';
import { CitationExtractorAdapter } from '../../research/CitationExtractorAdapter';
// Wave F
import { McpToolConsumerAdapter } from '../../mcp/McpToolConsumerAdapter';
import { A2ATaskRunnerAdapter } from '../../a2a/A2ATaskRunnerAdapter';
import { A2AStreamTransportAdapter } from '../../a2a/A2AStreamTransportAdapter';
import { SsrfDnsGuard } from '../../security/SsrfDnsGuard';
import {
  HttpA2AX402SettlementAdapter,
  InMemoryA2AX402NonceStore,
  InMemoryA2AX402PaymentRepository,
  ProfiledA2AX402MerchantPolicy,
} from '../../a2a/A2AX402PaymentAdapters';
import { InMemoryA2AX402CommerceMeter } from '../../a2a/A2AX402CommerceMeter';
import { AgentDialogueLoopAdapter } from '../../mas/AgentDialogueLoopAdapter';
// Wave G
import { CostAwareModelSelectorAdapter } from '../../routing/CostAwareModelSelectorAdapter';
import { ReviewerPanelAdapter } from '../../evaluation/ReviewerPanelAdapter';
import { ResearchLabAdapter } from '../../exploration/ResearchLabAdapter';
import { ResearchAgentStateAdapter } from '../../exploration/ResearchAgentStateAdapter';
// Wave H
import { AgentBudgetAdapter } from '../../execution/AgentBudgetAdapter';
import { RecoveryStrategyAdapter } from '../../execution/RecoveryStrategyAdapter';
import { CheckpointableFlowAdapter } from '../../execution/CheckpointableFlowAdapter';
import { AutonomyLevelAdapter } from '../../security/AutonomyLevelAdapter';
import { UserFeedbackCollectorAdapter } from '../../feedback/UserFeedbackCollectorAdapter';
import { VotingAggregatorAdapter } from '../../evaluation/VotingAggregatorAdapter';
import { ConcurrencyLimiterAdapter } from '../../execution/ConcurrencyLimiterAdapter';
import { ToolResultSummarizerAdapter } from '../../agents/ToolResultSummarizerAdapter';
import {
  RequireA2AX402PaymentService,
  SubmitA2AX402PaymentService,
} from '../../../application/services/a2a/A2AX402PaymentService';
// Wave I
import { PQCAuthorizationGuard } from '../../a2a/PQCAuthorizationGuard';
import { FormalProverAdapter } from '../../evaluation/FormalProverAdapter';
// OpenClaw V3/V4
import { ContextWindowGuardAdapter } from '../../agents/ContextWindowGuardAdapter';
import { ToolLoopDetectorAdapter } from '../../agents/ToolLoopDetectorAdapter';
import { ToolResultTruncatorAdapter } from '../../agents/ToolResultTruncatorAdapter';
import { ContextPrunerAdapter } from '../../agents/ContextPrunerAdapter';

const log = getBootstrapLogger('agentic');

// -----------------------------------------------------------------------------
// Wave A -> Foundation (Phase 1): ILlmJudge, IReflectionLoop, IPromptClassifier
// Critical path: unlocks 80% of dependent patterns
// -----------------------------------------------------------------------------

export function registerAgenticFoundation(): void {
  // --- ILlmJudge: Hub interface used by 6 consumers (Ch.19+11+17+18+16+20) ---
  container.register(DI_TOKENS.ILlmJudge, (c) => {
    return new LlmJudgeAdapter(
      c.resolve(DI_TOKENS.LLMAdapterFactory),
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.IEventStore),
    );
  }, { lifecycle: 'singleton' });

  // --- IReflectionLoop: Iterative generate->reflect->refine (Ch.4+17) ---
  container.register(DI_TOKENS.IReflectionLoop, (c) => {
    return new ReflectionLoopAdapter(
      c.resolve(DI_TOKENS.LLMAdapterFactory),
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.IEventStore),
      c.resolve(DI_TOKENS.ILlmJudge),
    );
  }, { lifecycle: 'singleton' });

  // --- IPromptClassifier: Complexity routing (Ch.2+16) ---
  container.register(DI_TOKENS.IPromptClassifier, (c) => {
    return new PromptClassifierAdapter(
      c.resolve(DI_TOKENS.LLMAdapterFactory),
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.IEventStore),
    );
  }, { lifecycle: 'singleton' });

  log.info('Agentic Foundation (Wave A) -> 3 services registered', {
    tokens: ['ILlmJudge', 'IReflectionLoop', 'IPromptClassifier'],
  });
}

// -----------------------------------------------------------------------------
// Wave B -> Reasoning (Phase 2): IStructuredReasoningProtocol, ISelfCorrectionAgent
// -----------------------------------------------------------------------------

export function registerAgenticReasoning(): void {
  if (!container.isRegistered(DI_TOKENS.ICoTScratchpad)) {
    container.register(
      DI_TOKENS.ICoTScratchpad,
      (c) =>
        new InMemoryCoTScratchpad(
          undefined,
          undefined,
          c.isRegistered(DI_TOKENS.IEventStore)
            ? c.resolve<IEventStore>(DI_TOKENS.IEventStore)
            : undefined,
        ),
      {
        lifecycle: 'singleton',
        tags: ['reasoning', 'cot', 'scratchpad'],
        description: 'In-memory Chain-of-Thought scratchpad for StructuredReasoningAdapter',
      },
    );
  }

  container.register(DI_TOKENS.IStructuredReasoningProtocol, (c) => {
    return new StructuredReasoningAdapter(
      c.resolve(DI_TOKENS.LLMAdapterFactory),
      c.resolve(DI_TOKENS.ICoTScratchpad),
      c.resolve(DI_TOKENS.ILlmJudge),
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.IEventStore),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.ISelfCorrectionAgent, (c) => {
    return new SelfCorrectionAgentAdapter(
      c.resolve(DI_TOKENS.LLMAdapterFactory),
      c.resolve(DI_TOKENS.IReflectionLoop),
      c.resolve(DI_TOKENS.ILlmJudge),
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.IEventStore),
    );
  }, { lifecycle: 'singleton' });

  log.info('Agentic Reasoning (Wave B) -> ICoTScratchpad + 2 services registered');
}

// -----------------------------------------------------------------------------
// Wave C -> Evaluation & Safety (Phase 3)
// -----------------------------------------------------------------------------

export function registerAgenticEvaluation(): void {
  if (container.isRegistered(DI_TOKENS.IGoalEvaluator)) {
    return;
  }
  container.register(DI_TOKENS.IGoalEvaluator, (c) => {
    return new GoalEvaluatorAdapter(
      c.resolve(DI_TOKENS.ILlmJudge),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IResponseEvaluator, (c) => {
    return new ResponseEvaluatorAdapter(
      c.resolve(DI_TOKENS.ILlmJudge),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IInputGuardrailPipeline, (c) => {
    return new InputGuardrailPipelineAdapter(
      c.resolve(DI_TOKENS.IPromptInjectionScanner),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IOutputGuardrailPipeline, (c) => {
    return new OutputGuardrailPipelineAdapter(
      c.resolve(DI_TOKENS.IOutputRail),
      c.resolve(DI_TOKENS.ILlmJudge),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IIterativeRefiner, (c) => {
    return new IterativeRefinerAdapter(
      c.resolve(DI_TOKENS.IReflectionLoop),
      c.resolve(DI_TOKENS.IGoalEvaluator),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  log.info('Agentic Evaluation & Safety (Wave C) -> 5 services registered');
}

// -----------------------------------------------------------------------------
// Wave D -> Planning & Scheduling (Phase 4)
// -----------------------------------------------------------------------------

export function registerAgenticPlanning(): void {
  if (container.isRegistered(DI_TOKENS.ITaskPrioritizer)) {
    return;
  }
  container.register(DI_TOKENS.ITaskPrioritizer, (c) => {
    return new TaskPrioritizerAdapter(
      c.resolve(DI_TOKENS.ILlmJudge),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IEvolutionEngine, (c) => {
    return new EvolutionEngineAdapter(
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.LLMAdapterFactory), // FIX-R06: LLM-based mutation
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IFitnessEvaluator, (c) => {
    return new FitnessEvaluatorAdapter(
      c.resolve(DI_TOKENS.ILlmJudge),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  log.info('Agentic Planning (Wave D) -> 3 services registered');
}

// -----------------------------------------------------------------------------
// Wave E -> Chains & Pipelines (Phase 5)
// -----------------------------------------------------------------------------

export function registerAgenticChains(): void {
  if (container.isRegistered(DI_TOKENS.IPromptChainExecutor)) {
    return;
  }
  container.register(DI_TOKENS.IPromptChainExecutor, (c) => {
    return new PromptChainExecutorAdapter(
      c.resolve(DI_TOKENS.LLMAdapterFactory),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IDeepResearchService, (c) => {
    return new DeepResearchAdapter(
      c.resolve(DI_TOKENS.LLMAdapterFactory),
      c.resolve(DI_TOKENS.IResearchService),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.ICitationExtractor, (c) => {
    return new CitationExtractorAdapter(
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  log.info('Agentic Chains (Wave E) -> 3 services registered');
}

// -----------------------------------------------------------------------------
// Wave F -> Inter-Agent Communication (Phase 6)
// -----------------------------------------------------------------------------

export function registerAgenticInterAgent(): void {
  if (container.isRegistered(DI_TOKENS.IMcpToolConsumer)) {
    return;
  }
  container.register(DI_TOKENS.IMcpToolConsumer, (c) => {
    let toolPolicy: IToolExecutionPolicy | undefined;
    try {
      if (container.isRegistered(DI_TOKENS.IToolExecutionPolicy)) {
        toolPolicy = c.resolve<IToolExecutionPolicy>(DI_TOKENS.IToolExecutionPolicy);
      }
    } catch { /* graceful degradation */ }
    return new McpToolConsumerAdapter(
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.IConfigLoader),
      toolPolicy,
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IA2ATaskRunner, (c) => {
    const guard = c.isRegistered(DI_TOKENS.ISsrfDnsGuard)
      ? c.resolve<SsrfDnsGuard>(DI_TOKENS.ISsrfDnsGuard)
      : undefined;
    return new A2ATaskRunnerAdapter(
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.IConfigLoader),
      guard,
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IA2AStreamTransport, (c) => {
    const guard = c.isRegistered(DI_TOKENS.ISsrfDnsGuard)
      ? c.resolve<SsrfDnsGuard>(DI_TOKENS.ISsrfDnsGuard)
      : undefined;
    return new A2AStreamTransportAdapter(
      c.resolve(DI_TOKENS.IStructuredLogger),
      guard,
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IA2AX402MerchantPolicy, () => {
    return new ProfiledA2AX402MerchantPolicy();
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IA2AX402PaymentRepository, () => {
    return new InMemoryA2AX402PaymentRepository();
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IA2AX402NonceStore, () => {
    return new InMemoryA2AX402NonceStore();
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IA2AX402SettlementPort, (c) => {
    return new HttpA2AX402SettlementAdapter(
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.IConfigLoader),
      c.resolve(DI_TOKENS.ISsrfDnsGuard),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IA2AX402CommerceMeter, () => {
    return new InMemoryA2AX402CommerceMeter();
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.RequireA2AX402PaymentService, (c) => {
    return new RequireA2AX402PaymentService(
      c.resolve(DI_TOKENS.IA2AX402MerchantPolicy),
      c.resolve(DI_TOKENS.IA2AX402PaymentRepository),
      c.resolve(DI_TOKENS.IEventStore),
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.IA2AX402CommerceMeter),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.SubmitA2AX402PaymentService, (c) => {
    return new SubmitA2AX402PaymentService(
      c.resolve(DI_TOKENS.IA2AX402PaymentRepository),
      c.resolve(DI_TOKENS.IA2AX402MerchantPolicy),
      c.resolve(DI_TOKENS.IA2AX402NonceStore),
      c.resolve(DI_TOKENS.IA2AX402SettlementPort),
      c.resolve(DI_TOKENS.IEventStore),
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.IA2AX402CommerceMeter),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IAgentDialogueLoop, (c) => {
    return new AgentDialogueLoopAdapter(
      c.resolve(DI_TOKENS.LLMAdapterFactory),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  log.info('Agentic Inter-Agent (Wave F) -> 11 services registered');
}

// -----------------------------------------------------------------------------
// Wave G -> Advanced Patterns (Phase 7)
// -----------------------------------------------------------------------------

export function registerAgenticAdvanced(): void {
  if (container.isRegistered(DI_TOKENS.ICostAwareModelSelector)) {
    return;
  }
  container.register(DI_TOKENS.ICostAwareModelSelector, (c) => {
    return new CostAwareModelSelectorAdapter(
      c.resolve(DI_TOKENS.IPromptClassifier),
      c.resolve(DI_TOKENS.ITokenomicsController),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IReviewerPanel, (c) => {
    return new ReviewerPanelAdapter(
      c.resolve(DI_TOKENS.LLMAdapterFactory),
      c.resolve(DI_TOKENS.ILlmJudge),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IResearchLabOrchestrator, (c) => {
    return new ResearchLabAdapter(
      c.resolve(DI_TOKENS.LLMAdapterFactory),
      c.resolve(DI_TOKENS.IReviewerPanel),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IResearchAgentState, (c) => {
    return new ResearchAgentStateAdapter(
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  log.info('Agentic Advanced (Wave G) -> 4 services registered');
}

// -----------------------------------------------------------------------------
// Wave H -> Cross-Cutting (Gap Analysis, all phases)
// -----------------------------------------------------------------------------

export function registerAgenticCrossCutting(): void {
  if (container.isRegistered(DI_TOKENS.IAgentBudget)) {
    return;
  }
  container.register(DI_TOKENS.IAgentBudget, (c) => {
    return new AgentBudgetAdapter(
      c.resolve(DI_TOKENS.ITokenomicsController),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'transient' }); // transient: one budget per flow

  container.register(DI_TOKENS.IRecoveryStrategy, (c) => {
    return new RecoveryStrategyAdapter(
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.ICheckpointableFlow, (c) => {
    return new CheckpointableFlowAdapter(
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.isRegistered(DI_TOKENS.IAgentEventStream)
        ? c.resolve(DI_TOKENS.IAgentEventStream)
        : undefined,
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IAutonomyLevel, (c) => {
    return new AutonomyLevelAdapter(
      c.resolve(DI_TOKENS.IConfigLoader),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IUserFeedbackCollector, (c) => {
    return new UserFeedbackCollectorAdapter(
      c.resolve(DI_TOKENS.IEventStore),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IVotingAggregator, (c) => {
    return new VotingAggregatorAdapter(
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IConcurrencyLimiter, (c) => {
    return new ConcurrencyLimiterAdapter(
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  container.register(DI_TOKENS.IToolResultSummarizer, (c) => {
    return new ToolResultSummarizerAdapter(
      c.resolve(DI_TOKENS.LLMAdapterFactory),
      c.resolve(DI_TOKENS.IStructuredLogger),
    );
  }, { lifecycle: 'singleton' });

  log.info('Agentic Cross-Cutting (Wave H) -> 8 services registered');
}

// -----------------------------------------------------------------------------
// Wave I -> Singularity (Phase 8): PQC Federation Guard + Formal Proof Engine
// @see 61_PHASE_8_SINGULARITY_AUDITOR.md -> SOTA March 2026
// -----------------------------------------------------------------------------

export function registerAgenticSingularity(): void {
  // --- IPqcCryptoProvider: Post-Quantum crypto-agile provider (ML-KEM, ML-DSA) ---
  // Note: PQCAuthorizationGuard wraps IA2AAuthorizationGuard with PQC verification.
  // The PQC guard itself is wired separately (see a2a bootstrap) since it decorates
  // the classical guard. Here we register the raw PQC crypto provider.
  container.register(DI_TOKENS.IPqcCryptoProvider, (c) => {
    // PQC crypto provider stub - in production, this would be backed by
    // liboqs or pqcrypto-wasm. For now, the PQCAuthorizationGuard itself
    // serves as the integration point for PQC-signed federation manifests.
    // The provider interface is crypto-agile: ML-KEM -> HQC, ML-DSA -> SLH-DSA.
    const logger = c.resolve<{ info: (msg: string, data: Record<string, unknown>) => void }>(DI_TOKENS.IStructuredLogger);
    logger.info('IPqcCryptoProvider: stub registered (awaiting liboqs WASM binding)', {});
    return {
      generateKeyPair: async () => { throw new Error('PQC provider not yet configured - install liboqs-node'); },
      kemEncapsulate: async () => { throw new Error('PQC provider not yet configured'); },
      kemDecapsulate: async () => { throw new Error('PQC provider not yet configured'); },
      sign: async () => { throw new Error('PQC provider not yet configured'); },
      verify: async () => false,
      signFederationManifest: async () => { throw new Error('PQC provider not yet configured'); },
      verifyFederationManifest: async () => false,
      getSupportedAlgorithms: () => ({
        kem: ['ML-KEM-512', 'ML-KEM-768', 'ML-KEM-1024'] as const,
        signature: ['ML-DSA-44', 'ML-DSA-65', 'ML-DSA-87'] as const,
      }),
    };
  }, { lifecycle: 'singleton' });

  // --- IFormalProofEngine: Lean 4 / Coq formal verification (Zero-Trust Gate) ---
  container.register(DI_TOKENS.IFormalProofEngine, (c) => {
    return new FormalProverAdapter(
      c.resolve(DI_TOKENS.LLMAdapterFactory),
      c.resolve(DI_TOKENS.IStructuredLogger),
      c.resolve(DI_TOKENS.IEventStore),
    );
  }, { lifecycle: 'singleton' });

  log.info('Agentic Singularity (Wave I) -> 2 services registered', {
    tokens: ['IPqcCryptoProvider', 'IFormalProofEngine'],
  });
}

// -----------------------------------------------------------------------------
// OpenClaw Extraction V3 -> Context Window Guard
// -----------------------------------------------------------------------------

/**
 * Register IContextWindowGuard (OpenClaw Extraction V3)
 * Evaluates context window limits and generates warn/block decisions.
 */
export function registerContextWindowGuard(): void {
  if (container.isRegistered(DI_TOKENS.IContextWindowGuard)) {
    return;
  }
  container.register(
    DI_TOKENS.IContextWindowGuard,
    () => new ContextWindowGuardAdapter(),
    {
      lifecycle: 'singleton',
      tags: ['agents', 'context-window', 'guard', 'openclaw-v3'],
      description: 'Context window guard with model-aware limits (OpenClaw Extraction V3)',
    },
  );
  log.info('IContextWindowGuard registered (OpenClaw Extraction V3)');
}

// -----------------------------------------------------------------------------
// OpenClaw Extraction V4 -> Sprint 2 (Agentic Safety)
// -----------------------------------------------------------------------------

/**
 * Register IToolLoopDetector (OpenClaw Extraction V4)
 * Detects repetitive tool call loops using 4 detection strategies.
 */
export function registerToolLoopDetector(): void {
  if (container.isRegistered(DI_TOKENS.IToolLoopDetector)) {
    return;
  }
  container.register(
    DI_TOKENS.IToolLoopDetector,
    () => new ToolLoopDetectorAdapter(),
    {
      lifecycle: 'singleton',
      tags: ['agents', 'loop-detection', 'safety', 'openclaw-v4'],
      description: 'Tool loop detector with 4 strategies (OpenClaw Extraction V4)',
    },
  );
  log.info('IToolLoopDetector registered (OpenClaw Extraction V4)');
}

/**
 * Register IToolResultTruncator (OpenClaw Extraction V4)
 * Smart head+tail truncation of oversized tool results.
 */
export function registerToolResultTruncator(): void {
  if (container.isRegistered(DI_TOKENS.IToolResultTruncator)) {
    return;
  }
  container.register(
    DI_TOKENS.IToolResultTruncator,
    () => new ToolResultTruncatorAdapter(),
    {
      lifecycle: 'singleton',
      tags: ['agents', 'truncation', 'context-window', 'openclaw-v4'],
      description: 'Tool result truncator with head+tail strategy (OpenClaw Extraction V4)',
    },
  );
  log.info('IToolResultTruncator registered (OpenClaw Extraction V4)');
}

/**
 * Register IContextPruner (OpenClaw Extraction V4)
 * Two-phase context pruning: soft trim then hard clear.
 */
export function registerContextPruner(): void {
  if (container.isRegistered(DI_TOKENS.IContextPruner)) {
    return;
  }
  container.register(
    DI_TOKENS.IContextPruner,
    () => new ContextPrunerAdapter(),
    {
      lifecycle: 'singleton',
      tags: ['agents', 'context-pruning', 'context-window', 'openclaw-v4'],
      description: 'Context pruner with soft trim + hard clear (OpenClaw Extraction V4)',
    },
  );
  log.info('IContextPruner registered (OpenClaw Extraction V4)');
}

