/**
 * IDriftAwarePromptEnricher — Domain port for Inverse Symbiotic Injection.
 *
 * Integrates DocumentDriftDetector into agent initialization: when an agent
 * session starts, files from the current Git diff are checked for drift.
 * Critical/recurring findings are injected into the agent's system prompt
 * as "⚠️ ATTENTION REQUIRED" warnings, preventing the agent from generating
 * code that contradicts known documentation drift.
 *
 * Academic Basis:
 *   - "Inverse Symbiotic Injection" — proactive context enrichment from
 *     self-maintaining documentation systems (SOTA March 2026)
 *   - Stanford Q4 2025: 89% of enterprise knowledge bases contain outdated APIs
 *
 * Workflow:
 *   1. Agent session starts → enrichForSession() called
 *   2. Adapter calls IDocumentDriftDetector.detectDrift() on changed files
 *   3. Findings with status 'recurring' or severity 'critical' are selected
 *   4. Selected findings are formatted as system prompt warnings
 *   5. Enriched prompt fragment is returned for injection into agent context
 *
 * @layer Domain (Agents)
 * @pattern Inverse Symbiotic Injection (SOTA 2026 — Proactive Context Enrichment)
 * @see src/domain/agents/IDocumentDriftDetector.ts — drift detection source
 * @see PLANS/DOCS_AUDIT_2026/87_DOCS_SOTA_ACADEMIC_RESEARCH_MARCH_2026.md
 */

import type { DriftReport, DriftFinding } from './IDocumentDriftDetector';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Request to enrich an agent session with drift-aware context.
 */
export interface DriftEnrichmentRequest {
  /** Files changed in current Git diff (relative paths). */
  readonly changedFiles: readonly string[];
  /** Optional limit on number of findings to inject. */
  readonly maxFindings?: number;
  /** Optional minimum severity to include. Default: inject critical + recurring. */
  readonly minSeverity?: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * Result of drift-aware prompt enrichment.
 */
export interface DriftEnrichmentResult {
  /** Formatted prompt fragment to inject into system prompt. Empty string if no findings. */
  readonly promptFragment: string;
  /** Number of findings injected. */
  readonly findingsInjected: number;
  /** Estimated token count of the prompt fragment (~chars/4). For S-MMU budget checks. */
  readonly estimatedTokens: number;
  /** Underlying drift report (for tracing/auditing). */
  readonly driftReport: DriftReport;
  /** Filtered findings that were selected for injection. */
  readonly selectedFindings: readonly DriftFinding[];
  /** ISO timestamp of enrichment. */
  readonly enrichedAt: string;
}

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * IDriftAwarePromptEnricher — injects documentation drift warnings into agent prompts.
 *
 * Usage:
 *   const enricher = container.resolve<IDriftAwarePromptEnricher>(DI_TOKENS.IDriftAwarePromptEnricher);
 *   const result = await enricher.enrichForSession({ changedFiles: ['src/core/di/DI_TOKENS.ts'] }, correlationId);
 *   if (result.promptFragment) {
 *     systemPrompt += '\n\n' + result.promptFragment;
 *   }
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface IDriftAwarePromptEnricher {
  /**
   * Analyze changed files for documentation drift and generate a prompt fragment
   * containing warnings about critical/recurring findings.
   *
   * @param request - Changed files and optional filters
   * @param correlationId - Request correlation for tracing
   * @returns Enrichment result with formatted prompt fragment
   */
  enrichForSession(
    request: DriftEnrichmentRequest,
    correlationId: string,
  ): Promise<DriftEnrichmentResult>;
}
