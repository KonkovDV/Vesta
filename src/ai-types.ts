/**
 * AI Type Index - Machine-Readable Contract Declarations
 * 
 * **CRITICAL FOR AI PROGRAMMERS**
 * This file provides verified TypeScript type exports for IDE autocomplete.
 * All imports are validated against actual source files.
 * 
 * @generated Manual curation (NOT auto-generated)
 * @verified 2025-12-05
 * @purpose AI IDE autocomplete + type safety
 * 
 * ============================================================================
 * QUICK COPY (for Use Cases):
 * ============================================================================
 * import type { IEventStore, ISessionMemoryManager, IRequestContext, IUnifiedPluginRegistry } from '@/ai-types';
 * import { DI_TOKENS } from '@/ai-types';
 * ============================================================================
 * 
 * @example
 * import type { 
 *   IEventStore, 
 *   ISessionMemoryManager 
 * } from '@/ai-types';
 * import { DI_TOKENS } from '@/ai-types';
 */

// ============================================================================
// DOMAIN LAYER: Core Business Contracts
// ============================================================================

/**
 * Typed Events (Critical Domain Events)
 * @source src/domain/events/typed-events.ts
 */
export type { 
  CriticalEventMap, 
  LlmUsagePayload,
  MemoryGovernanceDecisionPayloadV1,
  MemoryGovernanceViolationPayloadV1,
  MasSessionMemoryFinalizedPayloadV1
} from './domain/events/typed-events';

/**
 * Unified Plugin Registry
 * @source src/application/plugins/unified-plugin-registry.ts
 */
export type { IUnifiedPluginRegistry } from './application/plugins/unified-plugin-registry';

/**
 * Event persistence contract
 * @source src/domain/events/event-store.interface.ts
 * @methods saveEvents, getEvents, getEventsByCorrelationId
 */
export type { 
  IEventStore, 
  DomainEvent,
  SaveEventsResult,
  SaveEventsOptions 
} from './domain/events/event-store.interface';

/**
 * Event metadata (helper type)
 */
export type EventMetadata = Record<string, unknown>;

/**
 * Event pub/sub contract
 * @source src/domain/events/event-bus.interface.ts
 * @methods publish, subscribe, unsubscribe
 */
export type { IEventBus } from './domain/events/event-bus.interface';

/**
 * Transactional outbox pattern
 * @source src/domain/events/outbox.interface.ts
 * @methods addMessages, getUnpublished, markPublished
 */
export type { IOutbox } from './domain/events/outbox.interface';

/**
 * LLM client abstraction
 * @source src/domain/ai/IAIClient.ts
 * @methods complete, embed, isAvailable
 */
export type { IAIClient } from './domain/ai/IAIClient';

/**
 * LLM adapter (higher-level abstraction)
 * @source src/domain/ai/ILLMAdapter.ts
 * @methods generateText, generateTextStream, generateEmbeddings
 */
export type { ILLMAdapter } from './domain/ai/ILLMAdapter';

/**
 * Cache abstraction (Redis/InMemory)
 * @source src/domain/cache/ICache.ts
 * @methods get, set, delete, exists, increment
 */
export type { ICache } from './domain/cache/ICache';

/**
 * Database connection
 * @source src/domain/persistence/IDatabaseConnection.ts
 * @methods query, execute, transaction
 */
export type { IDatabaseConnection } from './domain/persistence/IDatabaseConnection';

/**
 * Unit of Work pattern
 * @source src/domain/persistence/IUnitOfWork.ts
 * @methods begin, commit, rollback
 */
export type { IUnitOfWork } from './domain/persistence/IUnitOfWork';

/**
 * File storage (S3/local)
 * @source src/domain/storage/IFileStorage.ts
 * @methods upload, download, delete, exists
 */
export type { IFileStorage } from './domain/storage/IFileStorage';

