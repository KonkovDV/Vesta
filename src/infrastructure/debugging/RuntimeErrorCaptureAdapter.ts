import path from 'node:path';

import type { CorrelationId } from '@/ai-types';
import { IdGenerator } from '../../core/utils/IdGenerator';
import type {
  ErrorCategory,
  ErrorGraphNode,
  ErrorSeverity,
  IErrorGraphRepository,
} from '../../domain/debugging/IErrorGraphRepository';
import type { CapturedErrorLogRecord } from '../logging/StructuredLogger';
import { ErrorLessonCaptureAdapter } from './ErrorLessonCaptureAdapter';

const PROJECT_ROOT = path.resolve(__dirname, '../../..').replace(/\\/g, '/').toLowerCase();

type CaptureKind = CapturedErrorLogRecord['captureKind'];

interface RuntimeErrorCaptureDeps {
  readonly lessonCapture?: ErrorLessonCaptureAdapter;
}

export class RuntimeErrorCaptureAdapter {
  constructor(
    private readonly errorGraph: IErrorGraphRepository,
    private readonly deps: RuntimeErrorCaptureDeps = {},
  ) {}

  async capture(record: CapturedErrorLogRecord): Promise<void> {
    try {
      const summary = this.buildSummary(record);
      const category = this.classifyCategory(record, summary);
      const severity = this.classifySeverity(record, summary);
      const affectedFiles = this.extractAffectedFiles(record);
      const primaryFile = affectedFiles[0];
      const existing = primaryFile
        ? await this.findMatchingExisting(primaryFile, summary, category)
        : null;

      const node: ErrorGraphNode = {
        id: existing?.id ?? IdGenerator.generateWithPrefix('errdb'),
        summary,
        affectedFiles,
        rootCause: existing?.rootCause ?? this.buildPendingRootCause(record.captureKind),
        rule: existing?.rule ?? 'Pending investigation — derive a permanent prevention rule after RCA.',
        testTrap: existing?.testTrap,
        category,
        severity,
        status: 'OPEN',
        discoveredAt: existing?.discoveredAt ?? record.ts,
        fixedAt: undefined,
        verification: this.buildVerificationEvidence(record, primaryFile),
        recurrenceCount: (existing?.recurrenceCount ?? 0) + 1,
      };

      const correlationId =
        typeof record.correlationId === 'string' ? record.correlationId : undefined;

      await this.errorGraph.ingestError(node, this.toCorrelationId(correlationId));
      await this.deps.lessonCapture?.capture(node, record);
    } catch {
      // Never let error capture break the main execution path.
    }
  }

  private async findMatchingExisting(
    primaryFile: string,
    summary: string,
    category: ErrorCategory,
  ): Promise<ErrorGraphNode | null> {
    const candidates = await this.errorGraph.getByFile(primaryFile);
    const normalizedSummary = this.normalizeText(summary);

    for (const candidate of candidates) {
      if (candidate.category !== category) {
        continue;
      }

      if (this.normalizeText(candidate.summary) !== normalizedSummary) {
        continue;
      }

      return candidate;
    }

    return null;
  }

  private buildSummary(record: CapturedErrorLogRecord): string {
    const base = this.safeText(record.msg) || 'Runtime error captured';
    const errorMessage = this.safeText(record.error?.message);
    const loggerName = this.safeText(record.logger);

    let summary = base;

    if (errorMessage && !this.normalizeText(base).includes(this.normalizeText(errorMessage))) {
      summary = `${base}: ${errorMessage}`;
    }

    if (loggerName && !this.normalizeText(summary).includes(this.normalizeText(loggerName))) {
      summary = `[${loggerName}] ${summary}`;
    }

    return summary.slice(0, 500);
  }

  private buildPendingRootCause(kind: CaptureKind | undefined): string {
    switch (kind) {
      case 'uncaughtException':
        return 'Pending RCA — auto-captured from uncaught exception handler.';
      case 'unhandledRejection':
        return 'Pending RCA — auto-captured from unhandled rejection handler.';
      default:
        return 'Pending RCA — auto-captured from structured logger error sink.';
    }
  }

  private buildVerificationEvidence(record: CapturedErrorLogRecord, primaryFile?: string): string {
    const parts = [
      'captureKind=' + String(record.captureKind ?? 'logger'),
      'logger=' + String(record.logger ?? 'unknown'),
      'correlationId=' + String(record.correlationId ?? 'n/a'),
      'primaryFile=' + String(primaryFile ?? 'n/a'),
    ];

    const topFrame = this.extractFilesFromStack(record.error?.stack)[0];
    if (topFrame) {
      parts.push(`topFrame=${topFrame}`);
    }

    return parts.join('; ');
  }

