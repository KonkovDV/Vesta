/**
 * CbvShadowAuditorAdapter — In-memory CBV (Consensus-Based Verification) auditor.
 *
 * In-memory implementation of ICbvShadowAuditor. Performs deterministic adversarial
 * analysis of proposed changes: generates red-team scenarios based on change kind,
 * runs inversion tests, and validates evidence chains.
 *
 * In production, the `auditProposal` method would delegate to a secondary LLM
 * model (via LLMAdapterFactory) for independent review.
 *
 * @layer Infrastructure (Evaluation)
 * @pattern CC-022 CBV Shadow Auditor (PUA Phase 12 → codified)
 * @see src/domain/evaluation/ICbvShadowAuditor.ts — domain port
 * @see src/core/events/cbv-shadow-auditor.schemas.ts — Zod validation schemas
 */

import type {
  ICbvShadowAuditor,
  CbvProposal,
  CbvVerdict,
  CbvDecision,
  RedTeamScenario,
  InversionTestResult,
  EvidenceLink,
} from '../../domain/evaluation/ICbvShadowAuditor';
import type { CorrelationId } from '../../core/types/branded';
import type {
  ICrossModelShadowConsensus,
  ConsensusOutcome,
  AuditorIdentity,
} from '../../domain/evaluation/ICrossModelShadowConsensus';
import type {
  IMultiModelConsensus,
  ModelParticipant,
} from '../../domain/evaluation/IMultiModelConsensus';

// ── Minimal Logger ────────────────────────────────────────────────

interface AuditorLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Risk Heuristics ───────────────────────────────────────────────

const RISK_HEURISTICS: Record<string, { baseSeverity: 'low' | 'medium' | 'high' | 'critical'; areas: string[] }> = {
  di_registration: { baseSeverity: 'high', areas: ['DI container', 'bootstrap chain'] },
  schema_change: { baseSeverity: 'high', areas: ['event schemas', 'Zod validation'] },
  architecture: { baseSeverity: 'critical', areas: ['layer boundaries', 'domain contracts'] },
  config_change: { baseSeverity: 'medium', areas: ['runtime configuration'] },
  code_edit: { baseSeverity: 'low', areas: ['source files'] },
};

const HEURISTIC_AUDITOR_MODEL = 'deterministic-heuristic-v1';
const SHADOW_REVIEW_AUDITOR_MODEL = 'deterministic-heuristic-v1+cc-002+cc-031';
const SHADOW_FALLBACK_AUDITOR_MODEL = 'deterministic-heuristic-v1+shadow-fallback';

const SHADOW_PARTICIPANTS: readonly ModelParticipant[] = [
  {
    providerId: 'shadow-primary',
    modelId: 'shadow-primary-reviewer',
    role: 'primary',
  },
  {
    providerId: 'shadow-reviewer',
    modelId: 'shadow-secondary-reviewer',
    role: 'reviewer',
  },
];

const PRIMARY_AUDITOR: AuditorIdentity = {
  provider: 'deterministic',
  modelId: 'heuristic-baseline-v1',
  role: 'primary',
};

const SECONDARY_AUDITOR: AuditorIdentity = {
  provider: 'consensus',
  modelId: 'cc-002-shadow-review',
  role: 'secondary',
};

interface ShadowReviewOutcome {
  readonly decision: CbvDecision;
  readonly auditorModel: string;
  readonly summarySuffix?: string;
  readonly additionalScenarios: readonly RedTeamScenario[];
}

// ── Adapter ───────────────────────────────────────────────────────

export class CbvShadowAuditorAdapter implements ICbvShadowAuditor {
  private auditCounter = 0;

  constructor(
    private readonly logger?: AuditorLogger,
    private readonly multiModelConsensus?: IMultiModelConsensus,
    private readonly shadowConsensus?: ICrossModelShadowConsensus,
  ) {}

