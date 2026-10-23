/**
 * DI Tokens Registry - Single Source of Truth for all DI container tokens
 * Layer: Core (Pure Constants — no dependencies)
 *
 * AUDIT-V4 C.5: Moved from Infrastructure to Core layer (dependency inversion).
 * Infrastructure re-exports from here for backward compatibility.
 *
 * AUDIT-V6 G7 (Updated V7, B-05 audit 2026-03-19): Originally 25 stale tokens identified.
 * 23 have been removed or reclassified as active tokens.
 * 2 deprecated compatibility aliases remain in DEPRECATED_TOKENS: CacheService and MetricsCollector.
 *
 * Usage:
 *   container.register(DI_TOKENS.HttpServer, ...);
 *   const server = container.resolve(DI_TOKENS.HttpServer);
 *
 * Benefits:
 *   - Compile-time type checking for token names
 *   - IDE autocomplete for all available tokens
 *   - Single source of truth for token naming conventions
 *   - Prevents typos and refactoring errors
 */

/**
 * Centralized DI token definitions
 */
export const DI_TOKENS = {
  // Core Infrastructure
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#Example-27:-WebSocket-Adapter-Server */
  HttpServer: 'HttpServer' as const,
  /** @see docs: AI_CHEATSHEET.md#9.-Anti-Patterns-break-arch-tests */
  AppFactory: 'AppFactory' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#bootstrap-18-services */
  IConfigLoader: 'IConfigLoader' as const,

  // Platform Abstraction (Cross-Platform V1)
  /** @see src/domain/platform/IPlatformAdapter.ts — cross-platform abstraction port */
  /** @see PLANS/CROSS_PLATFORM_PLAN_V1.md — Phase 1 */
  /** @see docs: AI_CHEATSHEET.md#9.-Anti-Patterns-break-arch-tests */
  IPlatformAdapter: 'IPlatformAdapter' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Registration-Pattern */
  IContainerRegistryClient: 'IContainerRegistryClient' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.4.-Observability-и-health‑checks */
  IGpuHealthMonitor: 'IGpuHealthMonitor' as const,

  // Event Sourcing
  /** @see docs: ARCHITECTURE_GUIDE.md#4.2.-Events-и-Outbox */
  IEventStore: 'IEventStore' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.8.-Обзор-подсистем-и-слоёв-диаграмма */
  IEventBus: 'IEventBus' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.8.-Обзор-подсистем-и-слоёв-диаграмма */
  IOutbox: 'IOutbox' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.2.-Events-и-Outbox */
  IEventGapDetector: 'IEventGapDetector' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.2.-Events-и-Outbox */
  IProcessedEventStore: 'IProcessedEventStore' as const,

  // Event Mesh (Phase 7 — LMAX Disruptor)
  /** @see src/domain/events/event-mesh.interface.ts — High-throughput ring buffer event distribution */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.2.-Events-и-Outbox */
  IEventMesh: 'IEventMesh' as const,

  // Multi-Modal Memory (Phase 7 — CLIP Embeddings)
  /** @see src/domain/memory/multimodal-memory.interface.ts — Multi-modal embedding provider */
  /** @see docs: AI_CHEATSHEET.md#S-MMU-Semantic-Memory-Management-Unit-—-4-Tier-Architecture */
  IEmbeddingProvider: 'IEmbeddingProvider' as const,
  /** @see src/domain/memory/multimodal-memory.interface.ts — Multi-modal memory store & retrieval */
  /** @see docs: 04-REFERENCE/architecture.md#11.3-Обновленные-правила-зависимостей */
  IMultiModalMemoryService: 'IMultiModalMemoryService' as const,

  // Memory Intelligence (Fact Extraction + Consolidation)
  /** @see src/domain/memory/IFactExtractionService.ts — LLM-based fact extraction port */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#mas_core-17-services */
  IFactExtractionService: 'IFactExtractionService' as const,
  /** @see src/domain/memory/IMemoryConsolidationService.ts — LLM-based memory consolidation port */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#memory-1-services */
  IMemoryConsolidationService: 'IMemoryConsolidationService' as const,

  // Semantic Event Sourcing (Этап 6 — Event Vectorization)
  /** @see src/domain/memory/IEventVectorizer.ts — Event embedding vectorizer port */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.2.-Events-и-Outbox */
  IEventVectorizer: 'IEventVectorizer' as const,

  // Database & Persistence
  /** @see docs: AI_CHEATSHEET.md#9.-Anti-Patterns-break-arch-tests */
  DatabaseConnection: 'DatabaseConnection' as const,

  /** @see docs: 04-REFERENCE/testing-patterns.md#R2.3-MAS-events-Streams-+-CQRS-tests */
  IMasSessionStore: 'IMasSessionStore' as const,

  /** @see src/domain/identity/IUserRepository.ts — identity.users (migration 009) */
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#7.1.-Mermaid-диаграмма-e2e */
  IUserRepository: 'IUserRepository' as const,
  /** @see src/domain/identity/ITenantRepository.ts — identity.tenants (migration 009) */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#repositories-3-services */
  ITenantRepository: 'ITenantRepository' as const,

  // Cache & Redis
  /** @deprecated B-05 audit: 0 registrations, 0 consumers. Scheduled for removal. */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#core_infra-36-services */
  CacheService: 'CacheService' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.4.-Observability-и-health‑checks */
  RedisClient: 'RedisClient' as const,


  // Logging & Observability
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#interaction-1-services */
  ILogger: 'ILogger' as const,
  /** @see docs: docs/TESTING_GUIDE.md#Unit-Test-L0 */
  IStructuredLogger: 'IStructuredLogger' as const,
  /** @deprecated B-05 audit: replaced by IChannelMetricsCollector / IMetricsCollector. */
  /** @see docs: 04-REFERENCE/ERROR_HANDLING_GUIDE.md#Error-Metrics-Collection */
  MetricsCollector: 'MetricsCollector' as const,

  // LLM & AI
  /** @see docs: AI_CHEATSHEET.md#9.-Anti-Patterns-break-arch-tests */
  LLMAdapterFactory: 'LLMAdapterFactory' as const,
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#Example-6:-Scoped-Lifecycle */
  ILLMAdapter: 'ILLMAdapter' as const,
  /** Model catalog — aggregated multi-provider model metadata. @see KC-001..KC-007 */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.9.-MCP-Servers-Model-Context-Protocol */
  IModelCatalog: 'IModelCatalog' as const,
  /** LLM cost calculator — computes API call costs from token usage. @see KC-008 */
  /** @see docs: 04-REFERENCE/architecture.md#Context-Condensing-Memory-Layer */
  ILLMCostCalculator: 'ILLMCostCalculator' as const,
  /** Dynamic LLM model router — task-based routing + fallback cascades. @see KC-025 */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.9.-MCP-Servers-Model-Context-Protocol */
  IModelRouter: 'IModelRouter' as const,


  // Memory & Context
  /** Ebbinghaus 2.0 temporal decay strategy for memory search. @see domain/memory/ITemporalDecayStrategy.ts */
  /** @see docs: docs/TESTING_GUIDE.md#Worker-Strategy */
  ITemporalDecayStrategy: 'ITemporalDecayStrategy' as const,
  /** Code Knowledge Graph Store — structural code intelligence (AST, RRF, Leiden, BFS). @see domain/memory/ICodeGraphStore.ts */
  /** Extracted from: GitNexus v1.4.0 (patterns only, PolyForm-NC) */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Graph-Port-Taxonomy */
  ICodeGraphStore: 'ICodeGraphStore' as const,
  /** Code Path Context Resolver — local AST enclosure + imported graph snippet retrieval. @see domain/memory/ICodePathContextResolver.ts */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#Orphaned-Tokens-no-deps,-not-depended-upon */
  ICodePathContextResolver: 'ICodePathContextResolver' as const,
  /** Search Augmentation Engine — enriches search results with graph context. @see domain/memory/ISearchAugmentationEngine.ts */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Graph-Port-Taxonomy */
  ISearchAugmentationEngine: 'ISearchAugmentationEngine' as const,
  /** Change Impact Analyzer — maps git diff to affected symbols/processes/risk. @see domain/memory/IChangeImpactAnalyzer.ts */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Graph-Port-Taxonomy */
  IChangeImpactAnalyzer: 'IChangeImpactAnalyzer' as const,
  /** MRO Processor — language-aware method resolution order (C3, DFS, BFS). @see domain/memory/IMroProcessor.ts */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Layer-5:-Context-Processing */
  IMroProcessor: 'IMroProcessor' as const,
  /** Centrality Scorer — graph centrality analysis (PageRank, Betweenness, Degree). @see domain/memory/ICentralityScorer.ts */
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  ICentralityScorer: 'ICentralityScorer' as const,
  /** Query Classification Verifier — LLM shadow consensus for search routing. @see domain/memory/IQueryClassificationVerifier.ts */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Priority-Classification */
  IQueryClassificationVerifier: 'IQueryClassificationVerifier' as const,
  /** Tree-sitter AST Parser — language-agnostic AST parsing for code intelligence. @see domain/memory/ITreeSitterParser.ts */
  /** @see docs: 04-REFERENCE/architecture.md#🟡-HIGH:-Tree‑sitter-AST-Parser-AI/ML-Layer */
  ITreeSitterParser: 'ITreeSitterParser' as const,
  /** Static Call Graph Builder — constructs call graph from AST call sites. @see domain/memory/IStaticCallGraphBuilder.ts */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Knowledge-Graph-Integration-NEW-in-v2.2.0 */
  IStaticCallGraphBuilder: 'IStaticCallGraphBuilder' as const,
  /** Type Environment — scope-aware type resolution for code intelligence. @see domain/memory/ITypeEnvironment.ts */
  /** @see docs: ARCHITECTURE_GUIDE.md#2.-Runtime‑цепочка */
  ITypeEnvironment: 'ITypeEnvironment' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Layer-2:-Application-Orchestration-Contracts */
  ISessionMemoryManager: 'ISessionMemoryManager' as const,
  /** Explicit working-memory plane port. */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.6.-Память */
  IWorkingMemory: 'IWorkingMemory' as const,
  /** Explicit summary-memory plane port. */
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  ISummaryMemory: 'ISummaryMemory' as const,
  /** Explicit governance-memory plane port. */
  /** @see docs: docs/ARCHITECTURE_VALIDATION.md#Закрыто-Closed */
  IGovernanceMemory: 'IGovernanceMemory' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#2.3.-Context-Coordinator */
  IContextCoordinator: 'IContextCoordinator' as const,

  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#4.3.-Режимы-памяти-и-fallback */
  OpenMemoryAdapter: 'OpenMemoryAdapter' as const,

  // MAS Orchestration
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#2.-Компоненты-MAS-Runtime-Core-и-границы */
  IMasterAgent: 'IMasterAgent' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#2.1.-Диаграмма-runtime‑цепочки */
  TaskOrchestrator: 'TaskOrchestrator' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#3.3.-Диаграмма-слоёв */
  AgentRouter: 'AgentRouter' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#2.-Компоненты-MAS-Runtime-Core-и-границы */
  ITaskDecomposer: 'ITaskDecomposer' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.7.2.-Размещение-MAS-Runtime-Policy-Layer-и-scoping */
  IMasRuntimePolicyService: 'IMasRuntimePolicyService' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.5.3.-Поток-CIRCUIT_OPEN-end‑to‑end */
  MasDurableExecutionService: 'MasDurableExecutionService' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Application-Layer-34-interfaces */
  IAgentRegistry: 'IAgentRegistry' as const,

  // Swarm Agent Registry (Phase 88 — The Hive)
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Domain-Layer-110-interfaces */
  ISwarmAgentRegistry: 'ISwarmAgentRegistry' as const,

  // Swarm Event-Driven Orchestrator (Horizon 2.3)
  /** @see docs: ARCHITECTURE_GUIDE.md#2.1.-Диаграмма-runtime‑цепочки */
  ISwarmOrchestrator: 'ISwarmOrchestrator' as const,
  /** @see docs: 04-REFERENCE/architecture.md#MessageQueueService-Application-Layer */
  ISwarmEventEmitter: 'ISwarmEventEmitter' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#mas_core-17-services */
  DynamicAgentRegistry: 'DynamicAgentRegistry' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#mas_core-17-services */
  AgentFactory: 'AgentFactory' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#1.-Область-применения-и-связь-с-планами */
  MasAgentExecutor: 'MasAgentExecutor' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.7.2.-Размещение-MAS-Runtime-Policy-Layer-и-scoping */
  RoutingPolicyService: 'RoutingPolicyService' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#interaction-1-services */
  IToolRegistry: 'IToolRegistry' as const,
  /** @see docs: AI_CHEATSHEET.md#11.-Grep-Index */
  IToolExecutionPolicy: 'IToolExecutionPolicy' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#2.-Runtime‑цепочка */
  RuntimeToolCompiler: 'RuntimeToolCompiler' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#mas_core-17-services */
  DynamicToolRegistry: 'DynamicToolRegistry' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#Orphaned-Tokens-no-deps,-not-depended-upon */
  CodebaseIntegrityService: 'CodebaseIntegrityService' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#Orphaned-Tokens-no-deps,-not-depended-upon */
  CodebaseIntegrityTool: 'CodebaseIntegrityTool' as const,
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#IBrowserServer */
  IBrowserServer: 'IBrowserServer' as const,

  // Agents & Workers
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#agent_runner-3-services */
  AgentRunner: 'IAgentRunner' as const,

  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Layer-7:-Agent-Runtime */
  IAgentWorker: 'IAgentWorker' as const,

  // Security & Policy
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#7.1.-Mermaid-диаграмма-e2e */
  IUserApprovalInterceptor: 'IUserApprovalInterceptor' as const,
  /** @see docs: docs/protocols/ANTI_STUB_POLICY_SOTA_2026.md#План-Внедрения-в-Рабочий-Процесс-ИИ-Программиста */
  IPolicyEngine: 'IPolicyEngine' as const,

  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#security-1-services */
  ISecretResolver: 'ISecretResolver' as const,
  /** @see src/domain/security/secret-inventory.port.ts */
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  ISecretInventory: 'ISecretInventory' as const,
  /** @see src/domain/security/secret-rotation-planner.port.ts */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#ai-47-services */
  ISecretRotationPlanner: 'ISecretRotationPlanner' as const,
  /** @see src/domain/security/secret-rotation-executor.port.ts */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#ai-47-services */
  ISecretRotationExecutor: 'ISecretRotationExecutor' as const,
  /** @see src/domain/security/secret-rotation-receipt-store.port.ts */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.2.-Events-и-Outbox */
  ISecretRotationReceiptStore: 'ISecretRotationReceiptStore' as const,
  /** @see src/application/services/security/SecretRotationOrchestratorService.ts */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#ai-47-services */
  SecretRotationOrchestratorService: 'SecretRotationOrchestratorService' as const,
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Phase-0K:-RECON-K-—-Knowledge-Reconnaissance */
  IContentBoundaryWrapper: 'IContentBoundaryWrapper' as const,
  /** @see docs: AI_CHEATSHEET.md#DI-&-Events */
  ITtsService: 'ITtsService' as const,

  // Messaging & Dispatch (Phase 14)
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#2.-Cognitive-Loop-Persistence-Outbox-Pattern */
  IMessageDispatcher: 'IMessageDispatcher' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Infrastructure-Layer-24-interfaces */
  ICommandRegistry: 'ICommandRegistry' as const,

  // ACP Runtime (Phase 18)
  /** @see src/domain/acp/IAcpRuntime.ts */
  /** @see docs: ARCHITECTURE_GUIDE.md#2.-Runtime‑цепочка */
  IAcpRuntime: 'IAcpRuntime' as const,
  /** @see src/application/services/acp/AcpPolicyService.ts */
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.7.2.-Размещение-MAS-Runtime-Policy-Layer-и-scoping */
  AcpPolicyService: 'AcpPolicyService' as const,
  /** @see src/application/controllers/AcpController.ts */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#singularity-1-services */
  AcpController: 'AcpController' as const,

  // Phase 16: SSRF DNS Guard
  /** @see src/infrastructure/security/SsrfDnsGuard.ts */
  /** @see docs: docs/TESTING_GUIDE.md#Preflight-Guard:-Hot-Path-Logging-Check-17 */
  ISsrfDnsGuard: 'ISsrfDnsGuard' as const,

  // Phase 16A: Prompt Injection Scanner (OpenClaw extraction)
  /** @see src/domain/security/prompt-injection-scanner.port.ts */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.1.-Dependency-Injection-DI */
  IPromptInjectionScanner: 'IPromptInjectionScanner' as const,

  // Phase 0B: Output Rail Scanner (NeMo Layer 5)
  /** @see src/domain/security/output-rail.port.ts */
  /** @see docs: docs/TESTING_GUIDE.md#LLM-Evaluation-H2 */
  IOutputRail: 'IOutputRail' as const,

  // Phase 7: Cognitive Firewall Service
  /** @see src/application/security/firewall.service.ts — schema validation, XSS sanitization, jailbreak detection */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#interaction-1-services */
  IFirewallService: 'IFirewallService' as const,

  // Scheduling (Phase 12)
  /** @see docs: AI_CHEATSHEET.md#DI-&-Events */
  ICronService: 'ICronService' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#repositories-3-services */
  ICronJobRepository: 'ICronJobRepository' as const,
  /** @see src/domain/scheduling/cron-service.port.ts — ICronTimerManager */
  /** @see docs: docs/TESTING_GUIDE.md#Open-handles-detection-—-shows-leaked-connections/timers */
  ICronTimerManager: 'ICronTimerManager' as const,
  /** @see src/domain/scheduling/cron-service.port.ts — ICronJobNormalizer */
  /** @see docs: 04-REFERENCE/testing-patterns.md#.github/workflows/tests.yml */
  ICronJobNormalizer: 'ICronJobNormalizer' as const,

  // Plugin System
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.2.-Typed-events-MAS */
  IPluginRegistry: 'IPluginRegistry' as const,
  /** @see docs: docs/TESTING_GUIDE.md#CI-/-Pre-PR-Checklist */
  IPluginManifestValidator: 'IPluginManifestValidator' as const,
  /** @see docs: docs/TESTING_GUIDE.md#CI-/-Pre-PR-Checklist */
  PluginAutoLoader: 'PluginAutoLoader' as const,
  /** @see docs: docs/TESTING_GUIDE.md#CI-pipeline-optimized-order */
  IHookPipeline: 'IHookPipeline' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#Full-Service-Topology */
  IPluginSlotManager: 'IPluginSlotManager' as const,
  /** @see src/application/plugins/PluginLifecycleService.ts */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#Full-Service-Topology */
  PluginLifecycleManager: 'PluginLifecycleManager' as const,

  // Skills & Execution
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#skills-2-services */
  ISkillRegistry: 'ISkillRegistry' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#sandbox-3-services */
  ISandboxExecutor: 'ISandboxExecutor' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#sandbox-3-services */
  ISandboxPool: 'ISandboxPool' as const,
  /** @see src/domain/sandbox/ISandboxStrategy.ts — cross-platform sandbox strategy factory */
  /** @see docs: 04-REFERENCE/architecture.md#🟡-HIGH:-Design-Patterns-неполные-статус-на-2025-11-04 */
  ISandboxStrategyFactory: 'ISandboxStrategyFactory' as const,
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#Example-8:-Conditional-Registration */
  IProcessContainer: 'IProcessContainer' as const,

  // Service Discovery
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#service_discovery-3-services */
  IServiceDiscovery: 'IServiceDiscovery' as const,

  // Feature Flags
  /** @see docs: 04-REFERENCE/architecture.md#4.9-Feature-Flags-Architecture-TASK‑035 */
  IFeatureFlagsStore: 'IFeatureFlagsStore' as const,

  // Research
  /** @see docs: ARCHITECTURE_GUIDE.md#4.11.-TIM-—-Trajectory-Informed-Memory */
  IResearchService: 'IResearchService' as const,

  // Memory Clients
  /** @see docs: ARCHITECTURE_GUIDE.md#4.4.-Observability-и-health‑checks */
  HSGClient: 'HSGClient' as const,

  // Vector Store (Phase 74)
  /** @see docs: ARCHITECTURE_GUIDE.md#4.4.-Observability-и-health‑checks */
  VectorClient: 'VectorClient' as const,

  // Mem0 Integration (Phase 1-3, donor: @mem0/openclaw-mem0 plugin)
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  IMem0Provider: 'IMem0Provider' as const,
  /** @see docs: 04-REFERENCE/extraction-protocol.md#GitNexus-Extraction-Artifacts-Detailed */
  IGraphMemoryAdapter: 'IGraphMemoryAdapter' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.10.-Code-Intelligence-GitNexus-GraphRAG */
  IGraphMemoryEngine: 'IGraphMemoryEngine' as const,
  /** @see docs: AI_CHEATSHEET.md#S-MMU-Semantic-Memory-Management-Unit-—-4-Tier-Architecture */
  Mem0MemoryProviderBridge: 'Mem0MemoryProviderBridge' as const,
  /** @see docs: AI_CHEATSHEET.md#DI-&-Events */
  AutoCaptureService: 'AutoCaptureService' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#Full-Service-Topology */
  ILifecycleHookManager: 'ILifecycleHookManager' as const,

  // Horizon 1 — Memory Evolution
  /** @see docs: ARCHITECTURE_GUIDE.md#4.6.-Память */
  IMemorySigner: 'IMemorySigner' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.6.-Память */
  HolographicMemorySyncer: 'HolographicMemorySyncer' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.6.-Память */
  PredictiveMemoryCache: 'PredictiveMemoryCache' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  IDreamSynthesizer: 'IDreamSynthesizer' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#skills-2-services */
  ILiquidSkillRegistry: 'ILiquidSkillRegistry' as const,

  // Horizon 1 — Industry Integration (Visual Debugger, CoT, HITL)
  /** @see docs: 04-REFERENCE/testing-patterns.md#3.2-R2.2-Event-Store-partitioning-&-R2.3-MAS-events-Streams-+-CQRS-tests */
  IEventStreamDebugger: 'IEventStreamDebugger' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  ICoTScratchpad: 'ICoTScratchpad' as const,
  // IUserApprovalInterceptor declared in Security & Policy section above

  // Étap 3 — DX & UI Visualization (WebSocket Debug Bridge)
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#IChannelAdapter */
  IWebSocketStreamAdapter: 'IWebSocketStreamAdapter' as const,

  // --- Tokens merged from ai-types.ts (Phase 100 unification) ---

  // AI Clients
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#http-1-services */
  IAIClient: 'IAIClient' as const,
  /** @see src/domain/ai/IChatCompletionModel.ts — chat history with tool role */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.9.-MCP-Servers-Model-Context-Protocol */
  IChatCompletionModel: 'IChatCompletionModel' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#core_infra-36-services */
  ICache: 'ICache' as const,
  /** @see docs: AI_CHEATSHEET.md#9.-Anti-Patterns-break-arch-tests */
  IDatabaseConnection: 'IDatabaseConnection' as const,
  /** @see docs: docs/TESTING_GUIDE.md#NPM-Scripts-Reference */
  IUnitOfWork: 'IUnitOfWork' as const,
  /** @see docs: AI_CHEATSHEET.md#5.-Where-to-Put-New-Code */
  IFileStorage: 'IFileStorage' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#memory-1-services */
  IVectorStore: 'IVectorStore' as const,

  // MCP Server (Phase 7)
  /** @see docs: ARCHITECTURE_GUIDE.md#4.9.-MCP-Servers-Model-Context-Protocol */
  IMcpServer: 'IMcpServer' as const,
  // MCP Context Server (Phase CE-1: Context Engineering Horizon 1)
  /** @see src/infrastructure/mcp/context/MicroPhoenixMcpServer.ts — dev-time MCP context server */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.9.-MCP-Servers-Model-Context-Protocol */
  IMcpContextServer: 'IMcpContextServer' as const,
  // MCP Docs Server (Phase CE-2: Context Engineering — Documentation Server)
  /** @see src/infrastructure/mcp/docs/MicroPhoenixDocsMcpServer.ts — dev-time MCP docs server */
  /** @see docs: docs/TESTING_GUIDE.md#Chaos-Test-H1 */
  IMcpDocsServer: 'IMcpDocsServer' as const,
  // MCP Extraction Server (dev-time tool for donor extraction pipeline)
  /** @see src/infrastructure/mcp/extraction/MicroPhoenixExtractionMcpServer.ts */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Donor-Extraction-Protocol-—-Dual-Pipeline-Architecture */
  IMcpExtractionServer: 'IMcpExtractionServer' as const,
  // MCP Audit Server (dev-time continuous auditing tool)
  /** @see src/infrastructure/mcp/audit/MicroPhoenixAuditMcpServer.ts */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.9.-MCP-Servers-Model-Context-Protocol */
  IMcpAuditServer: 'IMcpAuditServer' as const,
  // MCP Code Intelligence Server (knowledge graph + code analysis)
  /** @see src/infrastructure/mcp/code-intelligence/MicroPhoenixMcpCodeIntelligenceServer.ts */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.9.-MCP-Servers-Model-Context-Protocol */
  IMcpCodeIntelligenceServer: 'IMcpCodeIntelligenceServer' as const,
  // MCP SPP Server (Scientific Publication Protocol — citation health, peer review, STRESS)
  /** @see src/infrastructure/mcp/spp/MicroPhoenixSppMcpServer.ts */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.9.-MCP-Servers-Model-Context-Protocol */
  IMcpSppServer: 'IMcpSppServer' as const,

  // Extraction Pipeline V5.1 (Proof-of-Extraction, Semantic Archiving, Symbiotic Protocol)
  /** @see src/domain/extraction/IProofOfExtractionStore.ts — Cryptographic extraction provenance */
  /** @see docs: docs/TESTING_GUIDE.md#"Out-of-memory"-during-tests */
  IProofOfExtractionStore: 'IProofOfExtractionStore' as const,
  /** @see src/domain/extraction/ISemanticDonorArchive.ts — Semantic archiving of skipped donor code */
  /** @see docs: AI_CHEATSHEET.md#S-MMU-Semantic-Memory-Management-Unit-—-4-Tier-Architecture */
  ISemanticDonorArchive: 'ISemanticDonorArchive' as const,
  /** @see src/domain/extraction/ISymbioticProtocol.ts — Reverse Extraction (Sidecar Adapters) */
  /** @see docs: ARCHITECTURE_GUIDE.md#3.2.-Допустимые-зависимости */
  ISymbioticProtocol: 'ISymbioticProtocol' as const,
  /** @see src/domain/extraction/IContinuousSymbiosisWatcher.ts — Watch Mode Pipeline (auto-regeneration) */
  /** @see docs: 04-REFERENCE/architecture.md#FileContextTracker-Memory-Layer */
  IContinuousSymbiosisWatcher: 'IContinuousSymbiosisWatcher' as const,
  /** @see src/domain/extraction/IExtractionTrajectoryStore.ts — Cross-session extraction memory (V11.0) */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#9.4-Protocol-Self-Improvement-Loop-NEW-in-v2.2.0 */
  IExtractionTrajectoryStore: 'IExtractionTrajectoryStore' as const,
  /** @see src/domain/extraction/ICrossDonorKnowledgeGraph.ts — Cross-donor knowledge graph (V11.0) */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Knowledge-Graph-Integration-NEW-in-v2.2.0 */
  ICrossDonorKnowledgeGraph: 'ICrossDonorKnowledgeGraph' as const,

  // Memory Governance
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#memory-1-services */
  IMemoryGovernanceService: 'IMemoryGovernanceService' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#memory-1-services */
  hybridMemoryRetrievalService: 'hybridMemoryRetrievalService' as const,

  // Memory Governance (Phase 8: N5-N8)
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#5.2.-Связь-с-Memory-и-PolicyEngine */
  IMemoryAccessPolicy: 'IMemoryAccessPolicy' as const,

  // Plugin & Execution
  /** @see docs: 04-REFERENCE/architecture.md#4.-Интеграционные-точки-и-сквозные-аспекты */
  IUnifiedPluginRegistry: 'IUnifiedPluginRegistry' as const,
  /** @see docs: AI_CHEATSHEET.md#11.-Grep-Index */
  IExecutionStrategy: 'IExecutionStrategy' as const,

  // Metrics
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#IMetricsPort */
  IMetricsPort: 'IMetricsPort' as const,

  // Integration (extended)
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#5.2.-Связь-с-Memory-и-PolicyEngine */
  policyEngine: 'policyEngine' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#http-1-services */
  slackHttpClient: 'slackHttpClient' as const,
  /**
   * PascalCase alias for `slackHttpClient` — naming convention consistency.
   * @see AUDIT C6: other tokens use PascalCase (HttpServer, IConfigLoader, etc.)
   */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#http-1-services */
  SlackHttpClient: 'slackHttpClient' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Other-Layer-4-interfaces */
  slackIntegrationAdapter: 'slackIntegrationAdapter' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Other-Layer-4-interfaces */
  integrationHub: 'integrationHub' as const,

  // Skills (extended)
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Layer-1b:-Scientific-Skills-Ports-Plugin-System */
  IPythonSkillBridge: 'IPythonSkillBridge' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Layer-1b:-Scientific-Skills-Ports-Plugin-System */
  IScientificSkillPlugin: 'IScientificSkillPlugin' as const,

  // HTTP & Bridges
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#http-1-services */
  HttpClient: 'HttpClient' as const,

  // Channel Adapters (Step 22)
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#Full-Service-Topology */
  IChannelPluginManager: 'IChannelPluginManager' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Layer-4:-Channel-Adapters */
  IChannelDispatcher: 'IChannelDispatcher' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.4.-Observability-и-health‑checks */
  IChannelHealthMonitor: 'IChannelHealthMonitor' as const,
  /** @see src/domain/channels/channel-rate-limiter.interface.ts */
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#Example-39:-Rate-Limited-Send */
  IChannelRateLimiter: 'IChannelRateLimiter' as const,
  /** @see src/domain/channels/retryable-channel-sender.interface.ts */
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#Example-40:-Retryable-Channel-Adapter */
  IRetryableChannelSender: 'IRetryableChannelSender' as const,
  /** @see src/domain/channels/circuit-breaker.interface.ts */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Layer-8:-Resilience-&-Discovery */
  ICircuitBreaker: 'ICircuitBreaker' as const,
  /** @see src/domain/messaging/IDeadLetterQueue.ts — channel-specific DLQ instance */
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#Example-99:-Dead-Letter-Queue */
  IChannelDeadLetterQueue: 'IChannelDeadLetterQueue' as const,
  /** @see src/domain/channels/idempotency-store.interface.ts — send deduplication */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.2.-Events-и-Outbox */
  IIdempotencyStore: 'IIdempotencyStore' as const,
  /** @see src/domain/channels/channel-metrics-collector.interface.ts — channel pipeline observability */
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#Example-43:-Channel-Metrics */
  IChannelMetricsCollector: 'IChannelMetricsCollector' as const,
  /** @see src/domain/channels/outbound-queue.interface.ts — priority queue for outbound messages */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#tools-1-services */
  IOutboundQueue: 'IOutboundQueue' as const,
  /** @see src/domain/channels/channel-bulkhead.interface.ts — per-channel concurrency limiter */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Layer-4:-Channel-Adapters */
  IChannelBulkhead: 'IChannelBulkhead' as const,
  /** @see src/infrastructure/channels/workers/DLQReplayWorker.ts — periodic DLQ replay */
  /** @see docs: AI_CHEATSHEET.md#9c.-V8/Vitest/ESLint-Memory-Tuning-PF-084..093 */
  IDLQReplayWorker: 'IDLQReplayWorker' as const,
  /** @see src/infrastructure/channels/workers/QueueDrainWorker.ts — outbound queue drain */
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#Example-103:-Worker-Status */
  IQueueDrainWorker: 'IQueueDrainWorker' as const,

  // Token Estimation (Step 23)
  /** @see docs: AI_CHEATSHEET.md#4.-Key-DI-Tokens */
  ITokenEstimator: 'ITokenEstimator' as const,

  // LLM Circuit Breaker (Step 24)
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#Mistake-2:-Not-Checking-Circuit-Breaker-State */
  ILlmCircuitBreakerAdapter: 'ILlmCircuitBreakerAdapter' as const,

  // Persistent Queue (Step 25)
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#Example-42:-Message-Queue-Integration */
  IQueueAdapter: 'IQueueAdapter' as const,

  // Config Validation (Step 26)
  /** @see docs: AI_CHEATSHEET.md#9c.-V8/Vitest/ESLint-Memory-Tuning-PF-084..093 */
  IConfigValidator: 'IConfigValidator' as const,

  // Observability (Step 27)
  /** @see docs: 04-REFERENCE/ERROR_HANDLING_GUIDE.md#Error-Metrics-Collection */
  IMetricsCollector: 'IMetricsCollector' as const,

  // Horizon 2 — FinOps (Tokenomics Cost Governance)
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#singularity-1-services */
  ITokenomicsController: 'ITokenomicsController' as const,
  /** @see src/infrastructure/finops/PostgresSpendStateStore.ts — Durable spend persistence */
  /** @see docs: 04-REFERENCE/architecture.md#7.3.2-Partitioned-Event-Store-cutover-states-R2.2/R2.4 */
  ISpendStateStore: 'ISpendStateStore' as const,

  // Hermes Integration (ported from Hermes-Agent)
  /** @see src/infrastructure/security/exec/DangerousCommandDetector.ts — CommandApprovalAllowlist */
  /** @see docs: AI_CHEATSHEET.md#8.-Commands */
  IDangerousCommandDetector: 'IDangerousCommandDetector' as const,
  /** @see src/infrastructure/ai/auxiliary-llm-client.ts — resolveAuxiliaryClient() */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.4.-Observability-и-health‑checks */
  IAuxiliaryLLMClient: 'IAuxiliaryLLMClient' as const,
  /** @see src/infrastructure/context/hermes-context-compressor.ts — HermesContextCompressor */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.3.-RequestContext */
  IHermesContextCompressor: 'IHermesContextCompressor' as const,
  /** @see src/infrastructure/sandbox/process-registry.ts — ProcessRegistry */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Layer-5:-Context-Processing */
  IProcessRegistry: 'IProcessRegistry' as const,
  /** @see src/infrastructure/sandbox/environment-pool.ts — EnvironmentPool */
  /** @see docs: AI_CHEATSHEET.md#9.-Anti-Patterns-break-arch-tests */
  IEnvironmentPool: 'IEnvironmentPool' as const,
  /** @see src/domain/security/content-threat-scanner.ts — scanContentForThreats() */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Phase-0K:-RECON-K-—-Knowledge-Reconnaissance */
  IContentThreatScanner: 'IContentThreatScanner' as const,
  /** @see src/domain/security/skills-guard.ts — scanSkill(), shouldAllowInstall() */
  /** @see docs: docs/TESTING_GUIDE.md#Preflight-Guard:-Hot-Path-Logging-Check-17 */
  ISkillsGuard: 'ISkillsGuard' as const,
  /** @see src/application/services/system-prompt/hermes-prompt-layers.ts — assembleSystemPrompt() */
  /** @see docs: docs/protocols/ANTI_STUB_POLICY_SOTA_2026.md#План-Внедрения-в-Рабочий-Процесс-ИИ-Программиста */
  IHermesPromptLayers: 'IHermesPromptLayers' as const,
  /** @see src/core/tools/toolset-registry.ts — ToolsetRegistry */
  /** @see docs: AI_CHEATSHEET.md#4.-Key-DI-Tokens */
  IToolsetRegistry: 'IToolsetRegistry' as const,
  /** @see src/infrastructure/ai/model-metadata-registry.ts — ModelMetadataRegistry */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.9.-MCP-Servers-Model-Context-Protocol */
  IModelMetadataRegistry: 'IModelMetadataRegistry' as const,
  /** @see src/domain/security/file-operations-safety.ts — checkWritePermission() */
  /** @see docs: AI_CHEATSHEET.md#5.-Where-to-Put-New-Code */
  IFileOperationsSafety: 'IFileOperationsSafety' as const,
  /** @see src/domain/session/session-reset-policy.ts — evaluateSessionReset() */
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#5.2.-Связь-с-Memory-и-PolicyEngine */
  ISessionResetPolicy: 'ISessionResetPolicy' as const,
  /** @see src/infrastructure/logging/debug-session.ts — DebugSession */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.12.-PUA-v5.3-—-Exhaustive-Debugging-Protocol */
  IDebugSession: 'IDebugSession' as const,

  // Hermes H7: New extractions (MicroPhoenix v2.9.0, Hermes v2 commit 152e080)
  /** @see src/domain/ai/mcp-client-registry.port.ts — MCP client connections to external servers */
  /** @see docs: 04-REFERENCE/testing-patterns.md#tests/performance/test_performance.ts */
  IMcpClientRegistry: 'IMcpClientRegistry' as const,
  /** @see src/application/agents/services/McpToolDiscoveryService.ts — Lazy MCP tool discovery + IAgentTool bridge */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#Module-Level-Topology */
  IMcpToolDiscoveryService: 'IMcpToolDiscoveryService' as const,
  /** @see src/core/hooks/hook-registry.ts — Lightweight lifecycle event hooks */
  /** @see docs: AI_CHEATSHEET.md#4.-Key-DI-Tokens */
  IHookRegistry: 'IHookRegistry' as const,
  /** @see src/core/security/sensitive-text-redactor.ts — API key/token/credential redaction */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.3.-RequestContext */
  ISensitiveTextRedactor: 'ISensitiveTextRedactor' as const,

  // A2A Protocol (Horizon 2-3 — Agent-to-Agent, Linux Foundation RC v1.0)
  /** @see src/domain/a2a/IAgentCardProvider.ts — AgentCard discovery port */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#ai-47-services */
  IAgentCardProvider: 'IAgentCardProvider' as const,

  // MCP↔A2A Bridge (Horizon 1 — Tool bridge between protocols)
  /** @see src/domain/mcp/IMcpBridge.ts — MCP↔A2A tool bridge port */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.9.-MCP-Servers-Model-Context-Protocol */
  IMcpBridge: 'IMcpBridge' as const,

  // Horizon 2: A2A Authorization Guard (OAuth 2.1 Streamable HTTP)
  /** @see src/domain/a2a/IA2AAuthorizationGuard.ts — A2A/MCP authorization port */
  /** @see docs: docs/TESTING_GUIDE.md#Preflight-Guard:-Hot-Path-Logging-Check-17 */
  IA2AAuthorizationGuard: 'IA2AAuthorizationGuard' as const,
  /** @see src/domain/a2a/a2a-x402-payment.interface.ts — merchant policy for paid A2A execution */
  /** @see docs: AI_CHEATSHEET.md#11.-Grep-Index */
  IA2AX402MerchantPolicy: 'IA2AX402MerchantPolicy' as const,
  /** @see src/domain/a2a/a2a-x402-commerce.interface.ts — billing-grade commerce metering port */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#6.2-Security-Adaptations */
  IA2AX402CommerceMeter: 'IA2AX402CommerceMeter' as const,
  /** @see src/domain/a2a/a2a-x402-payment.interface.ts — payment record repository */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#repositories-3-services */
  IA2AX402PaymentRepository: 'IA2AX402PaymentRepository' as const,
  /** @see src/domain/a2a/a2a-x402-payment.interface.ts — replay-safe nonce reservation */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.2.-Events-и-Outbox */
  IA2AX402NonceStore: 'IA2AX402NonceStore' as const,
  /** @see src/domain/a2a/a2a-x402-payment.interface.ts — settlement boundary */
  /** @see docs: ARCHITECTURE_GUIDE.md#3.4.-Clean-Architecture:-Ports-Pattern-Пример */
  IA2AX402SettlementPort: 'IA2AX402SettlementPort' as const,
  /** @see src/application/services/a2a/A2AX402PaymentService.ts — payment challenge service */
  /** @see docs: 04-REFERENCE/technical/a2a-x402-architecture.md#2.-Общая-схема */
  RequireA2AX402PaymentService: 'RequireA2AX402PaymentService' as const,
  /** @see src/application/services/a2a/A2AX402PaymentService.ts — payment submission service */
  /** @see docs: 04-REFERENCE/technical/a2a-x402-architecture.md#9.-Интерфейсы-проектируемые-API,-выдержки */
  SubmitA2AX402PaymentService: 'SubmitA2AX402PaymentService' as const,

  // Horizon 2: Semantic Paging Service / S-MMU (Context Engineering)
  /** @see src/domain/context/ISemanticPagingService.ts — multi-tier semantic memory port */
  /** @see docs: AI_CHEATSHEET.md#DI-&-Events */
  ISemanticPagingService: 'ISemanticPagingService' as const,

  // Horizon 2: Archival Memory Plane (Tier 3 standalone surface)
  /** @see src/domain/memory/IArchivalMemory.ts — cold-tier archival memory port */
  /** @see src/infrastructure/context/adapters/VectorArchivalProvider.ts — pgvector archival adapter */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.6.-Память */
  IArchivalMemory: 'IArchivalMemory' as const,
  /** @see src/infrastructure/context/adapters/VectorArchivalProvider.ts — canonical archival adapter */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.6.-Память */
  IArchivalMemoryAdapter: 'IArchivalMemoryAdapter' as const,

  // Horizon 2: S-MMU Factory — unified factory for creating S-MMU instances (DEEP-01 fix)
  /** @see src/domain/context/ISemanticPagingServiceFactory.ts — factory port */
  /** @see src/infrastructure/context/SemanticPagingServiceFactory.ts — adapter */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#mas_core-17-services */
  ISemanticPagingServiceFactory: 'ISemanticPagingServiceFactory' as const,

  // Horizon 2: Predictive S-MMU / Predictive Context Prefetcher (Phase 6)
  /** @see src/domain/context/IPredictiveContextService.ts — predictive context prefetching port */
  /** @see src/application/services/context/PredictiveContextPrefetcher.ts — orchestrator */
  /** @see docs: docs/TESTING_GUIDE.md#Unit-Test-L0 */
  IPredictiveContextService: 'IPredictiveContextService' as const,

  // Horizon 6: Seed Injection — Entropy Guard for deterministic Markov weighted sampling
  /** @see src/core/utils/DeterministicRng.ts — seedable Mulberry32 PRNG */
  /** @see docs: 04-REFERENCE/ERROR_HANDLING_GUIDE.md#Вектор-1:-Agentic-Time-Travel-Debugging-ATTD-—-Q3-2027 */
  DeterministicRng: 'DeterministicRng' as const,
  /** @see src/application/services/context/PredictiveContextPrefetcher.ts — IQueryPredictor interface */
  /** @see src/infrastructure/context/prediction/MarkovContextPredictor.ts — implementation */
  /** @see docs: 04-REFERENCE/ERROR_HANDLING_GUIDE.md#Вектор-4:-OOM-&-GC-Leak-Predictors-—-Q4-2026 */
  IQueryPredictor: 'IQueryPredictor' as const,

  // Horizon 2: Knowledge Graph Provider / GraphRAG (Phase 5.5)
  /** @see src/infrastructure/context/graph/KnowledgeGraphProvider.ts — AST-driven graph adapter */
  /** @see src/application/services/context/SemanticPagingService.ts — IGraphContextProvider port */
  /** @see docs: AI_CHEATSHEET.md#S-MMU-Semantic-Memory-Management-Unit-—-4-Tier-Architecture */
  IGraphContextProvider: 'IGraphContextProvider' as const,

  // Horizon 1: Constitutional AI Guard (EU AI Act compliance)
  /** @see src/domain/security/IConstitutionalGuard.ts — Constitutional AI governance port */
  /** @see docs: docs/TESTING_GUIDE.md#Preflight-Guard:-Hot-Path-Logging-Check-17 */
  IConstitutionalGuard: 'IConstitutionalGuard' as const,

  // Horizon 4: Post-Quantum Cryptography Provider (Phase 8 — Singularity)
  /** @see src/domain/security/pq-crypto.interface.ts — PQC crypto-agile port (ML-KEM, ML-DSA) */
  /** @see docs: AI_CHEATSHEET.md#S-MMU-Semantic-Memory-Management-Unit-—-4-Tier-Architecture */
  IPqcCryptoProvider: 'IPqcCryptoProvider' as const,

  // Horizon 4: Formal Proof Engine (Phase 8 — Singularity Core Auditor)
  /** @see src/domain/evaluation/formal-prover.interface.ts — Lean 4 / Coq proof compilation port */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.10.-Code-Intelligence-GitNexus-GraphRAG */
  IFormalProofEngine: 'IFormalProofEngine' as const,

  // Horizon 2: Retrieval Evaluator (Self-Reflective RAG)
  /** @see src/domain/ai/IRetrievalEvaluator.ts — RAG-Critic self-correction port */
  /** @see docs: AI_CHEATSHEET.md#9d.-SOTA-2026-Core-Upgrades-Anti-Stub-Verified */
  IRetrievalEvaluator: 'IRetrievalEvaluator' as const,

  // Horizon 2: Event Sourcing Projector (Graph RAG preparation)
  /** @see src/domain/events/IEventProjector.ts — event projection / Read Model port */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.2.-Events-и-Outbox */
  IEventProjector: 'IEventProjector' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // Agentic Design Patterns (Book: Gulli, Springer 2026)
  // Registered: Phase 0 — Preparation & Infrastructure Scaffold
  // ═══════════════════════════════════════════════════════════════════════════

  // --- Wave A: Foundation (Phase 1 — unlocks 80% of dependent patterns) ---
  /** @see src/domain/evaluation/llm-judge.interface.ts — Ch.19+11+17+18 hub interface */
  /** @see docs: AI_CHEATSHEET.md#9d.-SOTA-2026-Core-Upgrades-Anti-Stub-Verified */
  ILlmJudge: 'ILlmJudge' as const,
  /** @see src/domain/reasoning/reflection-loop.interface.ts — Ch.4+17 reflection loop */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#9.4-Protocol-Self-Improvement-Loop-NEW-in-v2.2.0 */
  IReflectionLoop: 'IReflectionLoop' as const,
  /** @see src/domain/routing/prompt-classifier.interface.ts — Ch.2+16 prompt classifier */
  /** @see docs: docs/protocols/ANTI_STUB_POLICY_SOTA_2026.md#План-Внедрения-в-Рабочий-Процесс-ИИ-Программиста */
  IPromptClassifier: 'IPromptClassifier' as const,

  // --- Wave B: Reasoning (Phase 2) ---
  /** @see src/domain/reasoning/structured-reasoning.interface.ts — Ch.17 5-phase CoT */
  /** @see docs: ARCHITECTURE_GUIDE.md#3.2.-Допустимые-зависимости */
  IStructuredReasoningProtocol: 'IStructuredReasoningProtocol' as const,
  /** @see src/domain/reasoning/self-correction.interface.ts — Ch.17 self-correction agent */
  /** @see docs: ARCHITECTURE_GUIDE.md#3.3.-Диаграмма-слоёв */
  ISelfCorrectionAgent: 'ISelfCorrectionAgent' as const,

  // --- Wave C: Evaluation & Safety (Phase 3) ---
  /** @see src/domain/evaluation/goal-evaluator.interface.ts — Ch.11 goal evaluation */
  /** @see docs: AI_CHEATSHEET.md#9d.-SOTA-2026-Core-Upgrades-Anti-Stub-Verified */
  IGoalEvaluator: 'IGoalEvaluator' as const,
  /** @see src/domain/evaluation/response-evaluator.interface.ts — Ch.19 dual-dimension eval */
  /** @see docs: AI_CHEATSHEET.md#9d.-SOTA-2026-Core-Upgrades-Anti-Stub-Verified */
  IResponseEvaluator: 'IResponseEvaluator' as const,
  /** @see src/domain/guardrails/input-pipeline.interface.ts — Ch.18 input guardrails */
  /** @see docs: docs/TESTING_GUIDE.md#CI-pipeline-optimized-order */
  IInputGuardrailPipeline: 'IInputGuardrailPipeline' as const,
  /** @see src/domain/guardrails/output-pipeline.interface.ts — Ch.18 output guardrails */
  /** @see docs: docs/TESTING_GUIDE.md#CI-pipeline-optimized-order */
  IOutputGuardrailPipeline: 'IOutputGuardrailPipeline' as const,
  /** @see src/domain/evaluation/iterative-refiner.interface.ts — Ch.11 iterative refiner */
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  IIterativeRefiner: 'IIterativeRefiner' as const,

  // --- Wave D: Planning & Scheduling (Phase 4) ---
  /** @see src/domain/scheduling/task-prioritizer.interface.ts — Ch.20 task priority */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.7.-Feature‑флаги */
  ITaskPrioritizer: 'ITaskPrioritizer' as const,
  /** @see src/domain/exploration/evolution-engine.interface.ts — Ch.9 evolutionary search */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.10.-Code-Intelligence-GitNexus-GraphRAG */
  IEvolutionEngine: 'IEvolutionEngine' as const,
  /** @see src/domain/exploration/fitness-evaluator.interface.ts — Ch.9 fitness-driven selection */
  /** @see docs: AI_CHEATSHEET.md#9d.-SOTA-2026-Core-Upgrades-Anti-Stub-Verified */
  IFitnessEvaluator: 'IFitnessEvaluator' as const,

  // --- Wave E: Chains & Pipelines (Phase 5) ---
  /** @see src/domain/chains/prompt-chain.interface.ts — Ch.1 prompt chain pipeline */
  /** @see docs: AI_CHEATSHEET.md#2.-Hard-Invariants-NEVER-violate */
  IPromptChainExecutor: 'IPromptChainExecutor' as const,
  /** @see src/domain/research/deep-research.interface.ts — Ch.6 deep research pipeline */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.11.-TIM-—-Trajectory-Informed-Memory */
  IDeepResearchService: 'IDeepResearchService' as const,
  /** @see src/domain/research/citation-extractor.interface.ts — Ch.6 citation annotation */
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  ICitationExtractor: 'ICitationExtractor' as const,

  // --- Wave F: Inter-Agent (Phase 6) ---
  /** @see src/domain/mcp/mcp-tool-consumer.interface.ts — Ch.10 MCP client */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Donor-Extraction-Protocol-—-Dual-Pipeline-Architecture */
  IMcpToolConsumer: 'IMcpToolConsumer' as const,
  /** @see src/domain/a2a/a2a-task-runner.interface.ts — Ch.15 A2A task runner */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#agent_runner-3-services */
  IA2ATaskRunner: 'IA2ATaskRunner' as const,
  /** @see src/domain/a2a/a2a-stream.interface.ts — Ch.15 A2A stream transport */
  /** @see docs: 04-REFERENCE/architecture.md#6.-Миграция:-4/6/9-→-10-слоев */
  IA2AStreamTransport: 'IA2AStreamTransport' as const,
  /** @see src/domain/mas/agent-dialogue-loop.interface.ts — Ch.7 iterative MAS dialogue */
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#Example-113:-Agent-Runner-Loop */
  IAgentDialogueLoop: 'IAgentDialogueLoop' as const,

  // --- Wave G: Advanced (Phase 7) ---
  /** @see src/domain/routing/cost-aware-model-selector.interface.ts — Ch.16 cost optimization */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.9.-MCP-Servers-Model-Context-Protocol */
  ICostAwareModelSelector: 'ICostAwareModelSelector' as const,
  /** @see src/domain/evaluation/reviewer-panel.interface.ts — Ch.21 multi-persona review */
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  IReviewerPanel: 'IReviewerPanel' as const,
  /** @see src/domain/exploration/research-lab.interface.ts — Ch.21 research lab orchestrator */
  /** @see docs: ARCHITECTURE_GUIDE.md#2.1.-Диаграмма-runtime‑цепочки */
  IResearchLabOrchestrator: 'IResearchLabOrchestrator' as const,
  /** @see src/domain/exploration/research-state.interface.ts — Ch.21 research agent state */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Academic-Foundation-NEW-in-v2.2.0 */
  IResearchAgentState: 'IResearchAgentState' as const,

  // --- Wave H: Cross-Cutting (Gap Analysis — Ch.3,5,8,12,13,14 + Anthropic guide) ---
  /** @see src/domain/execution/agent-budget.interface.ts — Ch.12+Anthropic stopping conditions */
  /** @see docs: docs/TESTING_GUIDE.md#Horizon-3:-Multi-Agent-Swarm-Testing */
  IAgentBudget: 'IAgentBudget' as const,
  /** @see src/domain/execution/recovery-strategy.interface.ts — Ch.12 exception recovery */
  /** @see docs: docs/TESTING_GUIDE.md#Worker-Strategy */
  IRecoveryStrategy: 'IRecoveryStrategy' as const,
  /** @see src/domain/execution/checkpointable-flow.interface.ts — Ch.12 checkpoint/resume */
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.5.3.-Поток-CIRCUIT_OPEN-end‑to‑end */
  ICheckpointableFlow: 'ICheckpointableFlow' as const,
  /** @see src/domain/security/autonomy-level.interface.ts — Ch.13 configurable HITL */
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.7.3.-Поток-политик-в-MasterAgentV1-non‑durable-ветка */
  IAutonomyLevel: 'IAutonomyLevel' as const,
  /** @see src/domain/feedback/user-feedback-collector.interface.ts — Ch.13 feedback loop */
  /** @see docs: docs/TESTING_GUIDE.md#Run-unit-tests-fast-feedback-≈-30s */
  IUserFeedbackCollector: 'IUserFeedbackCollector' as const,
  /** @see src/domain/evaluation/voting-aggregator.interface.ts — Ch.3 ensemble/voting */
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  IVotingAggregator: 'IVotingAggregator' as const,
  /** @see src/domain/execution/concurrency-limiter.interface.ts — Ch.3 rate limiting */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#tools-1-services */
  IConcurrencyLimiter: 'IConcurrencyLimiter' as const,
  /** @see src/domain/agents/tool-result-summarizer.interface.ts — Ch.5 tool output truncation */
  /** @see docs: docs/ARCHITECTURE_VALIDATION.md#4.-Summary-Generator-tools/generate-validation-summary.ts */
  IToolResultSummarizer: 'IToolResultSummarizer' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // OpenClaw Extraction V3 (Sprint 1-2 — Security, Memory, Agent Utilities)
  // ═══════════════════════════════════════════════════════════════════════════

  // --- P0 Security: ReDoS Protection ---
  /** @see src/domain/security/safe-regex-compiler.port.ts — AST-based nested repetition detection */
  /** @donor external/openclaw/src/security/safe-regex.ts (333L, 0 deps) */
  /** @owasp Denial of Service — user-supplied regex in tool args / skill files */
  /** @see docs: docs/TESTING_GUIDE.md#PoC-Test-Files-—-Phase-1-5-files,-64-tests */
  ISafeRegexCompiler: 'ISafeRegexCompiler' as const,

  // --- P0 Security: External Content Wrapping (Prompt Injection 2.0) ---
  /** @see src/domain/security/external-content-scanner.port.ts — untrusted content wrapping for LLM */
  /** @donor external/openclaw/src/security/external-content.ts (350L, 1 dep: node:crypto) */
  /** @owasp LLM01 (Prompt Injection 2.0), Memory Poisoning */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#External-/-Unresolved-Dependencies */
  IExternalContentScanner: 'IExternalContentScanner' as const,

  // --- P0 Security: Skill/Plugin Code Scanner ---
  /** @see src/domain/security/skill-scanner.port.ts — deep-scan skill/plugin source files for dangerous patterns */
  /** @donor external/openclaw/src/security/skill-scanner.ts (584L) */
  /** @owasp Goal Hijacking, Tool Misuse */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#Module-Level-Topology */
  ISkillScanner: 'ISkillScanner' as const,

  // --- P1 Memory: FTS Query Expansion (8 languages) ---
  /** @see src/domain/memory/query-expansion.port.ts — multi-language keyword extraction for FTS fallback */
  /** @donor external/openclaw/src/memory/query-expansion.ts (807L, 0 deps) */
  /** @see docs: AI_CHEATSHEET.md#DI-&-Events */
  IQueryExpansionService: 'IQueryExpansionService' as const,

  // --- P2 Agent: Context Window Guard ---
  /** @see src/domain/agents/context-window-guard.port.ts — warn/block on context window limits */
  /** @donor external/openclaw/src/agents/context-window-guard.ts (82L) */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.3.-RequestContext */
  IContextWindowGuard: 'IContextWindowGuard' as const,

  // --- P2 Security: Path Boundary Enforcement ---
  /** @see src/domain/security/path-boundary-enforcer.port.ts — workspace/sandbox path escape prevention */
  /** @donor external/openclaw/src/agents/path-policy.ts (130L) */
  /** @owasp Tool Misuse — restrict filesystem scope */
  /** @see docs: docs/TESTING_GUIDE.md#Preflight-Guard:-Hot-Path-Logging-Check-17 */
  IPathBoundaryEnforcer: 'IPathBoundaryEnforcer' as const,
  /** @see src/domain/security/IAclEnforcer.ts — cross-platform ACL enforcement */
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  IAclEnforcer: 'IAclEnforcer' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // OpenClaw Extraction V4 (Sprint 2 — Agentic Safety, Log Redaction)
  // ═══════════════════════════════════════════════════════════════════════════

  // --- P0 Agent: Tool Loop Detection ---
  /** @see src/domain/agents/tool-loop-detector.port.ts — 4-strategy loop detector */
  /** @donor external/openclaw/src/agents/tool-loop-detection.ts (560L, 1 dep: node:crypto) */
  /** @owasp Agentic Top 10 2026: Resource Exhaustion, Infinite Loop DoS */
  /** @see docs: 04-REFERENCE/architecture.md#ToolRepetitionDetector-Agent-Layer */
  IToolLoopDetector: 'IToolLoopDetector' as const,

  // --- P1 Agent: Tool Result Truncation ---
  /** @see src/domain/agents/tool-result-truncator.port.ts — head+tail smart truncation */
  /** @donor external/openclaw/src/agents/pi-embedded-runner/tool-result-truncation.ts (13.8KB) */
  /** @owasp Agentic Top 10 2026: Context Window Overflow */
  /** @see docs: docs/ARCHITECTURE_VALIDATION.md#4.-Summary-Generator-tools/generate-validation-summary.ts */
  IToolResultTruncator: 'IToolResultTruncator' as const,

  // --- P0 Security: Sensitive Log Redaction ---
  /** @see src/domain/security/log-redactor.port.ts — 17 credential patterns + chunked regex */
  /** @donor external/openclaw/src/logging/redact.ts + redact-bounded.ts (5.6KB) */
  /** @owasp LLM07: Sensitive Information Disclosure */
  /** @see docs: docs/TESTING_GUIDE.md#Unit-Test-L0 */
  ILogRedactor: 'ILogRedactor' as const,

  // --- P1 Agent: Context Pruning ---
  /** @see src/domain/agents/context-pruner.port.ts — soft trim + hard clear, 2-phase */
  /** @donor external/openclaw/src/agents/pi-extensions/context-pruning/pruner.ts (9.3KB) */
  /** @owasp Agentic Top 10 2026: Context Window Overflow */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.3.-RequestContext */
  IContextPruner: 'IContextPruner' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // Error Debugging Evolution — SOTA March 2026 (Ticket #67)
  // 5 Vectors: ATTD, Formal Verification, BFT Consensus, V8 Leak, Auto-Traps
  // ═══════════════════════════════════════════════════════════════════════════

  // --- V5 Q3 2026: Predictive Auto-Traps (GraphRAG KNOWN_BUGS) ---
  /** @see src/domain/debugging/IErrorGraphRepository.ts — GraphRAG error knowledge base */
  /** @see PLANS/06_BLUEPRINTS/ERROR_DEBUGGING_EVOLUTION_SOTA_2026.md §6 */
  /** @see docs: 04-REFERENCE/ERROR_HANDLING_GUIDE.md#Roadmap-Summary */
  IErrorGraphRepository: 'IErrorGraphRepository' as const,
  /** @see src/domain/debugging/IAutoTrapGenerator.ts — LLM-generated ESLint rules */
  /** @see docs: 04-REFERENCE/ERROR_HANDLING_GUIDE.md#Вектор-5:-Predictive-Auto-Traps-GraphRAG-KNOWN_BUGS-—-Q3-2026-★-NEXT */
  IAutoTrapGenerator: 'IAutoTrapGenerator' as const,
  /** @see src/domain/debugging/IJITContextInjector.ts — file-aware bug context injection */
  /** @see docs: AI_CHEATSHEET.md#9c.-SOTA-Bug-Catching-—-GraphRAG-+-BFT-Tribunal-+-End-to-End-Audit */
  IJITContextInjector: 'IJITContextInjector' as const,

  // --- V4 Q4 2026: OOM & GC Leak Predictors ---
  /** @see src/domain/debugging/IHeapSnapshotDiffer.ts — V8 heap snapshot comparison */
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#Example-134:-Heap-Snapshot */
  IHeapSnapshotDiffer: 'IHeapSnapshotDiffer' as const,
  /** @see src/domain/debugging/IAdaptiveBackpressure.ts — GC-driven concurrency control */
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  IAdaptiveBackpressure: 'IAdaptiveBackpressure' as const,

  // --- V3 Q1 2027: Multi-Agent BFT Consensus Debugging ---
  /** @see src/domain/debugging/IBFTErrorRouter.ts — Byzantine Fault Tolerant error routing */
  /** @see docs: AI_CHEATSHEET.md#9c.-SOTA-Bug-Catching-—-GraphRAG-+-BFT-Tribunal-+-End-to-End-Audit */
  IBFTErrorRouter: 'IBFTErrorRouter' as const,

  // --- V1 Q3 2027: Agentic Time-Travel Debugging ---
  /** @see src/domain/debugging/ITimeTravelDebugger.ts — deterministic record & replay */
  /** @see docs: 04-REFERENCE/ERROR_HANDLING_GUIDE.md#Вектор-1:-Agentic-Time-Travel-Debugging-ATTD-—-Q3-2027 */
  ITimeTravelDebugger: 'ITimeTravelDebugger' as const,

  // --- V2 2028+: Formal Verification (Singularity Core Auditor) ---
  /** @see src/domain/debugging/IFormalVerifier.ts — SMT-based invariant proofs */
  /** @see docs: docs/protocols/ANTI_STUB_POLICY_SOTA_2026.md#Уровень-1:-Формальная-Маркировка-Formal-Tagging */
  IFormalVerifier: 'IFormalVerifier' as const,

  // --- Ticket #70: Singularity Execution Pipeline & AGI Containment ---
  /** @see src/domain/security/ISingularityCoreAuditor.ts — L1→L4 audit pipeline */
  /** @see docs: 04-REFERENCE/ERROR_HANDLING_GUIDE.md#Horizon-5:-Singularity-Core-Auditor-L0–L6-Defense-in-Depth */
  ISingularityCoreAuditor: 'ISingularityCoreAuditor' as const,
  /** @see src/domain/context/IHolographicContextProvider.ts — model-adaptive token budget */
  /** @see docs: AI_CHEATSHEET.md#S-MMU-Semantic-Memory-Management-Unit-—-4-Tier-Architecture */
  IHolographicContextProvider: 'IHolographicContextProvider' as const,

  // --- REC-089: Context Protocol Enhancement (Report 89, March 2026) ---
  /** @see src/domain/context/IContextRelevanceJudge.ts — Self-Reflective RAG Loop (verify → rewrite → retry) */
  /** @see docs: docs/TESTING_GUIDE.md#Competitive-Advantages-Unique-to-MicroPhoenix */
  IContextRelevanceJudge: 'IContextRelevanceJudge' as const,
  /** @see src/domain/context/IHybridRetrievalService.ts — BM25+Vector hybrid retrieval with RRF */
  /** @see docs: AI_CHEATSHEET.md#DI-&-Events */
  IHybridRetrievalService: 'IHybridRetrievalService' as const,
  /** @see src/domain/context/IContextQualityMetrics.ts — Context pipeline observability (Prometheus-ready) */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#bootstrap-18-services */
  IContextQualityMetrics: 'IContextQualityMetrics' as const,
  /** @see src/domain/context/IAgentGatewayProxy.ts — MCP/A2A traffic gateway (rate limiting, audit) */
  /** @see docs: ARCHITECTURE_GUIDE.md#3.3.-Диаграмма-слоёв */
  IAgentGatewayProxy: 'IAgentGatewayProxy' as const,
  /** @see src/domain/context/IIncrementalMdcCompiler.ts — Incremental MDC compilation with dirty-tracking */
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  IIncrementalMdcCompiler: 'IIncrementalMdcCompiler' as const,

  // --- SOTA 2026 Context Engineering (S-MMU v3.22) ---
  /** @see src/domain/context/IRerankerService.ts — Two-stage retrieval reranking (ColBERTv2, cross-encoder) */
  /** @sota Santhanam et al. (2022) arXiv:2112.01488 "ColBERTv2" */
  /** @sota Anthropic (2025) "Contextual Retrieval" — +67% over base RAG with reranking */
  /** @see docs: AI_CHEATSHEET.md#DI-&-Events */
  IRerankerService: 'IRerankerService' as const,
  /** @see src/domain/context/IPromptCompressor.ts — LongLLMLingua-style prompt compression */
  /** @sota Jiang et al. (2024) arXiv:2310.06839 "LongLLMLingua" — 21.4% perf boost, 4x fewer tokens */
  /** @see docs: docs/protocols/ANTI_STUB_POLICY_SOTA_2026.md#План-Внедрения-в-Рабочий-Процесс-ИИ-Программиста */
  IPromptCompressor: 'IPromptCompressor' as const,

  /** @see src/domain/sandbox/IStatefulSandboxOrchestrator.ts — Firecracker persistent microVMs */
  /** @see docs: ARCHITECTURE_GUIDE.md#2.1.-Диаграмма-runtime‑цепочки */
  IStatefulSandboxOrchestrator: 'IStatefulSandboxOrchestrator' as const,
  /** @see src/domain/security/IAGIContainmentProtocol.ts — 7-layer containment meta-orchestrator */
  /** @see docs: 04-REFERENCE/ERROR_HANDLING_GUIDE.md#Horizon-5:-Singularity-Core-Auditor-L0–L6-Defense-in-Depth */
  IAGIContainmentProtocol: 'IAGIContainmentProtocol' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // SOTA 2026 Multi-Agent Extraction (31-advanced-multi-agent-extraction.md)
  // ACI, Critic Feedback Loop, Context Auto-Compaction
  // ═══════════════════════════════════════════════════════════════════════════

  // --- Idea 1: Agent-Computer Interface (SWE-agent / OpenHands pattern) ---
  /** @see src/domain/aci/IAgentComputerInterface.ts — AST navigation, sandbox tests, diff-patch */
  /** @sota Yang et al. (2024) "SWE-agent: Agent-Computer Interfaces" */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Layer-7:-Agent-Runtime */
  IAgentComputerInterface: 'IAgentComputerInterface' as const,

  // --- Idea 2: Critic Feedback Loop (Eco-Evolve pattern) ---
  /** @see src/domain/audit/ICriticFeedbackService.ts — proactive AST-enriched error analysis */
  /** @sota Zhang et al. (2025) "Eco-Evolve: Self-Evolving Multi-Agent Framework" */
  /** @see docs: docs/TESTING_GUIDE.md#Horizon-4:-Self-Healing-PlayPen-SOTA-Cognitive-+-Adversarial-Swarm */
  ICriticFeedbackService: 'ICriticFeedbackService' as const,

  // --- Idea 3: Context Auto-Compaction (ReDel / Deep Agent pattern) ---
  /** @see src/domain/context/context-compactor.interface.ts — Information Crystal compression */
  /** @sota Liu et al. (2025) "ReDel: Recursive Delegation for Multi-Agent Systems" */
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#IContextCompactor */
  IContextCompactor: 'IContextCompactor' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // Pillar 3: LATS & Bayesian Consensus (Horizon 5)
  // Zhou et al. "Language Agent Tree Search" (UIUC, 2024)
  // ═══════════════════════════════════════════════════════════════════════════

  /** @see src/domain/ai/ITreeOfThoughts.ts — LATS tree-structured reasoning */
  /** @sota Zhou et al. (2024) "Language Agent Tree Search" arXiv:2310.04406 */
  /** @see docs: AI_CHEATSHEET.md#9d.-SOTA-2026-Core-Upgrades-Anti-Stub-Verified */
  ITreeOfThoughts: 'ITreeOfThoughts' as const,

  /** @see src/domain/evaluation/IMultiJudgeEvaluator.ts — Bayesian multi-judge consensus */
  /** @pattern Pillar-3 Bayesian Consensus with judge accuracy weight tracking */
  /** @see docs: AI_CHEATSHEET.md#9d.-SOTA-2026-Core-Upgrades-Anti-Stub-Verified */
  IMultiJudgeEvaluator: 'IMultiJudgeEvaluator' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // Pillar 4: Post-Quantum Cryptographic Provenance (Horizon 5)
  // NIST FIPS 204 (ML-DSA) + FIPS 205 (SLH-DSA) Event Chain
  // ═══════════════════════════════════════════════════════════════════════════

  /** @see src/domain/events/IPqcEventChain.ts — PQC event chain signing + verification */
  /** @pattern Pillar-4 PQC Provenance: tamper-evident event chain via ML-DSA signatures */
  /** @see docs: docs/ARCHITECTURE_VALIDATION.md#Overview */
  IPqcEventChain: 'IPqcEventChain' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // Pillar 5: Cognitive CI/CD Quality Gates (Horizon 5)
  // Agentic Auto-Patch: AST failure analysis + auto-fix generation
  // ═══════════════════════════════════════════════════════════════════════════

  /** @see src/domain/ci/IAutoFixAnalyzer.ts — Cognitive CI/CD auto-fix analyzer */
  /** @pattern Pillar-5 Cognitive CI/CD: P1-P3 failure analysis + AST-level auto-patch */
  /** @see docs: 04-REFERENCE/ERROR_HANDLING_GUIDE.md#Вектор-5:-Predictive-Auto-Traps-GraphRAG-KNOWN_BUGS-—-Q3-2026-★-NEXT */
  IAutoFixAnalyzer: 'IAutoFixAnalyzer' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // Wave 1: Cross-Model QA & Permission Escalation (CC-002, CC-012)
  // Knowledge Extraction: claude-code-best-practice (EXTRACTION_SYSTEM V5.2)
  // ═══════════════════════════════════════════════════════════════════════════

  // --- CC-002: Cross-Model QA Workflow (FITNESS-K: 96.5) ---
  /** @see src/domain/evaluation/IMultiModelConsensus.ts — N-model Bayesian consensus verification */
  /** @pattern CC-002 Cross-Model QA: "Agent blindness" mitigation via independent model review */
  /** @see docs: docs/TESTING_GUIDE.md#SOTA-2026:-Eval-Driven-Development-EDD */
  IMultiModelConsensus: 'IMultiModelConsensus' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // Wave 2: Orchestration Pipeline & Workspace Isolation (CC-001, CC-008, CC-014)
  // Knowledge Extraction: claude-code-best-practice (EXTRACTION_SYSTEM V5.2)
  // ═══════════════════════════════════════════════════════════════════════════

  // --- CC-001: Command→Agent→Skill Orchestration (FITNESS-K: 90.5) ---
  /** @see src/domain/agents/IOrchestrationPipeline.ts — Command→Agent→Skill dispatch */
  /** @pattern CC-001 Orchestration: strict separation of agentic roles (Command, Agent, Skill) */
  /** @see docs: docs/TESTING_GUIDE.md#CI-pipeline-optimized-order */
  IOrchestrationPipeline: 'IOrchestrationPipeline' as const,

  // --- CC-008: Worktree Isolation (FITNESS-K: 89.0) ---
  /** @see src/domain/agents/IWorkspaceIsolation.ts — ephemeral git worktree per agent */
  /** @pattern CC-008 Worktree Isolation: filesystem-level agent isolation via git worktrees */
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#Ключевые-изменения-в-v1.1.0 */
  IWorkspaceIsolation: 'IWorkspaceIsolation' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // Wave 3: Autonomous Loop, Batch Execution, Quality Monitoring (CC-009, CC-005, CC-010)
  // Knowledge Extraction: claude-code-best-practice (EXTRACTION_SYSTEM V5.2)
  // ═══════════════════════════════════════════════════════════════════════════

  // --- CC-009: Autonomous Execution Loop (FITNESS-K: 82.5) ---
  /** @see src/domain/agents/IAutonomousExecutionLoop.ts — bounded iterative agent execution */
  /** @pattern CC-009 Ralph Wiggum: check→execute→verify with budget/stall circuit breakers */
  /** @see docs: AI_CHEATSHEET.md#11.-Grep-Index */
  IAutonomousExecutionLoop: 'IAutonomousExecutionLoop' as const,

  // --- CC-009 sub-component: Stall Detector ---
  /** @see src/domain/agents/IAutonomousExecutionLoop.ts — progress-delta stall detection */
  /** @pattern CC-009 sub-component: IStallDetector for progress tracking */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#9.4.3-Immediate-Refresh-Mandate-NEW-in-v2.7.5 */
  IStallDetector: 'IStallDetector' as const,

  // --- CC-005: Batch Tool Execution (FITNESS-K: 81.0) ---
  /** @see src/domain/agents/IBatchToolExecutor.ts — pipelined N-call execution with dependency graph */
  /** @pattern CC-005 PTC: ~37% token reduction via batch tool calling */
  /** @see docs: AI_CHEATSHEET.md#11.-Grep-Index */
  IBatchToolExecutor: 'IBatchToolExecutor' as const,

  // --- CC-010: LLM Quality Monitor (FITNESS-K: 81.5) ---
  /** @see src/domain/ai/ILlmQualityMonitor.ts — runtime quality variance detection */
  /** @pattern CC-010 Quality Variance: 10-layer inference stack anomaly detection */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.4.-Observability-и-health‑checks */
  ILlmQualityMonitor: 'ILlmQualityMonitor' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // Wave 4: RPI Workflow, Memory Scoping, Deferred Tools, Skill Discovery
  //         (CC-003, CC-004, CC-007, CC-011)
  // ═══════════════════════════════════════════════════════════════════════════

  // --- CC-003: Research-Plan-Implement Workflow (FITNESS-K: 77.5) ---
  /** @see src/domain/agents/IResearchPlanImplementWorkflow.ts — 3-phase development methodology */
  /** @pattern CC-003 RPI: Research→Plan→Implement with validation gates */
  /** @see docs: AI_CHEATSHEET.md#10.-Agent-Protocol */
  IResearchPlanImplementWorkflow: 'IResearchPlanImplementWorkflow' as const,

  // --- CC-007: Deferred Tool Loading (FITNESS-K: 71.5) ---
  /** @see src/domain/agents/IDeferredToolRegistry.ts — lazy tool loading with manifests */
  /** @pattern CC-007 Deferred Tools: manifest-based search + on-demand resolution */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#interaction-1-services */
  IDeferredToolRegistry: 'IDeferredToolRegistry' as const,

  // --- CC-011: Skill Discovery (FITNESS-K: 71.5) ---
  /** @see src/domain/agents/ISkillDiscoveryService.ts — monorepo-aware skill discovery */
  /** @pattern CC-011 Skill Discovery: manifest scanning + keyword search + budget-bounded invocation */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#Module-Level-Topology */
  ISkillDiscoveryService: 'ISkillDiscoveryService' as const,

  // --- CC-037: Skill Relation Graph (FITNESS-K: 79) ---
  /** @see src/domain/agents/ISkillRelationGraph.ts — inter-skill relation modeling */
  /** @pattern CC-037 Skill Relation Graph: 4 relation types + graph traversal + composition chains */
  /** @academic SkillNet (arXiv:2603.04448) — Donor #28 EXTRACT-K */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#Module-Level-Topology */
  ISkillRelationGraph: 'ISkillRelationGraph' as const,

  // ── Wave 5 CC contracts (Horizon 4-5: Agent-Programmer & Singularity Core) ───

  // --- CC-013: Agent Teams (FITNESS-K: 73.5) ---
  /** @see src/domain/agents/ISharedTaskList.ts — cross-agent task coordination */
  /** @pattern CC-013 Agent Teams: event-sourced shared task list for multi-agent coordination */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.7.-Feature‑флаги */
  ISharedTaskList: 'ISharedTaskList' as const,

  // --- CC-006: Dynamic Filtering (FITNESS-K: 69.5) ---
  /** @see src/domain/agents/ISemanticToolFilter.ts — query-aware relevance filtering */
  /** @pattern CC-006 Dynamic Filtering: semantic tool result filter (~24% token savings) */
  /** @see docs: 04-REFERENCE/architecture.md#Multi‑Mode-System-Agent-Layer */
  ISemanticToolFilter: 'ISemanticToolFilter' as const,

  // --- T16: MCP Scope Model ---
  /** @see src/domain/mcp/IMcpScopeGuard.ts — MCP access control per agent scope */
  /** @pattern T16 MCP Scope: project/user/subagent scope levels for MCP tool access */
  /** @see docs: docs/protocols/ANTI_STUB_POLICY_SOTA_2026.md#🔴-Пример-1:-Скрытый-ИИ-Стаб-Опасно */
  IMcpScopeGuard: 'IMcpScopeGuard' as const,

  // --- MCP Shared AST Cache ---
  /** @see src/domain/mcp/ISharedASTCache.ts — unified AST parsing cache for MCP servers */
  /** @pattern AST deduplication: shared cache across Context, Docs, Extraction, Audit servers */
  /** @see docs: ARCHITECTURE_GUIDE.md#3.4.-Clean-Architecture:-Ports-Pattern-Пример */
  ISharedASTCache: 'ISharedASTCache' as const,

  // --- T31: Sandbox Isolation ---
  /** @see src/domain/security/INetworkSandbox.ts — network egress control */
  /** @pattern T31 Sandbox: hostname/protocol/agent-scoped network egress isolation */
  /** @see docs: docs/TESTING_GUIDE.md#Chaos-Test-H1 */
  INetworkSandbox: 'INetworkSandbox' as const,

  // ── Wave 6 CC contracts (Deep Audit Re-Extraction) ────────────────────────

  // --- CC-015: Self-Maintaining Documentation (FITNESS-K: 84.5) ---
  /** @see src/domain/agents/IDocumentDriftDetector.ts — drift detection + self-evolving verification */
  /** @pattern CC-015 Self-Maintaining Docs: drift detection, cross-doc consistency, verification rule evolution */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Phase-7K.1:-DOC-K-—-Documentation */
  IDocumentDriftDetector: 'IDocumentDriftDetector' as const,

  // --- CC-020: Drift-Aware Prompt Enrichment (Inverse Symbiotic Injection) ---
  /** @see src/domain/agents/IDriftAwarePromptEnricher.ts — injects drift warnings into agent system prompts */
  /** @pattern CC-020 Inverse Symbiotic Injection: proactive context enrichment from drift detection */
  /** @see docs: docs/protocols/ANTI_STUB_POLICY_SOTA_2026.md#План-Внедрения-в-Рабочий-Процесс-ИИ-Программиста */
  IDriftAwarePromptEnricher: 'IDriftAwarePromptEnricher' as const,

  // --- CC-021: LATS Consensus SSOT Workflow ---
  /** @see src/domain/agents/IUpdateSSOTWorkflow.ts — consensus-based SSOT file updates via LATS tree search */
  /** @pattern CC-021 LATS Consensus Policy: multi-variant SSOT validation with ICriticFeedbackService */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#top */
  IUpdateSSOTWorkflow: 'IUpdateSSOTWorkflow' as const,

  // ── Wave 7 CC contracts (RE-VERIFY Sprint 4) ──────────────────────────────────

  // --- CC-016: Scheduled Task Runner (FITNESS-K: 74) ---
  /** @see src/domain/agents/IScheduledTaskRunner.ts — cron-based recurring agent execution */
  /** @pattern CC-016 Scheduled Task Runner: /loop cron scheduling, deployment polling, PR monitoring */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#agent_runner-3-services */
  IScheduledTaskRunner: 'IScheduledTaskRunner' as const,

  // ── Wave 8 CC contracts (Anthropic Agent Skills + Org Extraction) ────────────

  // --- AS-001: Progressive Disclosure Architecture (FITNESS-K: 82) ---
  /** @see src/domain/agents/IProgressiveDisclosureLoader.ts — 3-level progressive content loading */
  /** @pattern AS-001 Progressive Disclosure: metadata→instructions→resources staged loading */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#bootstrap-18-services */
  IProgressiveDisclosureLoader: 'IProgressiveDisclosureLoader' as const,

  // --- AS-002: Skill Evaluation Runner (FITNESS-K: 73) ---
  /** @see src/domain/agents/ISkillEvaluationRunner.ts — evaluation-driven skill development */
  /** @pattern AS-002 Skill Evaluation: baseline→eval→compare→observe→improve cycle */
  /** @see docs: docs/TESTING_GUIDE.md#LLM-Evaluation-H2 */
  ISkillEvaluationRunner: 'ISkillEvaluationRunner' as const,

  // --- AS-043: Input Sanitization Pipeline (FITNESS-K: 84) ---
  /** @see src/domain/security/IInputSanitizationPipeline.ts — composable content pre-processing */
  /** @pattern AS-043 Input Sanitization Pipeline: 7-stage sanitization before injection detection */
  /** @see docs: docs/TESTING_GUIDE.md#CI-pipeline-optimized-order */
  IInputSanitizationPipeline: 'IInputSanitizationPipeline' as const,

  // ── Wave 9 CC contracts (V8.0 Academic + Industry Re-Extraction) ──

  // --- CC-017: Agent Event Stream (FITNESS-K: 80) ---
  /** @see src/domain/agents/IAgentEventStream.ts — chronological action/observation log */
  /** @pattern CC-017 Agent Event Stream: OpenHands-inspired unified event stream */
  /** @see docs: docs/TESTING_GUIDE.md#CI-/-Pre-PR-Checklist */
  IAgentEventStream: 'IAgentEventStream' as const,

  // --- CC-018: LLM Test Harness (FITNESS-K: 85) ---
  /** @see src/domain/ai/ILlmTestHarness.ts — deterministic LLM response mocking/replay */
  /** @pattern CC-018 LLM Test Harness: cassette-based prompt-response recording */
  /** @see docs: AI_CHEATSHEET.md#9.-Anti-Patterns-break-arch-tests */
  ILlmTestHarness: 'ILlmTestHarness' as const,

  // --- CC-019: Execution Provenance Tracer (FITNESS-K: 80) ---
  /** @see src/domain/agents/IExecutionProvenanceTracer.ts — file/terminal citation tracking */
  /** @pattern CC-019 Execution Provenance: Codex-inspired citation with line-level precision */
  /** @see docs: AI_CHEATSHEET.md#9a.-Implementation-Status-Markers */
  IExecutionProvenanceTracer: 'IExecutionProvenanceTracer' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // PUA Phase 12: CBV Shadow Auditor, S2I Lesson Extractor, TEE Attestation
  // (CC-022, CC-023, CC-024)
  // ═══════════════════════════════════════════════════════════════════════════

  // --- CC-022: CBV Shadow Auditor (PUA Phase 12 → codified) ---
  /** @see src/domain/evaluation/ICbvShadowAuditor.ts — adversarial self-audit via independent model */
  /** @pattern CC-022 CBV Shadow Auditor: Stechly arXiv:2310.12397 + MONA arXiv:2501.13011 */
  /** @see docs: 04-REFERENCE/testing-patterns.md#R2.4-Event-Store-cutover-scaffolding,-shadow-read-C1/C2-и-partial/full-cutover-C3/C4 */
  ICbvShadowAuditor: 'ICbvShadowAuditor' as const,

  // --- CC-023: S2I Lesson Extractor (PUA Phase 12 → codified) ---
  /** @see src/domain/agents/IS2iLessonExtractor.ts — automated SAMULE lesson extraction */
  /** @pattern CC-023 S2I Lesson Extractor: SAMULE arXiv:2509.20562 + TDAD arXiv:2603.08806 */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#10.2-Inputs */
  IS2iLessonExtractor: 'IS2iLessonExtractor' as const,

  // --- CC-024: TEE Attestation Verifier (PUA Phase 12 → codified) ---
  /** @see src/domain/security/ITeeAttestationVerifier.ts — hardware-backed attestation for high-risk ops */
  /** @pattern CC-024 Hardware-Aware Sovereign: teeML (Flashbots) + RATS RFC 9334 */
  /** @sota-stub Current implementation is simulated */
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#IBrowserServer */
  ITeeAttestationVerifier: 'ITeeAttestationVerifier' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // PUA v5.1: Cognitive Load Governor, Intent Misalignment Detector, Wisdom Consolidator
  // (CC-025, CC-026, CC-027)
  // ═══════════════════════════════════════════════════════════════════════════

  // --- CC-025: Cognitive Load Governor (PUA v5.1 → codified) ---
  /** @see src/domain/agents/ICognitiveLoadGovernor.ts — PROBE-based proactivity throttling */
  /** @pattern CC-025 Cognitive Load Governor: PROBE arXiv:2510.19771 + Taming OpenClaw arXiv:2603.11619 */
  /** @see docs: docs/TESTING_GUIDE.md#Horizon-4:-Self-Healing-PlayPen-SOTA-Cognitive-+-Adversarial-Swarm */
  ICognitiveLoadGovernor: 'ICognitiveLoadGovernor' as const,

  // --- CC-026: Intent Misalignment Detector (PUA v5.1 → IBAC 2.0) ---
  /** @see src/domain/security/IIntentMisalignmentDetector.ts — adversarial worst-case interpretation */
  /** @pattern CC-026 Intent Misalignment Detector: Taming OpenClaw arXiv:2603.11619 + Park arXiv:2511.12001 */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Protocol-Overview */
  IIntentMisalignmentDetector: 'IIntentMisalignmentDetector' as const,

  // --- CC-027: Wisdom Consolidator (PUA v5.1 → Ebbinghaus 2.1) ---
  /** @see src/domain/memory/IWisdomConsolidator.ts — SAGE micro→macro lesson consolidation */
  /** @pattern CC-027 Wisdom Consolidator: SAMULE arXiv:2509.20562 + Mouzouni arXiv:2602.21368 */
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  IWisdomConsolidator: 'IWisdomConsolidator' as const,

  // ═══════════════════════════════════════════════════════════════════════════
  // PUA v5.2: Dynamic Cognitive Budget, Intent Graph, Contrastive Lessons,
  // Cross-Model Consensus, Attested Intent Lifecycle
  // (CC-028, CC-029, CC-030, CC-031, CC-032)
  // ═══════════════════════════════════════════════════════════════════════════

  // --- CC-028: Dynamic Cognitive Budget (PUA v5.2 → extends CC-025) ---
  /** @see src/domain/agents/IDynamicCognitiveBudget.ts — criticality-aware budget allocation */
  /** @pattern CC-028 Dynamic Cognitive Budget: Epistemic Stability M3 arXiv:2603.10047 + ECL arXiv:2601.21742 */
  /** @see docs: docs/TESTING_GUIDE.md#Horizon-3:-Multi-Agent-Swarm-Testing */
  IDynamicCognitiveBudget: 'IDynamicCognitiveBudget' as const,

  // --- CC-029: Intent Graph Analyzer (PUA v5.2 → IBAC 3.0, extends CC-026) ---
  /** @see src/domain/security/IIntentGraphAnalyzer.ts — file-dependency graph proximity analysis */
  /** @pattern CC-029 Intent Graph Analyzer: ECL arXiv:2601.21742 + Taming OpenClaw arXiv:2603.11619 */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Graph-Port-Taxonomy */
  IIntentGraphAnalyzer: 'IIntentGraphAnalyzer' as const,

  // --- CC-030: Contrastive Lesson Learner (PUA v5.2 → Ebbinghaus 3.0, extends CC-027) ---
  /** @see src/domain/memory/IContrastiveLessonLearner.ts — success/failure trajectory comparison */
  /** @pattern CC-030 Contrastive Lesson Learner: Epistemic Stability M1 arXiv:2603.10047 + SAMULE arXiv:2509.20562 */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#9.4-Protocol-Self-Improvement-Loop-NEW-in-v2.2.0 */
  IContrastiveLessonLearner: 'IContrastiveLessonLearner' as const,

  // --- CC-031: Cross-Model Shadow Consensus (PUA v5.2 → CBV 2.0, extends CC-022) ---
  /** @see src/domain/evaluation/ICrossModelShadowConsensus.ts — multi-model audit consensus */
  /** @pattern CC-031 Cross-Model Shadow Consensus: ECL arXiv:2601.21742 + Stechly arXiv:2310.12397 */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.9.-MCP-Servers-Model-Context-Protocol */
  ICrossModelShadowConsensus: 'ICrossModelShadowConsensus' as const,

  // --- CC-032: Attested Intent Lifecycle (PUA v5.2 → TEE 2.0, extends CC-024) ---
  /** @see src/domain/security/IAttestedIntentLifecycle.ts — TEE-signed intent lifecycle for write gating */
  /** @pattern CC-032 Attested Intent Lifecycle: ECL arXiv:2601.21742 + Taming OpenClaw stage 5 arXiv:2603.11619 */
  /** @sota-stub TEE signing simulated */
  /** @see docs: docs/TESTING_GUIDE.md#DI-Lifecycle-Guard */
  IAttestedIntentLifecycle: 'IAttestedIntentLifecycle' as const,

  // --- CC-032+: Hardware Enclave Provider (PUA v5.3 → TEE bridge) ---
  /** @see src/domain/security/IHardwareEnclaveProvider.ts — hardware enclave abstraction (SGX/SNP/TrustZone) */
  /** @pattern CC-032+ Hardware Enclave: Taming OpenClaw stage 5 arXiv:2603.11619 */
  /** @sota-stub Hardware enclave simulated — no real TEE available */
  /** @see docs: AI_CHEATSHEET.md#S-MMU-Semantic-Memory-Management-Unit-—-4-Tier-Architecture */
  IHardwareEnclaveProvider: 'IHardwareEnclaveProvider' as const,

  // --- CC-029+: Semantic Proximity Provider (PUA v5.3 → Vector-Augmented Graph) ---
  /** @see src/domain/security/ISemanticProximityProvider.ts — vector-based file similarity for intent graph */
  /** @pattern CC-029+ Semantic Proximity: S-MMU Tier 3 arXiv:2603.10047 */
  /** @sota-stub Semantic embeddings simulated — Tier 3 S-MMU pending */
  /** @see docs: AI_CHEATSHEET.md#S-MMU-Semantic-Memory-Management-Unit-—-4-Tier-Architecture */
  ISemanticProximityProvider: 'ISemanticProximityProvider' as const,

  // --- CC-033: Trajectory Intelligence Extractor (TIM arXiv:2603.10600) ---
  /** @see src/domain/memory/ITrajectoryIntelligenceExtractor.ts — semantic reasoning pattern extraction */
  /** @pattern CC-033 Trajectory Intelligence: TIM arXiv:2603.10600 §3.1 */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#9.4.1-TIM-Integration-—-Trajectory-Informed-Memory-NEW-in-v2.6.0 */
  ITrajectoryIntelligenceExtractor: 'ITrajectoryIntelligenceExtractor' as const,

  // --- CC-034: Decision Attribution Analyzer (TIM arXiv:2603.10600) ---
  /** @see src/domain/memory/IDecisionAttributionAnalyzer.ts — causal chain attribution (immediate→proximate→root cause) */
  /** @pattern CC-034 Decision Attribution: TIM arXiv:2603.10600 §3.2 */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#Graph-Port-Taxonomy */
  IDecisionAttributionAnalyzer: 'IDecisionAttributionAnalyzer' as const,

  // --- CC-035: Contextual Tip Generator (TIM arXiv:2603.10600) ---
  /** @see src/domain/memory/IContextualTipGenerator.ts — 3-type structured tip generation (strategy/recovery/optimization) */
  /** @pattern CC-035 Contextual Tip Generator: TIM arXiv:2603.10600 §3.3 */
  /** @see docs: AI_CHEATSHEET.md#DI-&-Events */
  IContextualTipGenerator: 'IContextualTipGenerator' as const,

  // --- CC-036: Adaptive Memory Retrieval (TIM arXiv:2603.10600) ---
  /** @see src/domain/memory/IAdaptiveMemoryRetrieval.ts — context-aware tip retrieval + prompt injection */
  /** @pattern CC-036 Adaptive Memory Retrieval: TIM arXiv:2603.10600 §3.3 (Phase 3) */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.6.-Память */
  IAdaptiveMemoryRetrieval: 'IAdaptiveMemoryRetrieval' as const,

  // --- Learning Memory durable stores ---
  /** @see src/domain/memory/ITrajectoryStore.ts — durable persistence for TIM and contrastive trajectories */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.2.-Events-и-Outbox */
  ITrajectoryStore: 'ITrajectoryStore' as const,
  /** @see src/domain/memory/ILessonStore.ts — durable persistence for extracted lessons and macro-principles */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.2.-Events-и-Outbox */
  ILessonStore: 'ILessonStore' as const,
  /** @see src/domain/memory/ISuccessLedgerStore.ts — durable persistence for Success Ledger evidence entries */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.2.-Events-и-Outbox */
  ISuccessLedgerStore: 'ISuccessLedgerStore' as const,
  /** @see src/domain/memory/ITipStore.ts — durable persistence for structured learning tips */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.2.-Events-и-Outbox */
  ITipStore: 'ITipStore' as const,

  // --- CC-033 LLM variant: LLM-enhanced Trajectory Intelligence (TIM arXiv:2603.10600) ---
  /** @see src/infrastructure/memory/trajectory/LlmTrajectoryIntelligenceAdapter.ts — LLM-powered semantic analysis */
  /** @pattern CC-033 LLM: Trajectory Intelligence with IModelRouter (arXiv:2603.10600 §3.1) */
  /** @see docs: docs/TESTING_GUIDE.md#Test-Directories */
  ILlmTrajectoryIntelligenceExtractor: 'ILlmTrajectoryIntelligenceExtractor' as const,

  // --- TIM Wisdom Exporter (Horizon 3 — LSP Bridge) ---
  /** @see src/domain/memory/IWisdomExporter.ts — export Tier 3-4 wisdom as LSP diagnostics */
  /** @pattern TIM Wisdom Export: Horizon 3 LSP Red-Line Bridge */
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  IWisdomExporter: 'IWisdomExporter' as const,

  // --- TIM LSP Server (Horizon 0 — LSP Diagnostics) ---
  /** @see src/infrastructure/lsp/TIMLspServer.ts — LSP server delivering TIM wisdom as IDE diagnostics */
  /** @pattern TIM Horizon 0: LSP Red-Line Bridge (arXiv:2603.10600) */
  /** @see docs: ARCHITECTURE_GUIDE.md#2.-Runtime‑цепочка */
  ITIMLspServer: 'ITIMLspServer' as const,

  // ── Phase 0B: Infrastructure-internal tokens (migrated from string literals) ──
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#events_llm-12-services */
  ICircuitBreakerEventObserver: 'ICircuitBreakerEventObserver' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.5.3.-Поток-CIRCUIT_OPEN-end‑to‑end */
  OpenAIClient: 'OpenAIClient' as const,
  /** @see docs: 04-REFERENCE/architecture.md#🟡-HIGH:-Tree‑sitter-AST-Parser-AI/ML-Layer */
  DirectiveParser: 'DirectiveParser' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#Orphaned-Tokens-no-deps,-not-depended-upon */
  AnthropicClient: 'AnthropicClient' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#2.3.-Context-Coordinator */
  IAgentMemory: 'IAgentMemory' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#memory-1-services */
  MemoryExtractionService: 'MemoryExtractionService' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#memory-1-services */
  MemoryConsolidationService: 'MemoryConsolidationService' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#memory-1-services */
  IMemoryRetrievalService: 'IMemoryRetrievalService' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.5.3.-Поток-CIRCUIT_OPEN-end‑to‑end */
  RagQueryService: 'RagQueryService' as const,
  /** @see docs: AI_CHEATSHEET.md#S-MMU-Semantic-Memory-Management-Unit-—-4-Tier-Architecture */
  OpenMemoryProvider: 'OpenMemoryProvider' as const,
  /** @see docs: AI_CHEATSHEET.md#S-MMU-Semantic-Memory-Management-Unit-—-4-Tier-Architecture */
  CompositeMemoryProvider: 'CompositeMemoryProvider' as const,
  /** @see docs: AI_CHEATSHEET.md#S-MMU-Semantic-Memory-Management-Unit-—-4-Tier-Architecture */
  IMemoryProvider: 'IMemoryProvider' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#ai-47-services */
  ISafetyPolicyProvider: 'ISafetyPolicyProvider' as const,
  /** @see docs: docs/TESTING_GUIDE.md#Horizon-3:-Multi-Agent-Swarm-Testing */
  ISwarmRiskClassifier: 'ISwarmRiskClassifier' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#ai-47-services */
  ObservabilityService: 'ObservabilityService' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#ai-47-services */
  IPlanner: 'IPlanner' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#ai-47-services */
  IExecutor: 'IExecutor' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#ai-47-services */
  AgentOrchestrator: 'AgentOrchestrator' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#2.3.-Context-Coordinator */
  InMemoryAgentRegistry: 'InMemoryAgentRegistry' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#tools-1-services */
  ISwarmRateLimiter: 'ISwarmRateLimiter' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#3.3.-Диаграмма-слоёв */
  CoderAgent: 'CoderAgent' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#3.3.-Диаграмма-слоёв */
  ResearcherAgent: 'ResearcherAgent' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#3.3.-Диаграмма-слоёв */
  ReviewerAgent: 'ReviewerAgent' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#tools-1-services */
  ISwarmMetrics: 'ISwarmMetrics' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#tools-1-services */
  ISwarmTaskQueue: 'ISwarmTaskQueue' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.4.-Observability-и-health‑checks */
  ISwarmHealthMonitor: 'ISwarmHealthMonitor' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.5.2.-Распределение-ответственности-за-retry-и-circuit-breaker */
  ISwarmCircuitBreaker: 'ISwarmCircuitBreaker' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.7.-MAS-Runtime-Policy-Layer:-configurable-retry-&-circuit‑breaker-policies-MAS‑RT‑R2 */
  ISwarmRetryPolicy: 'ISwarmRetryPolicy' as const,
  /** @see docs: docs/TESTING_GUIDE.md#Horizon-3:-Multi-Agent-Swarm-Testing */
  SwarmAutoLoader: 'SwarmAutoLoader' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#A1-—-MAS-Runtime-Core */
  SwarmToMasRegistryAdapter: 'SwarmToMasRegistryAdapter' as const,
  /** @see docs: AI_CHEATSHEET.md#11.-Grep-Index */
  SwarmExecutionStrategy: 'SwarmExecutionStrategy' as const,
  /** @see docs: AI_CHEATSHEET.md#9.-Anti-Patterns-break-arch-tests */
  ISwarmFactory: 'ISwarmFactory' as const,
  /** @see docs: docs/TESTING_GUIDE.md#Horizon-4:-Self-Healing-PlayPen-SOTA-Cognitive-+-Adversarial-Swarm */
  ISwarmLearningService: 'ISwarmLearningService' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.5.-DurableExecution‑aware-resilience-v2-MAS‑RT‑R1 */
  ISwarmDurableExecutionBridge: 'ISwarmDurableExecutionBridge' as const,
  /** @see docs: docs/protocols/ANTI_STUB_POLICY_SOTA_2026.md#План-Внедрения-в-Рабочий-Процесс-ИИ-Программиста */
  ISwarmPolicyEngine: 'ISwarmPolicyEngine' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#3.3.-Диаграмма-слоёв */
  ImageProcessingAgent: 'ImageProcessingAgent' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#3.3.-Диаграмма-слоёв */
  AudioTranscriptionAgent: 'AudioTranscriptionAgent' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#External-/-Unresolved-Dependencies */
  chatService: 'chatService' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#top */
  ISummarizer: 'ISummarizer' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#Orphaned-Tokens-no-deps,-not-depended-upon */
  PgClientContext: 'PgClientContext' as const,
  /** @see docs: docs/TESTING_GUIDE.md#Preflight-Guard:-Hot-Path-Logging-Check-17 */
  LoggingAspect: 'LoggingAspect' as const,
  /** @see src/core/aop/SecurityAspect.ts — Cross-cutting security aspect */
  /** @see docs: docs/TESTING_GUIDE.md#Run-everything-unit-+-arch-+-security-+-integration-+-e2e-+-chaos */
  SecurityAspect: 'SecurityAspect' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#bootstrap-18-services */
  MetricsAspect: 'MetricsAspect' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.7.-MAS-Runtime-Policy-Layer:-configurable-retry-&-circuit‑breaker-policies-MAS‑RT‑R2 */
  ICircuitBreakerPolicyProvider: 'ICircuitBreakerPolicyProvider' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.5.2.-Распределение-ответственности-за-retry-и-circuit-breaker */
  ICircuitBreakerFactory: 'ICircuitBreakerFactory' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#events_llm-12-services */
  ICircuitBreakerStateStore: 'ICircuitBreakerStateStore' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Layer-8:-Resilience-&-Discovery */
  ICircuitBreakerRegistry: 'ICircuitBreakerRegistry' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#core_infra-36-services */
  CircuitBreakerAspect: 'CircuitBreakerAspect' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.5.2.-Распределение-ответственности-за-retry-и-circuit-breaker */
  RetryAspect: 'RetryAspect' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#core_infra-36-services */
  CachingAspect: 'CachingAspect' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.5.2.-Распределение-ответственности-за-retry-и-circuit-breaker */
  ICircuitBreakerPostgres: 'ICircuitBreaker:Postgres' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.5.2.-Распределение-ответственности-за-retry-и-circuit-breaker */
  ICircuitBreakerRedis: 'ICircuitBreaker:Redis' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.5.2.-Распределение-ответственности-за-retry-и-circuit-breaker */
  ICircuitBreakerNeo4j: 'ICircuitBreaker:Neo4j' as const,
  /** @see docs: AI_CHEATSHEET.md#2.-Hard-Invariants-NEVER-violate */
  IListCache: 'IListCache' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.5.-MAS-Runtime */
  MasMetricsAggregator: 'MasMetricsAggregator' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#bootstrap-18-services */
  IBusinessMetrics: 'IBusinessMetrics' as const,
  /** @see docs: 04-REFERENCE/ERROR_HANDLING_GUIDE.md#Error-Metrics-Collection */
  MasMetricsCollector: 'MasMetricsCollector' as const,
  /** @see docs: 04-REFERENCE/ERROR_HANDLING_GUIDE.md#Error-Metrics-Collection */
  DlqMetricCollector: 'DlqMetricCollector' as const,
  /** @see docs: docs/TESTING_GUIDE.md#Integration-Test-L2 */
  SlackIntegrationPort: 'SlackIntegrationPort' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Other-Layer-4-interfaces */
  SlackIntegrationAdapter: 'SlackIntegrationAdapter' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/AI_INTERFACE_REGISTRY.md#Other-Layer-4-interfaces */
  IntegrationHub: 'IntegrationHub' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#5.2.-Связь-с-Memory-и-PolicyEngine */
  PolicyEngine: 'PolicyEngine' as const,
  /** @see docs: 04-REFERENCE/testing-patterns.md#R2.3-MAS-events-Streams-+-CQRS-tests */
  MasRedisStreamsClient: 'MasRedisStreamsClient' as const,
  /** @see docs: 04-REFERENCE/testing-patterns.md#R2.3-MAS-events-Streams-+-CQRS-tests */
  MasEventsRedisStreamsProducer: 'MasEventsRedisStreamsProducer' as const,
  /** @see docs: docs/protocols/singularity/SINGULARITY_PORTS_SPECIFICATION.md#top */
  MasReadModelsRepository: 'MasReadModelsRepository' as const,
  /** @see docs: 04-REFERENCE/testing-patterns.md#R2.3-MAS-events-Streams-+-CQRS-tests */
  MasEventsRedisStreamsProjector: 'MasEventsRedisStreamsProjector' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#events_llm-12-services */
  IMasCircuitBreakerAdvisor: 'IMasCircuitBreakerAdvisor' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.5.3.-Поток-CIRCUIT_OPEN-end‑to‑end */
  masDurableExecutionService: 'masDurableExecutionService' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.7.4.-Поток-политик-в-MasRecoveryService-durable-timeout/CB */
  masRecoveryService: 'masRecoveryService' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#6.6.-DurableExecution/Recovery-observability-MAS‑RT‑R1‑C4 */
  masRecoveryWorker: 'masRecoveryWorker' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#repositories-3-services */
  IConversationRepository: 'IConversationRepository' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.11.-TIM-—-Trajectory-Informed-Memory */
  IResearchReportRepository: 'IResearchReportRepository' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#repositories-3-services */
  IApiKeyRepository: 'IApiKeyRepository' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#security-1-services */
  IToolPolicyResolver: 'IToolPolicyResolver' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#singularity-1-services */
  SingularityProtocolController: 'SingularityProtocolController' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#tools-1-services */
  DelegateTaskTool: 'DelegateTaskTool' as const,

  // ── Phase 0 Audit: missing memory.module.ts tokens ──
  /** @see docs: AI_CHEATSHEET.md#11.-Grep-Index */
  masExecutionStore: 'masExecutionStore' as const,
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#bootstrap-18-services */
  MetricsAnalysisService: 'MetricsAnalysisService' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#5.2.-Связь-с-Memory-и-PolicyEngine */
  IMemoryPolicyEngineAdapter: 'IMemoryPolicyEngineAdapter' as const,
  /** @see docs: docs/TESTING_GUIDE.md#"Out-of-memory"-during-tests */
  IMemoryGovernanceAuditSink: 'IMemoryGovernanceAuditSink' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#4.3.-Режимы-памяти-и-fallback */
  ISessionMemoryManagerCore: 'ISessionMemoryManagerCore' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.6.-Память */
  IProfileMemory: 'IProfileMemory' as const,
  /** @see src/domain/memory/IMemoryFactStore.ts — bitemporal facts, written only from MemoryFactProposed */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#GitNexus-Extraction-Artifacts-Detailed */
  IMemoryFactStore: 'IMemoryFactStore' as const,
  /** @see src/application/memory/ProposeMemoryFact.ts — ASI06 gate then event append */
  /** @see docs: 04-REFERENCE/extraction-protocol.md#GitNexus-Extraction-Artifacts-Detailed */
  ProposeMemoryFact: 'ProposeMemoryFact' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.6.-Память */
  IEvaluationMemory: 'IEvaluationMemory' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.6.-Память */
  IMemoryEmbeddingIndexer: 'IMemoryEmbeddingIndexer' as const,
  /** @see docs: 04-REFERENCE/ERROR_HANDLING_GUIDE.md#2.-Dead-Letter-Queue-Memory */
  LongTermMemoryStore: 'LongTermMemoryStore' as const,

  // ── Healthcare / MRI Second-Opinion CDS ──────────────────────────
  /** @see docs/superpowers/specs/2026-03-23-mri-second-opinion-design.md */
  /** @see docs: docs/TESTING_GUIDE.md#Unit-Test-L0 */
  IMriSecondOpinionCaseRepository: 'IMriSecondOpinionCaseRepository' as const,
  /** @see docs/superpowers/specs/2026-03-23-mri-second-opinion-design.md */
  /** @see docs: AI_CHEATSHEET.md#DI-&-Events */
  ISecondOpinionInferenceService: 'ISecondOpinionInferenceService' as const,
  /** @see docs/superpowers/specs/2026-03-23-mri-second-opinion-design.md */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#ai-47-services */
  IClinicalSafetyPolicy: 'IClinicalSafetyPolicy' as const,
  /** @see docs/superpowers/specs/2026-03-23-mri-second-opinion-wave-a-plan.md */
  /** @see docs: 04-REFERENCE/architecture.md#FileContextTracker-Memory-Layer */
  IImagingInboxWatcher: 'IImagingInboxWatcher' as const,
  /** @see docs/superpowers/specs/2026-03-23-mri-second-opinion-wave-a-plan.md */
  /** @see docs: docs/TESTING_GUIDE.md#SOTA-March-2026:-IDE-Testing-Pipeline-Analysis */
  IArchiveExtractor: 'IArchiveExtractor' as const,
  /** @see docs/superpowers/specs/2026-03-23-mri-second-opinion-wave-a-plan.md */
  /** @see docs: docs/TESTING_GUIDE.md#Test-Helpers-14-files,-122-KB */
  IDicomMetadataExtractor: 'IDicomMetadataExtractor' as const,
  /** @see docs/superpowers/specs/2026-03-23-mri-second-opinion-wave-a-plan.md */
  /** @see docs: docs/TESTING_GUIDE.md#AI-Facing-CI-Reporting */
  IClinicalReportRenderer: 'IClinicalReportRenderer' as const,
  /** @see docs/superpowers/specs/2026-03-23-mri-second-opinion-wave-a-plan.md */
  /** @see docs: docs/ARCHITECTURE_VALIDATION.md#Architecture-Violation-Report */
  IClinicalReportDeliveryService: 'IClinicalReportDeliveryService' as const,
  /** @see docs/superpowers/specs/2026-03-23-mri-second-opinion-wave-a-plan.md */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#tools-1-services */
  IMriDeliveryJobQueue: 'IMriDeliveryJobQueue' as const,
  /** @see docs/superpowers/specs/2026-03-23-mri-second-opinion-wave-a-plan.md */
  /** @see docs: AI_CHEATSHEET.md#9c.-V8/Vitest/ESLint-Memory-Tuning-PF-084..093 */
  ImagingIngestionWorker: 'ImagingIngestionWorker' as const,
  /** @see docs/superpowers/specs/2026-03-23-mri-second-opinion-wave-a-plan.md */
  /** @see docs: AI_CHEATSHEET.md#9c.-V8/Vitest/ESLint-Memory-Tuning-PF-084..093 */
  MriDeliveryWorker: 'MriDeliveryWorker' as const,

  /**
   * @deprecated No references in src outside this file.
   * Measured by scripts/di-token-usage.ts on 2026-10-14. Remove after one release.
   */
  // MAS Agent Registries (composite, static, dynamic)
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#2.4.-Agent-Registry */
  StaticAgentRegistry: 'StaticAgentRegistry' as const,
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#2.4.-Agent-Registry */
  InnerStaticAgentRegistry: 'InnerStaticAgentRegistry' as const,
  /** @see docs: ARCHITECTURE_GUIDE.md#4.2.-Events-и-Outbox */
  TeamStore: 'TeamStore' as const,
  /** @see docs: docs/TESTING_GUIDE.md#Worker-Strategy */
  SupervisorStrategy: 'SupervisorStrategy' as const,
  // Phase 17: Skill Matching
  /** @see src/infrastructure/skills/SkillMatcher.ts */
  /** @see docs: 06-AI_SYSTEMS_ARCHITECTURE/DI_TOPOLOGY.md#Module-Level-Topology */
  ISkillMatcher: 'ISkillMatcher' as const,
  // Integration Services (Plans 34-38)
  /** @see docs: 07-MULTI_AGENT_SYSTEMS/MAS_RUNTIME_CORE_ARCHITECTURE.md#4.3.-Режимы-памяти-и-fallback */
  IDiagnosticSessionStateManager: 'IDiagnosticSessionStateManager' as const,
  // Config Redaction (Plan 37.7)
  /** @see docs: AI_CHEATSHEET.md#9c.-V8/Vitest/ESLint-Memory-Tuning-PF-084..093 */
  IConfigRedactor: 'IConfigRedactor' as const,
  // PQC Metadata Enricher (Horizon 1 — Post-Quantum Cryptography readiness)
  /** @see src/infrastructure/events/PqcMetadataEnricher.ts — PQC simulation enricher */
  /** @see docs: AI_CHEATSHEET.md#9a.-Implementation-Status-Markers */
  IPqcMetadataEnricher: 'IPqcMetadataEnricher' as const,
  /** @see src/domain/context/IRetrievalEvaluator.ts — CRAG-style retrieval quality evaluation */
  /** @sota Yan et al. (2024) arXiv:2401.15884 "Corrective RAG" */
  /** @see docs: ARCHITECTURE_GUIDE.md#4.3.-RequestContext */
  IContextRetrievalEvaluator: 'IContextRetrievalEvaluator' as const,
} as const;