  private classifyCategory(record: CapturedErrorLogRecord, summary: string): ErrorCategory {
    const haystack = this.normalizeText(
      `${summary} ${record.error?.name ?? ''} ${record.error?.stack ?? ''}`,
    );

    if (/(oom|out of memory|heap|allocation failed|gc overhead|memory)/.test(haystack)) {
      return 'Memory';
    }
    if (/(timeout|deadlock|race|concurr|lock wait|parallel)/.test(haystack)) {
      return 'Concurrency';
    }
    if (/(config|environment|missing env|invalid configuration|feature flag)/.test(haystack)) {
      return 'Config';
    }
    if (/(zod|schema|typescript|ts\d+|type mismatch|typeerror|validation)/.test(haystack)) {
      return 'TypeSystem';
    }
    if (/(jest|test suite|expect\(|assertion|snapshot)/.test(haystack)) {
      return 'Testing';
    }
    if (/(event store|outbox|aggregate|projection|event bus|event sourcing)/.test(haystack)) {
      return 'EventSourcing';
    }
    if (/(^|\s)di(\s|$)|container|resolve\(|inject|binding|dependency/.test(haystack)) {
      return 'DI';
    }
    if (/(auth|forbidden|permission|secret|api key|apikey|jwt|bearer|ssrf|security|csrf|xss|jailbreak)/.test(haystack)) {
      return 'Security';
    }
    if (/(latency|slow|throughput|performance|hot path)/.test(haystack)) {
      return 'Performance';
    }

    return 'Architecture';
  }

  private classifySeverity(record: CapturedErrorLogRecord, summary: string): ErrorSeverity {
    if (record.captureKind === 'uncaughtException' || record.captureKind === 'unhandledRejection') {
      return 'CRITICAL';
    }

    const haystack = this.normalizeText(`${summary} ${record.error?.name ?? ''}`);
    if (/(fatal|panic|corrupt|data loss|crash|oom|out of memory)/.test(haystack)) {
      return 'CRITICAL';
    }
    if (/(failed|exception|error|rejected|denied|timeout)/.test(haystack)) {
      return 'HIGH';
    }
    return 'MEDIUM';
  }

  private extractAffectedFiles(record: CapturedErrorLogRecord): string[] {
    const candidates = new Set<string>();

    for (const key of ['filePath', 'file', 'module', 'sourceFile', 'path']) {
      const value = record[key];
      if (typeof value === 'string') {
        const normalized = this.normalizeFilePath(value);
        if (normalized) {
          candidates.add(normalized);
        }
      }
    }

    for (const stackFile of this.extractFilesFromStack(record.error?.stack)) {
      candidates.add(stackFile);
    }

    return [...candidates].slice(0, 5);
  }

  private extractFilesFromStack(stack: string | undefined): string[] {
    if (!stack) {
      return [];
    }

    const matches = stack.match(/[A-Za-z]:\\[^\n)]+\.(?:ts|js)|\/[^\n)]+\.(?:ts|js)/g) ?? [];
    const normalized = matches
      .map((match) => this.normalizeFilePath(match))
      .filter((value): value is string => Boolean(value));

    return [...new Set(normalized)];
  }

  private normalizeFilePath(rawPath: string): string | null {
    const normalized = rawPath.replace(/\\/g, '/').trim();
    const lowered = normalized.toLowerCase();

    if (lowered.includes('/src/')) {
      return normalized.slice(lowered.lastIndexOf('/src/') + 1);
    }
    if (lowered.includes('/tests/')) {
      return normalized.slice(lowered.lastIndexOf('/tests/') + 1);
    }
    if (lowered.includes('/scripts/')) {
      return normalized.slice(lowered.lastIndexOf('/scripts/') + 1);
    }
    if (lowered.startsWith(PROJECT_ROOT)) {
      return normalized.slice(PROJECT_ROOT.length + 1);
    }
    if (/^(src|tests|scripts)\//i.test(normalized)) {
      return normalized;
    }

    return null;
  }

  private normalizeText(value: string): string {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private safeText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private toCorrelationId(value: string | undefined): CorrelationId {
    return (value ?? IdGenerator.generateWithPrefix('errcorr')) as CorrelationId;
  }
}