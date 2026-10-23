/**
 * MAS Runtime Core - shared types and DTOs.
 *
 * Layer: Domain
 *
 * NOTE: This module must stay free from infrastructure dependencies
 * (HTTP, DB, Outbox, LLM SDKs etc.).
 */

import type {
  IRequestContext,
  UserId,
  TenantId,
  SessionId,
  CorrelationId,
} from '../../core/context/request-context';

// ---------- Branded identifiers ----------

export type MasSessionId = string & { readonly __brand: 'MasSessionId' };
export type MasTaskId = string & { readonly __brand: 'MasTaskId' };
export type MasAgentExecutionId = string & { readonly __brand: 'MasAgentExecutionId' };
export type MasTraceId = string & { readonly __brand: 'MasTraceId' };
export type AgentId = string & { readonly __brand: 'AgentId' };

// ---------- Enums / string unions ----------

export type AgentModality = 'text' | 'voice' | 'tool' | 'multimodal';

export type MasTaskType =
  | 'analysis'
  | 'research'
  | 'planning'
  | 'execution'
  | 'review'
  | 'other';

export type MasTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped';

export type AgentRole = 'coordinator' | 'worker' | 'tool' | 'observer';

export type ExecutionStrategyType = 'sequential' | 'parallel' | 'hybrid';

// ---------- Shared bag types ----------

/** Opaque metadata bag used across MAS DTOs for extensibility. */
export interface MasMetadataBag {
  [key: string]: unknown;
}
/** Diagnostic details emitted by MAS flows. */
export interface MasDiagnosticsBag {
  [key: string]: unknown;
}
/** Per-policy decision map resolved for the current MAS request/session. */
export interface MasPolicyDecisionMap {
  [key: string]: unknown;
}
/** Structured, non-string message payload content. */
export interface MasStructuredContent {
  [key: string]: unknown;
}
/** Additional filter bag reserved for future MAS context selection needs. */
export interface MasFilterBag {
  [key: string]: unknown;
}
/** Arbitrary working-memory state exposed at MAS application boundary. */
export interface MasWorkingMemoryState {
  [key: string]: unknown;
}
/** Backend-agnostic knowledge/snippet metadata. */
export interface MasKnowledgeMetadata {
  [key: string]: unknown;
}
/** Free-form runtime constraint values attached to tasks. */
export interface MasTaskConstraintBag {
  [key: string]: unknown;
}
/** Free-form limits/configuration attached to agent descriptors. */
export interface MasAgentLimits {
  [key: string]: unknown;
}
/** Per-component token budgets keyed by logical MAS component name. */
export interface MasComponentBudgetMap {
  [key: string]: number;
}
/** Per-channel context window limits keyed by channel/source name. */
export interface MasChannelLimitMap {
  [key: string]: number;
}

// ---------- MAS request / response ----------

export interface MasRequest {
  /** High-level scenario identifier, e.g. "general_chat". */
  scenario: string;
  /** Optional business use-case or route name invoking MAS. */
  useCase?: string;
  /** Normalized payload for MAS. */
  payload: unknown;
  /** Optional hint for execution strategy (sequential/parallel/hybrid). */
  strategy?: ExecutionStrategyType;
  /** Optional MAS session information if known at the call site. */
  session?: MasSessionContext;
  /** Additional loose metadata for MAS invocation. */
  metadata?: MasMetadataBag;
}

export interface MasResponse {
  /** Whether MAS completed the scenario successfully at business level. */
  success: boolean;
  /** Primary result produced by agents. Shape depends on scenario. */
  result: unknown;
  /** Optional list of human-readable messages, suitable for chat UI. */
  messages?: MasMessage[];
  /** Optional diagnostic information about MAS execution. */
  diagnostics?: MasDiagnosticsBag;
  /** MAS session context after the operation. */
  session?: MasSessionContext;
}

// ---------- Session context ----------

