/**
 * IWisdomExporter — Domain port for exporting TIM wisdom to external tools.
 *
 * Bridges the Trajectory-Informed Memory pipeline with IDE tooling (LSP, linters)
 * by serializing Tier 3-4 wisdom into structured diagnostic rules. Enables
 * real-time code guidance via LSP "Red-Line" diagnostics derived from past
 * trajectory insights.
 *
 * Export Format:
 *   Each exported rule maps a StructuredTip to a diagnostic:
 *   - Severity: derived from tip priority (CRITICAL→error, HIGH→warning, MEDIUM→info, LOW→hint)
 *   - Message: tip content + trigger condition
 *   - Source: "TIM" with tip category tag
 *   - Code: tip ID for traceability
 *
 * Integration Points:
 *   - IContextualTipGenerator (CC-035) — tip source
 *   - IAdaptiveMemoryRetrieval (CC-036) — memory tier classification
 *   - LSP server — downstream consumer of exported rules
 *
 * Academic Basis:
 *   - Trajectory-Informed Memory (arXiv:2603.10600, Mar 2026) — wisdom export
 *   - TIM Strategic Recommendations: Horizon 3 (LSP Red-Line Bridge)
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @pattern TIM Wisdom Export (Horizon 3 — LSP Bridge)
 * @see src/domain/memory/IContextualTipGenerator.ts — CC-035 tip source
 * @see src/domain/memory/IAdaptiveMemoryRetrieval.ts — CC-036 memory tiers
 */

import type { StructuredTip, TipCategory } from './IContextualTipGenerator';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Diagnostic severity levels aligned with LSP DiagnosticSeverity.
 */
export type WisdomSeverity = 'error' | 'warning' | 'info' | 'hint';

/**
 * A single wisdom diagnostic rule ready for LSP consumption.
 */
export interface WisdomDiagnosticRule {
  /** Unique rule ID (maps to tip ID). */
  readonly ruleId: string;
  /** Diagnostic severity. */
  readonly severity: WisdomSeverity;
  /** Diagnostic message (tip content). */
  readonly message: string;
  /** Trigger condition (when this diagnostic applies). */
  readonly triggerPattern: string;
  /** Tip category (strategy/recovery/optimization). */
  readonly category: TipCategory;
  /** Source identifier. */
  readonly source: string;
  /** Memory tier of the originating tip (3-4 for exported rules). */
  readonly memoryTier: number;
  /** When this rule was exported. */
  readonly exportedAt: string;
}

/**
 * Result of a wisdom export operation.
 */
export interface WisdomExportResult {
  /** Exported diagnostic rules. */
  readonly rules: readonly WisdomDiagnosticRule[];
  /** Total tips evaluated for export. */
  readonly totalTipsEvaluated: number;
  /** Tips that qualified for export (Tier 3-4 only). */
  readonly tipsExported: number;
  /** Export timestamp. */
  readonly exportedAt: string;
}

/**
 * Configuration for wisdom export.
 */
export interface WisdomExportConfig {
  /** Minimum memory tier for export (default: 3 — Procedural+). */
  readonly minTier: number;
  /** Minimum tip priority for export (default: 0.5). */
  readonly minPriority: number;
  /** Categories to export (default: all). */
  readonly categoryFilter?: readonly TipCategory[];
  /** Maximum rules to export (default: 50). */
  readonly maxRules: number;
  /** Include Hard Invariant seed rules (default: true). */
  readonly includeSeedRules?: boolean;
}

/** Default export configuration. */
export const DEFAULT_EXPORT_CONFIG: WisdomExportConfig = {
  minTier: 3,
  minPriority: 0.5,
  maxRules: 50,
};

/**
 * Export statistics.
 */
export interface WisdomExportStats {
  /** Total exports performed. */
  readonly totalExports: number;
  /** Total rules exported across all operations. */
  readonly totalRulesExported: number;
  /** Distribution by severity. */
  readonly severityDistribution: Record<WisdomSeverity, number>;
  /** Distribution by category. */
  readonly categoryDistribution: Record<TipCategory, number>;
}

// ── Main Interface ────────────────────────────────────────────────

/**
 * Wisdom Exporter — serializes accumulated TIM wisdom into LSP-compatible
 * diagnostic rules for IDE integration.
 */
export interface IWisdomExporter {
  /**
   * Export wisdom from accumulated tips as diagnostic rules.
   *
   * @param tips - Accumulated structured tips (from CC-035)
   * @param tierClassifier - Function to classify a tip's memory tier (from CC-036)
   * @param config - Export configuration
   * @returns Export result with diagnostic rules
   */
  exportRules(
    tips: readonly StructuredTip[],
    tierClassifier: (tip: StructuredTip) => number,
    config?: WisdomExportConfig,
  ): WisdomExportResult;

  /**
   * Get export statistics.
   *
   * @returns Aggregate export stats
   */
  getStats(): WisdomExportStats;

  /**
   * Optional readiness barrier for exporters that hydrate persisted macro-principles
   * at startup before projecting them into diagnostic rules.
   */
  whenReady?(): Promise<void>;

  /** Reset all state. */
  reset(): void;
}