/**
 * Vector database (Qdrant/pgvector)
 * @source src/domain/memory/IVectorStore.ts
 * @methods upsert, search, delete
 */
export type { IVectorStore } from './domain/memory/IVectorStore';

/**
 * Circuit breaker pattern
 * @source src/domain/external/ICircuitBreaker.ts
 * @methods execute, getState
 */
export type { ICircuitBreaker } from './domain/external/ICircuitBreaker';

/**
 * Retry policy pattern
 * @source src/domain/external/IRetryPolicy.ts
 * @methods execute, shouldRetry
 */
export type { IRetryPolicy } from './domain/external/IRetryPolicy';

/**
 * A2A x402 payment contracts
 * @source src/domain/a2a/a2a-x402-payment.interface.ts
 */
export type {
  A2AX402Asset,
  A2AX402Network,
  A2AX402PaymentPayload,
  A2AX402PaymentReceipt,
  A2AX402PaymentRequirements,
  IA2AX402CommerceMeter,
  IA2AX402MerchantPolicy,
  IA2AX402NonceStore,
  IA2AX402PaymentRepository,
  IA2AX402SettlementPort,
} from './domain/a2a/a2a-x402-payment.interface';

/**
 * A2A x402 commerce metering contracts
 * @source src/domain/a2a/a2a-x402-commerce.interface.ts
 */
export type {
  A2AX402CommercialContext,
  A2AX402CommerceLifecycle,
  A2AX402CommerceRecord,
} from './domain/a2a/a2a-x402-commerce.interface';

// ============================================================================
// APPLICATION LAYER: Orchestration & Context
// ============================================================================

/**
 * Session memory manager (HSG + Vector)
 * @source src/memory/session/SessionMemoryManager.ts
 * @methods get_context_window, add_message, end_session
 */
export type { ISessionMemoryManager } from './domain/memory/ISessionMemoryManager';
export type { 
  SessionMessage, 
  WorkingMemoryEntry, 
  SessionConfig, 
  SessionMetadata 
} from './domain/memory/session-types';

/**
 * Memory governance (policies + auditing)
 * @source src/memory/governance/memory-governance.service.ts
 * @methods enforcePolicy, auditAccess
 */
export type { IMemoryGovernanceService } from './memory/governance/memory-governance.service';

/**
 * Request context (correlation tracking)
 * @source src/application/context/request-context.ts
 *
 * NOTE:
 * - Use IRequestContext for all type annotations.
 * - Runtime implementation is the RequestContext singleton; do not instantiate it manually.
 */
export type { IRequestContext } from './application/context/request-context';

/**
 * Branded types for type safety
 * @source src/application/context/request-context.ts
 */
export type { 
  UserId, 
  SessionId, 
  TenantId, 
  CorrelationId, 
  RequestId,
  MasSessionId,
  MasTraceId 
} from './application/context/request-context';

// ============================================================================
// MAS (Multi-Agent System) Contracts
// ============================================================================

/**
 * Master agent orchestrator
 * @source src/application/agents/core/master-agent.ts
 * @methods executeMultiAgentTask, startSession, continueSession
 */
export type { IMasterAgent } from './application/agents/core/master-agent';

/**
 * Context coordinator (memory bridge)
 * @source src/application/agents/core/context-coordinator.ts
 * @methods getContextWindow, appendMessages, finalizeSession
 */
export type { IContextCoordinator } from './application/agents/core/context-coordinator';

/**
 * Task decomposer (planning service)
 * @source src/application/agents/core/task-decomposer.ts
 * @methods decomposeTask
 */
export type { ITaskDecomposer } from './application/agents/core/task-decomposer';

/**
 * Execution strategy (runtime execution)
 * @source src/application/agents/core/execution-strategy.ts
 * @methods executePlan
 */
export type { IExecutionStrategy } from './application/agents/core/execution-strategy';

/**
 * Agent registry (agent lookup)
 * @source src/application/agents/core/agent-registry.ts
 * @methods getAgent, listAgents
 */
