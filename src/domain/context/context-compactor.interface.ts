/**
 * IContextCompactor - Context Compaction Interface
 * @layer Domain
 * @singularity Layer 5
 */

export interface ConversationContext {
  conversationId: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    timestamp?: Date;
    tool_call_id?: string;
    tool_calls?: Array<{id: string; type: string; function: {name: string; arguments: string}}>;
  }>;
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface CompactionOptions {
  targetTokens?: number;
  maxTokens?: number;
  strategy?: CompactionStrategy;
  preserveSystemPrompt?: boolean;
  minMessages?: number;
  model?: string; // Phase 9: Model awareness
}

export type CompactionStrategy = 
  | 'none'
  | 'sliding_window'
  | 'summarization'
  | 'importance_based'
  | 'hybrid';

export interface CompactedContext {
  conversationId: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    tool_call_id?: string;
    tool_calls?: Array<{id: string; type: string; function: {name: string; arguments: string}}>;
  }>;
  originalTokens: number;
  compactedTokens: number;
  strategy: CompactionStrategy;
  summary?: string;
}

export interface IContextCompactor {
  compact(context: ConversationContext, options?: CompactionOptions): Promise<CompactedContext>;
  estimateTokens(context: ConversationContext): number;
  getCompactionStrategy(): CompactionStrategy;
  setCompactionStrategy(strategy: CompactionStrategy): void;
}
