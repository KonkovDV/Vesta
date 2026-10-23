/**
 * SessionMemoryManager and related default implementations.
 *
 * Layer: Memory
 */

import {
  CorrelationId,
  HSGPrimarySector,
  SessionConfig,
  SessionContext,
  SessionId,
  SessionMessage,
  SessionMetadata,
  SessionState,
  TenantId,
  UserId,
  WorkingMemoryEntry,
} from '../../domain/memory/session-types';
import {
  HSGClient,
  LongTermMemoryStore,
  MemoryRoutingPolicy,
  RoutingDecision,
  SectorClassifier,
  SessionMemoryStore,
  VectorClient,
  WorkingMemoryStore,
} from '../../domain/memory/session-memory-ports';
import type {
  IProfileMemory,
  ProfileMemoryEntry,
  ProfileMemorySnapshotInput,
  ProfileMemoryWriteResult,
  SearchProfileMemoryInput,
  WriteProfileMemoryInput,
} from '../../domain/memory/IProfileMemory';
import type {
  EvaluationMemoryPlane,
  EvaluationMemoryRunRecord,
  EvaluationMemoryVerdict,
  EvaluationPlaneScorecard,
  EvaluationPlaneScorecardInput,
  IEvaluationMemory,
  RecordEvaluationRunInput,
} from '../../domain/memory/IEvaluationMemory';
import type { DistilledFact, IMemoryDistiller } from '../../domain/memory/distillation-types';
import { updateContextWindowTokens } from '../observability/memory-metrics';
import type { MemoryMode } from './MemoryModeResolver';
import type { ISessionMemoryManager } from '../../domain/memory/ISessionMemoryManager';
import { IdGenerator } from '../../core/utils/IdGenerator';
import { MessageDistillationFilter } from './MessageDistillationFilter';

/**
 * High-level Session Memory API interface (Phase 11 contract).
 *
 * This mirrors the logical interface from memory-api-contract.md and is the
 * primary entry point for Application layer when working with session memory.
 */
export type { ISessionMemoryManager } from '../../domain/memory/ISessionMemoryManager';

const DEFAULT_SESSION_CONFIG: SessionConfig = {
  max_context_tokens: 8000,
  consolidation_threshold: 7000,
  max_messages: 50,
  sliding_window: true,
  enable_compression: true,
  retention_days: 90,
};

function nowIso(): string {
  return new Date().toISOString();
}

function estimateTokenCount(text: string): number {
  if (!text) return 0;
  // Very rough heuristic; real implementation will use tokenizer from LLM adapter.
  const words = text.trim().split(/\s+/);
  return Math.max(1, Math.round(words.length * 1.2));
}

function generateMessageId(sessionId: SessionId): string {
  const random = IdGenerator.generateRandomString(8);
  return `${sessionId}-${random}`;
}

/**
 * Default implementation of ISessionMemoryManager.
 *
 * For M1.3–M1.4 this class provides a safe skeleton:
 * - it wires SessionMemoryStore / WorkingMemoryStore / LongTermMemoryStore;
 * - it implements basic context window management and working memory injection;
 * - HSG/Vector-specific behavior is intentionally minimal and will be expanded
 *   in later tasks.
 *
 * Observability (M1.6):
 * - aggregate Memory API metrics (counters/histograms) are emitted from
 *   DualWriteMemoryManager, which is the canonical entrypoint;
 * - this implementation only updates per-session gauges such as
 *   memory_context_window_tokens for the OpenMemory path.
 */
export class SessionMemoryManager implements ISessionMemoryManager {
  constructor(
    private readonly sessionStore: SessionMemoryStore,
    private readonly workingMemoryStore: WorkingMemoryStore,
    private readonly longTermMemoryStore: LongTermMemoryStore,
    private readonly sectorClassifier: SectorClassifier,
    private readonly routingPolicy: MemoryRoutingPolicy,
    private readonly hsgClient: HSGClient,
    private readonly vectorClient: VectorClient,
    private readonly memoryDistiller?: IMemoryDistiller, // Optional for backward compatibility/progressive rollout
  ) {}