export type { IAgentRegistry } from './application/agents/core/agent-registry';

// ============================================================================
// CODE INTELLIGENCE CONTRACTS
// ============================================================================

/**
 * Code Knowledge Graph Store — AST-based structural code intelligence.
 * @source src/domain/memory/ICodeGraphStore.ts
 * @methods ingestRepository, hybridSearch, getSymbolContext, analyzeImpact, getCommunities, getProcesses
 */
export type {
  ICodeGraphStore,
  CodeGraphNode,
  CodeGraphEdge,
  CodeNodeLabel,
  CodeRelationType,
  ImpactAnalysisResult,
  CodeProcess,
  CodeCommunity,
  SymbolContext,
} from './domain/memory/ICodeGraphStore';

// ============================================================================
// COMMON TYPES & UTILITIES
// ============================================================================

/**
 * Typed result pattern (success/error discriminated union)
 */
export type Result<T, E = Error> = 
  | { success: true; data: T }
  | { success: false; error: E };

/**
 * Async operation (just Promise wrapper for docs)
 */
export type AsyncOperation<T> = Promise<T>;

// ============================================================================
// DI TOKENS REGISTRY (CRITICAL FOR AI)
// ============================================================================

/**
 * DI Token Registry - String constants for dependency injection
 * 
 * **USAGE**: Use these constants in DI wiring (constructor injection)
 * 
 * @example
 * // DI bootstrap (pseudocode)
 * // container.register(DI_TOKENS.IEventStore, PostgresEventStore);
 * // class InvoiceProcessingUseCase {
 * //   constructor(private readonly eventStore: IEventStore) {}
 * // }
 * 
 * **SOURCE OF TRUTH**: src/infrastructure/di/bootstrap.ts
 */
export const DI_TOKENS = {
  // ========== DOMAIN ===========
  /** Event Store - Event persistence */
  IEventStore: 'IEventStore',
  
  /** Event Bus - Pub/sub messaging */
  IEventBus: 'IEventBus',
  
  /** Outbox - Transactional outbox pattern */
  IOutbox: 'IOutbox',
  
  /** AI Client - LLM client (OpenAI/Anthropic) */
  IAIClient: 'IAIClient',
  
  /** LLM Adapter - Higher-level LLM abstraction */
  ILLMAdapter: 'ILLMAdapter',
  
  /** Cache - Redis or in-memory cache */
  ICache: 'ICache',
  
  /** Database Connection - PostgreSQL connection pool */
  IDatabaseConnection: 'IDatabaseConnection',
  
  /** Unit of Work - Transaction coordinator */
  IUnitOfWork: 'IUnitOfWork',
  
  /** File Storage - S3 or local filesystem */
  IFileStorage: 'IFileStorage',
  
  /** Vector Store - Qdrant or pgvector */
  IVectorStore: 'IVectorStore',
  
  // ========== APPLICATION ===========
  /** Session Memory Manager - Memory orchestration */
  ISessionMemoryManager: 'ISessionMemoryManager',
  
  /** Memory Governance Service - Policy enforcement */
  IMemoryGovernanceService: 'IMemoryGovernanceService',

  /** Hybrid Memory Retrieval Service - RAG read-only retrieval facade */
  hybridMemoryRetrievalService: 'hybridMemoryRetrievalService',
  
  /** Unified Plugin Registry - Plugin execution */
  IUnifiedPluginRegistry: 'IUnifiedPluginRegistry',
  
  // ========== MAS ===========
  /** Master Agent - MAS orchestrator */
  IMasterAgent: 'IMasterAgent',
  
  /** Context Coordinator - MAS memory bridge */
  IContextCoordinator: 'IContextCoordinator',
  
  /** Task Decomposer - MAS planning */
  ITaskDecomposer: 'ITaskDecomposer',
  
  /** Execution Strategy - MAS runtime */
  IExecutionStrategy: 'IExecutionStrategy',
  
  /** Agent Registry - Agent lookup */
  IAgentRegistry: 'IAgentRegistry',
  
  // ========== INFRASTRUCTURE ===========
  /** Logger - Structured logging */
  ILogger: 'ILogger',
  
  /** Metrics Port - Prometheus metrics */
  IMetricsPort: 'IMetricsPort',

  // ========== SECURITY & INTEGRATIONS ===========
  /** Policy Engine - Security policy enforcement */
  policyEngine: 'policyEngine',

  /** Slack Http Client */
  slackHttpClient: 'slackHttpClient',

  /** Slack Integration Adapter */
  slackIntegrationAdapter: 'slackIntegrationAdapter',

  /** Integration Hub */
  integrationHub: 'integrationHub',

  /** OpenMemory Adapter - External memory engine adapter */
  OpenMemoryAdapter: 'OpenMemoryAdapter',

  // ========== SCIENTIFIC SKILLS ===========
  /** Python Skill Bridge - Infrastructure adapter for Python execution */
  IPythonSkillBridge: 'IPythonSkillBridge',

  /** Scientific Skill Plugin - Plugin wrapper for scientific skills */
  IScientificSkillPlugin: 'IScientificSkillPlugin',

  /** Mem0 Adapter - Intelligent knowledge distillation */
  Mem0Adapter: 'Mem0Adapter',

  /** HttpClient - Shared HTTP client */
  HttpClient: 'HttpClient',

  // ========== CODE INTELLIGENCE ===========
  /** Code Graph Store - AST-based knowledge graph (KuzuDB/InMemory) */
  ICodeGraphStore: 'ICodeGraphStore',

  /** Graph Memory Adapter - Entity relationship graph (Neo4j/InMemory) */
  IGraphMemoryAdapter: 'IGraphMemoryAdapter',
} as const;

