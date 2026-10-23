import type {
  ExtractedLesson,
  RootCauseCategory,
  SamuleLevel,
} from '../../domain/agents/IS2iLessonExtractor';
import type {
  ErrorCategory,
  ErrorGraphNode,
} from '../../domain/debugging/IErrorGraphRepository';
import type { ILessonStore } from '../../domain/memory/ILessonStore';
import type { IWisdomConsolidator } from '../../domain/memory/IWisdomConsolidator';
import type { CapturedErrorLogRecord } from '../logging/StructuredLogger';

interface ErrorLessonCaptureLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

interface ErrorLessonCaptureDeps {
  readonly lessonStore: () => ILessonStore | undefined;
  readonly wisdomConsolidator?: () => IWisdomConsolidator | undefined;
  readonly logger?: ErrorLessonCaptureLogger;
}

export class ErrorLessonCaptureAdapter {
  constructor(private readonly deps: ErrorLessonCaptureDeps) {}

  async capture(node: ErrorGraphNode, record: CapturedErrorLogRecord): Promise<void> {
    const lessonStore = this.deps.lessonStore();
    if (!lessonStore) {
      return;
    }

    const lesson = this.buildLesson(node, record);

    try {
      await lessonStore.saveLesson(lesson);
    } catch (error) {
      this.deps.logger?.warn('Runtime error lesson persistence failed', {
        lessonId: lesson.lessonId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const consolidator = this.deps.wisdomConsolidator?.();
    if (!consolidator) {
      return;
    }

    try {
      await consolidator.whenReady?.();

      const lessons = await lessonStore.listLessons();
      const candidates = consolidator.findCandidates(
        lessons.map((item) => ({
          lessonId: item.lessonId,
          level: item.level,
          rootCauseCategory: item.rootCauseCategory,
          statement: item.statement,
          tags: item.tags,
          extractedAt: item.extractedAt,
        })),
      );

      const relatedCandidates = candidates.filter(
        (candidate) =>
          candidate.sharedCategory === lesson.rootCauseCategory
          && candidate.lessonIds.includes(lesson.lessonId),
      );

      if (relatedCandidates.length === 0) {
        return;
      }

      const consolidationInput = lessons.map((item) => ({
        lessonId: item.lessonId,
        statement: item.statement,
        rootCauseCategory: item.rootCauseCategory,
        tags: item.tags,
      }));

      for (const candidate of relatedCandidates) {
        const principle = consolidator.consolidate(candidate, consolidationInput);
        if (principle) {
          this.deps.logger?.info('Runtime error lessons consolidated', {
            principleId: principle.principleId,
            sourceLessonIds: principle.sourceLessonIds,
          });
        }
      }
    } catch (error) {
      this.deps.logger?.warn('Runtime error lesson consolidation failed', {
        lessonId: lesson.lessonId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildLesson(node: ErrorGraphNode, record: CapturedErrorLogRecord): ExtractedLesson {
    const level = this.classifyLevel(node.recurrenceCount);
    const primaryFile = node.affectedFiles[0];
    const statementPrefix = level === 'meso' ? '[MESO-INSIGHT]' : '[AUTO-ERROR-LESSON]';
    const fileSuffix = primaryFile ? ` in ${primaryFile}` : '';

    return {
      lessonId: `error-lesson-${node.id}`,
      level,
      statement: `${statementPrefix} ${node.summary}${fileSuffix}`.slice(0, 500),
      rootCauseCategory: this.mapRootCauseCategory(node.category),
      sourceEntryId: `error:${node.id}`,
      prevention: this.buildPrevention(node, record.captureKind),
      tags: this.buildTags(node, record.captureKind),
      extractedAt: record.ts,
    };
  }

  private classifyLevel(recurrenceCount: number | undefined): SamuleLevel {
    return (recurrenceCount ?? 0) >= 2 ? 'meso' : 'micro';
  }

  private mapRootCauseCategory(category: ErrorCategory): RootCauseCategory {
    switch (category) {
      case 'Config':
        return 'config';
      case 'DI':
        return 'dependency';
      case 'Testing':
        return 'missing_test';
      case 'Concurrency':
      case 'EventSourcing':
      case 'Cache':
        return 'integration';
      case 'Memory':
      case 'Performance':
      case 'Security':
      case 'Architecture':
      case 'TypeSystem':
      default:
        return 'architecture';
    }
  }

  private buildPrevention(node: ErrorGraphNode, captureKind: string | undefined): string {
    if (node.rule && !/pending/i.test(node.rule)) {
      return node.rule;
    }

    const capturePrefix = captureKind ? `${captureKind} capture` : 'runtime capture';

    switch (node.category) {
      case 'Config':
        return `Convert ${capturePrefix} into config validation and bootstrap-time guardrails.`;
      case 'DI':
        return `Convert ${capturePrefix} into DI registration coverage and constructor-wiring tests.`;
      case 'Testing':
        return `Convert ${capturePrefix} into a regression test before touching production code.`;
      case 'Concurrency':
      case 'EventSourcing':
        return `Convert ${capturePrefix} into ordering, retry, and outbox-focused verification.`;
      default:
        return `Convert ${capturePrefix} into RCA, a prevention rule, and a regression check for ${node.category}.`;
    }
  }

  private buildTags(node: ErrorGraphNode, captureKind: string | undefined): readonly string[] {
    const primaryFile = node.affectedFiles[0];
    return [...new Set([
      'error-capture',
      'runtime-learning',
      node.category.toLowerCase(),
      node.severity.toLowerCase(),
      captureKind ?? 'logger',
      primaryFile ? primaryFile.replace(/[\\/]/g, ':') : 'unknown-file',
    ])];
  }
}
