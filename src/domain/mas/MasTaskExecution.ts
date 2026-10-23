/**
 * MasTaskExecution - Domain type for MAS task execution state.
 *
 * Layer: Domain (enterprise business rules)
 */

import type { MasExecutionError } from './MasExecutionError';

import type { MasExecutionStep } from './MasExecutionStep';
import type { MasTaskStatus } from './MasTaskStatus';

import type { RequestContextSnapshot } from './RequestContextSnapshot';

export interface MasTaskExecution {
  taskExecutionId: string;
  taskId: string;
  sessionId: string;
  status: MasTaskStatus;
  currentStepId: string | null;
  steps: MasExecutionStep[];
  attempts: number;
  lastError?: MasExecutionError;
  requestContextSnapshot: RequestContextSnapshot;
  createdAt: Date;
  updatedAt: Date;
  meta?: Record<string, unknown>;
  timeouts: {
    taskTimeoutMs?: number;
    stepTimeoutMs?: number;
  };
  lockedBy?: string;
  lockExpiresAt?: Date;
  /**
   * Optimistic locking version for concurrent access control.
   * Incremented on each update to prevent lost updates in race conditions.
   */
  version?: number;
}