/**
 * Type-safe DI token accessor
 */
export type DIToken = typeof DI_TOKENS[keyof typeof DI_TOKENS];

// ============================================================================
// SINGULARITY PROTOCOL TOKENS
// ============================================================================

export { SINGULARITY_TOKENS, type SingularityToken } from './core/singularity/tokens';

// ============================================================================
// AI CODE GENERATION PATTERNS (VERIFIED)
// ============================================================================

/**
 * PATTERN 1: Simple Use Case (Event Store only)
 * 
 * @verified ✅ Tested against actual codebase
 * @complexity ⭐ Low
 * 
 * @example
 * import type { IEventStore, IRequestContext } from '@/ai-types';
 * import { DI_TOKENS } from '@/ai-types';
 * import { EventFactory } from '@/domain/factories/EventFactory';
 *
 * export class InvoiceProcessingUseCase {
 *   constructor(private readonly eventStore: IEventStore) {}
 *
 *   async execute(invoice: Invoice, context: IRequestContext) {
 *     // Create event with correlationId (REQUIRED!)
 *     const event = EventFactory.getInstance().createEvent(
 *       'InvoiceProcessed',
 *       invoice.id,
 *       1,
 *       { invoice },
 *       { correlationId: context.getCorrelationId() }
 *     );
 *     
 *     // Save to event store
 *     await this.eventStore.saveEvents([event]);
 *     
 *     return { success: true };
 *   }
 * }
 */