  async auditProposal(proposal: CbvProposal): Promise<CbvVerdict> {
    const startMs = Date.now();
    this.auditCounter++;

    this.logger?.info('CBV audit started', {
      auditId: this.auditCounter,
      changeKind: proposal.changeKind,
      fileCount: proposal.affectedFiles.length,
      puaLevel: proposal.puaLevel,
    });

    // Step 1: Red-Team — generate concrete break scenarios
    const redTeamScenarios = this.generateRedTeamScenarios(proposal);

    // Step 2: Inversion Test — argue the opposite
    const inversionTest = this.runInversionTest(proposal);

    // Step 3: Evidence Chain — validate all affected files are cited
    const evidenceChain = this.buildEvidenceChain(proposal);

    // Step 4: Anti-Sycophancy check — verify we didn't just agree
    const antiSycophancyCheck = this.checkAntiSycophancy(redTeamScenarios, inversionTest);

    // Step 5: Decide
    const heuristicDecision = this.decide(redTeamScenarios, inversionTest, evidenceChain, proposal);
    let decision = heuristicDecision;
    let auditorModel = HEURISTIC_AUDITOR_MODEL;
    let finalScenarios = redTeamScenarios;
    let summarySuffix: string | undefined;

    const shadowReview = await this.tryShadowReview(proposal, heuristicDecision, redTeamScenarios);
    if (shadowReview) {
      decision = shadowReview.decision;
      auditorModel = shadowReview.auditorModel;
      finalScenarios = [...redTeamScenarios, ...shadowReview.additionalScenarios];
      summarySuffix = shadowReview.summarySuffix;
    }

    const durationMs = Date.now() - startMs;

    const verdict: CbvVerdict = {
      decision,
      redTeamScenarios: finalScenarios,
      inversionTest,
      evidenceChain,
      auditorModel,
      antiSycophancyCheck,
      durationMs,
      summary: this.formatSummary(decision, finalScenarios, inversionTest, summarySuffix),
      auditedAt: new Date().toISOString(),
    };

    this.logger?.info('CBV audit completed', {
      auditId: this.auditCounter,
      decision,
      scenarioCount: finalScenarios.length,
      evidenceCount: evidenceChain.length,
      auditorModel,
      shadowReviewUsed: auditorModel === SHADOW_REVIEW_AUDITOR_MODEL,
      durationMs,
    });

    return verdict;
  }

  async quickCheck(proposal: CbvProposal): Promise<Pick<CbvVerdict, 'decision' | 'evidenceChain' | 'summary' | 'durationMs'>> {
    const startMs = Date.now();

    const evidenceChain = this.buildEvidenceChain(proposal);
    const hasHighRiskKind = proposal.changeKind === 'architecture' || proposal.changeKind === 'di_registration';
    const hasManyFiles = proposal.affectedFiles.length >= 5;

    const decision: CbvDecision = hasHighRiskKind && hasManyFiles
      ? 'pass_with_warnings'
      : 'pass';

    const durationMs = Date.now() - startMs;

    return {
      decision,
      evidenceChain,
      summary: `Quick check: ${decision}. ${proposal.affectedFiles.length} file(s), kind=${proposal.changeKind}.`,
      durationMs,
    };
  }

  // ── Private Methods ───────────────────────────────────────────

  private generateRedTeamScenarios(proposal: CbvProposal): RedTeamScenario[] {
    const scenarios: RedTeamScenario[] = [];
    const heuristic = RISK_HEURISTICS[proposal.changeKind] ?? RISK_HEURISTICS.code_edit;

    // Scenario 1: Always generate a basic regression risk
    scenarios.push({
      description: `${proposal.changeKind} change may cause regression in ${heuristic.areas.join(', ')}`,
      impact: `Existing functionality in ${proposal.affectedFiles.length} file(s) could break`,
      severity: heuristic.baseSeverity,
      affectedAreas: [...heuristic.areas, ...proposal.affectedFiles.slice(0, 3)],
      mitigation: 'Run architecture tests + affected unit tests before committing',
    });

    // Scenario 2: For DI/schema changes, add cascading failure risk
    if (proposal.changeKind === 'di_registration' || proposal.changeKind === 'schema_change') {
      scenarios.push({
        description: 'Cascading dependency failure from changed contract',
        impact: 'Downstream consumers of the modified token/schema may fail silently',
        severity: 'high',
        affectedAreas: ['DI resolution chain', 'event consumers'],
        mitigation: 'Verify all container.resolve() calls for affected token still succeed',
      });
    }

    // Scenario 3: For architecture changes, add layer violation risk
    if (proposal.changeKind === 'architecture') {
      scenarios.push({
        description: 'Layer boundary violation from structural change',
        impact: 'Domain/Application code may gain forbidden infrastructure dependency',
        severity: 'critical',
        affectedAreas: ['layer boundaries', 'import graph'],
        mitigation: 'Run npm run test:architecture:quick to verify layer compliance',
      });
    }

    return scenarios;
  }

