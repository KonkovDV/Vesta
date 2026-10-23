/**
 * PostgresSessionMemoryStore
 * Infrastructure implementation of SessionMemoryStore using PostgreSQL.
 *
 * Layer: Infrastructure
 *
 * Maps SessionContext to 'conversations' and 'messages' tables.
 * - Session -> Conversation (metadata -> conversations.metadata)
 * - SessionMessage -> Message (messages table)
 * - WorkingMemory -> Stored in conversations.metadata['__mas_working_memory']
 *
 * Follows strict architecture:
 * - Implements SessionMemoryStore (Memory Layer)
 * - Depends on IDatabaseConnection (Domain/Persistence)
 */

import {
  SessionMemoryStore,
} from '../../../domain/memory/session-memory-ports';
import {
  SessionContext,
  SessionId,
  TenantId,
  SessionConfig,
  SessionMetadata,
  UserId,
  SessionState,
  SessionMessage,
  WorkingMemoryEntry,
  SessionRole,
  SessionModality,
} from '../../../domain/memory/session-types';
import { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';
import { safeJsonParse } from '../../../core/utils/json';
import { countTokens } from '../../../core/utils/tokenizer';
import { IdGenerator } from '../../../core/utils/IdGenerator';

const WORKING_MEMORY_METADATA_KEY = '__mas_working_memory';
const CONFIG_METADATA_KEY = '__mas_session_config';

type JsonMetadata = Record<string, unknown>;

interface DbConversationRow {
  id: string;
  created_by: string;
  status: string;
  session_state?: string | null;
  participants: unknown; // JSONB
  metadata: JsonMetadata; // JSONB
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface DbMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  author_id: string;
  content: string;
  message_type: string | null;
  created_at: Date;
  metadata: JsonMetadata; // JSONB
  token_count?: number; // Might not exist in schema yet, fall back to calc or metadata
}

export class PostgresSessionMemoryStore implements SessionMemoryStore {
  constructor(private readonly db: IDatabaseConnection) {}

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
    // 1. Check if session exists (Idempotency)
    // For now, we assume external_session_ref MIGHT be the ID or we generate a new one.
    // The interface implies we might get an ID or we generate it. 
    // In this system, typically the caller provides the ID or we use a UUID.
    // Assuming input.external_session_ref IS the session_id if provided.

    const sessionId = input.external_session_ref || IdGenerator.generate();
    const now = new Date();

    // Check existence
    const existing = await this.loadSession(input.tenant_id, sessionId);
    if (existing) {
      return {
        session: existing,
        created: false,
        loaded_working_memory: existing.working_memory.length,
      };
    }

    // 2. Create new SessionContext structure
    const config: SessionConfig = {
      max_context_tokens: 8000,
      consolidation_threshold: 4000,
      max_messages: 50,
      sliding_window: true,
      enable_compression: false,
      retention_days: 7,
      ...input.config_override,
    };

    const metadata: SessionMetadata = {
      session_id: sessionId,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      started_at: now.toISOString(),
      last_activity: now.toISOString(),
      message_count: 0,
      total_tokens: 0,
      state: SessionState.ACTIVE,
      context_summary: undefined,
    };

    const initialWorkingMemory: WorkingMemoryEntry[] = []; // Loading from input.initial_context TBD

    const sessionContext: SessionContext = {
      metadata,
      context_window: [],
      working_memory: initialWorkingMemory,
      config,
    };

    // 3. Persist to DB
    await this.saveSessionToDb(sessionContext);

    return {
      session: sessionContext,
      created: true,
      loaded_working_memory: 0,
    };
  }

  async loadSession(tenant_id: TenantId, session_id: SessionId): Promise<SessionContext | null> {
    // 1. Get Conversation
    const convResult = await this.db.query<DbConversationRow>(
      `SELECT * FROM conversations WHERE id = $1 AND status != 'deleted'`,
      [session_id]
    );

    if (convResult.rows.length === 0) {
      return null;
    }
    const row = convResult.rows[0];

    // 2. Get Messages (Limited by default, but for Context Window we might need latest N)
    // Using a safe limit of 50 for context window
    const msgsResult = await this.db.query<DbMessageRow>(
      `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [session_id]
    );

    // 3. Reconstruct SessionContext
    const metadataJson = row.metadata || {};
    const workingMemory = safeJsonParse<WorkingMemoryEntry[]>(String(metadataJson[WORKING_MEMORY_METADATA_KEY] ?? ''), []) || [];
    const config = safeJsonParse<SessionConfig>(String(metadataJson[CONFIG_METADATA_KEY] ?? ''), {
        max_context_tokens: 8000,
        consolidation_threshold: 4000,
        max_messages: 50,
        sliding_window: true,
        enable_compression: false,
        retention_days: 7,
    }) as SessionConfig;

    const messages = msgsResult.rows.reverse().map((m: DbMessageRow) => this.mapDbMessageToSessionMessage(m, tenant_id, row.created_by));

    const metadata: SessionMetadata = {
      session_id: row.id,
      tenant_id,
      user_id: row.created_by,
      started_at: row.created_at.toISOString(),
      last_activity: row.updated_at.toISOString(),
      message_count: messages.length, // Approximation of loaded window
      total_tokens: messages.reduce((acc: number, m: SessionMessage) => acc + m.token_count, 0),
      state: (row.session_state || row.status) as SessionState,
      context_summary: undefined,
    };

    return {
      metadata,
      context_window: messages,
      working_memory: workingMemory,
      config,
    };
  }

  async saveSession(context: SessionContext): Promise<void> {
    return this.saveSessionToDb(context);
  }

  async archiveSession(tenant_id: TenantId, session_id: SessionId): Promise<void> {
    await this.db.query(
      `UPDATE conversations SET status = 'archived', updated_at = NOW() WHERE id = $1`,
      [session_id]
    );
  }

  async getSessionMetadata(tenant_id: TenantId, session_id: SessionId): Promise<SessionMetadata | null> {
    const session = await this.loadSession(tenant_id, session_id);
    return session ? session.metadata : null;
  }

  // --- Helpers ---

  private async saveSessionToDb(context: SessionContext): Promise<void> {
    const { session_id, user_id, state } = context.metadata;
    const { working_memory, config } = context;

    // Prepare metadata JSON
    const metadataPayload = {
      [WORKING_MEMORY_METADATA_KEY]: working_memory,
      [CONFIG_METADATA_KEY]: config,
      // preserve other keys if we were doing a merge, but here strict override
    };

    // Upsert Conversation
    await this.db.query(
      `INSERT INTO conversations (
         id, created_by, participants, status, session_state, version, created_at, updated_at, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         session_state = EXCLUDED.session_state,
         updated_at = EXCLUDED.updated_at,
         metadata = conversations.metadata || EXCLUDED.metadata`,
      [
        session_id,
        user_id,
        JSON.stringify([user_id]),
        state === 'archived' ? 'archived' : 'active',
        state,
        1,
        new Date(context.metadata.started_at),
        new Date(),
        JSON.stringify(metadataPayload),
      ]
    );

    // Persist messages that are new ? 
    // SessionMemoryStore.saveSession implies saving the state. 
    // Usually messages are added incrementally via addMessage events. 
    // But if context.context_window contains new messages, we should save them.
    // Logic: Iterate context window, upsert messages.
    
    for (const msg of context.context_window) {
       await this.db.query(
         `INSERT INTO messages (
            id, conversation_id, role, author_id, content, message_type, created_at, metadata, token_count
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO NOTHING`,
         [
           msg.message_id,
           msg.session_id,
           msg.role,
           msg.user_id || context.metadata.user_id,
           msg.content,
           msg.modality,
           new Date(msg.created_at),
           JSON.stringify(msg.metadata),
           msg.token_count || countTokens(msg.content),
         ]
       );
    }
  }

  private mapDbMessageToSessionMessage(row: DbMessageRow, tenant_id: string, defUserId: string): SessionMessage {
    return {
      message_id: row.id,
      session_id: row.conversation_id,
      tenant_id,
      user_id: row.author_id,
      role: row.role as SessionRole,
      modality: (row.message_type as SessionModality) || 'text',
      content: row.content,
      created_at: row.created_at.toISOString(),
      token_count: row.token_count || countTokens(row.content),
      metadata: row.metadata || {},
    };
  }
}