export interface MasSessionContext {
  /** MAS-level session identifier (may map to Memory session id). */
  masSessionId: MasSessionId;
  /** Correlation id of the outer request. */
  correlationId: CorrelationId;
  /** Optional link to HTTP/BFF session id. */
  sessionId?: SessionId;
  /** Tenant and user identifiers if available. */
  tenantId?: TenantId;
  userId?: UserId;
  /** Additional MAS-level trace id (on top of correlationId). */
  masTraceId?: MasTraceId;
  /** MAS-level token budget for this session or request. */
  tokenBudget?: TokenBudget;
  /** Policy decisions applied to this MAS session. */
  policyDecisions?: PolicyDecisionRecord;
  /** Reference to IRequestContext for correlation tracing (required). */
  requestContext: IRequestContext;
  /** Arbitrary MAS-specific metadata (e.g. debug flags). */
  metadata?: MasMetadataBag;
  /** The execution plan for this session (persisted for resumption). */
  plan?: MasTaskPlan;
  /** The initial input/request payload (persisted for resumption). */
  initialInput?: unknown;
}

export interface TokenBudget {
  /** Maximum tokens allowed for the entire MAS session. */
  totalTokens?: number;
  /** Remaining tokens according to MAS accounting. */
  remainingTokens?: number;
  /** Optional per-component budgets (master, agents, tools, memory, etc). */
  componentBudgets?: MasComponentBudgetMap;
}

export interface PolicyDecisionRecord {
  /**
   * Per-policy decision map; keys correspond to policy identifiers
   * defined in security layer, but represented as plain strings here.
   */
  decisions: MasPolicyDecisionMap;
}

// ---------- Messages and context window ----------

export interface MasMessage {
  id?: string;
  role: 'user' | 'assistant' | 'agent' | 'system' | 'tool';
  content: string | MasStructuredContent;
  createdAt?: Date;
  /** Optional identifier of MAS task this message relates to. */
  taskId?: MasTaskId;
  /** Identifier of the agent that produced this message (if applicable). */
  agentId?: AgentId;
  metadata?: MasMetadataBag;
}

/**
 * MAS-level representation of a knowledge snippet or document fragment.
 *
 * This type is intentionally decoupled from concrete Memory/HSG/Vector DTOs
 * (e.g. WorkingMemoryEntry, HSGPointer, VectorPointer) so that MAS callers
 * can consume knowledge in a stable, backend-agnostic form.
 */
export interface MasKnowledgeSnippet {
  /**
   * Stable identifier of the snippet when available.
   *
   * For Session Memory-backed snippets this is typically derived from:
   * - HSG pointer id (if present),
   * - or Vector pointer id (as a fallback).
   */
  id?: string;
  /**
   * Short human-readable label for the snippet (optional).
   * Not guaranteed to be unique.
   */
  title?: string;
  /**
   * Primary textual content of the snippet.
   *
   * For Memory-backed snippets this is usually sourced from a summary field
   * such as `WorkingMemoryEntry.summary`.
   */
  content: string;
  /**
   * Logical source of the snippet, e.g.:
   * - "session_consolidated_context"
   * - "episodic_memory"
   * - "long_term_user_profile"
   * - "user_preference".
   */
  source?: string;
  /**
   * Optional numeric score used for ranking/relevance.
   *
   * For Session Memory this is typically mapped from importance (0..1) or
   * backend-specific similarity scores.
   */
  score?: number;
  /**
   * Opaque bag for backend-specific details (pointers, tags, etc.).
   *
   * When populated from Session Memory this may include:
   * - type/originalCount/timestamp/importance;
   * - lightweight HSG/Vector pointers (ids, sectors, collections).
   */
  metadata?: MasKnowledgeMetadata;
}

/**
 * MAS-level filters for building a context window.
 *
 * This DTO is intentionally backend-agnostic and should not expose
 * Memory/HSG/Vector-specific details. It is used by MAS callers to express
 * high-level filtering and selection preferences for context retrieval.
 *
 * NOTE: Starting from MAS-B2.4.3 these filters are interpreted by
 * [`ContextCoordinatorV1`](src/application/agents/impl/context-coordinator-v1.ts:46)
 * for query-driven selection and ranking of `MasKnowledgeSnippet[]` within
 * [`MasContextWindow`](src/application/agents/types/mas-types.ts:271). Message-
 * level/channel-aware selection remains reserved for future stages.
 */
