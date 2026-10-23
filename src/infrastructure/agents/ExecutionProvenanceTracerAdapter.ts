/**
 * ExecutionProvenanceTracerAdapter — In-memory file/terminal citation tracking.
 *
 * In-memory implementation of IExecutionProvenanceTracer. Records file access
 * and terminal output events, generates citations linking claims to source
 * evidence, and produces provenance reports with coverage scoring.
 *
 * @layer Infrastructure (Agents)
 * @pattern CC-019 Execution Provenance Tracer (FITNESS-K: 80)
 * @see src/domain/agents/IExecutionProvenanceTracer.ts — domain port
 * @see src/core/events/execution-provenance.schemas.ts — Zod validation schemas
 */

import type {
  IExecutionProvenanceTracer,
  CitationSourceType,
  FileAccessRecord,
  TerminalOutputRecord,
  Citation,
  ProvenanceReport,
  CitationValidation,
} from '../../domain/agents/IExecutionProvenanceTracer';

// ── Minimal Logger ────────────────────────────────────────────────

interface ProvenanceLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Adapter ───────────────────────────────────────────────────────

export class ExecutionProvenanceTracerAdapter implements IExecutionProvenanceTracer {
  private readonly fileAccesses = new Map<string, FileAccessRecord>();
  private readonly terminalOutputs = new Map<string, TerminalOutputRecord>();
  private readonly citations = new Map<string, Citation>();
  private idCounter = 0;

  constructor(private readonly logger?: ProvenanceLogger) {}

  recordFileAccess(
    filePath: string,
    lineStart: number,
    lineEnd: number,
    contentSnippet?: string,
    sessionId?: string,
  ): FileAccessRecord {
    const recordId = `fa-${++this.idCounter}`;
    const record: FileAccessRecord = {
      recordId,
      filePath,
      lineStart,
      lineEnd,
      accessedAt: new Date().toISOString(),
      contentSnippet,
      sessionId,
    };
    this.fileAccesses.set(recordId, record);
    this.logger?.info('File access recorded', { recordId, filePath, lineStart, lineEnd });
    return record;
  }

  recordTerminalOutput(
    command: string,
    chunkId: string,
    lineStart: number,
    lineEnd: number,
    contentSnippet?: string,
    sessionId?: string,
  ): TerminalOutputRecord {
    const recordId = `to-${++this.idCounter}`;
    const record: TerminalOutputRecord = {
      recordId,
      command,
      chunkId,
      lineStart,
      lineEnd,
      capturedAt: new Date().toISOString(),
      contentSnippet,
      sessionId,
    };
    this.terminalOutputs.set(recordId, record);
    this.logger?.info('Terminal output recorded', { recordId, command, chunkId });
    return record;
  }

  createCitation(
    claim: string,
    sourceType: CitationSourceType,
    sourceRecordId: string,
    lineStart: number,
    lineEnd?: number,
  ): Citation {
    const citationId = `cit-${++this.idCounter}`;

    // Resolve source record for file path / chunk ID
    let filePath: string | undefined;
    let chunkId: string | undefined;
    if (sourceType === 'file') {
      const record = this.fileAccesses.get(sourceRecordId);
      filePath = record?.filePath;
    } else {
      const record = this.terminalOutputs.get(sourceRecordId);
      chunkId = record?.chunkId;
    }

    const citation: Citation = {
      citationId,
      sourceType,
      sourceRecordId,
      claim,
      filePath,
      chunkId,
      lineStart,
      lineEnd,
      createdAt: new Date().toISOString(),
    };
    this.citations.set(citationId, citation);
    return citation;
  }

  generateReport(sessionId: string, taskDescription: string): ProvenanceReport {
    const sessionCitations = [...this.citations.values()];
    const sessionFileAccesses = [...this.fileAccesses.values()].filter(
      r => !r.sessionId || r.sessionId === sessionId,
    );
    const sessionTerminalOutputs = [...this.terminalOutputs.values()].filter(
      r => !r.sessionId || r.sessionId === sessionId,
    );

    const totalSources = sessionFileAccesses.length + sessionTerminalOutputs.length;
    const coverageScore = totalSources > 0
      ? Math.min(1, sessionCitations.length / totalSources)
      : 0;

    const report: ProvenanceReport = {
      reportId: `rep-${++this.idCounter}`,
      sessionId,
      taskDescription,
      citations: sessionCitations,
      fileAccesses: sessionFileAccesses,
      terminalOutputs: sessionTerminalOutputs,
      generatedAt: new Date().toISOString(),
      totalCitations: sessionCitations.length,
      coverageScore,
    };

    this.logger?.info('Provenance report generated', {
      reportId: report.reportId,
      sessionId,
      totalCitations: report.totalCitations,
      coverageScore,
    });

    return report;
  }

  validateCitation(citationId: string): CitationValidation {
    const citation = this.citations.get(citationId);
    if (!citation) {
      return { citationId, valid: false, reason: 'Citation not found' };
    }

    // Verify the source record still exists
    if (citation.sourceType === 'file') {
      const record = this.fileAccesses.get(citation.sourceRecordId);
      if (!record) {
        return { citationId, valid: false, reason: 'Source file access record not found' };
      }
      return { citationId, valid: true, currentContent: record.contentSnippet };
    }

    const record = this.terminalOutputs.get(citation.sourceRecordId);
    if (!record) {
      return { citationId, valid: false, reason: 'Source terminal output record not found' };
    }
    return { citationId, valid: true, currentContent: record.contentSnippet };
  }

  formatCitation(citation: Citation): string {
    if (citation.sourceType === 'file') {
      const lineRange = citation.lineEnd
        ? `L${citation.lineStart}-L${citation.lineEnd}`
        : `L${citation.lineStart}`;
      return `【F:${citation.filePath ?? 'unknown'}†${lineRange}】`;
    }
    const lineRange = citation.lineEnd
      ? `L${citation.lineStart}-L${citation.lineEnd}`
      : `L${citation.lineStart}`;
    return `【${citation.chunkId ?? 'unknown'}†${lineRange}】`;
  }

  getCitationsForSession(sessionId: string): readonly Citation[] {
    // In a full implementation, citations would be linked to sessions.
    // For now, return all citations (in-memory adapter).
    return [...this.citations.values()];
  }
}