  async create_session(input: {
    tenant_id: TenantId;
    user_id: UserId;
    external_session_ref?: string;
    initial_context?: Record<string, unknown>;
    config_override?: Partial<SessionConfig>;
    correlation_id: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    created: boolean;
    loaded_working_memory: number;
  }> {
    const { tenant_id, user_id, external_session_ref, initial_context, config_override } = input;

    const result = await this.sessionStore.createSessionRecord({
      tenant_id,
      user_id,
      external_session_ref,
      initial_context,
      config_override,
    });

    return {
      session_id: result.session.metadata.session_id,
      created: result.created,
      loaded_working_memory: result.loaded_working_memory,
    };
  }

  async add_message(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    user_id?: UserId;
    role: SessionMessage['role'];
    modality?: SessionMessage['modality'];
    content: string;
    metadata?: SessionMessage['metadata'];
    correlation_id: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    message_id: string;
    total_tokens: number;
    context_window_size: number;
    consolidation_triggered: boolean;
  }> {
    const { tenant_id, session_id, user_id, role, modality = 'text', content, metadata, correlation_id } = input;

    const session = await this.sessionStore.loadSession(tenant_id, session_id);
    if (!session) {
      throw new Error(`Session not found: ${session_id}`);
    }

    const message_id = generateMessageId(session_id);
    const token_count = estimateTokenCount(content);

    const message: SessionMessage = {
      message_id,
      session_id,
      tenant_id,
      user_id,
      role,
      modality,
      content,
      created_at: nowIso(),
      token_count,
      metadata: metadata ?? {},
    };

    session.context_window.push(message);
    session.metadata.message_count += 1;
    session.metadata.total_tokens += token_count;
    session.metadata.last_activity = nowIso();

    let consolidation_triggered = false;
    if (
      session.metadata.total_tokens >=
      (session.config.consolidation_threshold || DEFAULT_SESSION_CONFIG.consolidation_threshold)
    ) {
      // Consolidation trigger is tracked as a boolean for now; actual consolidation
      // strategy is delegated to consolidate_session().
      consolidation_triggered = true;
    }

    await this.sessionStore.saveSession(session);

    await this.routeMessageToMemory({
      tenant_id,
      session_id,
      user_id,
      message,
      correlation_id,
    });

    return {
      session_id,
      message_id,
      total_tokens: session.metadata.total_tokens,
      context_window_size: session.context_window.length,
      consolidation_triggered,
    };
  }

  async get_context_window(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    max_messages?: number;
    max_tokens?: number;
    correlation_id?: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    messages: SessionMessage[];
  }> {
    const { tenant_id, session_id, max_messages, max_tokens } = input;
    const session = await this.sessionStore.loadSession(tenant_id, session_id);
    if (!session) {
      throw new Error(`Session not found: ${session_id}`);
    }

    let messages = [...session.context_window];

    if (typeof max_messages === 'number' && max_messages > 0 && messages.length > max_messages) {
      messages = messages.slice(-max_messages);
    }

    if (typeof max_tokens === 'number' && max_tokens > 0) {
      const limited: SessionMessage[] = [];
      let total = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (total + m.token_count > max_tokens) break;
        limited.unshift(m);
        total += m.token_count;
      }
      messages = limited;
    }

    // Optionally inject working memory as a synthetic system message
    const workingMemory = await this.workingMemoryStore.getWorkingMemory({
      tenant_id,
      session_id,
      limit: 10,
    });

    if (workingMemory.length > 0) {
      const summaryText = workingMemory
        .map((wm) => `- ${wm.summary}`)
        .join('\n');

      const systemMessage: SessionMessage = {
        message_id: generateMessageId(session_id),
        session_id,
        tenant_id,
        user_id: undefined,
        role: 'system',
        modality: 'text',
        content: `Relevant context:\n${summaryText}`,
        created_at: nowIso(),
        token_count: estimateTokenCount(summaryText),
        metadata: { type: 'working_memory_injection' },
      };

      messages = [systemMessage, ...messages];
    }

    const mode: MemoryMode = 'openmemory-only';
    const totalTokens = messages.reduce(
      (acc, m) => acc + (m.token_count ?? estimateTokenCount(m.content)),
      0,
    );
    updateContextWindowTokens({
      tokens: totalTokens,
      mode,
    });

    return {
      session_id,
      messages,
    };
  }

