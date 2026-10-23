/**
 * Session memory port. The manager class stays in the memory layer.
 * Layer: Domain
 */

import type {
  CorrelationId,
  SessionConfig,
  SessionId,
  SessionMessage,
  SessionMetadata,
  TenantId,
  UserId,
  WorkingMemoryEntry,
} from './session-types';

export interface ISessionMemoryManager {
  create_session(input: {
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
  }>;

  add_message(input: {
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
  }>;

  get_context_window(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    max_messages?: number;
    max_tokens?: number;
    correlation_id?: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    messages: SessionMessage[];
  }>;

  consolidate_session(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    strategy?: 'auto' | 'full' | 'recent_window';
    correlation_id: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    summaries: WorkingMemoryEntry[];
    consolidated_messages: number;
  }>;

  end_session(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    reason?: string;
    correlation_id: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    archived: boolean;
  }>;

  get_session_state(input: {
    tenant_id: TenantId;
    session_id: SessionId;
  }): Promise<{
    metadata: SessionMetadata;
    working_memory: WorkingMemoryEntry[];
  }>;
}
