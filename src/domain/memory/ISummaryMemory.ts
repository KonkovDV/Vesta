/**
 * ISummaryMemory — Domain port for the explicit summary-memory plane.
 *
 * Exposes session consolidation as a first-class memory-plane operation
 * instead of leaving summary artifacts implicit inside session-management
 * internals.
 *
 * @layer Domain (Memory)
 * @since v2.9.0 — summary-memory plane explicitization
 */

import type { WorkingMemoryPlaneEntry } from './IWorkingMemory';

export type SummaryMemoryStrategy = 'auto' | 'full' | 'recent_window';

export interface ConsolidateSummaryMemoryInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly strategy?: SummaryMemoryStrategy;
  readonly correlationId: string;
}

export interface SummaryMemoryConsolidationResult {
  readonly sessionId: string;
  readonly summaries: ReadonlyArray<WorkingMemoryPlaneEntry>;
  readonly consolidatedMessages: number;
}

export interface ISummaryMemory {
  consolidateSession(
    input: ConsolidateSummaryMemoryInput,
  ): Promise<SummaryMemoryConsolidationResult>;
}