  async consolidate_session(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    strategy?: 'auto' | 'full' | 'recent_window';
    correlation_id: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    summaries: WorkingMemoryEntry[];
    consolidated_messages: number;
  }> {
    const { tenant_id, session_id } = input;
    const strategy: 'auto' | 'full' | 'recent_window' = input.strategy ?? 'auto';

    const session = await this.sessionStore.loadSession(tenant_id, session_id);
    if (!session) {
      throw new Error(`Session not found: ${session_id}`);
    }

    const messages = session.context_window;
    if (messages.length === 0) {
      return {
        session_id,
        summaries: [],
        consolidated_messages: 0,
      };
    }

    const config: SessionConfig = {
      ...DEFAULT_SESSION_CONFIG,
      ...(session.config ?? {}),
    };

    const thresholdTokens =
      config.consolidation_threshold ?? DEFAULT_SESSION_CONFIG.consolidation_threshold;
    const maxContextTokens =
      config.max_context_tokens ?? DEFAULT_SESSION_CONFIG.max_context_tokens;

    // For "auto" strategy we only consolidate when the window is sufficiently large.
    if (strategy === 'auto') {
      const totalTokens = session.metadata.total_tokens;
      const shouldConsolidateByThreshold = totalTokens >= thresholdTokens;
      const shouldConsolidateByHardLimit = totalTokens >= maxContextTokens;

      if (!shouldConsolidateByThreshold && !shouldConsolidateByHardLimit) {
        return {
          session_id,
          summaries: [],
          consolidated_messages: 0,
        };
      }
    }

    const maxMessages = config.max_messages ?? DEFAULT_SESSION_CONFIG.max_messages;
    // Keep at least a small recent window even for "full" consolidation.
    const retainRecent = Math.max(1, Math.min(5, maxMessages));

    let boundaryIndex: number;

    if (strategy === 'full') {
      // Consolidate everything except the most recent N messages (if there are enough).
      // If the window is smaller than retainRecent, consolidate everything.
      if (messages.length <= retainRecent) {
        boundaryIndex = messages.length;
      } else {
        boundaryIndex = Math.max(0, messages.length - retainRecent);
      }
    } else if (strategy === 'recent_window') {
      // Consolidate messages that exceed the configured max_messages window.
      boundaryIndex = Math.max(0, messages.length - maxMessages);
      if (boundaryIndex === 0 && messages.length > retainRecent) {
        boundaryIndex = messages.length - retainRecent;
      }
    } else {
      // "auto" – consolidate roughly the older half of the window while keeping
      // at least retainRecent tail messages.
      const half = Math.floor(messages.length / 2);
      boundaryIndex = Math.max(0, Math.min(messages.length - retainRecent, half));
    }

    if (boundaryIndex <= 0) {
      // Nothing to consolidate for the requested strategy.
      return {
        session_id,
        summaries: [],
        consolidated_messages: 0,
      };
    }

    const messagesToConsolidate = messages.slice(0, boundaryIndex);
    const remainingMessages = messages.slice(boundaryIndex);

    let distilledFacts: DistilledFact[] = [];
    if (this.memoryDistiller) {
       try {
           // Phase 12: Apply noise filter before distillation
           const filteredMessages = MessageDistillationFilter.filter(messagesToConsolidate);
           
           if (filteredMessages.length === 0) {
               console.log('SessionMemoryManager: All messages filtered as noise, skipping Mem0');
           } else {
               distilledFacts = await this.memoryDistiller.addMemories({
                   tenant_id,
                   user_id: session.metadata.user_id,
                   session_id,
                   messages: filteredMessages
               });
           }
       } catch (error) {
           console.error('SessionMemoryManager: Mem0 distillation failed, falling back to skeletal summary', error);
       }
    }

    const summaries: WorkingMemoryEntry[] = [];

    if (distilledFacts.length > 0) {
        for (const fact of distilledFacts) {
            const entry: WorkingMemoryEntry = {
                type: 'consolidated_context',
                summary: fact.text,
                original_count: messagesToConsolidate.length, // approximation per fact
                timestamp: nowIso(),
                importance: 0.8,
                metadata: {
                    mem0_id: fact.id,
                    event: fact.event,
                    ...fact.metadata
                }
            };
            
            summaries.push(entry);

            // Handle ADD/UPDATE in L1 cache
            await this.workingMemoryStore.appendWorkingMemoryEntries({
                tenant_id,
                session_id,
                entries: [entry],
                correlation_id: input.correlation_id,
            });

            // Route to L2 LongTerm/HSG/Vector
            await this.routeWorkingMemoryEntry({
                tenant_id,
                session_id,
                user_id: session.metadata.user_id,
                entry,
                correlation_id: input.correlation_id,
            });
        }
    } else {
        // Fallback to skeletal summary if Mem0 is disabled or failed
        const concatenated = messagesToConsolidate
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n');

        const rawSummary = concatenated.slice(0, 2000);
        const entry: WorkingMemoryEntry = {
            type: 'consolidated_context',
            summary: rawSummary,
            original_count: messagesToConsolidate.length,
            timestamp: nowIso(),
            importance: 0.5,
        };
        summaries.push(entry);

        await this.workingMemoryStore.appendWorkingMemoryEntries({
            tenant_id,
            session_id,
            entries: [entry],
            correlation_id: input.correlation_id,
        });

        // Route to L2 LongTerm/HSG/Vector (skeletal summary also needs routing)
        await this.routeWorkingMemoryEntry({
            tenant_id,
            session_id,
            user_id: session.metadata.user_id,
            entry,
            correlation_id: input.correlation_id,
        });
    }

    // Update context window and metadata after consolidation.
    session.context_window = remainingMessages;
    session.metadata.total_tokens = remainingMessages.reduce(
      (acc, m) => acc + (m.token_count ?? 100), // simplistic fallback for estimate
      0,
    );
    session.metadata.state = SessionState.ACTIVE;
    session.metadata.context_summary = summaries.length > 0 ? summaries[0].summary : undefined;

    await this.sessionStore.saveSession(session);

    return {
      session_id,
      summaries,
      consolidated_messages: messagesToConsolidate.length,
    };
  }