/**
 * Type-safe token type
 */
export type DIToken = typeof DI_TOKENS[keyof typeof DI_TOKENS];

/**
 * Token categories for validation and documentation
 */
export const TOKEN_CATEGORIES = {
  CORE: ['HttpServer', 'AppFactory', 'IConfigLoader', 'IPlatformAdapter', 'IContainerRegistryClient', 'IGpuHealthMonitor'] as const,
  EVENT_SOURCING: ['IEventStore', 'IEventBus', 'IOutbox', 'IEventGapDetector', 'IProcessedEventStore'] as const,
  PERSISTENCE: ['DatabaseConnection', 'IMasSessionStore'] as const,
  CACHE: ['CacheService', 'RedisClient'] as const,
  OBSERVABILITY: ['ILogger', 'IStructuredLogger', 'MetricsCollector', 'IMetricsCollector'] as const,
  AI: ['LLMAdapterFactory', 'ILLMAdapter', 'IChatCompletionModel', 'IModelCatalog', 'ILLMCostCalculator', 'IModelRouter', 'IRetrievalEvaluator', 'ILlmQualityMonitor', 'ITreeOfThoughts'] as const,
  MEMORY: ['ISessionMemoryManager', 'IWorkingMemory', 'ISummaryMemory', 'IGovernanceMemory', 'IContextCoordinator', 'IMem0Provider', 'IGraphMemoryAdapter', 'IGraphMemoryEngine', 'Mem0MemoryProviderBridge', 'AutoCaptureService', 'ILifecycleHookManager', 'IMemoryAccessPolicy', 'IQueryExpansionService', 'ICodeGraphStore', 'ICodePathContextResolver', 'ISearchAugmentationEngine', 'IChangeImpactAnalyzer', 'IMroProcessor', 'IEvaluationMemory', 'IProfileMemory', 'IFactExtractionService', 'IMemoryConsolidationService', 'IMemorySigner', 'IMemoryRetrievalService', 'IMemoryFactStore', 'ProposeMemoryFact'] as const,
  MAS: ['IMasterAgent', 'TaskOrchestrator', 'AgentRouter', 'ITaskDecomposer', 'ISwarmOrchestrator', 'IOrchestrationPipeline', 'IAutonomousExecutionLoop'] as const,
  AGENTS: ['AgentRunner', 'IAgentWorker', 'IContextWindowGuard', 'IToolLoopDetector', 'IToolResultTruncator', 'IContextPruner', 'IWorkspaceIsolation', 'IStallDetector', 'IBatchToolExecutor', 'ISharedTaskList', 'ISemanticToolFilter', 'IDocumentDriftDetector', 'IScheduledTaskRunner', 'IProgressiveDisclosureLoader', 'ISkillEvaluationRunner', 'IDriftAwarePromptEnricher', 'IUpdateSSOTWorkflow'] as const,
  SECURITY: ['IPolicyEngine', 'IUserApprovalInterceptor', 'ISecretResolver', 'ISecretInventory', 'ISecretRotationPlanner', 'ISecretRotationExecutor', 'ISecretRotationReceiptStore', 'IContentBoundaryWrapper', 'ISsrfDnsGuard', 'IPromptInjectionScanner', 'IOutputRail', 'ISafeRegexCompiler', 'IExternalContentScanner', 'ISkillScanner', 'IPathBoundaryEnforcer', 'IAclEnforcer', 'ILogRedactor', 'INetworkSandbox', 'IInputSanitizationPipeline'] as const,
  DEBUGGING: ['IEventStreamDebugger', 'IWebSocketStreamAdapter', 'IErrorGraphRepository', 'IAutoTrapGenerator', 'IBFTErrorRouter', 'IJITContextInjector', 'IHeapSnapshotDiffer', 'IAdaptiveBackpressure', 'ITimeTravelDebugger', 'IFormalVerifier'] as const,
  REASONING: ['ICoTScratchpad'] as const,
  STORAGE: [] as const,
  INTEGRATION: [] as const,
  PLUGINS: ['IPluginRegistry', 'IPluginManifestValidator', 'PluginAutoLoader', 'IHookPipeline', 'IPluginSlotManager', 'PluginLifecycleManager'] as const,
  SKILLS: ['ISkillRegistry', 'ISandboxExecutor', 'ISandboxPool', 'ISandboxStrategyFactory', 'IProcessContainer', 'ISkillMatcher', 'ISkillRelationGraph'] as const,
  SERVICE_DISCOVERY: ['IServiceDiscovery'] as const,
  FEATURE_FLAGS: ['IFeatureFlagsStore'] as const,
  RESEARCH: ['IResearchService'] as const,
  CHANNELS: ['IChannelPluginManager', 'IChannelDispatcher', 'IChannelHealthMonitor', 'IChannelRateLimiter', 'IRetryableChannelSender', 'ICircuitBreaker', 'IChannelDeadLetterQueue', 'IIdempotencyStore', 'IChannelMetricsCollector', 'IOutboundQueue', 'IChannelBulkhead', 'IDLQReplayWorker', 'IQueueDrainWorker'] as const,
  TOKEN_ESTIMATION: ['ITokenEstimator'] as const,
  LLM_RESILIENCE: ['ILlmCircuitBreakerAdapter'] as const,
  QUEUE_PERSISTENCE: ['IQueueAdapter'] as const,
  CONFIG_VALIDATION: ['IConfigValidator'] as const,
  CONFIG_REDACTION: ['IConfigRedactor'] as const,
  FINOPS: ['ITokenomicsController', 'ISpendStateStore'] as const,
  HERMES: ['IDangerousCommandDetector', 'IAuxiliaryLLMClient', 'IHermesContextCompressor', 'IProcessRegistry', 'IEnvironmentPool', 'IContentThreatScanner', 'ISkillsGuard', 'IHermesPromptLayers', 'IToolsetRegistry', 'IModelMetadataRegistry', 'IFileOperationsSafety', 'ISessionResetPolicy', 'IDebugSession', 'IMcpClientRegistry', 'IHookRegistry', 'ISensitiveTextRedactor'] as const,
  SCHEDULING: ['ICronService', 'ICronJobRepository', 'ICronTimerManager', 'ICronJobNormalizer'] as const,
  MESSAGING: ['IMessageDispatcher', 'ICommandRegistry'] as const,
  ACP: ['IAcpRuntime', 'AcpPolicyService', 'AcpController'] as const,
  TTS: ['ITtsService'] as const,
  A2A: ['IAgentCardProvider', 'IMcpBridge', 'IA2AAuthorizationGuard', 'IA2AX402CommerceMeter', 'IA2AX402MerchantPolicy', 'IA2AX402PaymentRepository', 'IA2AX402NonceStore', 'IA2AX402SettlementPort', 'RequireA2AX402PaymentService', 'SubmitA2AX402PaymentService'] as const,  // IMcpBridge: MCP↔A2A tool bridge
  MCP: ['IMcpServer', 'IMcpContextServer', 'IMcpDocsServer', 'IMcpExtractionServer', 'IMcpAuditServer', 'IMcpCodeIntelligenceServer', 'IMcpSppServer', 'IMcpScopeGuard', 'ISharedASTCache'] as const,
  EXTRACTION: ['IProofOfExtractionStore', 'ISemanticDonorArchive', 'ISymbioticProtocol', 'IContinuousSymbiosisWatcher', 'IExtractionTrajectoryStore', 'ICrossDonorKnowledgeGraph'] as const,
  PQC: ['IPqcMetadataEnricher', 'IPqcCryptoProvider'] as const,
  CONTEXT_ENGINEERING: ['ISemanticPagingService', 'IArchivalMemory', 'IArchivalMemoryAdapter', 'ISemanticPagingServiceFactory', 'IPredictiveContextService', 'IGraphContextProvider', 'IConstitutionalGuard', 'IHolographicContextProvider', 'IContextRelevanceJudge', 'IHybridRetrievalService', 'IContextQualityMetrics', 'IAgentGatewayProxy', 'IIncrementalMdcCompiler', 'IRerankerService', 'IContextRetrievalEvaluator', 'IPromptCompressor'] as const,
  PROJECTIONS: ['IEventProjector'] as const,

  // Agentic Design Patterns (Book: Gulli 2026) — 9 categories, 33 tokens
  AGENTIC_FOUNDATION: ['ILlmJudge', 'IReflectionLoop', 'IPromptClassifier'] as const,
  AGENTIC_REASONING: ['IStructuredReasoningProtocol', 'ISelfCorrectionAgent'] as const,
  AGENTIC_EVALUATION: ['IGoalEvaluator', 'IResponseEvaluator',
    'IInputGuardrailPipeline', 'IOutputGuardrailPipeline', 'IIterativeRefiner', 'IMultiModelConsensus', 'IMultiJudgeEvaluator'] as const,
  AGENTIC_PLANNING: ['ITaskPrioritizer', 'IEvolutionEngine', 'IFitnessEvaluator'] as const,
  AGENTIC_CHAINS: ['IPromptChainExecutor', 'IDeepResearchService', 'ICitationExtractor'] as const,
  AGENTIC_INTERAGENT: ['IMcpToolConsumer', 'IA2ATaskRunner', 'IA2AStreamTransport', 'IAgentDialogueLoop', 'IA2AX402CommerceMeter', 'IA2AX402MerchantPolicy', 'IA2AX402PaymentRepository', 'IA2AX402NonceStore', 'IA2AX402SettlementPort', 'RequireA2AX402PaymentService', 'SubmitA2AX402PaymentService'] as const,
  AGENTIC_ADVANCED: ['ICostAwareModelSelector', 'IReviewerPanel', 'IResearchLabOrchestrator',
    'IResearchAgentState', 'IVotingAggregator', 'IToolResultSummarizer'] as const,
  AGENTIC_EXECUTION: ['IAgentBudget', 'ICheckpointableFlow', 'IConcurrencyLimiter', 'IRecoveryStrategy'] as const,
  AGENTIC_HITL: ['IAutonomyLevel', 'IUserFeedbackCollector'] as const,
  SINGULARITY: ['IPqcCryptoProvider', 'IFormalProofEngine', 'ISingularityCoreAuditor', 'IAGIContainmentProtocol'] as const,
  CONTAINMENT: ['IAGIContainmentProtocol', 'ISingularityCoreAuditor', 'IStatefulSandboxOrchestrator'] as const,
  HOLOGRAPHIC_CONTEXT: ['IHolographicContextProvider'] as const,
  CONTEXT_PROTOCOL_REC89: ['IContextRelevanceJudge', 'IHybridRetrievalService', 'IContextQualityMetrics', 'IAgentGatewayProxy', 'IIncrementalMdcCompiler', 'IRerankerService', 'IContextRetrievalEvaluator', 'IPromptCompressor'] as const,
  SOTA_2026_MULTIAGENT: ['IAgentComputerInterface', 'ICriticFeedbackService', 'IContextCompactor'] as const,
  PILLAR3_LATS: ['ITreeOfThoughts', 'IMultiJudgeEvaluator'] as const,
  PILLAR4_PQC: ['IPqcCryptoProvider', 'IPqcEventChain'] as const,
  PILLAR5_CICD: ['IAutoFixAnalyzer'] as const,
  WAVE1_CC: ['IMultiModelConsensus', 'IToolExecutionPolicy'] as const,
  WAVE2_CC: ['IOrchestrationPipeline', 'IWorkspaceIsolation'] as const,
  WAVE3_CC: ['IAutonomousExecutionLoop', 'IStallDetector', 'IBatchToolExecutor', 'ILlmQualityMonitor'] as const,
  WAVE4_CC: ['IResearchPlanImplementWorkflow', 'IDeferredToolRegistry', 'ISkillDiscoveryService', 'ISkillRelationGraph'] as const,
  WAVE5_CC: ['ISharedTaskList', 'ISemanticToolFilter', 'IMcpScopeGuard', 'INetworkSandbox'] as const,
  WAVE6_CC: ['IDocumentDriftDetector'] as const,
  WAVE7_CC: ['IScheduledTaskRunner'] as const,
  WAVE8_CC: ['IProgressiveDisclosureLoader', 'ISkillEvaluationRunner', 'IInputSanitizationPipeline'] as const,
  WAVE9_CC: ['IAgentEventStream', 'ILlmTestHarness', 'IExecutionProvenanceTracer'] as const,
  WAVE10_DOCS: ['IDriftAwarePromptEnricher', 'IUpdateSSOTWorkflow'] as const,
  CODE_INTELLIGENCE: ['ICodeGraphStore', 'ICodePathContextResolver', 'ISearchAugmentationEngine', 'IChangeImpactAnalyzer', 'IMroProcessor', 'ICentralityScorer', 'IQueryClassificationVerifier', 'ITreeSitterParser', 'IStaticCallGraphBuilder', 'ITypeEnvironment'] as const,
  TRAJECTORY_LEARNING: ['ITrajectoryIntelligenceExtractor', 'IDecisionAttributionAnalyzer', 'IContextualTipGenerator', 'IAdaptiveMemoryRetrieval', 'ITrajectoryStore', 'ILessonStore', 'ISuccessLedgerStore', 'ITipStore', 'ILlmTrajectoryIntelligenceExtractor', 'IWisdomExporter', 'ITIMLspServer'] as const,
  HEALTHCARE: ['IMriSecondOpinionCaseRepository', 'ISecondOpinionInferenceService', 'IClinicalSafetyPolicy', 'IImagingInboxWatcher', 'IArchiveExtractor', 'IDicomMetadataExtractor', 'IClinicalReportRenderer', 'IClinicalReportDeliveryService', 'IMriDeliveryJobQueue', 'ImagingIngestionWorker', 'MriDeliveryWorker'] as const,
} as const;