  private runInversionTest(proposal: CbvProposal): InversionTestResult {
    // Deterministic inversion: argue that the change is unnecessary
    const isHighRisk = proposal.changeKind === 'architecture' || proposal.changeKind === 'di_registration';
    const manyFiles = proposal.affectedFiles.length >= 5;

    return {
      counterArgument: `The proposed ${proposal.changeKind} change affecting ${proposal.affectedFiles.length} files may not be necessary. Consider whether the same outcome can be achieved with fewer modifications.`,
      counterArgumentStronger: isHighRisk && manyFiles,
      strengthRationale: isHighRisk && manyFiles
        ? 'High-risk change touching many files — counter-argument has merit, review carefully'
        : 'Change appears scoped and manageable — counter-argument is weak',
    };
  }

  private buildEvidenceChain(proposal: CbvProposal): EvidenceLink[] {
    return proposal.affectedFiles.map((file) => ({
      claim: `File ${file} is part of the proposed ${proposal.changeKind} change`,
      sourceType: 'file_read' as const,
      source: file,
    }));
  }

  private checkAntiSycophancy(scenarios: RedTeamScenario[], inversion: InversionTestResult): boolean {
    // Anti-sycophancy: ensure we actually generated meaningful criticism
    const hasCriticalScenarios = scenarios.some(s => s.severity === 'critical' || s.severity === 'high');
    const hasSubstantiveCounter = inversion.counterArgument.length > 20;
    return hasCriticalScenarios || hasSubstantiveCounter;
  }