  async end_session(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    reason?: string;
    correlation_id: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    archived: boolean;
  }> {
    const { tenant_id, session_id } = input;
    const session = await this.sessionStore.loadSession(tenant_id, session_id);
    if (!session) {
      // Idempotent behavior: treat missing session as already archived.
      return { session_id, archived: false };
    }

    // Best-effort consolidation before archive (no-op skeleton).
    if (session.context_window.length > 0) {
      await this.consolidate_session({
        tenant_id,
        session_id,
        strategy: 'full',
        correlation_id: input.correlation_id,
      });
    }

    session.metadata.state = SessionState.ARCHIVED;
    await this.sessionStore.saveSession(session);
    await this.sessionStore.archiveSession(tenant_id, session_id);

    return {
      session_id,
      archived: true,
    };
  }

  async get_session_state(input: {
    tenant_id: TenantId;
    session_id: SessionId;
  }): Promise<{
    metadata: SessionMetadata;
    working_memory: WorkingMemoryEntry[];
  }> {
    const { tenant_id, session_id } = input;
    const session = await this.sessionStore.loadSession(tenant_id, session_id);
    if (!session) {
      throw new Error(`Session not found: ${session_id}`);
    }

    const working_memory = await this.workingMemoryStore.getWorkingMemory({
      tenant_id,
      session_id,
    });

    return {
      metadata: session.metadata,
      working_memory,
    };
  }

