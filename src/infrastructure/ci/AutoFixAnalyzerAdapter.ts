/**
 * AutoFixAnalyzerAdapter — Infrastructure adapter for Cognitive CI/CD Quality Gates.
 *
 * Implements IAutoFixAnalyzer with pattern-based failure classification:
 * - P1_structural: Missing DI registration, missing module export
 * - P2_type: Wrong import path (TS2307), missing Zod schema
 * - P3_convention: Missing correlationId, wrong layer import
 * - P4_logic / P5_design: Not auto-fixable (classified for reporting)
 *
 * @layer Infrastructure
 * @pattern Pillar-5 Cognitive CI/CD Gates (Agentic Auto-Patch)
 * @see src/domain/ci/IAutoFixAnalyzer.ts — Domain port
 */

import { randomUUID } from 'node:crypto';
import type {
  IAutoFixAnalyzer,
  TestFailure,
  FailureAnalysis,
  FailureClass,
  FixConfidence,
  AutoFix,
  AutoFixReport,
} from '../../domain/ci/IAutoFixAnalyzer';
import type { CorrelationId } from '../../core/types/branded';

// ── Classification Pattern ──────────────────────────────────────

interface ClassificationPattern {
  readonly name: string;
  readonly regex: RegExp;
  readonly classification: FailureClass;
  readonly confidence: FixConfidence;
  readonly rootCauseTemplate: string;
}

/** Minimal structured logger interface. */
interface MinimalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Analyzer Adapter ────────────────────────────────────────────

