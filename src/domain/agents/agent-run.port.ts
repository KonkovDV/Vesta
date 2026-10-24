/**
 * Agent loop contract. The service that records the loop stays in application.
 * Layer: Domain
 */

import type { ChatMessage, ChatToolSpec } from '../ai/IChatCompletionModel';

export interface AgentRunLimits {
  maxSteps: number;
  maxTotalTokens?: number;
  approvalTimeoutMs?: number;
  /** Compact the model prompt once usage is above this many tokens. */
  compactAfterTokens?: number;
  /** First delay after a failed model call; doubles per failure, with jitter. Default 500 ms. */
  modelRetryBaseMs?: number;
}

export interface AgentRunRequest {
  messages: ChatMessage[];
  tools?: ChatToolSpec[];
  correlationId: string;
  runId?: string;
  codeVersion?: string;
  modelId?: string;
  signal?: AbortSignal;
  limits?: AgentRunLimits;
  agentId?: string;
  sessionId?: string;
  workspaceRoot?: string;
  /** Authenticated principal that owns the run. Stored on AgentRunStarted. */
  ownerId?: string;
  tenantId?: string;
}

export interface AgentRunResult {
  runId: string;
  reason: 'completed' | 'max_steps' | 'budget_exhausted' | 'awaiting_approval' | 'paused' | 'cancelled' | 'killed' | 'version_mismatch';
  content?: string;
}

export interface AgentRunStatus {
  runId: string;
  status: 'running' | AgentRunResult['reason'];
  step: number;
  reason?: string;
  content?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface IAgentRunControl {
  start(request: AgentRunRequest): Promise<AgentRunResult>;
  status(runId: string): Promise<AgentRunStatus | undefined>;
  cancel(runId: string, correlationId: string): Promise<void>;
}
