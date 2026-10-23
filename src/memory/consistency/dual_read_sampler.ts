/**
 * Dual-read sampler for memory consistency (Phase 11 M2.4).
 *
 * Layer: Memory
 *
 * This module provides a small, self-contained component that can be used by
 * DualWriteMemoryManager (and other Memory-layer coordinators) to:
 *  - decide whether a particular read operation should be sampled;
 *  - compare results from legacy and OpenMemory backends;
 *  - emit a lightweight, structured report (log/sink) about (mis)matches.
 *
 * Scope for MEM-M2.4:
 *  - no DI/bootstrap changes;
 *  - no metrics via monitoring facade (metrics for dual-read are a separate task);
 *  - results are observable via a simple report sink (console or in-memory).
 */

import type {
  SessionMessage,
} from '../../domain/memory/session-types';
import { recordDualReadResultMetrics } from './dual_read_metrics_adapter';

// Re-export types from dual_read_types.ts for backward compatibility (TASK-023)
export type {
  DualReadOperation,
  DualReadContext,
  DualReadMismatchReason,
  DualReadMismatchExample,
  DualReadDiffSummary,
  DualReadComparisonResult,
} from './dual_read_types';

import type {
  DualReadOperation,
  DualReadContext,
  DualReadMismatchReason,
  DualReadMismatchExample,
  DualReadDiffSummary,
  DualReadComparisonResult,
} from './dual_read_types';

export type SessionContextWindow = SessionMessage[];

/**
 * Sink for dual-read results. Default implementation writes JSON lines
 * to console; tests can inject an in-memory implementation.
 */
export interface DualReadReportSink {
  record(result: DualReadComparisonResult): void;
}

/**
 * Sampling/comparison interface used by DualWriteMemoryManager.
 */
export interface DualReadSampler {
  /**
   * Decide whether this operation should be dual-read sampled.
   * Must be deterministic for the same context to avoid flapping.
   */
  shouldSample(ctx: DualReadContext): boolean;

  /**
   * Compare two context windows (legacy vs OpenMemory) and return a
   * lightweight summary of differences.
   */
  compareContextWindows(
    legacy: SessionContextWindow,
    openMemory: SessionContextWindow,
    ctx: DualReadContext,
  ): DualReadComparisonResult;

  /**
   * Record a comparison result to the configured sink.
   */
  recordResult(result: DualReadComparisonResult): void;
}

export interface DualReadSamplerOptions {
  /**
   * Fraction of operations to sample in [0, 1]. Default: 0.05 (5%).
   */
  sampleRate?: number;
  /**
   * Maximum number of mismatch examples to include in the result.
   * Default: 3.
   */
  maxExampleMismatches?: number;
  /**
   * Number of content characters to consider when comparing messages.
   * Default: 128.
   */
  contentFragmentLength?: number;
}

/**
 * Default implementation:
 *  - sampling is deterministic by sessionId (hash-based);
 *  - comparison looks at:
 *      * window sizes;
 *      * role + modality;
 *      * normalized content prefix (whitespace-normalized, lowercased);
 *  - report is forwarded to the configured sink.
 */
export class DefaultDualReadSampler implements DualReadSampler {
  private readonly sampleRate: number;
  private readonly maxExampleMismatches: number;
  private readonly contentFragmentLength: number;

  constructor(
    private readonly sink: DualReadReportSink,
    options: DualReadSamplerOptions = {},
  ) {
    const rate = options.sampleRate ?? 0.05;
    this.sampleRate = rate <= 0 ? 0 : rate >= 1 ? 1 : rate;
    this.maxExampleMismatches = options.maxExampleMismatches ?? 3;
    this.contentFragmentLength = options.contentFragmentLength ?? 128;
  }

  shouldSample(ctx: DualReadContext): boolean {
    // If sampling is effectively disabled, short-circuit.
    if (this.sampleRate <= 0) {
      return false;
    }
    if (this.sampleRate >= 1) {
      return true;
    }

    // Hash-based sampling by sessionId to keep decisions stable per session.
    const base = ctx.sessionId || `${ctx.tenantId}:${ctx.operation}`;
    const value = this.hashToUnitInterval(base);
    return value < this.sampleRate;
  }

