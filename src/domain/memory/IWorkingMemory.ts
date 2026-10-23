/**
 * IWorkingMemory — Domain port for the explicit working-memory plane.
 *
 * Exposes the hot-path session memory surface separately from the broader
 * session manager so bounded context assembly, working-memory injection, and
 * prioritization become first-class architecture concepts.
 *
 * @layer Domain (Memory)
 * @since v2.9.0 — working-memory plane explicitization
 */

export type WorkingMemoryEntryKind =
  | 'consolidated_context'
  | 'episodic_reference'
  | 'user_profile'
  | 'preference';

export interface WorkingMemoryPlaneEntry {
  readonly type: WorkingMemoryEntryKind;
  readonly summary: string;
  readonly originalCount?: number;
  readonly timestamp: string;
  readonly importance: number;
  readonly salience?: number;
  readonly lastSeenAt?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface AppendWorkingMemoryInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly entries: ReadonlyArray<WorkingMemoryPlaneEntry>;
  readonly correlationId?: string;
}

export interface GetWorkingMemoryInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly limit?: number;
}

export interface PrioritizeWorkingMemoryInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly currentContext: string;
  readonly topK?: number;
}

export interface IWorkingMemory {
  appendEntries(input: AppendWorkingMemoryInput): Promise<void>;

  getEntries(input: GetWorkingMemoryInput): Promise<ReadonlyArray<WorkingMemoryPlaneEntry>>;

  prioritizeEntries(
    input: PrioritizeWorkingMemoryInput,
  ): Promise<ReadonlyArray<WorkingMemoryPlaneEntry>>;
}