/**
 * CrossModelShadowConsensusAdapter — In-memory multi-model audit consensus.
 *
 * @layer Infrastructure (Evaluation)
 * @pattern CC-031 Cross-Model Shadow Consensus (PUA v5.2 → CBV 2.0)
 * @see src/domain/evaluation/ICrossModelShadowConsensus.ts — domain port
 */

import type {
  ICrossModelShadowConsensus,
  ConsensusOutcome,
  AuditorIdentity,
  ConsensusResult,
  LayerClassification,
  CrossModelConfig,
  CrossModelStats,
  CommitteeVerdict,
  BayesianCommitteeResult,
} from '../../domain/evaluation/ICrossModelShadowConsensus';
import { DEFAULT_CROSS_MODEL_CONFIG } from '../../domain/evaluation/ICrossModelShadowConsensus';

// ── Logger ────────────────────────────────────────────────────────

interface ConsensusLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Layer Names ───────────────────────────────────────────────────

const LAYER_NAMES: Record<number, string> = {
  0: 'Entry Chain',
  1: 'DI Container',
  2: 'Domain Core',
  3: 'Core Utilities',
  4: 'Application Services',
  5: 'Controllers',
  6: 'Infrastructure',
  7: 'External Adapters',
  8: 'Testing',
  9: 'Documentation',
};

// ── Adapter ───────────────────────────────────────────────────────

export class CrossModelShadowConsensusAdapter implements ICrossModelShadowConsensus {
  private totalAudits = 0;
  private unanimousPassCount = 0;
  private unanimousFailCount = 0;
  private divergentCount = 0;
  private humanEscalationCount = 0;
  private confidenceSum = 0;
  private committeeAuditCount = 0;

  constructor(private readonly logger?: ConsensusLogger) {}

  classifyLayer(filePath: string): LayerClassification {
    const normalized = filePath.replace(/\\/g, '/');
    const layer = this.detectLayer(normalized);
    return {
      layer,
      layerName: LAYER_NAMES[layer] ?? `Layer ${layer}`,
      requiresConsensus: layer <= DEFAULT_CROSS_MODEL_CONFIG.maxLayerForConsensus,
    };
  }

  requiresConsensus(
    affectedFiles: readonly string[],
    changeKind: string,
    config: CrossModelConfig = DEFAULT_CROSS_MODEL_CONFIG,
  ): { required: boolean; reason: string } {
    // Check DI changes
    if (config.consensusForDiChanges && changeKind === 'di_registration') {
      return { required: true, reason: 'DI registration changes always require multi-model consensus' };
    }

    // Check schema changes
    if (config.consensusForSchemaChanges && changeKind === 'schema_change') {
      return { required: true, reason: 'Schema changes always require multi-model consensus' };
    }

    // Check layer requirements
    for (const file of affectedFiles) {
      const classification = this.classifyLayer(file);
      if (classification.layer <= config.maxLayerForConsensus) {
        return {
          required: true,
          reason: `File "${file}" is in ${classification.layerName} (layer ${classification.layer}) — requires consensus for layers 0-${config.maxLayerForConsensus}`,
        };
      }
    }

    return { required: false, reason: 'No high-criticality files or change kinds detected' };
  }

  evaluateConsensus(
    primaryVerdict: { decision: string; risks: readonly string[] },
    secondaryVerdict: { decision: string; risks: readonly string[] },
    primaryAuditor: AuditorIdentity,
    secondaryAuditor: AuditorIdentity,
    durationMs: number,
  ): ConsensusResult {
    this.totalAudits++;

    const primaryPass = primaryVerdict.decision === 'pass' || primaryVerdict.decision === 'pass_with_warnings';
    const secondaryPass = secondaryVerdict.decision === 'pass' || secondaryVerdict.decision === 'pass_with_warnings';

    let consensus: ConsensusOutcome;
    if (primaryVerdict.decision === secondaryVerdict.decision) {
      consensus = primaryPass ? 'unanimous_pass' : 'unanimous_fail';
    } else if (primaryPass && secondaryPass) {
      // Both pass-ish but different flavors (pass vs pass_with_warnings)
      consensus = 'partial_agreement';
    } else {
      consensus = 'divergent';
    }

    switch (consensus) {
      case 'unanimous_pass': this.unanimousPassCount++; break;
      case 'unanimous_fail': this.unanimousFailCount++; break;
      case 'divergent': this.divergentCount++; break;
    }

    const requiresHumanReview = consensus === 'divergent';
    if (requiresHumanReview) {
      this.humanEscalationCount++;
    }

    // Find shared and unique risks
    const primaryRiskSet = new Set(primaryVerdict.risks);
    const secondaryRiskSet = new Set(secondaryVerdict.risks);
    const sharedRisks = primaryVerdict.risks.filter(r => secondaryRiskSet.has(r));
    const primaryOnly = primaryVerdict.risks.filter(r => !secondaryRiskSet.has(r));
    const secondaryOnly = secondaryVerdict.risks.filter(r => !primaryRiskSet.has(r));

    // Calculate combined confidence
    const agreementBonus = consensus === 'unanimous_pass' || consensus === 'unanimous_fail' ? 0.3 : 0;
    const sharedRiskBonus = sharedRisks.length > 0 ? 0.2 : 0;
    const combinedConfidence = Math.min(0.5 + agreementBonus + sharedRiskBonus, 1.0);
    this.confidenceSum += combinedConfidence;

    const summary = this.buildSummary(consensus, primaryAuditor, secondaryAuditor, sharedRisks, primaryOnly, secondaryOnly);

    this.logger?.info('Consensus evaluated', {
      consensus,
      primaryDecision: primaryVerdict.decision,
      secondaryDecision: secondaryVerdict.decision,
      sharedRisks: sharedRisks.length,
      requiresHumanReview,
    });

    return {
      consensus,
      primaryDecision: primaryVerdict.decision,
      secondaryDecision: secondaryVerdict.decision,
      primaryAuditor,
      secondaryAuditor,
      uniqueRisks: { primaryOnly, secondaryOnly },
      sharedRisks,
      requiresHumanReview,
      combinedConfidence,
      totalDurationMs: durationMs,
      summary,
      auditedAt: new Date().toISOString(),
    };
  }

