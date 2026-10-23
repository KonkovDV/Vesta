/**
 * DynamicCognitiveBudgetAdapter — In-memory criticality-aware budget allocation.
 *
 * @layer Infrastructure (Agents)
 * @pattern CC-028 Dynamic Cognitive Budget (PUA v5.2)
 * @see src/domain/agents/IDynamicCognitiveBudget.ts — domain port
 */

import type {
  IDynamicCognitiveBudget,
  CriticalityZone,
  CriticalityAssessment,
  DynamicBudget,
  DynamicBudgetConfig,
  DynamicBudgetStats,
} from '../../domain/agents/IDynamicCognitiveBudget';
import { DEFAULT_DYNAMIC_BUDGET_CONFIG } from '../../domain/agents/IDynamicCognitiveBudget';

// ── Logger ────────────────────────────────────────────────────────

interface BudgetLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Entry Chain Files ─────────────────────────────────────────────

const ENTRY_CHAIN_PATTERNS = [
  'index.ts', 'orchestrator.ts', 'bootstrap.ts', 'app.ts',
];

const DI_DEFINITION_PATTERNS = [
  'DI_TOKENS.ts', 'container.ts',
];

// ── Zone → Criticality Score Mapping ──────────────────────────────

const ZONE_SCORES: Record<CriticalityZone, number> = {
  system_core: 0.95,
  domain_logic: 0.75,
  application: 0.50,
  infrastructure: 0.40,
  testing: 0.20,
  documentation: 0.10,
  research: 0.05,
};

// ── Adapter ───────────────────────────────────────────────────────

export class DynamicCognitiveBudgetAdapter implements IDynamicCognitiveBudget {
  private totalAssessments = 0;
  private readonly zoneCounts: Record<CriticalityZone, number> = {
    system_core: 0, domain_logic: 0, application: 0,
    infrastructure: 0, testing: 0, documentation: 0, research: 0,
  };
  private hallucinationGuardActivations = 0;
  private budgetRatioSum = 0;

  constructor(private readonly logger?: BudgetLogger) {}

  assessCriticality(filePath: string): CriticalityAssessment {
    const normalized = filePath.replace(/\\/g, '/');
    const zone = this.detectZone(normalized);
    const isEntryChain = ENTRY_CHAIN_PATTERNS.some(p => normalized.endsWith(p));
    const isDiDefinition = DI_DEFINITION_PATTERNS.some(p => normalized.endsWith(p));

    let score = ZONE_SCORES[zone];
    if (isEntryChain) score = Math.max(score, 0.95);
    if (isDiDefinition) score = Math.max(score, 0.90);

    const layer = this.detectLayer(normalized);

    const rationale = this.buildRationale(zone, isEntryChain, isDiDefinition, score);

    this.totalAssessments++;
    this.zoneCounts[zone]++;

    this.logger?.info('Criticality assessed', { target: filePath, zone, score, layer });

    return {
      target: filePath,
      zone,
      score,
      architectureLayer: layer,
      isEntryChain,
      isDiDefinition,
      rationale,
    };
  }

  calculateBudget(
    baseBudget: number,
    filePath: string,
    config: DynamicBudgetConfig = DEFAULT_DYNAMIC_BUDGET_CONFIG,
  ): DynamicBudget {
    const assessment = this.assessCriticality(filePath);
    // Already counted in assessCriticality, decrement to avoid double-counting
    this.totalAssessments--;
    this.zoneCounts[assessment.zone]--;

    let effectiveBudget: number;
    if (assessment.zone === 'research') {
      // Research tasks get expanded budgets
      effectiveBudget = baseBudget * config.maxResearchExpansion;
    } else {
      // Critical files get compressed budgets
      const compression = 1 - (assessment.score * config.compressionFactor);
      effectiveBudget = baseBudget * Math.max(compression, config.minBudgetRatio);
    }

    const hallucinationGuardActive = assessment.score >= config.hallucinationGuardThreshold;
    if (hallucinationGuardActive) {
      this.hallucinationGuardActivations++;
      this.logger?.warn('Hallucination guard activated', {
        target: filePath,
        score: assessment.score,
        effectiveBudget,
      });
    }

    const ratio = baseBudget > 0 ? effectiveBudget / baseBudget : 1;
    this.budgetRatioSum += ratio;
    this.totalAssessments++;
    this.zoneCounts[assessment.zone]++;

    return {
      baseBudget,
      effectiveBudget,
      criticalityScore: assessment.score,
      compressionFactor: config.compressionFactor,
      zone: assessment.zone,
      hallucinationGuardActive,
      summary: hallucinationGuardActive
        ? `Hallucination guard ACTIVE — budget compressed to ${effectiveBudget.toFixed(3)} (base: ${baseBudget}, criticality: ${assessment.score.toFixed(2)})`
        : `Budget ${effectiveBudget.toFixed(3)} for ${assessment.zone} (base: ${baseBudget}, criticality: ${assessment.score.toFixed(2)})`,
    };
  }

  getStats(): DynamicBudgetStats {
    return {
      totalAssessments: this.totalAssessments,
      assessmentsByZone: { ...this.zoneCounts },
      hallucinationGuardActivations: this.hallucinationGuardActivations,
      avgBudgetRatio: this.totalAssessments > 0
        ? this.budgetRatioSum / this.totalAssessments
        : 1,
    };
  }

  reset(): void {
    this.totalAssessments = 0;
    for (const key of Object.keys(this.zoneCounts) as CriticalityZone[]) {
      this.zoneCounts[key] = 0;
    }
    this.hallucinationGuardActivations = 0;
    this.budgetRatioSum = 0;
    this.logger?.info('Dynamic Cognitive Budget reset');
  }

  // ── Private Helpers ─────────────────────────────────────────

  private detectZone(path: string): CriticalityZone {
    if (path === 'research' || path.startsWith('PLANS/')) return 'research';
    if (/\.(md|txt|json)$/.test(path) && !path.includes('src/')) return 'documentation';
    if (path.includes('tests/') || path.includes('test.ts')) return 'testing';
    if (path.includes('src/infrastructure/')) return 'infrastructure';
    if (path.includes('src/application/')) return 'application';
    if (path.includes('src/domain/') || path.includes('src/core/')) return 'domain_logic';
    if (
      ENTRY_CHAIN_PATTERNS.some(p => path.endsWith(p)) ||
      DI_DEFINITION_PATTERNS.some(p => path.endsWith(p))
    ) return 'system_core';
    return 'infrastructure';
  }

  private detectLayer(path: string): number {
    if (path === 'research') return -1;
    if (ENTRY_CHAIN_PATTERNS.some(p => path.endsWith(p))) return 0;
    if (DI_DEFINITION_PATTERNS.some(p => path.endsWith(p))) return 1;
    if (path.includes('src/domain/')) return 2;
    if (path.includes('src/core/')) return 3;
    if (path.includes('src/application/')) return 4;
    if (path.includes('src/infrastructure/')) return 6;
    if (path.includes('tests/')) return 8;
    return 9;
  }

  private buildRationale(
    zone: CriticalityZone,
    isEntryChain: boolean,
    isDiDefinition: boolean,
    score: number,
  ): string {
    const parts: string[] = [`Zone: ${zone} (base score: ${ZONE_SCORES[zone]})`];
    if (isEntryChain) parts.push('Entry chain file — elevated to 0.95');
    if (isDiDefinition) parts.push('DI definition file — elevated to 0.90');
    parts.push(`Final score: ${score.toFixed(2)}`);
    return parts.join('. ');
  }
}
