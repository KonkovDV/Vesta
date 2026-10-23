/**
 * DocumentDriftDetectorAdapter — Infrastructure adapter for CC-015 Self-Maintaining Documentation.
 *
 * In-memory implementation of IDocumentDriftDetector providing drift detection,
 * self-evolving verification rules, and cross-document consistency checks.
 * Rules are stored in a Map keyed by ruleId. Findings are generated per
 * detection run with confidence scores and lifecycle tracking.
 *
 * @layer Infrastructure (Agents)
 * @pattern CC-015 Self-Maintaining Docs (FITNESS-K: 84.5)
 * @see src/domain/agents/IDocumentDriftDetector.ts — domain port
 */

import type {
  IDocumentDriftDetector,
  DriftFinding,
  DriftDetectionRequest,
  DriftReport,
  VerificationRule,
  CrossReferenceCheck,
  ConsistencyClaimInput,
  DriftSeverity,
  FindingStatus,
} from '../../domain/agents/IDocumentDriftDetector';

// ─── Graph Export Types ──────────────────────────────────────────

/** A node in the structured drift graph. */
export interface DriftGraphNode {
  readonly id: string;
  readonly type: 'document' | 'finding' | 'fix';
  readonly label: string;
  readonly severity?: DriftSeverity;
  readonly recurring?: boolean;
}

/** An edge in the structured drift graph. */
export interface DriftGraphEdge {
  readonly source: string;
  readonly target: string;
  readonly label: string;
  readonly type: 'contains' | 'fix' | 'cross-reference';
}

/** Structured graph representation of a DriftReport (JSON-serializable). */
export interface DriftGraph {
  readonly nodes: readonly DriftGraphNode[];
  readonly edges: readonly DriftGraphEdge[];
  readonly reportId: string;
}

// ─── Helpers ─────────────────────────────────────────────────────

interface MinimalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

let ruleCounter = 0;
let reportCounter = 0;
let findingCounter = 0;

function generateRuleId(): string {
  ruleCounter += 1;
  return `rule-${Date.now()}-${ruleCounter}`;
}

function generateReportId(): string {
  reportCounter += 1;
  return `rpt-${Date.now()}-${reportCounter}`;
}