/**
 * PATTERN 2: Use Case with Memory + Plugins
 * 
 * @verified ✅ Based on FraudDetectionUseCase
 * @complexity ⭐⭐ Medium
 * 
 * @example
 * import type {
 *   IEventStore,
 *   ISessionMemoryManager,
 *   IRequestContext,
 *   TenantId,
 *   SessionId
 * } from '@/ai-types';
 * import { DI_TOKENS } from '@/ai-types';
 * import { EventFactory } from '@/domain/factories/EventFactory';
 * import type { IUnifiedPluginRegistry } from '@/application/plugins/unified-plugin-registry';
 * 
 * export class FraudDetectionUseCase {
 *   constructor(
 *     private readonly eventStore: IEventStore,
 *     private readonly memory: ISessionMemoryManager,
 *     private readonly plugins: IUnifiedPluginRegistry,
 *   ) {}
 * 
 *   async execute(transaction: Transaction, context: IRequestContext) {
 *     // 1. Get historical context
 *     const history = await this.memory.get_context_window({
 *       tenant_id: context.getTenantId() as TenantId,
 *       session_id: `fraud_${transaction.userId}` as SessionId,
 *       max_messages: 50,
 *       correlation_id: context.getCorrelationId()
 *     });
 *     
 *     // 2. Call risk plugin
 *     const risk = await this.plugins.call('risk_engine', { transaction }, context);
 *     
 *     // 3. Save event
 *     const event = EventFactory.getInstance().createEvent(
 *       'TransactionAnalyzed',
 *       transaction.id,
 *       1,
 *       { transaction, riskScore: risk.data.score },
 *       { correlationId: context.getCorrelationId(), createdBy: 'FraudDetectionUseCase' }
 *     );
 *     await this.eventStore.saveEvents([event]);
 *     
 *     return { isFraud: risk.data.score > 0.8, score: risk.data.score };
 *   }
 * }
 */

/**
 * PATTERN 3: MAS Orchestration Use Case
 * 
 * @verified ✅ Based on MasterAgentV1
 * @complexity ⭐⭐⭐⭐ Very High
 * 
 * @example
 * import type {
 *   IMasterAgent,
 *   IContextCoordinator,
 *   IRequestContext
 * } from '@/ai-types';
 * import { DI_TOKENS } from '@/ai-types';
 * 
 * export class ResearchOrchestrationUseCase {
 *   constructor(
 *     private readonly masterAgent: IMasterAgent,
 *     private readonly contextCoord: IContextCoordinator,
 *   ) {}
 * 
 *   async conductResearch(query: string, context: IRequestContext) {
 *     // Execute multi-agent task
 *     const result = await this.masterAgent.executeMultiAgentTask(
 *       {
 *         mas_session_id: `research_${Date.now()}`,
 *         user_query: query,
 *         context_hints: {}
 *       },
 *       context
 *     );
 *     
 *     return result;
 *   }
 * }
 */

// ============================================================================
// CRITICAL RULES FOR AI (MUST FOLLOW)
// ============================================================================

/**
 * RULE 1: NEVER import concrete classes in Use Cases
 * 
 * ❌ WRONG:
 * import { PostgresEventStore } from '@/infrastructure/events/postgres-event-store';
 * 
 * ✅ CORRECT:
 * import type { IEventStore } from '@/ai-types';
 * constructor(private readonly eventStore: IEventStore) // wired via DI_TOKENS.IEventStore in DI bootstrap
 */

/**
 * RULE 2: ALWAYS include correlationId in event metadata
 * 
 * ❌ WRONG:
 * EventFactory.getInstance().createEvent(type, id, v, payload, {
 *   createdBy: 'UseCase'
 * });
 * 
 * ✅ CORRECT:
 * EventFactory.getInstance().createEvent(type, id, v, payload, {
 *   correlationId: context.getCorrelationId(),
 *   createdBy: 'UseCase'
 * });
 */

/**
 * RULE 3: Use DI_TOKENS constants, not raw strings
 * 
 * ❌ WRONG:
 * 'IEventStore' // raw string token in DI config
 * 
 * ✅ CORRECT:
 * DI_TOKENS.IEventStore // centralized, type-safe token
 */

/**
 * RULE 4: RequestContext is passed, never created in Use Case
 * 
 * ❌ WRONG:
 * const context = new RequestContext({ correlationId: uuid() });
 * 
 * ✅ CORRECT:
 * async execute(data: Data, context: IRequestContext) {
 *   // context is injected by middleware
 * }
 */