  private async routeMessageToMemory(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    user_id?: UserId;
    message: SessionMessage;
    correlation_id: CorrelationId;
  }): Promise<void> {
    const decision = await this.routingPolicy.decideForMessage({
      tenant_id: input.tenant_id,
      session_id: input.session_id,
      user_id: input.user_id,
      role: input.message.role,
      content: input.message.content,
      metadata: input.message.metadata,
      correlation_id: input.correlation_id,
    });

    if (decision.target === 'none') {
      return;
    }

    const shouldWriteToHsg = decision.target === 'hsg' || decision.target === 'hsg+vector';
    const shouldWriteToVector = decision.target === 'vector' || decision.target === 'hsg+vector';

    if (shouldWriteToHsg) {
      const { primary_sector, sectors } = await this.resolvePrimarySectorFromDecision({
        decision,
        content: input.message.content,
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        session_id: input.session_id,
        correlation_id: input.correlation_id,
      });

      await this.hsgClient.addToSector({
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        session_id: input.session_id,
        primary_sector,
        sectors,
        content: input.message.content,
        metadata: {
          kind: 'session_message',
          message_id: input.message.message_id,
          role: input.message.role,
          modality: input.message.modality,
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          user_id: input.user_id,
          payload_metadata: input.message.metadata,
        },
        correlation_id: input.correlation_id,
      });
    }

    if (shouldWriteToVector) {
      const collection = decision.vector_collection ?? 'session_memories';
      const vector = this.buildPlaceholderVectorFromContent(input.message.content);

      await this.vectorClient.upsertVector({
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        session_id: input.session_id,
        collection,
        vector,
        payload: {
          kind: 'session_message',
          message_id: input.message.message_id,
          role: input.message.role,
          modality: input.message.modality,
          content: input.message.content,
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          user_id: input.user_id,
          metadata: input.message.metadata,
        },
        correlation_id: input.correlation_id,
      });
    }
  }

  private async routeWorkingMemoryEntry(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    user_id?: UserId;
    entry: WorkingMemoryEntry;
    correlation_id: CorrelationId;
  }): Promise<void> {
    const decision = await this.routingPolicy.decideForWorkingMemoryEntry({
      tenant_id: input.tenant_id,
      session_id: input.session_id,
      user_id: input.user_id,
      entry: input.entry,
      correlation_id: input.correlation_id,
    });

    if (decision.target === 'none') {
      return;
    }

    const shouldWriteToHsg = decision.target === 'hsg' || decision.target === 'hsg+vector';
    const shouldWriteToVector = decision.target === 'vector' || decision.target === 'hsg+vector';

    if (shouldWriteToHsg) {
      const { primary_sector, sectors } = await this.resolvePrimarySectorFromDecision({
        decision,
        content: input.entry.summary,
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        session_id: input.session_id,
        correlation_id: input.correlation_id,
      });

      const pointer = await this.hsgClient.addToSector({
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        session_id: input.session_id,
        primary_sector,
        sectors,
        content: input.entry.summary,
        metadata: {
          kind: 'working_memory_entry',
          entry_type: input.entry.type,
          original_count: input.entry.original_count,
          timestamp: input.entry.timestamp,
          importance: input.entry.importance,
        },
        correlation_id: input.correlation_id,
      });

      input.entry.hsg_pointer = pointer;
    }

    if (shouldWriteToVector) {
      const collection = decision.vector_collection ?? 'session_memories';
      const vector = this.buildPlaceholderVectorFromContent(input.entry.summary);

      const pointer = await this.vectorClient.upsertVector({
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        session_id: input.session_id,
        collection,
        vector,
        payload: {
          kind: 'working_memory_entry',
          entry_type: input.entry.type,
          original_count: input.entry.original_count,
          timestamp: input.entry.timestamp,
          importance: input.entry.importance,
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          user_id: input.user_id,
        },
        correlation_id: input.correlation_id,
      });

      input.entry.vector_pointer = pointer;
    }
  }

  private async resolvePrimarySectorFromDecision(input: {
    decision: RoutingDecision;
    content: string;
    tenant_id: TenantId;
    user_id?: UserId;
    session_id?: SessionId;
    correlation_id?: CorrelationId;
  }): Promise<{ primary_sector: HSGPrimarySector; sectors: string[] }> {
    if (input.decision.hsg_primary_sector) {
      const sectors =
        input.decision.additional_sectors && input.decision.additional_sectors.length > 0
          ? [input.decision.hsg_primary_sector, ...input.decision.additional_sectors]
          : [input.decision.hsg_primary_sector];

      return {
        primary_sector: input.decision.hsg_primary_sector,
        sectors,
      };
    }

    const classification = await this.sectorClassifier.classify({
      content: input.content,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      session_id: input.session_id,
      correlation_id: input.correlation_id,
    });

    return {
      primary_sector: classification.primary_sector,
      sectors: classification.sectors,
    };
  }

  private buildPlaceholderVectorFromContent(_content: string): number[] {
    // Placeholder vector; real embedding generation will be added in later phases.
    return [1];
  }
}

/**
 * Simple in-memory implementation of SessionMemoryStore for tests and
 * early development.
 */
export class InMemorySessionMemoryStore implements SessionMemoryStore {
  private readonly sessions = new Map<string, SessionContext>();

  async createSessionRecord(input: {
    tenant_id: TenantId;
    user_id: UserId;
    external_session_ref?: string;
    initial_context?: Record<string, unknown>;
    config_override?: Partial<SessionConfig>;
  }): Promise<{
    session: SessionContext;
    created: boolean;
    loaded_working_memory: number;
  }> {
    const sessionId = this.resolveSessionId(input);
    const key = this.key(input.tenant_id, sessionId);
    const existing = this.sessions.get(key);
    if (existing) {
      return { session: existing, created: false, loaded_working_memory: existing.working_memory.length };
    }

    const config: SessionConfig = {
      ...DEFAULT_SESSION_CONFIG,
      ...(input.config_override ?? {}),
    };

    const metadata: SessionMetadata = {
      session_id: sessionId,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      started_at: nowIso(),
      last_activity: nowIso(),
      message_count: 0,
      total_tokens: 0,
      state: SessionState.ACTIVE,
    };

    const session: SessionContext = {
      metadata,
      context_window: [],
      working_memory: [],
      config,
    };

    this.sessions.set(key, session);
    return { session, created: true, loaded_working_memory: 0 };
  }

