/**
 * DriftAwarePromptEnricherAdapter — Infrastructure adapter for Inverse Symbiotic Injection.
 *
 * Integrates DocumentDriftDetector into agent session initialization.
 * Analyzes changed files for documentation drift and generates system prompt
 * fragments with critical/recurring warnings.
 *
 * @layer Infrastructure (Agents)
 * @pattern Inverse Symbiotic Injection (SOTA 2026 — Proactive Context Enrichment)
 * @see src/domain/agents/IDriftAwarePromptEnricher.ts — domain port
 * @see src/domain/agents/IDocumentDriftDetector.ts — drift detection source
 */

import type {
  IDriftAwarePromptEnricher,
  DriftEnrichmentRequest,
  DriftEnrichmentResult,
} from '../../domain/agents/IDriftAwarePromptEnricher';
import type {
  IDocumentDriftDetector,
  DriftFinding,
  DriftSeverity,
} from '../../domain/agents/IDocumentDriftDetector';

// ─── Helpers ─────────────────────────────────────────────────────

interface MinimalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const SEVERITY_PRIORITY: Record<DriftSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const DEFAULT_MAX_FINDINGS = 10;

// ─── Adapter ─────────────────────────────────────────────────────

export class DriftAwarePromptEnricherAdapter implements IDriftAwarePromptEnricher {
  constructor(
    private readonly driftDetector: IDocumentDriftDetector,
    private readonly logger?: MinimalLogger,
  ) {}

  async enrichForSession(
    request: DriftEnrichmentRequest,
    correlationId: string,
  ): Promise<DriftEnrichmentResult> {
    const now = new Date().toISOString();
    const maxFindings = request.maxFindings ?? DEFAULT_MAX_FINDINGS;
    const minSeverityLevel = request.minSeverity
      ? SEVERITY_PRIORITY[request.minSeverity]
      : SEVERITY_PRIORITY.high; // Default: include critical + high

    // Run drift detection on changed files
    const driftReport = await this.driftDetector.detectDrift(
      {
        documentPaths: [...request.changedFiles],
        checkCrossReferences: false,
      },
      correlationId,
    );

    // Filter: select recurring OR critical findings above minSeverity
    const selectedFindings = driftReport.findings
      .filter((f: DriftFinding) => {
        const severityOk = SEVERITY_PRIORITY[f.severity] >= minSeverityLevel;
        const isRecurring = f.status === 'recurring';
        const isCritical = f.severity === 'critical';
        return severityOk || isRecurring || isCritical;
      })
      .slice(0, maxFindings);

    // Format prompt fragment
    const promptFragment = this.formatPromptFragment(selectedFindings);

    // Estimate token count (~chars/4 heuristic, standard for GPT-family tokenizers)
    const estimatedTokens = Math.ceil(promptFragment.length / 4);

    this.logger?.info('Drift-aware prompt enrichment completed', {
      correlationId,
      changedFiles: request.changedFiles.length,
      totalFindings: driftReport.findings.length,
      injectedFindings: selectedFindings.length,
      estimatedTokens,
    });

    return {
      promptFragment,
      findingsInjected: selectedFindings.length,
      estimatedTokens,
      driftReport,
      selectedFindings,
      enrichedAt: now,
    };
  }

  // ─── Private ─────────────────────────────────────────────────

  private formatPromptFragment(findings: readonly DriftFinding[]): string {
    if (findings.length === 0) {
      return '';
    }

    const lines: string[] = [
      '⚠️ ATTENTION REQUIRED — Documentation Drift Detected:',
      '',
    ];

    for (const finding of findings) {
      const statusTag = finding.status === 'recurring' ? ' [RECURRING]' : '';
      const confidence = Math.round(finding.confidence * 100);
      lines.push(
        `- [${finding.severity.toUpperCase()}${statusTag}] ${finding.documentPath}: ` +
        `${finding.description} (confidence: ${confidence}%)`,
      );
      if (finding.suggestedFix) {
        lines.push(`  Fix: ${finding.suggestedFix}`);
      }
    }

    lines.push('');
    lines.push('Review these findings before modifying the affected files.');

    return lines.join('\n');
  }
}