  compareContextWindows(
    legacy: SessionContextWindow,
    openMemory: SessionContextWindow,
    ctx: DualReadContext,
  ): DualReadComparisonResult {
    const legacyCount = legacy.length;
    const openMemoryCount = openMemory.length;
    const minLen = Math.min(legacyCount, openMemoryCount);

    let mismatchedCount = 0;
    const examples: DualReadMismatchExample[] = [];

    // Compare aligned messages.
    for (let i = 0; i < minLen; i += 1) {
      const legacyMsg = legacy[i];
      const openMsg = openMemory[i];

      const reasons: DualReadMismatchReason[] = [];

      if (legacyMsg.role !== openMsg.role) {
        reasons.push('role_mismatch');
      }
      if (legacyMsg.modality !== openMsg.modality) {
        reasons.push('modality_mismatch');
      }

      if (!this.contentsEquivalent(legacyMsg.content, openMsg.content)) {
        reasons.push('content_mismatch');
      }

      if (reasons.length > 0) {
        mismatchedCount += 1;
        if (examples.length < this.maxExampleMismatches) {
          examples.push({
            index: i,
            legacyMessageId: legacyMsg.message_id,
            openMemoryMessageId: openMsg.message_id,
            reasons,
          });
        }
      }
    }

    // Length-only differences.
    const lengthDiff = Math.abs(legacyCount - openMemoryCount);
    if (lengthDiff > 0) {
      mismatchedCount += lengthDiff;
      if (examples.length < this.maxExampleMismatches) {
        const index = minLen;
        const reason: DualReadMismatchReason =
          legacyCount > openMemoryCount ? 'missing_in_openmemory' : 'missing_in_legacy';

        examples.push({
          index,
          legacyMessageId: legacy[index]?.message_id,
          openMemoryMessageId: openMemory[index]?.message_id,
          reasons: [reason],
        });
      }
    }

    const ok = legacyCount === openMemoryCount && mismatchedCount === 0;

    return {
      ok,
      diffSummary: {
        legacyCount,
        openMemoryCount,
        mismatchedCount,
      },
      context: ctx,
      exampleMismatches: examples.length > 0 ? examples : undefined,
    };
  }

  recordResult(result: DualReadComparisonResult): void {
    // Best-effort metrics + sink; neither is allowed to affect the main path.
    recordDualReadResultMetrics(result);

    try {
      this.sink.record(result);
    } catch {
      // Sink failures must never impact main request path.
    }
  }

  private contentsEquivalent(a: string, b: string): boolean {
    const normA = this.normalizeContentFragment(a);
    const normB = this.normalizeContentFragment(b);
    return normA === normB;
  }

  private normalizeContentFragment(content: string): string {
    if (!content) {
      return '';
    }
    const collapsedWhitespace = content.trim().replace(/\s+/g, ' ');
    const fragment = collapsedWhitespace.slice(0, this.contentFragmentLength);
    return fragment.toLowerCase();
  }

  /**
   * Deterministic, cheap hash -> [0, 1) mapping based on 32-bit unsigned int.
   */
  private hashToUnitInterval(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }
    // 0xffffffff == 4294967295
    return hash / 0xffffffff;
  }
}

/**
 * Console-based sink that writes one JSON object per comparison result.
 *
 * Example record:
 * {
 *   "type": "memory_dualread_result",
 *   "tenantId": "...",
 *   "sessionId": "...",
 *   "operation": "get_context_window",
 *   "ok": false,
 *   "diff": { "legacyCount": 15, "openMemoryCount": 14, "mismatchedCount": 2 },
 *   "timestamp": "...",
 *   "mismatches": [ ... ],
 *   "error": "..."
 * }
 */
export class ConsoleDualReadReportSink implements DualReadReportSink {
  record(result: DualReadComparisonResult): void {
    const payload = {
      type: 'memory_dualread_result',
      tenantId: result.context.tenantId,
      sessionId: result.context.sessionId,
      userId: result.context.userId,
      operation: result.context.operation,
      ok: result.ok,
      diff: result.diffSummary,
      mismatches: result.exampleMismatches,
      error: result.errorMessage,
      timestamp: new Date().toISOString(),
    };

     
    console.log(JSON.stringify(payload));
  }
}

/**
 * In-memory sink intended for unit/integration tests. It simply stores all
 * recorded results in an array for later inspection.
 */
export class InMemoryDualReadReportSink implements DualReadReportSink {
  readonly results: DualReadComparisonResult[] = [];

  record(result: DualReadComparisonResult): void {
    this.results.push(result);
  }
}