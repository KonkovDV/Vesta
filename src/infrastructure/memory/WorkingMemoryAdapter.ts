import type {
  AppendWorkingMemoryInput,
  GetWorkingMemoryInput,
  IWorkingMemory,
  PrioritizeWorkingMemoryInput,
  WorkingMemoryPlaneEntry,
} from '../../domain/memory/IWorkingMemory';
import type { WorkingMemoryStore } from '../../domain/memory/session-memory-ports';
import type { WorkingMemoryEntry } from '../../domain/memory/session-types';

function toDomainEntry(entry: WorkingMemoryEntry): WorkingMemoryPlaneEntry {
  return {
    type: entry.type,
    summary: entry.summary,
    originalCount: entry.original_count,
    timestamp: entry.timestamp,
    importance: entry.importance,
    salience: entry.salience,
    lastSeenAt: entry.last_seen_at,
    metadata: entry.metadata,
  };
}

function toWorkingEntry(entry: WorkingMemoryPlaneEntry): WorkingMemoryEntry {
  return {
    type: entry.type,
    summary: entry.summary,
    original_count: entry.originalCount,
    timestamp: entry.timestamp,
    importance: entry.importance,
    salience: entry.salience,
    last_seen_at: entry.lastSeenAt,
    metadata: entry.metadata,
  };
}

export class WorkingMemoryAdapter implements IWorkingMemory {
  constructor(private readonly store: WorkingMemoryStore) {}

  async appendEntries(input: AppendWorkingMemoryInput): Promise<void> {
    await this.store.appendWorkingMemoryEntries({
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      entries: input.entries.map(toWorkingEntry),
      correlation_id: input.correlationId,
    });
  }

  async getEntries(input: GetWorkingMemoryInput): Promise<ReadonlyArray<WorkingMemoryPlaneEntry>> {
    const entries = await this.store.getWorkingMemory({
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      limit: input.limit,
    });

    return entries.map(toDomainEntry);
  }

  async prioritizeEntries(
    input: PrioritizeWorkingMemoryInput,
  ): Promise<ReadonlyArray<WorkingMemoryPlaneEntry>> {
    const entries = await this.store.prioritizeWorkingMemory({
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      user_id: input.userId,
      current_context: input.currentContext,
      top_k: input.topK,
    });

    return entries.map(toDomainEntry);
  }
}