/**
 * Validation helper: ensure token is registered
 */
export function validateToken(token: DIToken): boolean {
  return Object.values(DI_TOKENS).includes(token);
}

/**
 * Get all tokens in a category
 */
export function getTokensByCategory(
  category: keyof typeof TOKEN_CATEGORIES,
): readonly string[] {
  return TOKEN_CATEGORIES[category];
}

/**
 * Deprecated DI tokens — reserved for Phase 8-9 roadmap, not currently wired.
 * @see AUDIT-V6 G7, AUDIT C2
 *
 * These tokens remain in DI_TOKENS for backward compatibility (external consumers
 * may reference them). This set provides an explicit machine-readable registry
 * for tooling (linters, dead-code analyzers, onboarding docs).
 *
 * Usage:
 *   if (DEPRECATED_TOKENS.has(token)) warn(`Token '${token}' is deprecated`);
 */
export const DEPRECATED_TOKENS: ReadonlySet<string> = new Set([
  'CacheService',
  'IConfigRedactor',
  'IContextRetrievalEvaluator',
  'IDiagnosticSessionStateManager',
  'IPqcMetadataEnricher',
  'ISkillMatcher',
  'InnerStaticAgentRegistry',
  'MetricsCollector',
  'StaticAgentRegistry',
  'SupervisorStrategy',
  'TeamStore',
] as const);