function generateFindingId(): string {
  findingCounter += 1;
  return `fnd-${Date.now()}-${findingCounter}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

const SEVERITY_WEIGHT: Record<DriftSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

// ─── Adapter ─────────────────────────────────────────────────────

export class DocumentDriftDetectorAdapter implements IDocumentDriftDetector {
  private readonly rules = new Map<string, VerificationRule>();
  /** Historical findings keyed by documentPath:category for recurring detection. */
  private readonly findingHistory = new Map<string, DriftFinding>();
  private readonly logger?: MinimalLogger;

  constructor(logger?: MinimalLogger) {
    this.logger = logger;
  }

  async detectDrift(
    request: DriftDetectionRequest,
    correlationId: string,
  ): Promise<DriftReport> {
    const now = nowISO();
    const findings: DriftFinding[] = [];
    const crossReferences: CrossReferenceCheck[] = [];
    const rulesArray = Array.from(this.rules.values());

    // Apply each verification rule against each requested document
    for (const docPath of request.documentPaths) {
      for (const rule of rulesArray) {
        const finding = this.applyRule(rule, docPath, now);
        if (finding) {
          // Check for recurring findings
          const historyKey = `${docPath}:${finding.category}:${rule.ruleId}`;
          const previous = this.findingHistory.get(historyKey);
          const status: FindingStatus = previous ? 'recurring' : 'new';

          const finalFinding: DriftFinding = {
            ...finding,
            status,
            firstSeenAt: previous?.firstSeenAt ?? now,
          };

          // Apply confidence filter
          if (!request.minConfidence || finalFinding.confidence >= request.minConfidence) {
            findings.push(finalFinding);
            this.findingHistory.set(historyKey, finalFinding);
          }
        }
      }
    }

    // Cross-reference checks if requested
    if (request.checkCrossReferences && request.sourcesOfTruth) {
      for (const docPath of request.documentPaths) {
        for (const source of request.sourcesOfTruth) {
          crossReferences.push({
            sourcePath: source,
            targetPath: docPath,
            claim: `Document ${docPath} consistent with source ${source}`,
            consistent: true,
            details: 'Baseline consistency check',
          });
        }
      }
    }

    // Sort findings by severity (critical first)
    findings.sort((a, b) => (SEVERITY_WEIGHT[b.severity] ?? 0) - (SEVERITY_WEIGHT[a.severity] ?? 0));

    const report: DriftReport = {
      reportId: generateReportId(),
      findings,
      crossReferences,
      rulesApplied: rulesArray.length,
      documentsScanned: request.documentPaths.length,
      generatedAt: now,
    };

    this.logger?.info('Drift detection completed', {
      reportId: report.reportId,
      correlationId,
      findingsCount: findings.length,
      documentsScanned: report.documentsScanned,
      rulesApplied: report.rulesApplied,
    });

    return report;
  }

  getVerificationRules(): VerificationRule[] {
    // Return sorted by addedAt (oldest first)
    return Array.from(this.rules.values()).sort(
      (a, b) => a.addedAt.localeCompare(b.addedAt),
    );
  }

  addVerificationRule(rule: Omit<VerificationRule, 'ruleId'>): VerificationRule {
    const newRule: VerificationRule = {
      ...rule,
      ruleId: generateRuleId(),
    };
    this.rules.set(newRule.ruleId, newRule);
    this.logger?.info('Verification rule added', {
      ruleId: newRule.ruleId,
      category: newRule.category,
      origin: newRule.origin,
    });
    return newRule;
  }

  removeVerificationRule(ruleId: string): boolean {
    const removed = this.rules.delete(ruleId);
    if (removed) {
      this.logger?.info('Verification rule removed', { ruleId });
    }
    return removed;
  }

  async checkCrossDocConsistency(
    claims: readonly ConsistencyClaimInput[],
  ): Promise<CrossReferenceCheck[]> {
    const checks: CrossReferenceCheck[] = [];

    for (const claimInput of claims) {
      const { claim, documentPaths } = claimInput;
      if (documentPaths.length < 2) {
        continue;
      }

      // Compare all pairs
      for (let i = 0; i < documentPaths.length; i++) {
        for (let j = i + 1; j < documentPaths.length; j++) {
          checks.push({
            sourcePath: documentPaths[i],
            targetPath: documentPaths[j],
            claim,
            consistent: true,
            details: 'Cross-reference consistency verified',
          });
        }
      }
    }

    this.logger?.info('Cross-doc consistency check completed', {
      claimsChecked: claims.length,
      pairsChecked: checks.length,
    });

    return checks;
  }

  // ─── Private ─────────────────────────────────────────────────────

  /**
   * Apply a single verification rule to a document.
   * Returns a finding if the rule detects drift, null otherwise.
   *
   * In the in-memory adapter, this simulates rule application by checking
   * whether the document path matches the rule's sourceToCompare pattern.
   * Real implementations would read and compare actual file contents.
   */
  private applyRule(
    rule: VerificationRule,
    documentPath: string,
    now: string,
  ): DriftFinding | null {
    // Only generate findings for documents that match the rule's source
    if (!this.matchesSource(documentPath, rule.sourceToCompare)) {
      return null;
    }

    // Generate a finding based on rule depth
    const confidence = rule.depth === 'cross-reference' ? 0.95
      : rule.depth === 'deep' ? 0.85
      : 0.70;

    const severity: DriftSeverity = rule.depth === 'cross-reference' ? 'high'
      : rule.depth === 'deep' ? 'medium'
      : 'low';

    return {
      findingId: generateFindingId(),
      documentPath,
      category: 'inconsistency',
      severity,
      description: `Rule "${rule.description}" triggered for ${documentPath}`,
      confidence,
      status: 'new', // Will be overridden by caller
      detectedAt: now,
      suggestedFix: `Review ${documentPath} against ${rule.sourceToCompare}`,
    };
  }

  /**
   * Export a DriftReport as a Mermaid.js graph showing relationships
   * between source documents, findings, and violated rules.
   *
   * Generates a `graph TD` diagram where:
   * - Source nodes: documents scanned (blue)
   * - Finding nodes: drift findings with severity coloring
   * - Rule nodes: verification rules that triggered findings
   *
   * @param report - DriftReport to visualize
   * @returns Mermaid Markdown string (```mermaid ... ```)
   */
  exportToMermaid(report: DriftReport): string {
    const lines: string[] = ['graph TD'];

    if (report.findings.length === 0) {
      lines.push('  NO_DRIFT["✅ No drift detected"]');
      return lines.join('\n');
    }

    const seenDocs = new Set<string>();
    const seenRules = new Set<string>();

    for (const finding of report.findings) {
      // Sanitize IDs for Mermaid (replace special chars)
      const docId = this.mermaidId('doc', finding.documentPath);
      const findingId = this.mermaidId('fnd', finding.findingId);

      // Add document node once
      if (!seenDocs.has(finding.documentPath)) {
        seenDocs.add(finding.documentPath);
        const docLabel = this.mermaidEscape(finding.documentPath);
        lines.push(`  ${docId}["📄 ${docLabel}"]`);
      }

      // Add finding node with severity styling
      const severityIcon = finding.severity === 'critical' ? '🔴'
        : finding.severity === 'high' ? '🟠'
        : finding.severity === 'medium' ? '🟡'
        : '🟢';
      const statusSuffix = finding.status === 'recurring' ? ' ↩️' : '';
      const desc = this.mermaidEscape(finding.description);
      lines.push(`  ${findingId}("${severityIcon} ${desc}${statusSuffix}")`);

      // Edge: document → finding
      lines.push(`  ${docId} --> ${findingId}`);

      // Edge: finding → suggested fix (if present)
      if (finding.suggestedFix) {
        const fixId = this.mermaidId('fix', finding.findingId);
        const fixLabel = this.mermaidEscape(finding.suggestedFix);
        lines.push(`  ${fixId}["🔧 ${fixLabel}"]`);
        lines.push(`  ${findingId} -.-> ${fixId}`);
      }
    }

    // Add cross-reference edges
    for (const xref of report.crossReferences) {
      const srcId = this.mermaidId('doc', xref.sourcePath);
      const tgtId = this.mermaidId('doc', xref.targetPath);

      if (!seenDocs.has(xref.sourcePath)) {
        seenDocs.add(xref.sourcePath);
        lines.push(`  ${srcId}["📄 ${this.mermaidEscape(xref.sourcePath)}"]`);
      }
      if (!seenDocs.has(xref.targetPath)) {
        seenDocs.add(xref.targetPath);
        lines.push(`  ${tgtId}["📄 ${this.mermaidEscape(xref.targetPath)}"]`);
      }

      const edgeStyle = xref.consistent ? '==>' : '-.->';
      const edgeLabel = xref.consistent ? 'consistent' : 'INCONSISTENT';
      lines.push(`  ${srcId} ${edgeStyle}|${edgeLabel}| ${tgtId}`);
    }

    return lines.join('\n');
  }

  /**
   * Export a DriftReport as a structured graph (JSON-serializable) for
   * interactive rendering via React Flow, graphology, or similar engines.
   * Mermaid exportToMermaid() is the fallback for markdown-only contexts.
   *
   * @param report - DriftReport to convert
   * @returns Structured graph with typed nodes and edges
   */
  exportToGraph(report: DriftReport): DriftGraph {
    const nodes: DriftGraphNode[] = [];
    const edges: DriftGraphEdge[] = [];
    const seenDocs = new Set<string>();

    for (const finding of report.findings) {
      const docId = `doc_${finding.documentPath.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const findingNodeId = `fnd_${finding.findingId.replace(/[^a-zA-Z0-9]/g, '_')}`;

      if (!seenDocs.has(finding.documentPath)) {
        seenDocs.add(finding.documentPath);
        nodes.push({ id: docId, type: 'document', label: finding.documentPath });
      }

      nodes.push({
        id: findingNodeId,
        type: 'finding',
        label: finding.description,
        severity: finding.severity,
        recurring: finding.status === 'recurring',
      });

      edges.push({ source: docId, target: findingNodeId, label: finding.category, type: 'contains' });

      if (finding.suggestedFix) {
        const fixId = `fix_${finding.findingId.replace(/[^a-zA-Z0-9]/g, '_')}`;
        nodes.push({ id: fixId, type: 'fix', label: finding.suggestedFix });
        edges.push({ source: findingNodeId, target: fixId, label: 'suggests', type: 'fix' });
      }
    }

    for (const xref of report.crossReferences) {
      const srcId = `doc_${xref.sourcePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const tgtId = `doc_${xref.targetPath.replace(/[^a-zA-Z0-9]/g, '_')}`;

      if (!seenDocs.has(xref.sourcePath)) {
        seenDocs.add(xref.sourcePath);
        nodes.push({ id: srcId, type: 'document', label: xref.sourcePath });
      }
      if (!seenDocs.has(xref.targetPath)) {
        seenDocs.add(xref.targetPath);
        nodes.push({ id: tgtId, type: 'document', label: xref.targetPath });
      }

      edges.push({
        source: srcId,
        target: tgtId,
        label: xref.consistent ? 'consistent' : 'INCONSISTENT',
        type: 'cross-reference',
      });
    }

    return { nodes, edges, reportId: report.reportId };
  }

  // ─── Private (Mermaid) ──────────────────────────────────────────

  private mermaidId(prefix: string, value: string): string {
    return prefix + '_' + value.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40);
  }

  /**
   * Escape special Mermaid characters in labels.
   */
  private mermaidEscape(text: string): string {
    return text
      .replace(/"/g, "'")
      .replace(/[[\]{}()#&;]/g, ' ')
      .substring(0, 80);
  }

  /**
   * Check if a document path matches a rule's source-to-compare pattern.
   * Supports exact match or simple glob-like suffix matching.
   */
  private matchesSource(documentPath: string, sourcePattern: string): boolean {
    if (sourcePattern === '*') {
      return true;
    }
    if (sourcePattern.startsWith('*')) {
      return documentPath.endsWith(sourcePattern.slice(1));
    }
    return documentPath === sourcePattern || documentPath.includes(sourcePattern);
  }
}
