/**
 * SOTA 2026 Multi-Agent DI module.
 *
 * Registers the three SOTA 2026 innovations:
 *   1. IAgentComputerInterface — ACI (SWE-agent / OpenHands pattern)
 *   2. ICriticFeedbackService — Critic Feedback Loop (Eco-Evolve pattern)
 *   3. IContextCompactor — Context Auto-Compaction (ReDel / Deep Agent pattern)
 *
 * Wave 3 CC contracts:
 *   4. IStallDetector — CC-009 sub-component (progress stall detection)
 *   5. IAutonomousExecutionLoop — CC-009 (bounded iterative agent execution)
 *   6. IBatchToolExecutor — CC-005 (pipelined multi-call execution)
 *   7. ILlmQualityMonitor — CC-010 (runtime quality variance detection)
 *
 * Wave 4 CC contracts:
 *   8. IResearchPlanImplementWorkflow — CC-003 RPI Workflow
 *   9. IDeferredToolRegistry — CC-007 Deferred Tool Loading
 *  10. ISkillDiscoveryService — CC-011 Skill Discovery in Monorepos
 *
 * Wave 5 CC contracts (Horizon 4-5):
 *  11. ISharedTaskList — CC-013 Agent Teams (cross-agent task coordination)
 *  12. ISemanticToolFilter — CC-006 Dynamic Filtering (query-aware relevance)
 *  13. IMcpScopeGuard — T16 MCP Scope Model (project/user/subagent access)
 *  14. INetworkSandbox — T31 Sandbox Isolation (network egress control)
 *
 * Wave 6 CC contracts (Deep Audit Re-Extraction):
 *  15. IDocumentDriftDetector — CC-015 Self-Maintaining Documentation (drift detection + rule evolution)
 *
 * Wave 7 CC contracts (RE-VERIFY Sprint 4):
 *  16. IScheduledTaskRunner — CC-016 Scheduled Task Runner (cron-based recurring agent execution)
 *
 * Wave 8 CC contracts (Anthropic Agent Skills + Org Extraction):
 *  17. IProgressiveDisclosureLoader — AS-001 Progressive Disclosure (3-level content loading)
 *  18. ISkillEvaluationRunner — AS-002 Skill Evaluation (evaluation-driven development)
 *  19. IInputSanitizationPipeline — AS-043 Input Sanitization Pipeline (7-stage composable sanitization)
 *
 * Pillar 3 LATS & Bayesian Consensus (Horizon 5):
 *  16. ITreeOfThoughts — LATS tree search (Zhou et al. 2024)
 *  17. IMultiJudgeEvaluator — Bayesian multi-judge consensus
 *  17b. IMultiModelConsensus — CC-002 Cross-Model QA facade over IMultiJudgeEvaluator
 *
 * Pillar 4 PQC Cryptographic Provenance (Horizon 5):
 *  18. IPqcCryptoProvider — Post-quantum crypto adapter (ML-DSA, SLH-DSA, ML-KEM)
 *  19. IPqcEventChain — PQC event chain signing + chain verification
 *
 * Pillar 5 Cognitive CI/CD Quality Gates (Horizon 5):
 *  20. IAutoFixAnalyzer — AST failure analysis + auto-fix generation for P1-P3 errors
 *
 * @see docs/mcp_and_testing_audit/31-advanced-multi-agent-extraction.md
 * @see src/domain/aci/IAgentComputerInterface.ts
 * @see src/domain/audit/ICriticFeedbackService.ts
 * @see src/domain/context/context-compactor.interface.ts
 * @see src/domain/agents/IAutonomousExecutionLoop.ts
 * @see src/domain/agents/IBatchToolExecutor.ts
 * @see src/domain/ai/ILlmQualityMonitor.ts
 * @see src/domain/agents/IResearchPlanImplementWorkflow.ts
 * @see src/domain/agents/IDeferredToolRegistry.ts
 * @see src/domain/agents/ISkillDiscoveryService.ts
 */

