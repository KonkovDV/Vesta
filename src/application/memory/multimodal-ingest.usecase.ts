/**
 * Multimodal ingest use case for Session Memory (Phase 11 M3).
 *
 * Layer: Application
 *
 * Responsibilities:
 * - Accept normalized multi-modal content (text/image/audio/video) with metadata;
 * - Persist it via ISessionMemoryManager.add_message (dual-write aware);
 * - Emit typed event "multimodal.content.processed" via EventStoreService (Outbox-first).
 */

import type { ISessionMemoryManager } from '../../domain/memory/ISessionMemoryManager';
import type {
  TenantId,
  UserId,
  SessionId,
  CorrelationId,
  SessionModality,
  SessionRole,
} from '../../domain/memory/session-types';
import { RequestContext } from '../context/request-context';
import {
  emitMultimodalContentProcessed,
  type MultimodalContentType,
} from './multimodal-events';
import {
  incrementMultimodalIngestTotal,
  recordMultimodalIngestDuration,
  recordMultimodalIngestError,
} from '../../memory/observability/memory-metrics';

/**
 * Logical source of multimodal content.
 * Kept as a string union but allows arbitrary string for forward compatibility.
 */
export type MultimodalIngestSource = 'mas' | 'plugin' | 'api' | string;

export interface MultimodalContentItem {
  /**
   * High-level modality of the content being ingested.
   * Must stay in sync with MultimodalContentType / typed-events registry.
   */
  modality: MultimodalContentType;

  /**
   * Role under which the content is recorded in Session Memory.
   * Defaults to "user" when not provided.
   */
  role?: SessionRole;

  /**
   * Normalized textual representation of the content:
   * - text: original user/assistant message;
   * - image: caption/description;
   * - audio: transcription;
   * - video: summary/transcription.
   *
   * Binary blobs are NOT stored in Session Memory; only text representations.
   */
  content: string;

  /**
   * Arbitrary metadata, including references to uploaded files, mime types, etc.
   */
  metadata?: Record<string, unknown>;
}

export interface MultimodalIngestInput {
  tenantId: TenantId;
  sessionId: SessionId;
  userId?: UserId;
  source: MultimodalIngestSource;
  items: MultimodalContentItem[];
  correlationId?: CorrelationId;
}

export interface MultimodalIngestMessageResult {
  messageId: string;
  modality: MultimodalContentType;
  totalTokens: number;
  contextWindowSize: number;
}

export interface MultimodalIngestResult {
  sessionId: SessionId;
  messages: MultimodalIngestMessageResult[];
}

function toSessionModality(modality: MultimodalContentType): SessionModality {
  // Explicit mapping for future-proofing even though unions currently align 1:1.
  switch (modality) {
    case 'text':
    case 'image':
    case 'audio':
    case 'video':
      return modality;
    default:
      return 'text';
  }
}

function resolveCorrelationId(explicit?: CorrelationId): CorrelationId {
  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }

  try {
    const fromCtx = RequestContext.getCorrelationId();
    if (fromCtx) {
      return String(fromCtx);
    }
  } catch {
    // RequestContext not available — fall back to synthetic id below.
  }

  return `multimodal-ingest:${Date.now()}`;
}

/**
 * Application-layer facade for multi-modal ingest into Session Memory.
 *
 * This use case:
 * - is agnostic of specific HSG/Vector implementations;
 * - delegates all persistence to ISessionMemoryManager (which may be DualWriteMemoryManager);
 * - emits typed event "multimodal.content.processed" for each successfully persisted item.
 *
 * EV15_MEMORY_TX_GUARANTEES:
 * - when no active IUnitOfWork transaction exists, the whole ingest operation
 *   is executed inside a single executeInTransaction() boundary;
 * - when called from within an existing transaction, it reuses the ambient
 *   transaction instead of opening an additional nested executeInTransaction().
 */
