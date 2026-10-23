/**
 * DualWriteMemoryManager — координация legacy и OpenMemory backend'ов.
 *
 * Layer: Memory
 *
 * Реализует интерфейс ISessionMemoryManager и использует MemoryModeResolver
 * для переключения режимов:
 * - 'legacy-only'
 * - 'dual-write'
 * - 'openmemory-only'
 *
 * В режиме dual-write:
 * - mutating-операции сначала вызывают legacy backend;
 * - OpenMemory backend вызывается best-effort во втором шаге;
 * - ошибки legacy пробрасываются наружу;
 * - ошибки OpenMemory логируются и передаются в telemetry hooks,
 *   но не пробрасываются.
 */

import {
  CorrelationId,
  SessionConfig,
  SessionId,
  SessionMessage,
  SessionMetadata,
  TenantId,
  UserId,
  WorkingMemoryEntry,
} from '../../domain/memory/session-types';
import type { ISessionMemoryManager } from './SessionMemoryManager';
import type { MemoryMode, MemoryModeResolver } from './MemoryModeResolver';
import { logger } from '../../infrastructure/logging/logger';
import {
  recordSessionOperationDuration,
  incrementSessionOperationTotal,
  recordDualWriteOutcome,
  recordBackendError,
  updateActiveSessions,
} from '../observability/memory-metrics';
import type {
  DualReadSampler,
  DualReadContext,
  DualReadComparisonResult,
  DualReadReportSink,
} from '../consistency/dual_read_sampler';
import {
  DefaultDualReadSampler,
  ConsoleDualReadReportSink,
} from '../consistency/dual_read_sampler';

type DualWriteOperation =
  | 'create_session'
  | 'add_message'
  | 'consolidate_session'
  | 'end_session';

export type DualWriteBackend = 'legacy' | 'openmemory';

export interface DualWriteTelemetryHooks {
  recordSuccess(operation: DualWriteOperation, backend: DualWriteBackend): void;
  recordError(operation: DualWriteOperation, backend: DualWriteBackend, error: unknown): void;
}

export const NoopDualWriteTelemetryHooks: DualWriteTelemetryHooks = {
  recordSuccess: () => {},
  recordError: () => {},
};

const log = logger.child({ component: 'DualWriteMemoryManager' });

export class DualWriteMemoryManager implements ISessionMemoryManager {
  private readonly dualReadSampler: DualReadSampler;

  constructor(
    private readonly legacy: ISessionMemoryManager,
    private readonly openmemory: ISessionMemoryManager,
    private readonly modeResolver: MemoryModeResolver,
    private readonly telemetry: DualWriteTelemetryHooks = NoopDualWriteTelemetryHooks,
    reportSink?: DualReadReportSink,
  ) {
    // Use injected sink or fall back to console sink for MEM-M2.4.
    this.dualReadSampler = new DefaultDualReadSampler(
      reportSink ?? new ConsoleDualReadReportSink(),
      {
        sampleRate: 0.05,
      },
    );
  }

  private getMode(tenantId: TenantId): MemoryMode {
    return this.modeResolver.getMode(tenantId);
  }

