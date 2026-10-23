/**
 * IExecutionProvenanceTracer — Domain port for file/terminal citation tracking.
 *
 * CC-019 Execution Provenance: tracks which files were read, which terminal
 * commands were executed, and maps agent claims to their source evidence.
 * Produces verifiable citation chains so agent outputs can be independently
 * audited. Based on the OpenAI Codex citation system (openai.com/index/
 * introducing-codex/) where each agent action is traced back to source evidence
 * using file-path and terminal-output citations with line-level precision.
 *
 * Sub-capabilities:
 *   1. File Access Tracking — log file reads with line ranges
 *   2. Terminal Output Tracking — log command outputs with line ranges
 *   3. Citation Generation — link claims to source evidence
 *   4. Provenance Report — aggregate citations per task
 *   5. Citation Validation — verify cited content still matches source
 *
 * @extraction V8.0 Knowledge Pipeline — Source: OpenAI Codex Blog (2025)
 * @see PLANS/EXTRACTION/EXTRACTION_SYSTEM.md — Phase 2K Delta Classification
 */

export type CitationSourceType = 'file' | 'terminal';

export interface FileAccessRecord {
  readonly recordId: string;
  readonly filePath: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly accessedAt: string;
  readonly contentSnippet?: string;
  readonly sessionId?: string;
}

export interface TerminalOutputRecord {
  readonly recordId: string;
  readonly command: string;
  readonly chunkId: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly capturedAt: string;
  readonly contentSnippet?: string;
  readonly sessionId?: string;
}

export interface Citation {
  readonly citationId: string;
  readonly sourceType: CitationSourceType;
  readonly sourceRecordId: string;
  readonly claim: string;
  readonly filePath?: string;
  readonly chunkId?: string;
  readonly lineStart: number;
  readonly lineEnd?: number;
  readonly createdAt: string;
}

export interface ProvenanceReport {
  readonly reportId: string;
  readonly sessionId: string;
  readonly taskDescription: string;
  readonly citations: readonly Citation[];
  readonly fileAccesses: readonly FileAccessRecord[];
  readonly terminalOutputs: readonly TerminalOutputRecord[];
  readonly generatedAt: string;
  readonly totalCitations: number;
  readonly coverageScore: number; // 0.0–1.0, ratio of claims with citations
}

export interface CitationValidation {
  readonly citationId: string;
  readonly valid: boolean;
  readonly reason?: string;
  readonly currentContent?: string;
}

export interface IExecutionProvenanceTracer {
  /**
   * Record a file access (read) with line range.
   */
  recordFileAccess(filePath: string, lineStart: number, lineEnd: number, contentSnippet?: string, sessionId?: string): FileAccessRecord;

  /**
   * Record a terminal command output with line range.
   */
  recordTerminalOutput(command: string, chunkId: string, lineStart: number, lineEnd: number, contentSnippet?: string, sessionId?: string): TerminalOutputRecord;

  /**
   * Create a citation linking a claim to a source record.
   */
  createCitation(claim: string, sourceType: CitationSourceType, sourceRecordId: string, lineStart: number, lineEnd?: number): Citation;

  /**
   * Generate a provenance report for a session.
   */
  generateReport(sessionId: string, taskDescription: string): ProvenanceReport;

  /**
   * Validate that cited content still matches its source.
   */
  validateCitation(citationId: string): CitationValidation;

  /**
   * Format a citation in the standard format:
   * File: 【F:<file_path>†L<start>(-L<end>)?】
   * Terminal: 【<chunk_id>†L<start>(-L<end>)?】
   */
  formatCitation(citation: Citation): string;

  /**
   * Get all citations for a session.
   */
  getCitationsForSession(sessionId: string): readonly Citation[];
}