export class MultimodalIngestUseCase {
  constructor(
    private readonly sessionMemoryManager: ISessionMemoryManager,
    private readonly unitOfWork?: import('../../domain/persistence/IUnitOfWork').IUnitOfWork,
  ) {}
 
  async execute(input: MultimodalIngestInput): Promise<MultimodalIngestResult> {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      return {
        sessionId: input.sessionId,
        messages: [],
      };
    }
 
    const correlationId = resolveCorrelationId(input.correlationId);
 
    const run = async (): Promise<MultimodalIngestResult> => {
      return this.executeInternal(input, correlationId);
    };
 
    // If there is no UnitOfWork (e.g. test/dev without DB), fall back to
    // non-transactional execution – invariants apply only when UoW is available.
    if (!this.unitOfWork) {
      return run();
    }
 
    // If there is already an active transaction, reuse it instead of opening
    // a nested executeInTransaction to respect PostgresUnitOfWork invariants.
    if (this.unitOfWork.getCurrentTransaction()) {
      return run();
    }
 
    return this.unitOfWork.executeInTransaction(async () => run());
  }
 
  private async executeInternal(
    input: MultimodalIngestInput,
    correlationId: CorrelationId,
  ): Promise<MultimodalIngestResult> {
    const results: MultimodalIngestMessageResult[] = [];
 
    for (const item of input.items) {
      const modality: SessionModality = toSessionModality(item.modality);
      const role: SessionRole = item.role ?? 'user';
 
      const started = process.hrtime.bigint();
      let outcome: 'success' | 'error' = 'success';
 
      try {
        const memoryResult = await this.sessionMemoryManager.add_message({
          tenant_id: input.tenantId,
          session_id: input.sessionId,
          user_id: input.userId,
          role,
          modality,
          content: item.content,
          metadata: {
            ...(item.metadata ?? {}),
            source: input.source,
            modality: item.modality,
            // Hint for routing/policy engines that this message originates from
            // the multi-modal ingest pipeline.
            kind:
              (item.metadata)?.kind ??
              'multimodal_content',
          },
          correlation_id: correlationId,
        });
 
        const finished = process.hrtime.bigint();
        const processingTimeMs = Number(finished - started) / 1e6;
        const durationSeconds = processingTimeMs / 1000;
 
        results.push({
          messageId: memoryResult.message_id,
          modality: item.modality,
          totalTokens: memoryResult.total_tokens,
          contextWindowSize: memoryResult.context_window_size,
        });
 
        const processingResult: Record<string, unknown> = {
          tenant_id: input.tenantId,
          user_id: input.userId,
          session_id: input.sessionId,
          message_id: memoryResult.message_id,
          source: input.source,
          modality: item.modality,
          total_tokens: memoryResult.total_tokens,
          context_window_size: memoryResult.context_window_size,
        };
 
        // Typed event emission is best-effort and must not break ingest.
        await emitMultimodalContentProcessed({
          aggregateId: input.sessionId,
          contentId: memoryResult.message_id,
          contentType: item.modality,
          processingResult,
          correlationId,
          processingTimeMs,
        });
 
        // Metrics: best-effort, do not affect business logic.
        recordMultimodalIngestDuration({
          modality: item.modality,
          source: input.source,
          outcome,
          durationSeconds,
        });
        incrementMultimodalIngestTotal({
          modality: item.modality,
          source: input.source,
          outcome,
        });
      } catch (err) {
        outcome = 'error';
        const finished = process.hrtime.bigint();
        const durationSeconds = Number(finished - started) / 1e9;
 
        recordMultimodalIngestDuration({
          modality: item.modality,
          source: input.source,
          outcome,
          durationSeconds,
        });
        incrementMultimodalIngestTotal({
          modality: item.modality,
          source: input.source,
          outcome,
        });
        recordMultimodalIngestError({
          modality: item.modality,
          source: input.source,
          error: err,
        });
 
        throw err;
      }
    }
 
    return {
      sessionId: input.sessionId,
      messages: results,
    };
  }
}