import { container } from '../../../core/di/container';
import { DI_TOKENS, DEPRECATED_TOKENS } from '../../../core/di/DI_TOKENS';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import { AgenticRuntimeInterface } from '../../aci/AgenticRuntimeInterface';
import { CriticFeedbackService } from '../../../application/services/audit/CriticFeedbackService';
import { ContextCompactorService } from '../../../application/services/context/ContextCompactorService';
import type { IAgentComputerInterface } from '../../../domain/aci/IAgentComputerInterface';
import type { ICriticFeedbackService } from '../../../domain/audit/ICriticFeedbackService';
import type { IContextCompactor } from '../../../domain/context/context-compactor.interface';
import type { IStallDetector } from '../../../domain/agents/IAutonomousExecutionLoop';
import type { IAutonomousExecutionLoop } from '../../../domain/agents/IAutonomousExecutionLoop';
import type { IBatchToolExecutor } from '../../../domain/agents/IBatchToolExecutor';
import type { ILlmQualityMonitor } from '../../../domain/ai/ILlmQualityMonitor';
import type { IToolExecutionPolicy } from '../../../domain/security/tool-execution-policy.interface';
import type { IResearchPlanImplementWorkflow } from '../../../domain/agents/IResearchPlanImplementWorkflow';
import type { IDeferredToolRegistry } from '../../../domain/agents/IDeferredToolRegistry';
import type { ISkillDiscoveryService } from '../../../domain/agents/ISkillDiscoveryService';
import type { ISharedTaskList } from '../../../domain/agents/ISharedTaskList';
import type { ISemanticToolFilter } from '../../../domain/agents/ISemanticToolFilter';
import type { IWorkspaceIsolation } from '../../../domain/agents/IWorkspaceIsolation';
import type { IMcpScopeGuard } from '../../../domain/mcp/IMcpScopeGuard';
import type { INetworkSandbox } from '../../../domain/security/INetworkSandbox';
import type { IDocumentDriftDetector } from '../../../domain/agents/IDocumentDriftDetector';
import type { ITreeOfThoughts } from '../../../domain/ai/ITreeOfThoughts';
import type { IMultiJudgeEvaluator } from '../../../domain/evaluation/IMultiJudgeEvaluator';
import type { IMultiModelConsensus } from '../../../domain/evaluation/IMultiModelConsensus';
import type { IPqcCryptoProvider } from '../../../domain/security/pq-crypto.interface';
import type { IPqcEventChain } from '../../../domain/events/IPqcEventChain';
import type { ILessonStore } from '../../../domain/memory/ILessonStore';
import type { IEvaluationMemory } from '../../../domain/memory/IEvaluationMemory';
import type { ISuccessLedgerStore } from '../../../domain/memory/ISuccessLedgerStore';
import type { ITrajectoryStore } from '../../../domain/memory/ITrajectoryStore';
import { StallDetectorAdapter } from '../../agents/StallDetectorAdapter';
import { AutonomousLoopAdapter } from '../../agents/AutonomousLoopAdapter';
import { BatchToolExecutorAdapter } from '../../agents/BatchToolExecutorAdapter';
import { LlmQualityMonitorAdapter } from '../../ai/LlmQualityMonitorAdapter';
import { RpiWorkflowAdapter } from '../../agents/RpiWorkflowAdapter';
import { DeferredToolRegistryAdapter } from '../../tools/DeferredToolRegistryAdapter';
import { SkillDiscoveryAdapter } from '../../skills/SkillDiscoveryAdapter';
import { SharedTaskListAdapter } from '../../agents/SharedTaskListAdapter';
import { SemanticToolFilterAdapter } from '../../agents/SemanticToolFilterAdapter';
import { WorkspaceIsolationWorktreeAdapter } from '../../agents/workspace/WorkspaceIsolationWorktreeAdapter';
import { McpScopeGuardAdapter } from '../../mcp/scope/McpScopeGuardAdapter';
import { NetworkSandboxAdapter } from '../../security/NetworkSandboxAdapter';
import { DocumentDriftDetectorAdapter } from '../../agents/DocumentDriftDetectorAdapter';
import type { IScheduledTaskRunner } from '../../../domain/agents/IScheduledTaskRunner';
import { ScheduledTaskRunnerAdapter } from '../../agents/ScheduledTaskRunnerAdapter';
import type { IProgressiveDisclosureLoader } from '../../../domain/agents/IProgressiveDisclosureLoader';
import { ProgressiveDisclosureLoaderAdapter } from '../../agents/ProgressiveDisclosureLoaderAdapter';
import type { ISkillEvaluationRunner } from '../../../domain/agents/ISkillEvaluationRunner';
import { SkillEvaluationRunnerAdapter } from '../../agents/SkillEvaluationRunnerAdapter';
import type { IInputSanitizationPipeline } from '../../../domain/security/IInputSanitizationPipeline';
import { InputSanitizationPipelineAdapter } from '../../security/InputSanitizationPipelineAdapter';
import type { IAgentEventStream } from '../../../domain/agents/IAgentEventStream';
import { AgentEventStreamAdapter } from '../../agents/AgentEventStreamAdapter';
import type { ILlmTestHarness } from '../../../domain/ai/ILlmTestHarness';
import { LlmTestHarnessAdapter } from '../../ai/LlmTestHarnessAdapter';
import type { IExecutionProvenanceTracer } from '../../../domain/agents/IExecutionProvenanceTracer';
import { ExecutionProvenanceTracerAdapter } from '../../agents/ExecutionProvenanceTracerAdapter';
import { LatsEngine } from '../../ai/tree-of-thoughts/LatsEngine';
import { MultiJudgeEvalAdapter } from '../../ai/consensus/MultiJudgeEvalAdapter';
import { MultiModelConsensusFacadeAdapter } from '../../evaluation/MultiModelConsensusFacadeAdapter';
import { PqcCryptoAdapter } from '../../crypto/PqcCryptoAdapter';
import { PqcEventSigningMiddleware } from '../../events/PqcEventSigningMiddleware';
import type { IAutoFixAnalyzer } from '../../../domain/ci/IAutoFixAnalyzer';
import { AutoFixAnalyzerAdapter } from '../../ci/AutoFixAnalyzerAdapter';
import type { IDriftAwarePromptEnricher } from '../../../domain/agents/IDriftAwarePromptEnricher';
import { DriftAwarePromptEnricherAdapter } from '../../agents/DriftAwarePromptEnricherAdapter';
import type { IUpdateSSOTWorkflow } from '../../../domain/agents/IUpdateSSOTWorkflow';
import { UpdateSSOTWorkflowAdapter } from '../../agents/UpdateSSOTWorkflowAdapter';
import type { ICbvShadowAuditor } from '../../../domain/evaluation/ICbvShadowAuditor';
import { CbvShadowAuditorAdapter } from '../../evaluation/CbvShadowAuditorAdapter';
import type { IS2iLessonExtractor } from '../../../domain/agents/IS2iLessonExtractor';
import { S2iLessonExtractorAdapter } from '../../agents/S2iLessonExtractorAdapter';
import type { ITeeAttestationVerifier } from '../../../domain/security/ITeeAttestationVerifier';
import { TeeAttestationVerifierAdapter } from '../../security/TeeAttestationVerifierAdapter';
import type { ICognitiveLoadGovernor } from '../../../domain/agents/ICognitiveLoadGovernor';
import { CognitiveLoadGovernorAdapter } from '../../agents/CognitiveLoadGovernorAdapter';
import type { IIntentMisalignmentDetector } from '../../../domain/security/IIntentMisalignmentDetector';
import { IntentMisalignmentDetectorAdapter } from '../../security/IntentMisalignmentDetectorAdapter';
import type { IWisdomConsolidator } from '../../../domain/memory/IWisdomConsolidator';
import { WisdomConsolidatorAdapter } from '../../memory/WisdomConsolidatorAdapter';
import type { IDynamicCognitiveBudget } from '../../../domain/agents/IDynamicCognitiveBudget';
import { DynamicCognitiveBudgetAdapter } from '../../agents/DynamicCognitiveBudgetAdapter';
import type { IIntentGraphAnalyzer } from '../../../domain/security/IIntentGraphAnalyzer';
import { IntentGraphAnalyzerAdapter } from '../../security/IntentGraphAnalyzerAdapter';
import type { IContrastiveLessonLearner } from '../../../domain/memory/IContrastiveLessonLearner';
import { ContrastiveLessonLearnerAdapter } from '../../memory/ContrastiveLessonLearnerAdapter';
import type { ICrossModelShadowConsensus } from '../../../domain/evaluation/ICrossModelShadowConsensus';
import { CrossModelShadowConsensusAdapter } from '../../evaluation/CrossModelShadowConsensusAdapter';
import type { IAttestedIntentLifecycle } from '../../../domain/security/IAttestedIntentLifecycle';
import { AttestedIntentLifecycleAdapter } from '../../security/AttestedIntentLifecycleAdapter';
import type { IHardwareEnclaveProvider } from '../../../domain/security/IHardwareEnclaveProvider';
import { SimulatedHardwareEnclaveAdapter } from '../../security/SimulatedHardwareEnclaveAdapter';
import type { ISemanticProximityProvider } from '../../../domain/security/ISemanticProximityProvider';
import { SimulatedSemanticProximityAdapter } from '../../security/SimulatedSemanticProximityAdapter';

