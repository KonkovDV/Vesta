/**
 * IChangeImpactAnalyzer — Domain Port for Git-Diff-based Impact Analysis.
 *
 * Takes a git diff (changed lines/files) and maps them through the Code
 * Knowledge Graph to determine which symbols, processes, and modules
 * are affected. Pre-commit safety net for change risk assessment.
 *
 * Layer: Domain
 * Pattern source: GitNexus v1.4.0 mcp/tools.ts detect_changes (U17, patterns only)
 * License: PolyForm-Noncommercial — original implementation
 */

import type { TenantId, CorrelationId } from './session-types';
import type { CodeGraphNode, CodeProcess, ImpactRiskLevel } from './ICodeGraphStore';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/** A single file change from git diff. */
export interface FileChange {
  readonly filePath: string;
  readonly changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Changed line ranges (1-indexed, inclusive). */
  readonly changedLines?: readonly { start: number; end: number }[];
  readonly oldPath?: string;
}

/** A symbol directly affected by a code change. */
export interface AffectedSymbol {
  readonly node: CodeGraphNode;
  /** How the symbol is affected. */
  readonly changeType: 'modified' | 'deleted' | 'signature_changed' | 'body_changed';
  /** Line overlap between diff and symbol bounds. */
  readonly overlapLines: number;
}

/** Aggregated change impact analysis result. */
export interface ChangeImpactResult {
  /** Symbols directly touched by the diff. */
  readonly directlyAffected: readonly AffectedSymbol[];
  /** Symbols transitively affected (callers of changed symbols). */
  readonly transitivelyAffected: readonly CodeGraphNode[];
  /** Processes that flow through changed symbols. */
  readonly affectedProcesses: readonly CodeProcess[];
  /** Modules containing affected symbols. */
  readonly affectedModules: readonly string[];
  /** Overall risk level for this changeset. */
  readonly overallRisk: ImpactRiskLevel;
  /** Summary statistics. */
  readonly summary: {
    readonly directCount: number;
    readonly transitiveCount: number;
    readonly processCount: number;
    readonly moduleCount: number;
  };
}

// ──────────────────────────────────────────────
// Domain Port
// ──────────────────────────────────────────────

/**
 * Change Impact Analyzer — Domain Port (L3).
 *
 * Maps git diff → symbols → processes → risk level.
 * Used as pre-commit safety net and PR review tool.
 *
 * Implementations: ChangeImpactAnalyzerAdapter (infrastructure).
 */
export interface IChangeImpactAnalyzer {
  /** Analyze impact of a set of file changes. */
  analyzeChanges(input: {
    tenantId: TenantId;
    changes: readonly FileChange[];
    /** Max depth for transitive impact (default: 3). */
    maxTransitiveDepth?: number;
    correlationId: CorrelationId;
  }): Promise<ChangeImpactResult>;
}