export interface MasContextFilters {
  /** Текстовый или семантический запрос для отбора релевантных знаний. */
  query?: string;
  /**
   * Каналы или источники, по которым нужно выбирать сообщения/знания,
   * например: "conversation", "tools", "plugins", "system".
   *
   * The concrete set of channels is MAS-scenario-specific; this field is a
   * free-form list that may be interpreted by coordinators/adapters.
   */
  channels?: string[];
  /**
   * Ограничение по времени для выборки контекста.
   *
   * For MAS-B2.4.2 this is represented as a simple ISO8601 range; higher level
   * helpers are expected to normalize user-facing time expressions into this
   * structure.
   */
  timeRange?: {
    /** Inclusive lower bound (ISO8601). */
    from?: string;
    /** Inclusive upper bound (ISO8601). */
    to?: string;
  };
  /**
   * Ограничения по источникам знаний, согласованные с MasKnowledgeSnippet.source,
   * например:
   * - "session_consolidated_context"
   * - "episodic_memory"
   * - "long_term_user_profile"
   * - "user_preference".
   */
  knowledgeSources?: string[];
  /**
   * Максимальное число knowledge сниппетов (на уровне MAS),
   * отдельное от общего окна сообщений.
   */
  maxKnowledgeSnippets?: number;
  /**
   * Opaque bag для будущих/более сложных фильтров (чтобы не ломать контракт).
   *
   * Implementations MAY extend this bag with backend-specific filter clauses,
   * but must keep top-level fields of MasContextFilters stable.
   */
  extra?: MasFilterBag;
}
 
export interface ContextWindowLimits {
  /**
   * Soft upper bound on the number of messages returned in MAS context window.
   *
   * Forwarded as-is to Session Memory `get_context_window` as `max_messages`
   * (see [`SessionMemoryManager.get_context_window`](src/memory/session/SessionMemoryManager.ts:263)).
   */
  maxMessages?: number;
  /**
   * Soft upper bound on the total token count of the returned context window.
   *
   * Forwarded as-is to Session Memory `get_context_window` as `max_tokens`.
   * Applied by Memory after `maxMessages` slicing (see
   * [`memory-api-contract.md`](03-IMPLEMENTATION/phase-11-memory-details/memory-api-contract.md:239)).
   */
  maxTokens?: number;
  /**
   * Optional channel-specific limits (conversation, notes, tools, etc).
   *
   * Для MAS-B2.4.2 остаётся декларативным контрактом и пока не
   * интерпретируется `ContextCoordinatorV1` напрямую. Зарезервировано
   * для будущих шагов (channel-aware slicing/selection).
   */
  channelLimits?: MasChannelLimitMap;
}

export interface MasContextWindow {
  /** Ordered list of messages forming conversational/working history. */
  messages: MasMessage[];
  /** Optional long-term or summarized view of the session. */
  summary?: string;
  /** Arbitrary working memory (scratchpad, structured state). */
  workingMemory?: MasWorkingMemoryState;
  /**
   * Optional knowledge snippets or documents relevant to current task.
   *
   * In the default implementation backed by Session Memory this is populated
   * from working/long-term memory entries (e.g. consolidated context,
   * episodic references, user profile, preferences) and exposed as
   * backend-agnostic MAS DTOs (`MasKnowledgeSnippet`).
   */
  knowledgeSnippets?: MasKnowledgeSnippet[];
  /**
   * Implementation-level metadata about how this window was constructed.
   *
   * For the default implementation
   * [`ContextCoordinatorV1`](src/application/agents/impl/context-coordinator-v1.ts:44)
   * when backed by Session Memory, this typically includes:
   * - `source`: backend identifier (e.g. `"session_memory_v1"`);
   * - `sessionId`: underlying Memory session identifier;
   * - `appliedLimits`: snapshot of `ContextRequest.limits` actually forwarded
   *   to Memory (`maxMessages`/`maxTokens`);
   * - `filters`: echo-back of context filters that were effectively applied
   *   for this window (when available).
   *
   * At MAS-B2.4.3 stage `metadata.filters` is populated by the default
   * [`ContextCoordinatorV1`](src/application/agents/impl/context-coordinator-v1.ts:46)
   * implementation as an echo-back of `ContextRequest.filters` when provided.
   */
  metadata?: MasMetadataBag;
}