const log = getBootstrapLogger('sota-2026-multiagent');

/** Ports with no production consumer. Off unless ENABLE_EXPERIMENTAL_PORTS=true. */
function experimentalPortsEnabled(): boolean {
  return process.env['ENABLE_EXPERIMENTAL_PORTS'] === 'true';
}

export function registerSota2026MultiAgentModule(): void {
  if (container.isRegistered(DI_TOKENS.IContextCompactor)) return;

  log.info('Registering SOTA 2026 Multi-Agent services (Critic, Compactor; ACI if experimental)');

  // --- Idea 1: Agent-Computer Interface (no production consumer) ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.IAgentComputerInterface)) {
    container.register<IAgentComputerInterface>(DI_TOKENS.IAgentComputerInterface, () => {
      const logger = resolveLoggerOptional();
      return new AgenticRuntimeInterface(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['aci', 'agent', 'sota-2026', 'horizon-1'],
      description: 'ACI: AST navigation, sandbox tests, diff-patch for LLM agents (SWE-agent pattern)',
    });
  }

  // --- Idea 2: Critic Feedback Service ---
  container.register<ICriticFeedbackService>(DI_TOKENS.ICriticFeedbackService, () => {
    const logger = resolveLoggerOptional();

    // Build DI token map from DI_TOKENS constant
    const tokenEntries = new Map<string, string>();
    for (const [key, value] of Object.entries(DI_TOKENS)) {
      tokenEntries.set(key, value);
    }

    return new CriticFeedbackService(
      { entries: tokenEntries },
      { tokens: DEPRECATED_TOKENS },
      logger,
    );
  }, {
    lifecycle: 'singleton',
    tags: ['audit', 'critic', 'feedback', 'sota-2026', 'horizon-0'],
    description: 'Critic Feedback: proactive AST-enriched error analysis for Coder agent (Eco-Evolve pattern)',
  });

  // --- Idea 3: Context Compactor ---
  container.register<IContextCompactor>(DI_TOKENS.IContextCompactor, () => {
    const logger = resolveLoggerOptional();

    // Resolve optional summarizer (from HermesContextCompressor or IAuxiliaryLLMClient)
    let summarizer: { summarize(text: string, targetTokens: number): Promise<string> } | undefined;
    try {
      if (container.isRegistered(DI_TOKENS.IHermesContextCompressor)) {
        const compressor = container.resolve<{ compress(messages: unknown[], currentTokens: number): Promise<{ messages: unknown[] }> }>(DI_TOKENS.IHermesContextCompressor);
        // Adapt HermesContextCompressor to ISummarizer interface
        summarizer = {
          async summarize(text: string, targetTokens: number): Promise<string> {
            const messages = [{ role: 'user' as const, content: text }];
            const result = await compressor.compress(messages, targetTokens * 4);
            return result.messages.map((m: unknown) => (m as { content?: string }).content ?? '').join('\n');
          },
        };
      }
    } catch {
      // No summarizer available — will fall back to truncation strategies
    }

    return new ContextCompactorService(summarizer, logger);
  }, {
    lifecycle: 'singleton',
    tags: ['context', 'compactor', 'sota-2026', 'horizon-2'],
    description: 'Context Auto-Compaction: Information Crystal compression for MasterAgentFanout (ReDel pattern)',
  });

  log.info('SOTA 2026 core services registered (Critic, Compactor)');

  // --- CC-008: Workspace Isolation ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.IWorkspaceIsolation)) {
    container.register<IWorkspaceIsolation>(DI_TOKENS.IWorkspaceIsolation, () => {
      return new WorkspaceIsolationWorktreeAdapter({
        workspaceRoot: process.cwd(),
      });
    }, {
      lifecycle: 'singleton',
      tags: ['agent', 'workspace', 'isolation', 'wave-2', 'cc-008'],
      description: 'Concrete git worktree-based workspace isolation adapter',
    });
  }

  // ── Wave 3 CC contracts ───────────────────────────────────────

  // --- CC-009 sub: Stall Detector ---
  if (!container.isRegistered(DI_TOKENS.IStallDetector)) {
    container.register<IStallDetector>(DI_TOKENS.IStallDetector, () => {
      return new StallDetectorAdapter();
    }, {
      lifecycle: 'singleton',
      tags: ['agent', 'stall', 'detector', 'wave-3', 'cc-009'],
      description: 'CC-009 sub: Stateless stall detection for autonomous execution loops',
    });
  }

  // --- CC-009: Autonomous Execution Loop ---
  if (!container.isRegistered(DI_TOKENS.IAutonomousExecutionLoop)) {
    container.register<IAutonomousExecutionLoop>(DI_TOKENS.IAutonomousExecutionLoop, (c) => {
      const stallDetector = c.resolve<IStallDetector>(DI_TOKENS.IStallDetector);
      const logger = resolveLoggerOptional();
      const cognitiveLoadGovernor = c.isRegistered(DI_TOKENS.ICognitiveLoadGovernor)
        ? c.resolve<ICognitiveLoadGovernor>(DI_TOKENS.ICognitiveLoadGovernor)
        : undefined;
      const agentEventStream = c.isRegistered(DI_TOKENS.IAgentEventStream)
        ? c.resolve<IAgentEventStream>(DI_TOKENS.IAgentEventStream)
        : undefined;
      return new AutonomousLoopAdapter(stallDetector, logger, cognitiveLoadGovernor, agentEventStream);
    }, {
      lifecycle: 'singleton',
      tags: ['agent', 'autonomous', 'loop', 'wave-3', 'cc-009'],
      description: 'CC-009: Bounded iterative agent execution with stall detection',
    });
  }

  // --- CC-005: Batch Tool Executor ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.IBatchToolExecutor)) {
    container.register<IBatchToolExecutor>(DI_TOKENS.IBatchToolExecutor, () => {
      const logger = resolveLoggerOptional();
      // Resolve IToolExecutionPolicy for per-call security enforcement (FP-02 Phase 1)
      let toolPolicy: IToolExecutionPolicy | undefined;
      try {
        if (container.isRegistered(DI_TOKENS.IToolExecutionPolicy)) {
          toolPolicy = container.resolve<IToolExecutionPolicy>(DI_TOKENS.IToolExecutionPolicy);
        }
      } catch {
        // Graceful degradation — batch execution works without policy (allows all)
      }
      const tools = container.isRegistered(DI_TOKENS.IToolRegistry)
        ? container.resolve<import('../../../domain/agents/tools.interface').IToolRegistry>(DI_TOKENS.IToolRegistry)
        : undefined;
      return new BatchToolExecutorAdapter(logger, toolPolicy, tools);
    }, {
      lifecycle: 'singleton',
      tags: ['tool', 'batch', 'executor', 'wave-3', 'cc-005'],
      description: 'CC-005: Pipelined N-call tool execution with dependency graph + policy enforcement',
    });
  }

  // --- CC-010: LLM Quality Monitor ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.ILlmQualityMonitor)) {
    container.register<ILlmQualityMonitor>(DI_TOKENS.ILlmQualityMonitor, () => {
      const logger = resolveLoggerOptional();
      return new LlmQualityMonitorAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['ai', 'quality', 'monitor', 'wave-3', 'cc-010'],
      description: 'CC-010: Runtime LLM quality variance detection with sliding window',
    });
  }

  log.info('Wave 3 CC contracts registered (4 tokens: CC-009 sub, CC-009, CC-005, CC-010)');

  // ── Wave 4 CC contracts ───────────────────────────────────────

  // --- CC-003: Research-Plan-Implement Workflow ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.IResearchPlanImplementWorkflow)) {
    container.register<IResearchPlanImplementWorkflow>(DI_TOKENS.IResearchPlanImplementWorkflow, () => {
      const logger = resolveLoggerOptional();
      return new RpiWorkflowAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['agent', 'rpi', 'workflow', 'wave-4', 'cc-003'],
      description: 'CC-003: 3-phase Research→Plan→Implement workflow with validation gates',
    });
  }

  // --- CC-007: Deferred Tool Registry ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.IDeferredToolRegistry)) {
    container.register<IDeferredToolRegistry>(DI_TOKENS.IDeferredToolRegistry, () => {
      const logger = resolveLoggerOptional();
      let toolPolicy: IToolExecutionPolicy | undefined;
      try {
        if (container.isRegistered(DI_TOKENS.IToolExecutionPolicy)) {
          toolPolicy = container.resolve<IToolExecutionPolicy>(DI_TOKENS.IToolExecutionPolicy);
        }
      } catch { /* graceful degradation */ }
      return new DeferredToolRegistryAdapter(undefined, logger, toolPolicy);
    }, {
      lifecycle: 'singleton',
      tags: ['tool', 'deferred', 'registry', 'wave-4', 'cc-007'],
      description: 'CC-007: Deferred tool loading with manifests + policy enforcement (~85% token savings)',
    });
  }

  // --- CC-011: Skill Discovery Service ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.ISkillDiscoveryService)) {
    container.register<ISkillDiscoveryService>(DI_TOKENS.ISkillDiscoveryService, (c) => {
      // Resolve workspace root from DI config (Hard Rule #11), fallback for standalone
      let basePath: string;
      try {
        if (c.isRegistered(DI_TOKENS.IConfigLoader)) {
          const config = c.resolve<{ get<T>(key: string): T }>(DI_TOKENS.IConfigLoader);
          basePath = config.get<string>('basePath') ?? config.get<string>('workspaceRoot');
        } else {
          basePath = process.cwd();
        }
      } catch {
        basePath = process.cwd();
      }
      const logger = resolveLoggerOptional();
      return new SkillDiscoveryAdapter(basePath, logger);
    }, {
      lifecycle: 'singleton',
      tags: ['skill', 'discovery', 'monorepo', 'wave-4', 'cc-011'],
      description: 'CC-011: Monorepo-aware skill discovery with manifest-based lazy loading',
    });
  }

  if (experimentalPortsEnabled()) {
    log.info('Wave 4 CC contracts registered (3 tokens: CC-003, CC-007, CC-011)');
  }

  // ── Wave 5 CC contracts (Horizon 4-5) ─────────────────────────

  // --- CC-013: Agent Teams (Shared Task List) ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.ISharedTaskList)) {
    container.register<ISharedTaskList>(DI_TOKENS.ISharedTaskList, () => {
      const logger = resolveLoggerOptional();
      return new SharedTaskListAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['agent', 'team', 'shared-task', 'wave-5', 'cc-013'],
      description: 'CC-013: Cross-agent task coordination via event-sourced shared task list',
    });
  }

  // --- CC-006: Semantic Tool Filter ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.ISemanticToolFilter)) {
    container.register<ISemanticToolFilter>(DI_TOKENS.ISemanticToolFilter, () => {
      const logger = resolveLoggerOptional();
      return new SemanticToolFilterAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['agent', 'filter', 'semantic', 'wave-5', 'cc-006'],
      description: 'CC-006: Query-aware semantic tool result filtering (~24% token savings)',
    });
  }

  // --- T16: MCP Scope Guard ---
  if (!container.isRegistered(DI_TOKENS.IMcpScopeGuard)) {
    container.register<IMcpScopeGuard>(DI_TOKENS.IMcpScopeGuard, () => {
      const logger = resolveLoggerOptional();
      return new McpScopeGuardAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['mcp', 'scope', 'guard', 'wave-5', 't16'],
      description: 'T16: MCP scope-based access control (project/user/subagent levels)',
    });
  }

  // --- T31: Network Sandbox ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.INetworkSandbox)) {
    container.register<INetworkSandbox>(DI_TOKENS.INetworkSandbox, () => {
      const logger = resolveLoggerOptional();
      return new NetworkSandboxAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['security', 'sandbox', 'network', 'wave-5', 't31'],
      description: 'T31: Network egress control for autonomous agent isolation',
    });
  }

  log.info('Wave 5 CC contracts registered (4 tokens: CC-013, CC-006, T16, T31)');

  // ── Wave 6 CC contracts (Deep Audit Re-Extraction) ────────────

  // --- CC-015: Self-Maintaining Documentation ---
  if (!container.isRegistered(DI_TOKENS.IDocumentDriftDetector)) {
    container.register<IDocumentDriftDetector>(DI_TOKENS.IDocumentDriftDetector, () => {
      const logger = resolveLoggerOptional();
      return new DocumentDriftDetectorAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['agents', 'documentation', 'drift', 'wave-6', 'cc-015'],
      description: 'CC-015: Self-maintaining documentation with drift detection and rule evolution',
    });
  }

  log.info('Wave 6 CC contracts registered (1 token: CC-015)');

  // ── Wave 7 CC contracts (RE-VERIFY Sprint 4) ─────────────────

  // --- CC-016: Scheduled Task Runner ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.IScheduledTaskRunner)) {
    container.register<IScheduledTaskRunner>(DI_TOKENS.IScheduledTaskRunner, () => {
      const logger = resolveLoggerOptional();
      return new ScheduledTaskRunnerAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['agents', 'scheduler', 'cron', 'wave-7', 'cc-016'],
      description: 'CC-016: Cron-based recurring agent task execution (deployment polling, PR monitoring)',
    });
  }

  if (experimentalPortsEnabled()) {
    log.info('Wave 7 CC contracts registered (1 token: CC-016)');
  }

  // ── Wave 8 CC contracts (Anthropic Agent Skills Extraction) ───

  // --- AS-001: Progressive Disclosure Architecture ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.IProgressiveDisclosureLoader)) {
    container.register<IProgressiveDisclosureLoader>(DI_TOKENS.IProgressiveDisclosureLoader, () => {
      const logger = resolveLoggerOptional();
      return new ProgressiveDisclosureLoaderAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['agents', 'disclosure', 'context', 'wave-8', 'as-001'],
      description: 'AS-001: 3-level progressive content loading (metadata→instructions→resources)',
    });
  }

  // --- AS-002: Skill Evaluation Runner ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.ISkillEvaluationRunner)) {
    container.register<ISkillEvaluationRunner>(DI_TOKENS.ISkillEvaluationRunner, () => {
      const logger = resolveLoggerOptional();
      return new SkillEvaluationRunnerAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['agents', 'evaluation', 'skills', 'wave-8', 'as-002'],
      description: 'AS-002: Evaluation-driven skill development with baseline comparison',
    });
  }

  if (experimentalPortsEnabled()) {
    log.info('Wave 8 CC contracts registered (2 tokens: AS-001, AS-002)');
  }

  // --- AS-043: Input Sanitization Pipeline ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.IInputSanitizationPipeline)) {
    container.register<IInputSanitizationPipeline>(DI_TOKENS.IInputSanitizationPipeline, () => {
      const logger = resolveLoggerOptional();
      return new InputSanitizationPipelineAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['security', 'sanitization', 'pipeline', 'wave-8', 'as-043'],
      description: 'AS-043: Composable 7-stage input sanitization pipeline',
    });
  }

  if (experimentalPortsEnabled()) {
    log.info('Wave 8 Sprint 3 CC contracts registered (1 token: AS-043)');
  }

  // ── Wave 9 CC contracts (V8.0 Academic + Industry Re-Extraction) ──

  // --- CC-017: Agent Event Stream ---
  if (!container.isRegistered(DI_TOKENS.IAgentEventStream)) {
    container.register<IAgentEventStream>(DI_TOKENS.IAgentEventStream, () => {
      const logger = resolveLoggerOptional();
      return new AgentEventStreamAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['agents', 'event-stream', 'tracing', 'wave-9', 'cc-017'],
      description: 'CC-017: Chronological action/observation log for agent execution state',
    });
  }

  // --- CC-018: LLM Test Harness ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.ILlmTestHarness)) {
    container.register<ILlmTestHarness>(DI_TOKENS.ILlmTestHarness, () => {
      const logger = resolveLoggerOptional();
      return new LlmTestHarnessAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['ai', 'testing', 'harness', 'replay', 'wave-9', 'cc-018'],
      description: 'CC-018: Deterministic LLM response mocking/replay for agent testing',
    });
  }

  // --- CC-019: Execution Provenance Tracer ---
  if (!container.isRegistered(DI_TOKENS.IExecutionProvenanceTracer)) {
    container.register<IExecutionProvenanceTracer>(DI_TOKENS.IExecutionProvenanceTracer, () => {
      const logger = resolveLoggerOptional();
      return new ExecutionProvenanceTracerAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['agents', 'provenance', 'citations', 'wave-9', 'cc-019'],
      description: 'CC-019: File/terminal citation tracking with line-level provenance',
    });
  }

  log.info('Wave 9 CC contracts registered (3 tokens: CC-017, CC-018, CC-019)');

  // ── PUA Phase 12: CBV Shadow Auditor, S2I Lesson Extractor, TEE Attestation ──

  // --- CC-022: CBV Shadow Auditor ---
  if (!container.isRegistered(DI_TOKENS.ICbvShadowAuditor)) {
    container.register<ICbvShadowAuditor>(DI_TOKENS.ICbvShadowAuditor, (c) => {
      const logger = resolveLoggerOptional();
      const multiModelConsensus = c.isRegistered(DI_TOKENS.IMultiModelConsensus)
        ? c.resolve<IMultiModelConsensus>(DI_TOKENS.IMultiModelConsensus)
        : undefined;
      const shadowConsensus = c.isRegistered(DI_TOKENS.ICrossModelShadowConsensus)
        ? c.resolve<ICrossModelShadowConsensus>(DI_TOKENS.ICrossModelShadowConsensus)
        : undefined;
      return new CbvShadowAuditorAdapter(logger, multiModelConsensus, shadowConsensus);
    }, {
      lifecycle: 'singleton',
      tags: ['evaluation', 'cbv', 'shadow-auditor', 'pua-phase-12', 'cc-022'],
      description: 'CC-022: CBV Shadow Auditor — adversarial self-audit via independent model review',
    });
  }

  // --- CC-023: S2I Lesson Extractor ---
  if (!container.isRegistered(DI_TOKENS.IS2iLessonExtractor)) {
    container.register<IS2iLessonExtractor>(DI_TOKENS.IS2iLessonExtractor, () => {
      const logger = resolveLoggerOptional();
      const lessonStore = container.isRegistered(DI_TOKENS.ILessonStore)
        ? container.resolve<ILessonStore>(DI_TOKENS.ILessonStore)
        : undefined;
      const successLedgerStore = container.isRegistered(DI_TOKENS.ISuccessLedgerStore)
        ? container.resolve<ISuccessLedgerStore>(DI_TOKENS.ISuccessLedgerStore)
        : undefined;
      const consolidator = container.isRegistered(DI_TOKENS.IWisdomConsolidator)
        ? container.resolve<IWisdomConsolidator>(DI_TOKENS.IWisdomConsolidator)
        : undefined;
      return new S2iLessonExtractorAdapter(logger, lessonStore, successLedgerStore, consolidator);
    }, {
      lifecycle: 'singleton',
      tags: ['agents', 's2i', 'lesson-extractor', 'samule', 'pua-phase-12', 'cc-023'],
      description: 'CC-023: S2I Lesson Extractor — automated SAMULE lesson extraction from PUA Success Ledger',
    });
  }

  // --- CC-024: TEE Attestation Verifier ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.ITeeAttestationVerifier)) {
    container.register<ITeeAttestationVerifier>(DI_TOKENS.ITeeAttestationVerifier, () => {
      const logger = resolveLoggerOptional();
      return new TeeAttestationVerifierAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['security', 'tee', 'attestation', 'hardware-aware', 'pua-phase-12', 'cc-024'],
      description: 'CC-024: TEE Attestation Verifier — hardware-backed attestation for high-risk ops (stub)',
    });
  }

  log.info('PUA Phase 12 contracts registered (3 tokens: CC-022, CC-023, CC-024)');

  // ── PUA v5.1: Cognitive Load Governor, Intent Misalignment, Wisdom Consolidator ──

  // --- CC-025: Cognitive Load Governor ---
  if (!container.isRegistered(DI_TOKENS.ICognitiveLoadGovernor)) {
    container.register<ICognitiveLoadGovernor>(DI_TOKENS.ICognitiveLoadGovernor, () => {
      const logger = resolveLoggerOptional();
      return new CognitiveLoadGovernorAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['agents', 'cognitive-load', 'probe', 'throttling', 'pua-v51', 'cc-025'],
      description: 'CC-025: Cognitive Load Governor — PROBE-based proactivity throttling',
    });
  }

  // --- CC-026: Intent Misalignment Detector ---
  if (!container.isRegistered(DI_TOKENS.IIntentMisalignmentDetector)) {
    container.register<IIntentMisalignmentDetector>(DI_TOKENS.IIntentMisalignmentDetector, () => {
      const logger = resolveLoggerOptional();
      return new IntentMisalignmentDetectorAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['security', 'ibac', 'intent-misalignment', 'pua-v51', 'cc-026'],
      description: 'CC-026: Intent Misalignment Detector — IBAC 2.0 adversarial intent analysis',
    });
  }

  // --- CC-027: Wisdom Consolidator ---
  if (!container.isRegistered(DI_TOKENS.IWisdomConsolidator)) {
    container.register<IWisdomConsolidator>(DI_TOKENS.IWisdomConsolidator, () => {
      const logger = resolveLoggerOptional();
      const lessonStore = container.isRegistered(DI_TOKENS.ILessonStore)
        ? container.resolve<ILessonStore>(DI_TOKENS.ILessonStore)
        : undefined;
      return new WisdomConsolidatorAdapter(logger, lessonStore);
    }, {
      lifecycle: 'singleton',
      tags: ['memory', 'sage', 'wisdom-consolidator', 'ebbinghaus', 'pua-v51', 'cc-027'],
      description: 'CC-027: Wisdom Consolidator — SAGE micro→macro lesson consolidation',
    });
  }

  log.info('PUA v5.1 contracts registered (3 tokens: CC-025, CC-026, CC-027)');

  // ── PUA v5.2: Dynamic Budget, Intent Graph, Contrastive Lessons, Cross-Model, Attested Intent ──

  // --- CC-028: Dynamic Cognitive Budget ---
  if (!container.isRegistered(DI_TOKENS.IDynamicCognitiveBudget)) {
    container.register<IDynamicCognitiveBudget>(DI_TOKENS.IDynamicCognitiveBudget, () => {
      const logger = resolveLoggerOptional();
      return new DynamicCognitiveBudgetAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['agents', 'cognitive-budget', 'criticality', 'pua-v52', 'cc-028'],
      description: 'CC-028: Dynamic Cognitive Budget — criticality-aware budget allocation',
    });
  }

  // --- CC-029: Intent Graph Analyzer ---
  if (!container.isRegistered(DI_TOKENS.IIntentGraphAnalyzer)) {
    container.register<IIntentGraphAnalyzer>(DI_TOKENS.IIntentGraphAnalyzer, () => {
      const logger = resolveLoggerOptional();
      return new IntentGraphAnalyzerAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['security', 'ibac', 'intent-graph', 'proximity', 'pua-v52', 'cc-029'],
      description: 'CC-029: Intent Graph Analyzer — IBAC 3.0 file-dependency proximity analysis',
    });
  }

  // --- CC-030: Contrastive Lesson Learner ---
  if (!container.isRegistered(DI_TOKENS.IContrastiveLessonLearner)) {
    container.register<IContrastiveLessonLearner>(DI_TOKENS.IContrastiveLessonLearner, () => {
      const logger = resolveLoggerOptional();
      const trajectoryStore = container.isRegistered(DI_TOKENS.ITrajectoryStore)
        ? container.resolve<ITrajectoryStore>(DI_TOKENS.ITrajectoryStore)
        : undefined;
      return new ContrastiveLessonLearnerAdapter(logger, trajectoryStore);
    }, {
      lifecycle: 'singleton',
      tags: ['memory', 'contrastive', 'ebbinghaus', 'anti-patterns', 'pua-v52', 'cc-030'],
      description: 'CC-030: Contrastive Lesson Learner — Ebbinghaus 3.0 success/failure trajectory comparison',
    });
  }

  // --- CC-031: Cross-Model Shadow Consensus ---
  if (!container.isRegistered(DI_TOKENS.ICrossModelShadowConsensus)) {
    container.register<ICrossModelShadowConsensus>(DI_TOKENS.ICrossModelShadowConsensus, () => {
      const logger = resolveLoggerOptional();
      return new CrossModelShadowConsensusAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['evaluation', 'cbv', 'cross-model', 'consensus', 'pua-v52', 'cc-031'],
      description: 'CC-031: Cross-Model Shadow Consensus — CBV 2.0 multi-model audit consensus',
    });
  }

  // --- CC-032: Attested Intent Lifecycle ---
  if (!container.isRegistered(DI_TOKENS.IAttestedIntentLifecycle)) {
    container.register<IAttestedIntentLifecycle>(DI_TOKENS.IAttestedIntentLifecycle, () => {
      const logger = resolveLoggerOptional();
      return new AttestedIntentLifecycleAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['security', 'tee', 'intent-lifecycle', 'write-gating', 'pua-v52', 'cc-032'],
      description: 'CC-032: Attested Intent Lifecycle — TEE 2.0 signed intent write gating (stub)',
    });
  }

  log.info('PUA v5.2 contracts registered (5 tokens: CC-028, CC-029, CC-030, CC-031, CC-032)');

  // ── PUA v5.3 Enhancements: Hardware Enclave + Semantic Proximity ──

  // --- CC-032+: Hardware Enclave Provider (bridge to real TEE) ---
  if (!container.isRegistered(DI_TOKENS.IHardwareEnclaveProvider)) {
    container.register<IHardwareEnclaveProvider>(DI_TOKENS.IHardwareEnclaveProvider, () => {
      const logger = resolveLoggerOptional();
      return new SimulatedHardwareEnclaveAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['security', 'tee', 'enclave', 'pua-v53', 'cc-032-plus'],
      description: 'CC-032+: Hardware Enclave Provider — simulated TEE bridge (SGX/SNP/TrustZone stub)',
    });
  }

  // --- CC-029+: Semantic Proximity Provider (vector-augmented graph) ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.ISemanticProximityProvider)) {
    container.register<ISemanticProximityProvider>(DI_TOKENS.ISemanticProximityProvider, () => {
      const logger = resolveLoggerOptional();
      return new SimulatedSemanticProximityAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['security', 'semantic', 'proximity', 'vector', 'pua-v53', 'cc-029-plus'],
      description: 'CC-029+: Semantic Proximity Provider — simulated vector similarity (S-MMU Tier 3 stub)',
    });
  }

  log.info('PUA v5.3 enhancements registered (2 tokens: CC-032+, CC-029+)');

  // ── Pillar 3: LATS & Bayesian Consensus (Horizon 5) ──────────

  // --- ITreeOfThoughts: LATS tree-structured reasoning ---
  if (!container.isRegistered(DI_TOKENS.ITreeOfThoughts)) {
    container.register<ITreeOfThoughts>(DI_TOKENS.ITreeOfThoughts, () => {
      const logger = resolveLoggerOptional();
      return new LatsEngine(undefined, logger);
    }, {
      lifecycle: 'singleton',
      tags: ['ai', 'lats', 'tree-of-thoughts', 'pillar-3', 'horizon-5'],
      description: 'Pillar-3: LATS tree search — multi-path reasoning with critic evaluation',
    });
  }

  // --- IMultiJudgeEvaluator: Bayesian multi-judge consensus ---
  if (!container.isRegistered(DI_TOKENS.IMultiJudgeEvaluator)) {
    container.register<IMultiJudgeEvaluator>(DI_TOKENS.IMultiJudgeEvaluator, () => {
      const logger = resolveLoggerOptional();
      return new MultiJudgeEvalAdapter(
        [], // Judges injected dynamically at runtime
        { priorAccuracy: 0.6, weightDecay: 0.95 },
        logger,
        () => container.isRegistered(DI_TOKENS.IEvaluationMemory)
          ? container.resolve<IEvaluationMemory>(DI_TOKENS.IEvaluationMemory)
          : undefined,
      );
    }, {
      lifecycle: 'singleton',
      tags: ['ai', 'consensus', 'bayesian', 'pillar-3', 'horizon-5'],
      description: 'Pillar-3: Bayesian multi-judge evaluator with accuracy weight tracking',
    });
  }

  // --- IMultiModelConsensus: Cross-Model QA facade (CC-002) ---
  if (!container.isRegistered(DI_TOKENS.IMultiModelConsensus)) {
    container.register<IMultiModelConsensus>(DI_TOKENS.IMultiModelConsensus, () => {
      const logger = resolveLoggerOptional();
      const judgeEvaluator = container.resolve<IMultiJudgeEvaluator>(DI_TOKENS.IMultiJudgeEvaluator);
      return new MultiModelConsensusFacadeAdapter(judgeEvaluator, logger);
    }, {
      lifecycle: 'singleton',
      tags: ['evaluation', 'consensus', 'cross-model', 'cc-002', 'wave-1'],
      description: 'CC-002: Cross-Model QA — N-model Bayesian consensus facade over IMultiJudgeEvaluator',
    });
  }

  log.info('Pillar 3 LATS contracts registered (3 tokens: ITreeOfThoughts, IMultiJudgeEvaluator, IMultiModelConsensus)');

  // ── Pillar 4: PQC Cryptographic Provenance (Horizon 5) ────────

  // --- IPqcCryptoProvider: Post-Quantum Crypto adapter ---
  if (!container.isRegistered(DI_TOKENS.IPqcCryptoProvider)) {
    container.register<IPqcCryptoProvider>(DI_TOKENS.IPqcCryptoProvider, () => {
      const logger = resolveLoggerOptional();
      return new PqcCryptoAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['crypto', 'pqc', 'pillar-4', 'horizon-5'],
      description: 'Pillar-4: PQC crypto adapter — ML-DSA/SLH-DSA key gen, sign, verify (stub)',
    });
  }

  // --- IPqcEventChain: PQC event chain signing + verification ---
  if (!container.isRegistered(DI_TOKENS.IPqcEventChain)) {
    container.register<IPqcEventChain>(DI_TOKENS.IPqcEventChain, () => {
      const crypto = container.resolve<IPqcCryptoProvider>(DI_TOKENS.IPqcCryptoProvider);
      const logger = resolveLoggerOptional();
      return new PqcEventSigningMiddleware(crypto, 'ML-DSA-65', logger);
    }, {
      lifecycle: 'singleton',
      tags: ['crypto', 'events', 'pqc-chain', 'pillar-4', 'horizon-5'],
      description: 'Pillar-4: PQC event chain — tamper-evident signing + chain verification',
    });
  }

  log.info('Pillar 4 PQC contracts registered (2 tokens: IPqcCryptoProvider, IPqcEventChain)');

  // ── Pillar 5: Cognitive CI/CD Quality Gates (Horizon 5) ───────────

  // --- IAutoFixAnalyzer: Cognitive CI/CD auto-fix analyzer ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.IAutoFixAnalyzer)) {
    container.register<IAutoFixAnalyzer>(DI_TOKENS.IAutoFixAnalyzer, () => {
      const logger = resolveLoggerOptional();
      return new AutoFixAnalyzerAdapter(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['ci', 'auto-fix', 'pillar-5', 'horizon-5'],
      description: 'Pillar-5: Cognitive CI/CD auto-fix analyzer — P1-P3 failure classification + patch generation',
    });
  }

  if (experimentalPortsEnabled()) {
    log.info('Pillar 5 CI/CD contracts registered (1 token: IAutoFixAnalyzer)');
  }
  log.info(
    experimentalPortsEnabled()
      ? 'SOTA 2026 module complete, experimental ports included'
      : 'SOTA 2026 module complete, experimental ports skipped',
  );

  // ── Wave 10: Documentation System Modernization (SOTA March 2026) ──

  // --- CC-020: Drift-Aware Prompt Enrichment (Inverse Symbiotic Injection) ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.IDriftAwarePromptEnricher)) {
    container.register<IDriftAwarePromptEnricher>(DI_TOKENS.IDriftAwarePromptEnricher, () => {
      const logger = resolveLoggerOptional();
      const driftDetector = container.resolve<IDocumentDriftDetector>(DI_TOKENS.IDocumentDriftDetector);
      return new DriftAwarePromptEnricherAdapter(driftDetector, logger);
    }, {
      lifecycle: 'singleton',
      tags: ['agents', 'drift', 'prompt', 'wave-10', 'cc-020'],
      description: 'CC-020: Inverse Symbiotic Injection — injects drift warnings into agent system prompts',
    });
  }

  // --- CC-021: LATS Consensus SSOT Workflow ---
  if (experimentalPortsEnabled() && !container.isRegistered(DI_TOKENS.IUpdateSSOTWorkflow)) {
    container.register<IUpdateSSOTWorkflow>(DI_TOKENS.IUpdateSSOTWorkflow, () => {
      const logger = resolveLoggerOptional();
      const criticService = container.resolve<ICriticFeedbackService>(DI_TOKENS.ICriticFeedbackService);
      return new UpdateSSOTWorkflowAdapter(criticService, logger);
    }, {
      lifecycle: 'singleton',
      tags: ['agents', 'ssot', 'lats', 'consensus', 'wave-10', 'cc-021'],
      description: 'CC-021: LATS Consensus Policy — multi-variant SSOT validation with ICriticFeedbackService',
    });
  }

  if (experimentalPortsEnabled()) {
    log.info('Wave 10 Docs Modernization registered (2 tokens: CC-020, CC-021)');
  }
}

// ── Helpers ─────────────────────────────────────────────────────

interface MinimalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

function resolveLoggerOptional(): MinimalLogger | undefined {
  try {
    if (container.isRegistered(DI_TOKENS.IStructuredLogger)) {
      return container.resolve<MinimalLogger>(DI_TOKENS.IStructuredLogger);
    }
  } catch {
    // Logger not available
  }
  return undefined;
}