  async create_session(input: {
    tenant_id: TenantId;
    user_id: UserId;
    external_session_ref?: string;
    initial_context?: Record<string, unknown>;
    config_override?: Partial<SessionConfig>;
    correlation_id: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    created: boolean;
    loaded_working_memory: number;
  }> {
    const mode = this.getMode(input.tenant_id);
    const started = process.hrtime.bigint();
    let outcome: 'success' | 'error' = 'success';

    try {
      if (mode === 'openmemory-only') {
        try {
          const result = await this.openmemory.create_session(input);
          this.telemetry.recordSuccess('create_session', 'openmemory');
          recordDualWriteOutcome({
            operation: 'create_session',
            backend: 'openmemory',
            mode,
            outcome: 'success',
          });
          if (result.created) {
            updateActiveSessions({
              tenantId: input.tenant_id,
              mode,
              delta: 1,
            });
          }
          return result;
        } catch (err) {
          this.telemetry.recordError('create_session', 'openmemory', err);
          recordDualWriteOutcome({
            operation: 'create_session',
            backend: 'openmemory',
            mode,
            outcome: 'error',
          });
          recordBackendError({
            backend: 'openmemory',
            operation: 'create_session',
            error: err,
            mode,
          });
          throw err;
        }
      }

      if (mode === 'legacy-only') {
        try {
          const result = await this.legacy.create_session(input);
          this.telemetry.recordSuccess('create_session', 'legacy');
          recordDualWriteOutcome({
            operation: 'create_session',
            backend: 'legacy',
            mode,
            outcome: 'success',
          });
          if (result.created) {
            updateActiveSessions({
              tenantId: input.tenant_id,
              mode,
              delta: 1,
            });
          }
          return result;
        } catch (err) {
          this.telemetry.recordError('create_session', 'legacy', err);
          recordDualWriteOutcome({
            operation: 'create_session',
            backend: 'legacy',
            mode,
            outcome: 'error',
          });
          // Для legacy backendErrors сейчас не считаем, чтобы не засорять метрику.
          throw err;
        }
      }

      // dual-write
      let legacyResult;
      try {
        legacyResult = await this.legacy.create_session(input);
        this.telemetry.recordSuccess('create_session', 'legacy');
        recordDualWriteOutcome({
          operation: 'create_session',
          backend: 'legacy',
          mode,
          outcome: 'success',
        });
        if (legacyResult.created) {
          updateActiveSessions({
            tenantId: input.tenant_id,
            mode,
            delta: 1,
          });
        }
      } catch (err) {
        this.telemetry.recordError('create_session', 'legacy', err);
        recordDualWriteOutcome({
          operation: 'create_session',
          backend: 'legacy',
          mode,
          outcome: 'error',
        });
        throw err;
      }

      try {
        await this.openmemory.create_session(input);
        this.telemetry.recordSuccess('create_session', 'openmemory');
        recordDualWriteOutcome({
          operation: 'create_session',
          backend: 'openmemory',
          mode,
          outcome: 'success',
        });
      } catch (err) {
        log.error('OpenMemory create_session failed in dual-write mode', {
          tenant_id: input.tenant_id,
          error: err instanceof Error ? err.message : String(err),
        });
        this.telemetry.recordError('create_session', 'openmemory', err);
        recordDualWriteOutcome({
          operation: 'create_session',
          backend: 'openmemory',
          mode,
          outcome: 'error',
        });
        recordBackendError({
          backend: 'openmemory',
          operation: 'create_session',
          error: err,
          mode,
        });
      }

      return legacyResult;
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
      recordSessionOperationDuration({
        operation: 'create_session',
        mode,
        durationSeconds,
        outcome,
      });
      incrementSessionOperationTotal({
        operation: 'create_session',
        mode,
        outcome,
      });
    }
  }

  async add_message(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    user_id?: UserId;
    role: SessionMessage['role'];
    modality?: SessionMessage['modality'];
    content: string;
    metadata?: SessionMessage['metadata'];
    correlation_id: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    message_id: string;
    total_tokens: number;
    context_window_size: number;
    consolidation_triggered: boolean;
  }> {
    const mode = this.getMode(input.tenant_id);
    const started = process.hrtime.bigint();
    let outcome: 'success' | 'error' = 'success';
    const roleLabel = input.role;

    try {
      if (mode === 'openmemory-only') {
        try {
          const result = await this.openmemory.add_message(input);
          this.telemetry.recordSuccess('add_message', 'openmemory');
          recordDualWriteOutcome({
            operation: 'add_message',
            backend: 'openmemory',
            mode,
            outcome: 'success',
          });
          return result;
        } catch (err) {
          this.telemetry.recordError('add_message', 'openmemory', err);
          recordDualWriteOutcome({
            operation: 'add_message',
            backend: 'openmemory',
            mode,
            outcome: 'error',
          });
          recordBackendError({
            backend: 'openmemory',
            operation: 'add_message',
            error: err,
            mode,
          });
          throw err;
        }
      }

      if (mode === 'legacy-only') {
        try {
          const result = await this.legacy.add_message(input);
          this.telemetry.recordSuccess('add_message', 'legacy');
          recordDualWriteOutcome({
            operation: 'add_message',
            backend: 'legacy',
            mode,
            outcome: 'success',
          });
          return result;
        } catch (err) {
          this.telemetry.recordError('add_message', 'legacy', err);
          recordDualWriteOutcome({
            operation: 'add_message',
            backend: 'legacy',
            mode,
            outcome: 'error',
          });
          throw err;
        }
      }

      // dual-write
      let legacyResult;
      try {
        legacyResult = await this.legacy.add_message(input);
        this.telemetry.recordSuccess('add_message', 'legacy');
        recordDualWriteOutcome({
          operation: 'add_message',
          backend: 'legacy',
          mode,
          outcome: 'success',
        });
      } catch (err) {
        this.telemetry.recordError('add_message', 'legacy', err);
        recordDualWriteOutcome({
          operation: 'add_message',
          backend: 'legacy',
          mode,
          outcome: 'error',
        });
        throw err;
      }

      try {
        await this.openmemory.add_message(input);
        this.telemetry.recordSuccess('add_message', 'openmemory');
        recordDualWriteOutcome({
          operation: 'add_message',
          backend: 'openmemory',
          mode,
          outcome: 'success',
        });
      } catch (err) {
        log.error('OpenMemory add_message failed in dual-write mode', {
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          error: err instanceof Error ? err.message : String(err),
        });
        this.telemetry.recordError('add_message', 'openmemory', err);
        recordDualWriteOutcome({
          operation: 'add_message',
          backend: 'openmemory',
          mode,
          outcome: 'error',
        });
        recordBackendError({
          backend: 'openmemory',
          operation: 'add_message',
          error: err,
          mode,
        });
      }

      return legacyResult;
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
      recordSessionOperationDuration({
        operation: 'add_message',
        mode,
        durationSeconds,
        outcome,
        role: roleLabel,
      });
      incrementSessionOperationTotal({
        operation: 'add_message',
        mode,
        outcome,
      });
    }
  }

  async get_context_window(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    max_messages?: number;
    max_tokens?: number;
    correlation_id?: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    messages: SessionMessage[];
  }> {
    const mode = this.getMode(input.tenant_id);
    const started = process.hrtime.bigint();
    let outcome: 'success' | 'error' = 'success';

    try {
      if (mode === 'openmemory-only') {
        // When OpenMemory is the primary backend we do not perform dual-read,
        // as legacy is considered archival only.
        return await this.openmemory.get_context_window(input);
      }

      // В режимах legacy-only и dual-write UX основан на legacy-памяти.
      const legacyResult = await this.legacy.get_context_window(input);

      // Dual-read sampler is only engaged in dual-write mode to compare
      // legacy (primary) vs OpenMemory (shadow) results.
      if (mode === 'dual-write') {
        await this.maybeRunDualReadSample(input, legacyResult);
      }

      return legacyResult;
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
      recordSessionOperationDuration({
        operation: 'get_context_window',
        mode,
        durationSeconds,
        outcome,
      });
      incrementSessionOperationTotal({
        operation: 'get_context_window',
        mode,
        outcome,
      });
    }
  }

  private async maybeRunDualReadSample(
    input: {
      tenant_id: TenantId;
      session_id: SessionId;
      max_messages?: number;
      max_tokens?: number;
      correlation_id?: CorrelationId;
    },
    legacyResult: {
      session_id: SessionId;
      messages: SessionMessage[];
    },
  ): Promise<void> {
    const ctx: DualReadContext = {
      tenantId: input.tenant_id,
      sessionId: input.session_id,
      operation: 'get_context_window',
    };

    if (!this.dualReadSampler.shouldSample(ctx)) {
      return;
    }

    try {
      const shadowResult = await this.openmemory.get_context_window(input);

      const comparison = this.dualReadSampler.compareContextWindows(
        legacyResult.messages,
        shadowResult.messages,
        ctx,
      );

      this.dualReadSampler.recordResult(comparison);
    } catch (err) {
      const errorResult: DualReadComparisonResult = {
        ok: false,
        diffSummary: {
          legacyCount: legacyResult.messages.length,
          openMemoryCount: 0,
          mismatchedCount: legacyResult.messages.length,
        },
        context: ctx,
        errorMessage: err instanceof Error ? err.message : String(err),
      };

      this.dualReadSampler.recordResult(errorResult);
    }
  }

  async consolidate_session(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    strategy?: 'auto' | 'full' | 'recent_window';
    correlation_id: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    summaries: WorkingMemoryEntry[];
    consolidated_messages: number;
  }> {
    const mode = this.getMode(input.tenant_id);
    const started = process.hrtime.bigint();
    let outcome: 'success' | 'error' = 'success';
    const strategyLabel: 'auto' | 'full' | 'recent_window' = input.strategy ?? 'auto';

    try {
      if (mode === 'openmemory-only') {
        try {
          const result = await this.openmemory.consolidate_session(input);
          this.telemetry.recordSuccess('consolidate_session', 'openmemory');
          recordDualWriteOutcome({
            operation: 'consolidate_session',
            backend: 'openmemory',
            mode,
            outcome: 'success',
          });
          return result;
        } catch (err) {
          this.telemetry.recordError('consolidate_session', 'openmemory', err);
          recordDualWriteOutcome({
            operation: 'consolidate_session',
            backend: 'openmemory',
            mode,
            outcome: 'error',
          });
          recordBackendError({
            backend: 'openmemory',
            operation: 'consolidate_session',
            error: err,
            mode,
          });
          throw err;
        }
      }

      if (mode === 'legacy-only') {
        try {
          const result = await this.legacy.consolidate_session(input);
          this.telemetry.recordSuccess('consolidate_session', 'legacy');
          recordDualWriteOutcome({
            operation: 'consolidate_session',
            backend: 'legacy',
            mode,
            outcome: 'success',
          });
          return result;
        } catch (err) {
          this.telemetry.recordError('consolidate_session', 'legacy', err);
          recordDualWriteOutcome({
            operation: 'consolidate_session',
            backend: 'legacy',
            mode,
            outcome: 'error',
          });
          throw err;
        }
      }

      // dual-write
      let legacyResult;
      try {
        legacyResult = await this.legacy.consolidate_session(input);
        this.telemetry.recordSuccess('consolidate_session', 'legacy');
        recordDualWriteOutcome({
          operation: 'consolidate_session',
          backend: 'legacy',
          mode,
          outcome: 'success',
        });
      } catch (err) {
        this.telemetry.recordError('consolidate_session', 'legacy', err);
        recordDualWriteOutcome({
          operation: 'consolidate_session',
          backend: 'legacy',
          mode,
          outcome: 'error',
        });
        throw err;
      }

      try {
        await this.openmemory.consolidate_session(input);
        this.telemetry.recordSuccess('consolidate_session', 'openmemory');
        recordDualWriteOutcome({
          operation: 'consolidate_session',
          backend: 'openmemory',
          mode,
          outcome: 'success',
        });
      } catch (err) {
        log.error('OpenMemory consolidate_session failed in dual-write mode', {
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          error: err instanceof Error ? err.message : String(err),
        });
        this.telemetry.recordError('consolidate_session', 'openmemory', err);
        recordDualWriteOutcome({
          operation: 'consolidate_session',
          backend: 'openmemory',
          mode,
          outcome: 'error',
        });
        recordBackendError({
          backend: 'openmemory',
          operation: 'consolidate_session',
          error: err,
          mode,
        });
      }

      return legacyResult;
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
      recordSessionOperationDuration({
        operation: 'consolidate_session',
        mode,
        durationSeconds,
        outcome,
        strategy: strategyLabel,
      });
      incrementSessionOperationTotal({
        operation: 'consolidate_session',
        mode,
        outcome,
      });
    }
  }

  async end_session(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    reason?: string;
    correlation_id: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    archived: boolean;
  }> {
    const mode = this.getMode(input.tenant_id);
    const started = process.hrtime.bigint();
    let outcome: 'success' | 'error' = 'success';

    try {
      if (mode === 'openmemory-only') {
        try {
          const result = await this.openmemory.end_session(input);
          this.telemetry.recordSuccess('end_session', 'openmemory');
          recordDualWriteOutcome({
            operation: 'end_session',
            backend: 'openmemory',
            mode,
            outcome: 'success',
          });
          if (result.archived) {
            updateActiveSessions({
              tenantId: input.tenant_id,
              mode,
              delta: -1,
            });
          }
          return result;
        } catch (err) {
          this.telemetry.recordError('end_session', 'openmemory', err);
          recordDualWriteOutcome({
            operation: 'end_session',
            backend: 'openmemory',
            mode,
            outcome: 'error',
          });
          recordBackendError({
            backend: 'openmemory',
            operation: 'end_session',
            error: err,
            mode,
          });
          throw err;
        }
      }

      if (mode === 'legacy-only') {
        try {
          const result = await this.legacy.end_session(input);
          this.telemetry.recordSuccess('end_session', 'legacy');
          recordDualWriteOutcome({
            operation: 'end_session',
            backend: 'legacy',
            mode,
            outcome: 'success',
          });
          if (result.archived) {
            updateActiveSessions({
              tenantId: input.tenant_id,
              mode,
              delta: -1,
            });
          }
          return result;
        } catch (err) {
          this.telemetry.recordError('end_session', 'legacy', err);
          recordDualWriteOutcome({
            operation: 'end_session',
            backend: 'legacy',
            mode,
            outcome: 'error',
          });
          throw err;
        }
      }

      // dual-write
      let legacyResult;
      try {
        legacyResult = await this.legacy.end_session(input);
        this.telemetry.recordSuccess('end_session', 'legacy');
        recordDualWriteOutcome({
          operation: 'end_session',
          backend: 'legacy',
          mode,
          outcome: 'success',
        });
        if (legacyResult.archived) {
          updateActiveSessions({
            tenantId: input.tenant_id,
            mode,
            delta: -1,
          });
        }
      } catch (err) {
        this.telemetry.recordError('end_session', 'legacy', err);
        recordDualWriteOutcome({
          operation: 'end_session',
          backend: 'legacy',
          mode,
          outcome: 'error',
        });
        throw err;
      }

      try {
        await this.openmemory.end_session(input);
        this.telemetry.recordSuccess('end_session', 'openmemory');
        recordDualWriteOutcome({
          operation: 'end_session',
          backend: 'openmemory',
          mode,
          outcome: 'success',
        });
      } catch (err) {
        log.error('OpenMemory end_session failed in dual-write mode', {
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          error: err instanceof Error ? err.message : String(err),
        });
        this.telemetry.recordError('end_session', 'openmemory', err);
        recordDualWriteOutcome({
          operation: 'end_session',
          backend: 'openmemory',
          mode,
          outcome: 'error',
        });
        recordBackendError({
          backend: 'openmemory',
          operation: 'end_session',
          error: err,
          mode,
        });
      }

      return legacyResult;
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
      recordSessionOperationDuration({
        operation: 'end_session',
        mode,
        durationSeconds,
        outcome,
      });
      incrementSessionOperationTotal({
        operation: 'end_session',
        mode,
        outcome,
      });
    }
  }

  async get_session_state(input: {
    tenant_id: TenantId;
    session_id: SessionId;
  }): Promise<{
    metadata: SessionMetadata;
    working_memory: WorkingMemoryEntry[];
  }> {
    const mode = this.getMode(input.tenant_id);

    if (mode === 'openmemory-only') {
      return this.openmemory.get_session_state(input);
    }

    // В режимах legacy-only и dual-write основным источником состояния остаётся legacy.
    return this.legacy.get_session_state(input);
  }
}