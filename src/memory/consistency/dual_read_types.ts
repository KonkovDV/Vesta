/**
 * Dual-Read Types for Memory Consistency
 * Layer: Memory (consistency)
 *
 * Shared types for dual-read sampling and comparison.
 * Extracted from dual_read_sampler.ts to break circular dependency
 * with dual_read_metrics_adapter.ts (TASK-023).
 */

import type {
  TenantId,
  UserId,
  SessionId,
  CorrelationId,
} from '../../domain/memory/session-types';

/**
 * Logical operation name for dual-read. For now we only support get_context_window
 * but the type is kept extensible for future operations.
 */
export type DualReadOperation = 'get_context_window' | string;

/**
 * Minimal context about the operation being sampled.
 */
export interface DualReadContext {
  tenantId: TenantId;
  sessionId: SessionId;
  userId?: UserId;
  operation: DualReadOperation;
  correlationId?: CorrelationId;
}

/**
 * Reasons why a particular position or window is considered mismatched.
 */
export type DualReadMismatchReason =
  | 'missing_in_legacy'
  | 'missing_in_openmemory'
  | 'role_mismatch'
  | 'modality_mismatch'
  | 'content_mismatch'
  | 'shadow_error';

export interface DualReadMismatchExample {
  /**
   * Zero-based index in the aligned windows where mismatch was detected.
   * For length-only mismatches this may point to the first index beyond
   * the shorter window.
   */
  index: number;
  legacyMessageId?: string;
  openMemoryMessageId?: string;
  reasons: DualReadMismatchReason[];
}

export interface DualReadDiffSummary {
  legacyCount: number;
  openMemoryCount: number;
  mismatchedCount: number;
}

/**
 * Structured result of a dual-read comparison for a single operation.
 *
 * IMPORTANT:
 *  - ok === true means "no detectable differences" for the chosen heuristic.
 *  - ok === false covers both "hard" mismatches and technical failures
 *    (e.g. shadow backend error) – see errorMessage field.
 */
export interface DualReadComparisonResult {
  ok: boolean;
  diffSummary: DualReadDiffSummary;
  context: DualReadContext;
  exampleMismatches?: DualReadMismatchExample[];
  /**
   * Optional shadow backend error description (e.g. thrown by the shadow read).
   * Presence of this field implies ok === false.
   */
  errorMessage?: string;
}