  getStats(): CrossModelStats {
    return {
      totalAudits: this.totalAudits,
      unanimousPassCount: this.unanimousPassCount,
      unanimousFailCount: this.unanimousFailCount,
      divergentCount: this.divergentCount,
      humanEscalationCount: this.humanEscalationCount,
      avgConfidence: this.totalAudits > 0
        ? this.confidenceSum / this.totalAudits
        : 0,
      committeeAudits: this.committeeAuditCount,
    };
  }

  reset(): void {
    this.totalAudits = 0;
    this.unanimousPassCount = 0;
    this.unanimousFailCount = 0;
    this.divergentCount = 0;
    this.humanEscalationCount = 0;
    this.confidenceSum = 0;
    this.committeeAuditCount = 0;
    this.logger?.info('Cross-Model Shadow Consensus reset');
  }

  evaluateCommittee(
    verdicts: readonly CommitteeVerdict[],
    durationMs: number,
  ): BayesianCommitteeResult {
    this.committeeAuditCount++;

    // Compute Bayesian-weighted consensus
    const totalWeight = verdicts.reduce((s, v) => s + v.bayesianWeight, 0);
    const passWeight = verdicts
      .filter(v => v.decision === 'pass')
      .reduce((s, v) => s + v.bayesianWeight, 0);

    const bayesianConfidence = totalWeight > 0 ? passWeight / totalWeight : 0;
    const supermajorityReached = bayesianConfidence >= 2 / 3;
    const finalDecision = supermajorityReached ? 'pass' : 'fail';

    // Aggregate risks: majority (>50% of models) vs minority
    const riskCounts = new Map<string, number>();
    for (const v of verdicts) {
      for (const r of v.risks) {
        riskCounts.set(r, (riskCounts.get(r) ?? 0) + 1);
      }
    }

    const threshold = verdicts.length / 2;
    const majorityRisks: string[] = [];
    const minorityRisks: string[] = [];
    for (const [risk, count] of riskCounts) {
      if (count > threshold) majorityRisks.push(risk);
      else minorityRisks.push(risk);
    }

    const requiresHumanReview = !supermajorityReached || majorityRisks.length > 0;

    this.logger?.info('Committee evaluated', {
      models: verdicts.length,
      bayesianConfidence,
      supermajorityReached,
      finalDecision,
      majorityRisks: majorityRisks.length,
    });

    return {
      verdicts,
      finalDecision,
      bayesianConfidence,
      supermajorityReached,
      majorityRisks,
      minorityRisks,
      requiresHumanReview,
      totalDurationMs: durationMs,
      auditedAt: new Date().toISOString(),
    };
  }

  // ── Private Helpers ─────────────────────────────────────────

  private detectLayer(path: string): number {
    if (/\/(index|orchestrator|bootstrap|app)\.ts$/.test(path)) return 0;
    if (/\/DI_TOKENS\.ts$/.test(path) || /\/container\.ts$/.test(path)) return 1;
    if (path.includes('/domain/')) return 2;
    if (path.includes('/core/')) return 3;
    if (path.includes('/application/')) return 4;
    if (path.includes('/infrastructure/')) return 6;
    if (path.includes('/tests/') || path.includes('test.ts')) return 8;
    return 9;
  }

  private buildSummary(
    consensus: ConsensusOutcome,
    primary: AuditorIdentity,
    secondary: AuditorIdentity,
    shared: readonly string[],
    primaryOnly: readonly string[],
    secondaryOnly: readonly string[],
  ): string {
    const parts = [`Multi-model consensus: ${consensus.toUpperCase()}`];
    parts.push(`Primary: ${primary.provider}/${primary.modelId} | Secondary: ${secondary.provider}/${secondary.modelId}`);
    if (shared.length > 0) parts.push(`Shared risks (${shared.length}): ${shared.join('; ')}`);
    if (primaryOnly.length > 0) parts.push(`Primary-only risks: ${primaryOnly.join('; ')}`);
    if (secondaryOnly.length > 0) parts.push(`Secondary-only risks: ${secondaryOnly.join('; ')}`);
    if (consensus === 'divergent') parts.push('⚠ DIVERGENT — human review required');
    return parts.join('. ');
  }
}
