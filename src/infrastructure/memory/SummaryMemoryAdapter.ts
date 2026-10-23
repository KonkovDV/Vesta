import type {
  ConsolidateSummaryMemoryInput,
  ISummaryMemory,
  SummaryMemoryConsolidationResult,
} from '../../domain/memory/ISummaryMemory';
import type { WorkingMemoryPlaneEntry } from '../../domain/memory/IWorkingMemory';
import type { ISessionMemoryManager } from '../../domain/memory/ISessionMemoryManager';
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

export class SummaryMemoryAdapter implements ISummaryMemory {
  constructor(private readonly sessionMemoryManager: ISessionMemoryManager) {}

  async consolidateSession(
    input: ConsolidateSummaryMemoryInput,
  ): Promise<SummaryMemoryConsolidationResult> {
    const result = await this.sessionMemoryManager.consolidate_session({
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      strategy: input.strategy,
      correlation_id: input.correlationId,
    });

    return {
      sessionId: result.session_id,
      summaries: result.summaries.map(toDomainEntry),
      consolidatedMessages: result.consolidated_messages,
    };
  }
}