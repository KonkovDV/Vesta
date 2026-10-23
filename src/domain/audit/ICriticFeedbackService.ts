/**
 * ICriticFeedbackService — Domain port for Proactive AST-Critic Feedback.
 *
 * SOTA 2026 Extraction: Instead of returning raw compilation errors to the Coder agent,
 * the Critic intercepts errors, enriches them with AST-driven suggestions, and returns
 * structured actionable feedback. This closes the Self-Evolving Feedback Loop where
 * the Coder learns on-the-fly without hallucinating fixes.
 *
 * Pipeline:
 *   Coder Error → ICriticFeedbackService.analyzeDiagnostic()
 *               → AST lookup (ts-morph) → DI_TOKENS.ts scan
 *               → Structured CriticFeedback with fix suggestions
 *               → Coder receives [CRITIC_FEEDBACK] instead of raw error
 *
 * Example:
 *   Raw error:  "Cannot find name 'ILogger'"
 *   Critic:     "[CRITIC_FEEDBACK]: Token 'ILogger' exists but is deprecated.
 *                Use 'IStructuredLogger' from src/core/logging/IStructuredLogger.ts.
 *                DI: container.resolve(DI_TOKENS.IStructuredLogger)"
 *
 * Academic References:
 *   - Zhang et al. (2025) "Eco-Evolve: Self-Evolving Multi-Agent Framework"
 *   - Qian et al. (2024) "ChatDev: Communicative Agents for Software Development"
 *
 * @layer Domain (port — implemented by Application service + Infrastructure AST adapter)
 * @horizon H0/H1: Critic Agent Feedback Loop
 * @see PLANS/docs/mcp_and_testing_audit/31-advanced-multi-agent-extraction.md — Idea 2
 * @see src/infrastructure/mcp/audit/ast-checker.ts — existing AST analysis
 * @see src/domain/security/ISingularityCoreAuditor.ts — audit pipeline integration point
 */

import type { CorrelationId } from '@/ai-types';

// ── Diagnostic Input ──────────────────────────────────────────────

/** Classification of the error source. */
export type DiagnosticSource =
  | 'tsc'              // TypeScript compiler
  | 'eslint'           // ESLint rule violation
  | 'architecture'     // Clean Architecture layer violation
  | 'di_resolution'    // DI container resolution failure
  | 'test_failure'     // Jest test assertion failure
  | 'runtime';         // Runtime exception

/** Severity of the diagnostic. */
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** A raw diagnostic from a build/lint/test tool. */
export interface AgentDiagnostic {
  /** Source tool that produced the diagnostic. */
  readonly source: DiagnosticSource;
  /** Error/warning code (e.g. "TS2304", "no-unused-vars"). */
  readonly code: string;
  /** Raw error message. */
  readonly message: string;
  /** File path (relative to project root). */
  readonly file?: string;
  /** Line number (1-based). */
  readonly line?: number;
  /** Column number (1-based). */
  readonly column?: number;
  /** Severity level. */
  readonly severity: DiagnosticSeverity;
}

// ── Critic Feedback Output ────────────────────────────────────────

/** Confidence of the suggestion. */
export type SuggestionConfidence = 'high' | 'medium' | 'low';

/** A structured fix suggestion. */
export interface FixSuggestion {
  /** Human-readable description of the fix. */
  readonly description: string;
  /** Confidence that this fix will resolve the issue. */
  readonly confidence: SuggestionConfidence;
  /** Exact code to replace (if applicable). */
  readonly oldCode?: string;
  /** Replacement code (if applicable). */
  readonly newCode?: string;
  /** File to apply the fix to. */
  readonly targetFile?: string;
  /** Line range for the fix. */
  readonly lineRange?: { readonly start: number; readonly end: number };
}

/** Enriched feedback from the Critic. */
export interface CriticFeedback {
  /** Original diagnostic that triggered the analysis. */
  readonly diagnostic: AgentDiagnostic;
  /** Structured summary for the Coder agent. */
  readonly summary: string;
  /** Root cause analysis. */
  readonly rootCause: string;
  /** Ordered fix suggestions (most confident first). */
  readonly suggestions: readonly FixSuggestion[];
  /** Related DI tokens (if the error involves DI). */
  readonly relatedTokens: readonly string[];
  /** Related files that may need changes. */
  readonly relatedFiles: readonly string[];
  /** Analysis duration in milliseconds. */
  readonly analysisMs: number;
}

/** Batch analysis result. */
export interface CriticBatchResult {
  /** Individual feedback items. */
  readonly feedbacks: readonly CriticFeedback[];
  /** Total diagnostics analyzed. */
  readonly totalDiagnostics: number;
  /** Diagnostics with actionable suggestions. */
  readonly actionableDiagnostics: number;
  /** Total analysis time in milliseconds. */
  readonly totalMs: number;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Critic Feedback Service — proactive AST-enriched error analysis.
 *
 * Intercepts raw diagnostics from TSC/ESLint/Jest, enriches them with
 * AST context and DI knowledge, and returns structured fix suggestions.
 */
export interface ICriticFeedbackService {
  /**
   * Analyze a single diagnostic and produce enriched feedback.
   *
   * @param diagnostic - Raw diagnostic from build/lint/test tool
   * @param correlationId - Request correlation ID for tracing
   */
  analyzeDiagnostic(
    diagnostic: AgentDiagnostic,
    correlationId: CorrelationId,
  ): Promise<CriticFeedback>;

  /**
   * Analyze a batch of diagnostics (e.g. full TSC output).
   * Deduplicates and groups related errors for efficient processing.
   *
   * @param diagnostics - Array of raw diagnostics
   * @param correlationId - Request correlation ID for tracing
   */
  analyzeBatch(
    diagnostics: readonly AgentDiagnostic[],
    correlationId: CorrelationId,
  ): Promise<CriticBatchResult>;
}