export interface ContextRequest {
  /** MAS session for which context is requested. */
  session: MasSessionContext;
  /** Optional identifier of the task for which context is requested. */
  taskId?: MasTaskId;
  /**
   * Explicit limits for the context window.
   *
   * These limits are forwarded 1:1 to Session Memory
   * [`get_context_window`](src/memory/session/SessionMemoryManager.ts:263):
   * - `limits.maxMessages` → `max_messages` (applied first),
   * - `limits.maxTokens` → `max_tokens` (applied on top of the message slice).
   *
   * If omitted, Memory decides how much history to return based on its own
   * configuration and internal session state.
   */
  limits?: ContextWindowLimits;
  /**
   * Additional hints and filters for context selection.
   *
   * This MAS-level structure is backend-agnostic and is intended for expressing
   * query-driven preferences (semantic query, channels, knowledge sources,
   * time range, etc.).
   *
   * NOTE: At MAS-B2.4.3 these filters are interpreted by
   * [`ContextCoordinatorV1`](src/application/agents/impl/context-coordinator-v1.ts:46)
   * for working-memory-based knowledge selection only; they are not yet forwarded
   * to or enforced by Memory for message-level slicing.
   */
  filters?: MasContextFilters;
  /** Optional scenario identifier for observability/metrics (does not affect behavior). */
  scenario?: string;
  /** Optional use-case identifier for observability/metrics (does not affect behavior). */
  useCase?: string;
  /** Optional opaque metadata for observability, tracing, and coordination. */
  metadata?: MasMetadataBag;
}

// ---------- Tasks and plans ----------

export interface TaskRuntimeConstraints {
  /** Optional deadline (absolute time) by which the task should be completed. */
  deadlineAt?: Date;
  /** Soft maximum duration in milliseconds. */
  maxDurationMs?: number;
  /** Soft limit on tokens or cost units that can be consumed. */
  maxCostUnits?: number;
  /** Arbitrary constraint values understood by concrete implementations. */
  other?: MasTaskConstraintBag;
}

export interface MasTask {
  id: MasTaskId;
  /** Human-readable description of what needs to be done. */
  description: string;
  /** High-level type/category of the task. */
  type: MasTaskType;
  /** Current status of the task inside execution lifecycle. */
  status?: MasTaskStatus;
  /** Tasks that must be completed before this one can start. */
  dependsOn?: MasTaskId[];
  /** Recommended role of the agent that should execute this task. */
  preferredAgentRole?: AgentRole;
  /** Capabilities that the executing agent must provide. */
  requiredCapabilities?: AgentCapability[];
  /** Optional soft-constraints for runtime. */
  constraints?: TaskRuntimeConstraints;
  /** Free-form metadata for additional extensions. */
  metadata?: MasMetadataBag;
}

export interface MasTaskPlan {
  /** All tasks that constitute the plan. */
  tasks: MasTask[];
  /** Identifier(s) of tasks that can be executed first. */
  entryTaskIds: MasTaskId[];
  /** Optional free-form metadata (plan scoring, strategy info, etc). */
  metadata?: MasMetadataBag;
}

export interface TaskDecompositionInput {
  /** Normalized MAS request to decompose. */
  request: MasRequest;
  /** MAS session context for which the plan is built. */
  session: MasSessionContext;
  /** Optional snapshot of available agents. */
  availableAgents?: AgentDescriptor[];
}

// ---------- Agents and selection ----------

export interface AgentCapability {
  /** Capability tag, e.g. "general_assistant", "research", "writer". */
  tag: string;
  /** Optional domain or scope information for the capability. */
  domain?: string;
  /** Additional free-form metadata describing limits or details. */
  metadata?: MasMetadataBag;
}

export interface AgentDescriptor {
  id: AgentId;
  name: string;
  description?: string;
  /** One or more modalities supported by this agent. */
  modalities?: AgentModality[];
  /** Capabilities provided by this agent. */
  capabilities: AgentCapability[];
  /** Optional trust level (e.g. 0.0–1.0 or 0–100) interpreted by policies. */
  trustLevel?: number;
  /** Optional configuration limits and restrictions as opaque key-value pairs. */
  limits?: MasAgentLimits;
  /** Arbitrary metadata, including ownership, tags, etc. */
  metadata?: MasMetadataBag;
}

export interface AgentSelectionCriteria {
  /** Scenario/use-case for which agents are requested. */
  scenario?: string;
  /** Required capability tags. */
  requiredCapabilityTags?: string[];
  /** Optional full capability descriptors for fine-grained matching. */
  requiredCapabilities?: AgentCapability[];
  /** Preferred agent identifiers. */
  preferredAgentIds?: AgentId[];
  /** Desired modalities. */
  modalities?: AgentModality | AgentModality[];
  /** Minimum acceptable trust level. */
  minTrustLevel?: number;
  /**
   * Arbitrary additional filters understood by specific AgentRegistry
   * implementations (e.g. region, cost profile, governance level).
   */
  additionalFilters?: MasFilterBag;
}