  async loadSession(tenant_id: TenantId, session_id: SessionId): Promise<SessionContext | null> {
    const key = this.key(tenant_id, session_id);
    return this.sessions.get(key) ?? null;
  }

  async saveSession(context: SessionContext): Promise<void> {
    const key = this.key(context.metadata.tenant_id, context.metadata.session_id);
    this.sessions.set(key, context);
  }

  async archiveSession(tenant_id: TenantId, session_id: SessionId): Promise<void> {
    const key = this.key(tenant_id, session_id);
    // Keep archived sessions in memory for diagnostics in this simple impl.
    const existing = this.sessions.get(key);
    if (existing) {
      existing.metadata.state = SessionState.ARCHIVED;
      this.sessions.set(key, existing);
    }
  }

  async getSessionMetadata(tenant_id: TenantId, session_id: SessionId): Promise<SessionMetadata | null> {
    const session = await this.loadSession(tenant_id, session_id);
    return session ? session.metadata : null;
  }

  private resolveSessionId(input: {
    tenant_id: TenantId;
    user_id: UserId;
    external_session_ref?: string;
  }): SessionId {
    if (input.external_session_ref) {
      // Deterministic id based on tenant + external ref.
      return `${input.tenant_id}::${input.external_session_ref}`;
    }
    return IdGenerator.generateWithPrefix('session');
  }

  private key(tenant_id: TenantId, session_id: SessionId): string {
    return `${tenant_id}::${session_id}`;
  }
}

export class InMemoryWorkingMemoryStore implements WorkingMemoryStore {
  private readonly entries = new Map<string, WorkingMemoryEntry[]>();

  async appendWorkingMemoryEntries(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    entries: WorkingMemoryEntry[];
    correlation_id?: CorrelationId;
  }): Promise<void> {
    const key = this.key(input.tenant_id, input.session_id);
    const existing = this.entries.get(key) ?? [];
    
    // Create a copy to modify
    const newEntries = [...existing];

    for (const entry of input.entries) {
      const mem0Id = entry.metadata?.mem0_id;
      if (mem0Id) {
        // Find existing index for this fact
        const idx = newEntries.findIndex(e => e.metadata?.mem0_id === mem0Id);
        if (idx !== -1) {
          // Replace old version (consistency fix)
          newEntries[idx] = entry;
          continue;
        }
      }
      // Otherwise append
      newEntries.push(entry);
    }

    this.entries.set(key, newEntries);
  }

  async getWorkingMemory(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    limit?: number;
  }): Promise<WorkingMemoryEntry[]> {
    const key = this.key(input.tenant_id, input.session_id);
    const list = [...(this.entries.get(key) ?? [])];
    if (input.limit && list.length > input.limit) {
      return list.slice(-input.limit);
    }
    return list;
  }

  async prioritizeWorkingMemory(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    user_id: UserId;
    current_context: string;
    top_k?: number;
  }): Promise<WorkingMemoryEntry[]> {
    const all = await this.getWorkingMemory({
      tenant_id: input.tenant_id,
      session_id: input.session_id,
    });
    const sorted = [...all].sort((a, b) => b.importance - a.importance);
    const k = input.top_k ?? 10;
    return sorted.slice(0, k);
  }

  private key(tenant_id: TenantId, session_id: SessionId): string {
    return `${tenant_id}::${session_id}`;
  }
}

export class NoopLongTermMemoryStore implements LongTermMemoryStore, IProfileMemory, IEvaluationMemory {
  async upsertUserProfileEntries(): Promise<void> {
    // no-op skeleton implementation
  }

  async queryLongTermContext(): Promise<WorkingMemoryEntry[]> {
    return [];
  }

  async getSessionTimeline(): Promise<SessionMessage[]> {
    return [];
  }

  async writeProfileEntries(_input: WriteProfileMemoryInput): Promise<ProfileMemoryWriteResult> {
    return {
      written: 0,
      superseded: 0,
    };
  }