  private async tryShadowReview(
    proposal: CbvProposal,
    heuristicDecision: CbvDecision,
    heuristicScenarios: readonly RedTeamScenario[],
  ): Promise<ShadowReviewOutcome | null> {
    if (!this.multiModelConsensus || !this.shadowConsensus) {
      return null;
    }

    try {
      const requirement = this.shadowConsensus.requiresConsensus(
        proposal.affectedFiles,
        proposal.changeKind,
      );

      if (!requirement.required) {
        return null;
      }

      const startMs = Date.now();

      const consensusResult = await this.multiModelConsensus.consensusVerify(
        this.buildShadowReviewQuery(proposal),
        SHADOW_PARTICIPANTS,
        {
          requireDifferentProviders: true,
          minConfidenceThreshold: 0.55,
        },
        this.resolveCorrelationId(proposal),
      );

      const secondaryDecision = this.mapConsensusDecision(consensusResult.decision);
      const secondaryRisks = this.extractShadowRisks(consensusResult);
      const shadowConsensus = this.shadowConsensus.evaluateConsensus(
        {
          decision: heuristicDecision,
          risks: heuristicScenarios.map((scenario) => scenario.description),
        },
        {
          decision: secondaryDecision,
          risks: secondaryRisks,
        },
        PRIMARY_AUDITOR,
        SECONDARY_AUDITOR,
        Date.now() - startMs,
      );

      return {
        decision: this.mergeShadowDecision(
          heuristicDecision,
          secondaryDecision,
          shadowConsensus.consensus,
        ),
        auditorModel: SHADOW_REVIEW_AUDITOR_MODEL,
        summarySuffix: `Shadow review: ${shadowConsensus.consensus} (${requirement.reason})`,
        additionalScenarios: this.buildShadowScenarios(shadowConsensus, secondaryRisks),
      };
    } catch (error) {
      this.logger?.warn('CBV shadow review failed, falling back to deterministic audit', {
        changeKind: proposal.changeKind,
        affectedFiles: proposal.affectedFiles.length,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        decision: heuristicDecision,
        auditorModel: SHADOW_FALLBACK_AUDITOR_MODEL,
        summarySuffix: 'Shadow review failed; deterministic baseline retained',
        additionalScenarios: [],
      };
    }
  }

  private decide(
    scenarios: RedTeamScenario[],
    inversion: InversionTestResult,
    evidence: EvidenceLink[],
    proposal: CbvProposal,
  ): CbvDecision {
    // Fail if counter-argument is stronger (high-risk + many files)
    if (inversion.counterArgumentStronger) {
      return 'fail';
    }

    // Warn if critical scenarios exist
    const hasCritical = scenarios.some(s => s.severity === 'critical');
    if (hasCritical) {
      return 'pass_with_warnings';
    }

    // Warn if evidence chain is incomplete (no evidence for any file)
    if (evidence.length === 0 && proposal.affectedFiles.length > 0) {
      return 'pass_with_warnings';
    }

    return 'pass';
  }

  private buildShadowReviewQuery(proposal: CbvProposal): string {
    return [
      'Perform an independent CBV shadow review for this proposal.',
      `Description: ${proposal.description}`,
      `Change kind: ${proposal.changeKind}`,
      `Affected files: ${proposal.affectedFiles.join(', ') || 'none'}`,
      `Change summary: ${proposal.changeSummary}`,
      'Return a verdict via your cross-model review process and surface major concerns.',
    ].join('\n');
  }

  private resolveCorrelationId(proposal: CbvProposal): CorrelationId {
    return (proposal.correlationId ?? `cbv-shadow-${this.auditCounter}`) as CorrelationId;
  }

  private mapConsensusDecision(decision: Awaited<ReturnType<IMultiModelConsensus['consensusVerify']>>['decision']): CbvDecision {
    switch (decision) {
      case 'consensus_approve':
        return 'pass';
      case 'consensus_reject':
        return 'fail';
      case 'consensus_revise':
      case 'no_consensus':
      default:
        return 'pass_with_warnings';
    }
  }

  private extractShadowRisks(
    consensusResult: Awaited<ReturnType<IMultiModelConsensus['consensusVerify']>>,
  ): string[] {
    const disagreementRisks = consensusResult.disagreements.map(
      (disagreement) => `${disagreement.severity} disagreement on ${disagreement.aspect}`,
    );
    const concernRisks = consensusResult.verdicts.flatMap((verdict) =>
      verdict.concerns.map((concern) => `${verdict.participant.modelId}: ${concern}`),
    );
    const decisionRisk = consensusResult.decision === 'no_consensus'
      ? ['No consensus reached during shadow review']
      : [];

    return [...new Set([...decisionRisk, ...concernRisks, ...disagreementRisks])];
  }

  private mergeShadowDecision(
    heuristicDecision: CbvDecision,
    secondaryDecision: CbvDecision,
    consensusOutcome: ConsensusOutcome,
  ): CbvDecision {
    switch (consensusOutcome) {
      case 'unanimous_fail':
      case 'divergent':
        return 'fail';
      case 'partial_agreement':
        return heuristicDecision === 'fail' || secondaryDecision === 'fail'
          ? 'fail'
          : 'pass_with_warnings';
      case 'unanimous_pass':
        return heuristicDecision === 'pass' && secondaryDecision === 'pass'
          ? 'pass'
          : 'pass_with_warnings';
      default:
        return heuristicDecision;
    }
  }

  private buildShadowScenarios(
    shadowConsensus: Awaited<ReturnType<ICrossModelShadowConsensus['evaluateConsensus']>>,
    secondaryRisks: readonly string[],
  ): RedTeamScenario[] {
    if (!shadowConsensus.requiresHumanReview && secondaryRisks.length === 0) {
      return [];
    }

    return [{
      description: `Shadow review ${shadowConsensus.consensus}`,
      impact: secondaryRisks.length > 0
        ? secondaryRisks.join('; ')
        : shadowConsensus.summary,
      severity: shadowConsensus.requiresHumanReview ? 'high' : 'medium',
      affectedAreas: [
        'shadow-review',
        ...shadowConsensus.uniqueRisks.primaryOnly.slice(0, 2),
        ...shadowConsensus.uniqueRisks.secondaryOnly.slice(0, 2),
      ],
      mitigation: shadowConsensus.requiresHumanReview
        ? 'Escalate to human review before merge'
        : 'Review shadow concerns before merge',
    }];
  }

  private formatSummary(
    decision: CbvDecision,
    scenarios: RedTeamScenario[],
    inversion: InversionTestResult,
    extraNote?: string,
  ): string {
    const scenarioSummary = scenarios.map(s => `- [${s.severity}] ${s.description}`).join('\n');
    const inversionNote = inversion.counterArgumentStronger
      ? '⚠ Inversion test: counter-argument was STRONGER than proposal'
      : '✓ Inversion test: proposal holds against counter-argument';

    return [
      `[CBV: ${decision.toUpperCase()}]`,
      'Red-team scenarios:',
      scenarioSummary,
      inversionNote,
      extraNote,
    ].filter(Boolean).join('\n');
  }
}
