/**
 * IAutoFixAnalyzer — Domain port for Cognitive CI/CD Quality Gates.
 *
 * Provides automated analysis, classification, and repair of CI test failures:
 * - Parse structured test output (Jest JSON)
 * - Classify failures into P1–P5 severity tiers
 * - Generate file-level patches for auto-fixable classes (P1–P3)
 * - Validate generated fixes via targeted test execution
 *
 * @layer Domain
 * @pattern Pillar-5 Cognitive CI/CD Gates (Agentic Auto-Patch)
 * @FITNESS-K 93.0
 * @see Yang et al. "SWE-agent" (Princeton, 2024) — AST-driven auto-repair
 * @see Jimenez et al. "SWE-bench" (Princeton, 2023) — benchmark for auto-fix
 * @see Qian et al. "ChatDev" (Tsinghua, 2024) — multi-agent CI feedback
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Failure Classification ──────────────────────────────────────

/**
 * CI failure severity tier.
 *
 * - P1_structural: Missing DI registration, missing module export
 * - P2_type: Wrong import path, missing Zod schema, type mismatch
 * - P3_convention: Missing correlationId, wrong layer import, naming
 * - P4_logic: Business rule violation (partially auto-fixable)
 * - P5_design: Architecture decision, API design (manual only)
 */
export type FailureClass =
  | 'P1_structural'
  | 'P2_type'
  | 'P3_convention'
  | 'P4_logic'
  | 'P5_design';

/**
 * Confidence level for an auto-fix suggestion.
 */
export type FixConfidence = 'high' | 'medium' | 'low' | 'none';

// ── Test Failure ────────────────────────────────────────────────

/**
 * A single test failure from CI output (Jest JSON format).
 */
export interface TestFailure {
  /** Fully qualified test name (describe > it) */
  readonly testName: string;
  /** Relative file path of the test */
  readonly testFile: string;
  /** Error message from the assertion or runtime error */
  readonly errorMessage: string;
  /** Stack trace (optional for summary reports) */
  readonly errorStack?: string;
  /** The specific assertion that failed (optional) */
  readonly failedAssertion?: string;
  /** Test execution duration in milliseconds */
  readonly duration: number;
}

// ── Failure Analysis ────────────────────────────────────────────

/**
 * Analysis result for a single test failure.
 */
export interface FailureAnalysis {
  /** Original test failure */
  readonly failure: TestFailure;
  /** Classified severity tier */
  readonly classification: FailureClass;
  /** Human-readable root cause diagnosis */
  readonly rootCause: string;
  /** Source files that likely need changes */
  readonly affectedFiles: readonly string[];
  /** Confidence that an auto-fix can resolve this */
  readonly fixConfidence: FixConfidence;
  /** Suggested auto-fix (absent for P4/P5 or low-confidence) */
  readonly suggestedFix?: AutoFix;
}

// ── Auto-Fix ────────────────────────────────────────────────────

/**
 * A line-level change within a file patch.
 */
export interface LineChange {
  /** 1-based line number (-1 = append at end) */
  readonly line: number;
  /** Content to add or remove */
  readonly content: string;
}

/**
 * A file-level patch (set of additions and deletions).
 */
export interface FilePatch {
  /** Relative file path from project root */
  readonly filePath: string;
  /** Lines to add */
  readonly additions: readonly LineChange[];
  /** Lines to remove */
  readonly deletions: readonly LineChange[];
}

/**
 * A generated auto-fix with file patches, confidence score, and validation command.
 */
export interface AutoFix {
  /** Unique fix identifier */
  readonly id: string;
  /** File-level patches to apply */
  readonly patches: readonly FilePatch[];
  /** Human-readable explanation of what the fix does and why */
  readonly explanation: string;
  /** Numeric confidence score (0.0 – 1.0) */
  readonly confidence: number;
  /** Shell command to validate the fix (e.g. targeted Jest) */
  readonly testCommand: string;
  /** Shell command to roll back the fix (optional) */
  readonly rollbackCommand?: string;
}

// ── Auto-Fix Report ─────────────────────────────────────────────

/**
 * Aggregate report for a batch of analyzed CI failures.
 */
export interface AutoFixReport {
  /** Total number of test failures in CI output */
  readonly totalFailures: number;
  /** Number of failures successfully analyzed */
  readonly analyzed: number;
  /** Number of fixes generated */
  readonly fixGenerated: number;
  /** Number of fixes that passed validation */
  readonly fixValidated: number;
  /** Breakdown by failure class */
  readonly classifications: Readonly<Partial<Record<FailureClass, number>>>;
  /** Average confidence across generated fixes */
  readonly avgConfidence: number;
  /** Total analysis + fix generation duration in ms */
  readonly durationMs: number;
}

// ── Port Interface ──────────────────────────────────────────────

/**
 * Cognitive CI/CD Auto-Fix Analyzer.
 *
 * Orchestrates the analysis pipeline:
 * 1. Parse test failures from CI output
 * 2. Classify each failure (P1–P5)
 * 3. Generate patches for P1–P3 failures
 * 4. Validate fixes via targeted test execution
 * 5. Produce an aggregate report
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface IAutoFixAnalyzer {
  /**
   * Analyze test failures and classify them by severity tier.
   *
   * @param failures — structured test failures from CI output
   * @param correlationId — tracing ID for structured logging
   * @returns ordered list of failure analyses
   */
  analyzeFailures(
    failures: readonly TestFailure[],
    correlationId: CorrelationId,
  ): Promise<readonly FailureAnalysis[]>;

  /**
   * Generate auto-fixes for P1–P3 classified failures.
   * P4/P5 failures are skipped (returns empty for those).
   *
   * @param analyses — classified failure analyses
   * @param correlationId — tracing ID
   * @returns generated auto-fixes (only for fixable failures)
   */
  generateFixes(
    analyses: readonly FailureAnalysis[],
    correlationId: CorrelationId,
  ): Promise<readonly AutoFix[]>;

  /**
   * Validate an auto-fix by running its targeted test command.
   *
   * @param fix — the auto-fix to validate
   * @param correlationId — tracing ID
   * @returns true if the fix resolves the failure
   */
  validateFix(
    fix: AutoFix,
    correlationId: CorrelationId,
  ): Promise<boolean>;

  /**
   * Generate an aggregate report for a batch of analyses and fixes.
   *
   * @param analyses — all failure analyses
   * @param fixes — all generated fixes
   * @param durationMs — total pipeline duration
   * @param correlationId — tracing ID
   * @returns summary report
   */
  generateReport(
    analyses: readonly FailureAnalysis[],
    fixes: readonly AutoFix[],
    durationMs: number,
    correlationId: CorrelationId,
  ): AutoFixReport;
}