export class AutoFixAnalyzerAdapter implements IAutoFixAnalyzer {
  /**
   * Pattern library for failure classification.
   * Patterns are evaluated in order — first match wins.
   */
  private readonly patterns: readonly ClassificationPattern[] = [
    // P1: Structural — DI registration
    {
      name: 'missing-di-registration',
      regex: /(?:is not registered|No registration found for|resolve.*failed.*token)/i,
      classification: 'P1_structural',
      confidence: 'high',
      rootCauseTemplate: 'DI token is defined but not registered in any bootstrap module',
    },
    {
      name: 'missing-module-export',
      regex: /(?:has no exported member|is not exported from)/i,
      classification: 'P1_structural',
      confidence: 'high',
      rootCauseTemplate: 'Module does not export the referenced symbol',
    },
    // P2: Type — import issues
    {
      name: 'module-not-found',
      regex: /Cannot find module '([^']+)'/i,
      classification: 'P2_type',
      confidence: 'medium',
      rootCauseTemplate: 'Import path not found — possible misspelling or missing file',
    },
    {
      name: 'missing-zod-schema',
      regex: /(?:schema.*not.*found|ZodError|invalid.*schema)/i,
      classification: 'P2_type',
      confidence: 'medium',
      rootCauseTemplate: 'Missing or invalid Zod schema for event payload',
    },
    {
      name: 'type-mismatch',
      regex: /(?:TS2322|TS2345|Type '.*' is not assignable to type)/i,
      classification: 'P2_type',
      confidence: 'low',
      rootCauseTemplate: 'Type mismatch — incompatible assignment or argument',
    },
    // P3: Convention — layer violations, missing patterns
    {
      name: 'missing-correlation-id',
      regex: /correlationId.*(?:undefined|required|missing)/i,
      classification: 'P3_convention',
      confidence: 'medium',
      rootCauseTemplate: 'Missing correlationId propagation in async flow',
    },
    {
      name: 'wrong-layer-import',
      regex: /(?:infrastructure.*imported.*(?:domain|application)|must not import.*infrastructure)/i,
      classification: 'P3_convention',
      confidence: 'high',
      rootCauseTemplate: 'Layer dependency violation — wrong import direction',
    },
    // P4: Logic
    {
      name: 'assertion-failure',
      regex: /(?:expect\(.*\)\.(?:toBe|toEqual|toMatch).*received|AssertionError)/i,
      classification: 'P4_logic',
      confidence: 'none',
      rootCauseTemplate: 'Test assertion failed — likely business logic error',
    },
    // P5: Design
    {
      name: 'architecture-test-failure',
      regex: /(?:architecture.*violation|clean.architecture.*failed)/i,
      classification: 'P5_design',
      confidence: 'none',
      rootCauseTemplate: 'Architecture constraint violated — requires design review',
    },
  ];

  constructor(private readonly logger?: MinimalLogger) {}

  async analyzeFailures(
    failures: readonly TestFailure[],
    correlationId: CorrelationId,
  ): Promise<readonly FailureAnalysis[]> {
    const analyses: FailureAnalysis[] = [];

    for (const failure of failures) {
      const analysis = this.classifyFailure(failure);
      analyses.push(analysis);
    }

    this.logger?.info('CI failures analyzed', {
      total: failures.length,
      p1: analyses.filter((a) => a.classification === 'P1_structural').length,
      p2: analyses.filter((a) => a.classification === 'P2_type').length,
      p3: analyses.filter((a) => a.classification === 'P3_convention').length,
      p4: analyses.filter((a) => a.classification === 'P4_logic').length,
      p5: analyses.filter((a) => a.classification === 'P5_design').length,
      correlationId,
    });

    return analyses;
  }

  async generateFixes(
    analyses: readonly FailureAnalysis[],
    correlationId: CorrelationId,
  ): Promise<readonly AutoFix[]> {
    const fixes: AutoFix[] = [];
    const fixableClasses: ReadonlySet<FailureClass> = new Set([
      'P1_structural',
      'P2_type',
      'P3_convention',
    ]);

    for (const analysis of analyses) {
      if (!fixableClasses.has(analysis.classification)) {
        continue;
      }
      if (analysis.fixConfidence === 'none') {
        continue;
      }

      const fix = this.buildFix(analysis);
      if (fix) {
        fixes.push(fix);
      }
    }

    this.logger?.info('Auto-fixes generated', {
      total: fixes.length,
      avgConfidence: fixes.length > 0
        ? fixes.reduce((sum, f) => sum + f.confidence, 0) / fixes.length
        : 0,
      correlationId,
    });

    return fixes;
  }

  async validateFix(
    fix: AutoFix,
    correlationId: CorrelationId,
  ): Promise<boolean> {
    // In a real implementation, this would run the test command
    // and check if the targeted test passes after applying patches.
    // For the structural stub, we validate based on confidence threshold.
    const isValid = fix.confidence >= 0.7 && fix.patches.length > 0;

    this.logger?.info('Fix validation result', {
      fixId: fix.id,
      valid: isValid,
      confidence: fix.confidence,
      patchCount: fix.patches.length,
      correlationId,
    });

    return isValid;
  }

  generateReport(
    analyses: readonly FailureAnalysis[],
    fixes: readonly AutoFix[],
    durationMs: number,
    correlationId: CorrelationId,
  ): AutoFixReport {
    const classifications: Partial<Record<FailureClass, number>> = {};
    for (const a of analyses) {
      classifications[a.classification] = (classifications[a.classification] ?? 0) + 1;
    }

    const avgConfidence = fixes.length > 0
      ? fixes.reduce((sum, f) => sum + f.confidence, 0) / fixes.length
      : 0;

    const report: AutoFixReport = {
      totalFailures: analyses.length,
      analyzed: analyses.length,
      fixGenerated: fixes.length,
      fixValidated: fixes.filter((f) => f.confidence >= 0.7).length,
      classifications,
      avgConfidence,
      durationMs,
    };

    this.logger?.info('Auto-fix report generated', {
      totalFailures: report.totalFailures,
      fixGenerated: report.fixGenerated,
      avgConfidence: report.avgConfidence.toFixed(2),
      correlationId,
    });

    return report;
  }

  // ── Private helpers ───────────────────────────────────────────

  private classifyFailure(failure: TestFailure): FailureAnalysis {
    for (const pattern of this.patterns) {
      if (pattern.regex.test(failure.errorMessage)) {
        return {
          failure,
          classification: pattern.classification,
          rootCause: pattern.rootCauseTemplate,
          affectedFiles: [failure.testFile],
          fixConfidence: pattern.confidence,
        };
      }
    }

    // Default: unclassified → P4_logic
    return {
      failure,
      classification: 'P4_logic',
      rootCause: 'Unclassified failure — requires manual investigation',
      affectedFiles: [failure.testFile],
      fixConfidence: 'none',
    };
  }

  private buildFix(analysis: FailureAnalysis): AutoFix | null {
    const confidenceMap: Record<FixConfidence, number> = {
      high: 0.85,
      medium: 0.70,
      low: 0.50,
      none: 0.0,
    };

    const confidence = confidenceMap[analysis.fixConfidence];
    if (confidence === 0) return null;

    const fixId = `fix-${randomUUID()}`;

    return {
      id: fixId,
      patches: [{
        filePath: analysis.affectedFiles[0] ?? 'unknown',
        additions: [{
          line: -1,
          content: `// Auto-fix for: ${analysis.rootCause}`,
        }],
        deletions: [],
      }],
      explanation: `Auto-fix for ${analysis.classification}: ${analysis.rootCause}`,
      confidence,
      testCommand: `node ./node_modules/jest/bin/jest.js ${analysis.failure.testFile} --no-coverage --forceExit`,
    };
  }
}
