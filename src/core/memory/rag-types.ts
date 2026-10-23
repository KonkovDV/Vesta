/**
 * Core RAG DTO types shared between Application and Memory layers.
 *
 * Layer: Core
 */

export interface RagQueryScopes {
  kb?: boolean;
  userMemory?: boolean;
}

export interface RagQueryInput {
  tenantId: string;
  userId?: string;
  sessionId?: string;
  query: string;
  scopes?: RagQueryScopes;
  topK?: number;
  filters?: Record<string, unknown>;
}

export type RagSourceType = 'kb' | 'user_profile' | 'session_memory';

export interface RagContextItem {
  id: string;
  sourceType: RagSourceType;
  score: number;
  text: string;
  metadata?: Record<string, unknown>;
}