  async search(_input: SearchProfileMemoryInput): Promise<ReadonlyArray<ProfileMemoryEntry>> {
    return [];
  }

  async getProfileSnapshot(
    _input: ProfileMemorySnapshotInput,
  ): Promise<ReadonlyArray<ProfileMemoryEntry>> {
    return [];
  }

  async recordRun(input: RecordEvaluationRunInput): Promise<{ stored: boolean; storedRunId: string }> {
    return {
      stored: false,
      storedRunId: input.run.runId,
    };
  }

  async listRuns(_input: {
    tenantId?: string;
    userId?: string;
    plane?: EvaluationMemoryPlane;
    benchmarkId?: string;
    verdict?: EvaluationMemoryVerdict;
    limit?: number;
  }): Promise<ReadonlyArray<EvaluationMemoryRunRecord>> {
    return [];
  }

  async getPlaneScorecard(
    _input: EvaluationPlaneScorecardInput,
  ): Promise<ReadonlyArray<EvaluationPlaneScorecard>> {
    return [];
  }
}

/**
 * Default SectorClassifier implementation with simple heuristic rules based on
 * content. This is intentionally lightweight and deterministic to be used in
 * early unit tests; more advanced LLM-based classification will be introduced
 * later.
 */
export class DefaultSectorClassifier implements SectorClassifier {
  async classify(input: {
    content: string;
    tenant_id?: TenantId;
    user_id?: UserId;
    session_id?: SessionId;
    correlation_id?: CorrelationId;
  }): Promise<{
    primary_sector: HSGPrimarySector;
    sectors: string[];
    confidence: number;
  }> {
    const text = input.content.toLowerCase();

    if (/(yesterday|last week|today|tomorrow|at \d|met with|remember when)/.test(text)) {
      return { primary_sector: 'episodic', sectors: ['episodic'], confidence: 0.85 };
    }

    if (/(feel|excited|happy|frustrated|anxious|worried|sad)/.test(text)) {
      return { primary_sector: 'emotional', sectors: ['emotional'], confidence: 0.8 };
    }

    if (/(how to|step by step|procedure|use .* to|tutorial)/.test(text)) {
      return { primary_sector: 'procedural', sectors: ['procedural'], confidence: 0.8 };
    }

    // Default to semantic knowledge.
    return { primary_sector: 'semantic', sectors: ['semantic'], confidence: 0.7 };
  }
}

/**
 * Default routing policy that maps messages and working memory entries to
 * HSG/Vector targets according to their rough semantic kind.
 */
export class DefaultMemoryRoutingPolicy implements MemoryRoutingPolicy {
  async decideForMessage(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    user_id?: UserId;
    role: SessionMessage['role'];
    content: string;
    metadata?: SessionMessage['metadata'];
    correlation_id?: CorrelationId;
  }): Promise<RoutingDecision> {
    const meta = input.metadata as Record<string, unknown> | undefined;
    const kind = meta?.kind as string | undefined;

    if (kind === 'user_profile' || kind === 'preference') {
      return {
        target: 'hsg+vector',
        vector_collection: 'user_profile',
        hsg_primary_sector: 'semantic',
        additional_sectors: ['reflective'],
      };
    }

    if (input.role === 'system' || input.role === 'assistant') {
      return {
        target: 'hsg',
        hsg_primary_sector: 'reflective',
        additional_sectors: [],
      };
    }

    // Default: index user/tool messages in both HSG episodic and session_memories collection.
    return {
      target: 'hsg+vector',
      vector_collection: 'session_memories',
      hsg_primary_sector: 'episodic',
      additional_sectors: [],
    };
  }

  async decideForWorkingMemoryEntry(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    user_id?: UserId;
    entry: WorkingMemoryEntry;
    correlation_id?: CorrelationId;
  }): Promise<RoutingDecision> {
    switch (input.entry.type) {
      case 'user_profile':
      case 'preference':
        return {
          target: 'hsg+vector',
          vector_collection: 'user_profile',
          hsg_primary_sector: 'semantic',
          additional_sectors: ['reflective'],
        };
      case 'episodic_reference':
        return {
          target: 'hsg',
          hsg_primary_sector: 'episodic',
          additional_sectors: [],
        };
      case 'consolidated_context':
      default:
        return {
          target: 'hsg+vector',
          vector_collection: 'session_memories',
          hsg_primary_sector: 'reflective',
          additional_sectors: [],
        };
    }
  }
}