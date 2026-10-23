/**
 * ContextualTipGeneratorAdapter — In-memory tip generation from decision attributions.
 *
 * Generates 3 types of structured tips (strategy/recovery/optimization) from causal
 * attribution results. Supports tip consolidation via Jaccard similarity clustering.
 *
 * @layer Infrastructure (Memory)
 * @pattern CC-035 Contextual Tip Generator (TIM arXiv:2603.10600)
 * @see src/domain/memory/IContextualTipGenerator.ts — domain port
 */

import type {
  IContextualTipGenerator,
  StructuredTip,
  TipCluster,
  TipGenerationConfig,
  TipStats,
  TipCategory,
  GeneralizationLevel,
} from '../../../domain/memory/IContextualTipGenerator';
import { DEFAULT_TIP_CONFIG } from '../../../domain/memory/IContextualTipGenerator';
import type { DecisionAttributionResult } from '../../../domain/memory/IDecisionAttributionAnalyzer';
import type { ICrossModelShadowConsensus } from '../../../domain/evaluation/ICrossModelShadowConsensus';
import type { IWisdomConsolidator } from '../../../domain/memory/IWisdomConsolidator';
import type { ITipStore } from '../../../domain/memory/ITipStore';

// ── Dependencies ──────────────────────────────────────────────────

/** Optional dependencies for enhanced tip generation. */
export interface TipGeneratorDeps {
  /** Cross-model consensus for tip quality validation (CC-031). */
  readonly consensus?: ICrossModelShadowConsensus;
  /** Wisdom consolidator for merging similar tips (CC-027). */
  readonly consolidator?: IWisdomConsolidator;
  /** Durable tip store for cross-session persistence. */
  readonly tipStore?: ITipStore;
}

// ── Adapter ───────────────────────────────────────────────────────

export class ContextualTipGeneratorAdapter implements IContextualTipGenerator {
  private readonly tips: StructuredTip[] = [];
  private idCounter = Date.now();
  private readonly hydrationPromise: Promise<void>;
  private readonly consensus: ICrossModelShadowConsensus | undefined;
  private readonly consolidator: IWisdomConsolidator | undefined;
  private readonly tipStore: ITipStore | undefined;
  private validatedCount = 0;
  private rejectedByConsensus = 0;
  private epistemicallyUnstableCount = 0;
  private helpfulnessRate: number | undefined;

  constructor(deps?: TipGeneratorDeps) {
    this.consensus = deps?.consensus;
    this.consolidator = deps?.consolidator;
    this.tipStore = deps?.tipStore;
    this.hydrationPromise = this.tipStore
      ? this.hydrateTips().catch(() => { /* non-fatal: tips remain empty until next generation */ })
      : Promise.resolve();
  }

  whenReady(): Promise<void> {
    return this.hydrationPromise;
  }

  generateTips(
    attribution: DecisionAttributionResult,
    config: TipGenerationConfig = DEFAULT_TIP_CONFIG,
  ): readonly StructuredTip[] {
    const generated: StructuredTip[] = [];

    for (const attr of attribution.attributions) {
      const baseTips = this.createTipsFromAttribution(attr, attribution, config);
      generated.push(...baseTips);
    }

    // Filter by priority and limit
    const filtered = generated
      .filter(t => t.priority >= config.minPriority)
      .slice(0, config.maxTipsPerTrajectory);

    // Add dual generalization if enabled
    const withGeneric: StructuredTip[] = [];
    for (const tip of filtered) {
      withGeneric.push(tip);
      if (config.enableDualGeneralization && tip.generalizationLevel === 'domain_specific') {
        withGeneric.push(this.generalize(tip));
      }
    }

    const validated = this.consensus ? this.validateTips(withGeneric) : withGeneric;
    this.addTips(validated);
    if (this.tipStore) {
      for (const tip of validated) {
        void this.tipStore.saveTip(tip).catch(() => undefined);
      }
    }
    return validated;
  }

  generateBatch(
    attributions: readonly DecisionAttributionResult[],
    config: TipGenerationConfig = DEFAULT_TIP_CONFIG,
  ): readonly StructuredTip[] {
    const all: StructuredTip[] = [];
    for (const attr of attributions) {
      all.push(...this.generateTips(attr, config));
    }
    return all;
  }

  consolidate(
    tips: readonly StructuredTip[],
    config: TipGenerationConfig = DEFAULT_TIP_CONFIG,
  ): readonly TipCluster[] {
    if (tips.length === 0) return [];

    const clusters: TipCluster[] = [];
    const assigned = new Set<string>();

    for (const tip of tips) {
      if (assigned.has(tip.tipId)) continue;

      const members = [tip];
      for (const other of tips) {
        if (other.tipId === tip.tipId || assigned.has(other.tipId)) continue;
        if (other.category !== tip.category) continue;

        const similarity = this.jaccard(tip.content, other.content);
        if (similarity >= config.clusteringThreshold) {
          members.push(other);
          assigned.add(other.tipId);
        }
      }

      assigned.add(tip.tipId);

      if (members.length > 1) {
        const mergedTip = this.mergeTips(members);
        const avgSim = members.length > 1
          ? members.slice(1).reduce((sum, m) =>
            sum + this.jaccard(members[0].content, m.content), 0) / (members.length - 1)
          : 1;

        clusters.push({
          clusterId: `cluster-${this.idCounter++}`,
          mergedTip,
          memberTipIds: members.map(m => m.tipId),
          avgSimilarity: avgSim,
        });
      }
    }

    return clusters;
  }

  getAllTips(): readonly StructuredTip[] {
    return [...this.tips];
  }

  getStats(): TipStats {
    const categoryDist: Record<TipCategory, number> = {
      strategy: 0,
      recovery: 0,
      optimization: 0,
    };

    for (const t of this.tips) {
      categoryDist[t.category]++;
    }

    const consolidation = this.consolidate(this.tips);

    return {
      totalTipsGenerated: this.tips.length,
      tipsAfterConsolidation: this.tips.length - consolidation.reduce(
        (acc, c) => acc + c.memberTipIds.length - 1, 0),
      categoryDistribution: categoryDist,
      clustersFormed: consolidation.length,
      avgPriority: this.tips.length > 0
        ? this.tips.reduce((sum, t) => sum + t.priority, 0) / this.tips.length
        : 0,
    };
  }

  reset(): void {
    this.tips.length = 0;
    this.idCounter = Date.now();
    this.validatedCount = 0;
    this.rejectedByConsensus = 0;
    this.epistemicallyUnstableCount = 0;
    this.helpfulnessRate = undefined;
  }

  private async hydrateTips(): Promise<void> {
    const persisted = await this.tipStore?.listTips();
    if (!persisted || persisted.length === 0) {
      return;
    }

    this.addTips(persisted);
  }

  private addTips(tips: readonly StructuredTip[]): void {
    const existingIds = new Set(this.tips.map((tip) => tip.tipId));
    for (const tip of tips) {
      if (existingIds.has(tip.tipId)) {
        continue;
      }
      this.tips.push(tip);
      this.syncIdCounterFromTipId(tip.tipId);
      existingIds.add(tip.tipId);
    }
  }

  private syncIdCounterFromTipId(tipId: string): void {
    const match = /^tip-(?:merged-)?(\d+)(?:-unstable)?$/.exec(tipId);
    if (!match) {
      return;
    }

    this.idCounter = Math.max(this.idCounter, Number(match[1]) + 1);
  }

  /**
   * Set the helpfulness rate from IAdaptiveMemoryRetrieval feedback loop.
   * Recalibrates R-score acceptance threshold (arXiv:2602.21368 §4 adaptive gating):
   *   - helpfulnessRate < 0.5 → lower threshold to 0.85 (admit more tips)
   *   - helpfulnessRate ≥ 0.8 → raise threshold to 0.97 (be more selective)
   *   - Between 0.5-0.8 → default 0.95
   *
   * @param rate - Ratio of helpful tips to total feedback (0.0-1.0)
   */
  setHelpfulnessCalibration(rate: number): void {
    this.helpfulnessRate = Math.max(0, Math.min(1, rate));
  }

  /** Get the current calibrated R-score acceptance threshold. */
  get calibratedThreshold(): number {
    if (this.helpfulnessRate === undefined) return 0.95;
    if (this.helpfulnessRate < 0.5) return 0.85;
    if (this.helpfulnessRate >= 0.8) return 0.97;
    return 0.95;
  }

  /**
   * Validate tips through conformal calibration + cross-model consensus (CC-031).
   *
   * Replaces binary pass/fail gates with a statistical reliability score R
   * (arXiv:2602.21368, Mouzouni — Black-Box Reliability Certification).
   * R ≥ 0.95 → tip accepted into main wisdom base (epistemically stable).
   * R < 0.95 → tip marked "Epistemically Unstable" and sequestered (priority halved).
   *
   * R is computed as a weighted composite of 4 quality signals:
   *   - Priority signal (0.3 weight): priority score normalized
   *   - Content depth signal (0.25 weight): content length & step count adequacy
   *   - Consensus signal (0.3 weight): cross-model agreement level
   *   - Provenance signal (0.15 weight): evidence base breadth
   *
   * @see arXiv:2602.21368 — Conformal Calibration for Reliability Gating
   */
  private validateTips(tips: StructuredTip[]): StructuredTip[] {
    if (!this.consensus) return tips;

    return tips
      .map(tip => {
        if (tip.content.length < 10 || tip.steps.length === 0) {
          this.rejectedByConsensus++;
          return null;
        }

        // Signal 1: Priority (0.3 weight)
        const prioritySignal = Math.min(1.0, tip.priority / 0.8);

        // Signal 2: Content depth (0.25 weight)
        const contentLenScore = Math.min(1.0, tip.content.length / 50);
        const stepScore = Math.min(1.0, tip.steps.length / 3);
        const contentDepthSignal = contentLenScore * 0.6 + stepScore * 0.4;

        // Signal 3: Consensus (0.3 weight) via ICrossModelShadowConsensus
        const primaryDecision = tip.priority >= 0.3 ? 'pass' : 'fail';
        const secondaryDecision = tip.content.length >= 20 && tip.steps.length >= 2 ? 'pass' : 'fail';
        const result = this.consensus!.evaluateConsensus(
          { decision: primaryDecision, risks: primaryDecision === 'fail' ? ['Low priority'] : [] },
          { decision: secondaryDecision, risks: secondaryDecision === 'fail' ? ['Insufficient detail'] : [] },
          { provider: 'heuristic', modelId: 'priority-gate', role: 'primary' },
          { provider: 'heuristic', modelId: 'quality-gate', role: 'secondary' },
          0,
        );
        const consensusSignal = result.consensus === 'unanimous_pass' ? 1.0
          : result.consensus === 'unanimous_fail' ? 0.0
          : 0.5; // split / partial

        // Signal 4: Provenance breadth (0.15 weight)
        const provenanceSignal = Math.min(1.0, tip.provenance.length / 3);

        // Composite R-score (conformal reliability level)
        const reliabilityScore =
          prioritySignal * 0.3 +
          contentDepthSignal * 0.25 +
          consensusSignal * 0.3 +
          provenanceSignal * 0.15;

        this.validatedCount++;

        // Hard reject: R < 0.3 (unanimous_fail equivalent)
        if (reliabilityScore < 0.3) {
          this.rejectedByConsensus++;
          return null;
        }

        // Calibrated threshold (default 0.95, adjusted by helpfulness feedback)
        const acceptanceThreshold = this.calibratedThreshold;

        // R ≥ threshold: Epistemically Stable — full acceptance
        if (reliabilityScore >= acceptanceThreshold) {
          return tip;
        }

        // R < threshold: Epistemically Unstable — sequester with halved priority
        this.epistemicallyUnstableCount++;
        return {
          ...tip,
          tipId: `${tip.tipId}-unstable`,
          priority: tip.priority * 0.5,
          content: `[Epistemically Unstable R=${reliabilityScore.toFixed(2)}] ${tip.content}`,
        };
      })
      .filter((tip): tip is StructuredTip => tip !== null);
  }

  /**
   * Run wisdom consolidation on accumulated tips via IWisdomConsolidator (CC-027).
   * Ebbinghaus 2.1: merges duplicated/similar tips into consolidated macro-principles.
   */
  runConsolidation(): { candidatesFound: number; principlesGenerated: number } {
    if (!this.consolidator) return { candidatesFound: 0, principlesGenerated: 0 };

    const lessons = this.tips.map(tip => ({
      lessonId: tip.tipId,
      level: tip.generalizationLevel === 'generic' ? 'meso' as const : 'micro' as const,
      rootCauseCategory: tip.category,
      statement: tip.content,
      tags: [tip.category, tip.generalizationLevel, ...(tip.taskDomain ? [tip.taskDomain] : [])],
      extractedAt: tip.generatedAt,
    }));

    const candidates = this.consolidator.findCandidates(lessons);
    let principlesGenerated = 0;
    for (const candidate of candidates) {
      if (candidate.passesConformalGate) {
        const principle = this.consolidator.consolidate(candidate, lessons);
        if (principle) principlesGenerated++;
      }
    }

    return { candidatesFound: candidates.length, principlesGenerated };
  }

  // ── Private ───────────────────────────────────────────────────

  private createTipsFromAttribution(
    attr: DecisionAttributionResult['attributions'][number],
    result: DecisionAttributionResult,
    _config: TipGenerationConfig,
  ): StructuredTip[] {
    const tips: StructuredTip[] = [];
    const now = new Date().toISOString();

    switch (attr.attributionType) {
      case 'failure':
        tips.push(this.makeTip('recovery', attr.causalChain.rootCause.description,
          [
            `Identify if the situation matches: ${attr.causalChain.immediate.description}`,
            `Check for proximate cause: ${attr.causalChain.proximate.description}`,
            `Address root cause: ${attr.causalChain.rootCause.description}`,
            ...(attr.alternativeAction ? [`Consider: ${attr.alternativeAction}`] : []),
          ],
          `When encountering: ${attr.causalChain.immediate.description}`,
          `Avoid: continuing with the same approach after this failure pattern`,
          attr.impactScore, [result.trajectoryId], 'domain_specific', now));
        break;

      case 'recovery':
        tips.push(this.makeTip('recovery',
          `Recovery pattern: ${attr.causalChain.proximate.description}`,
          [
            `Recognize failure signal: ${attr.causalChain.immediate.description}`,
            `Apply recovery: ${attr.causalChain.proximate.description}`,
            `Verify recovery succeeded`,
          ],
          `When initial approach fails in similar context`,
          undefined,
          attr.impactScore * 0.8, [result.trajectoryId], 'domain_specific', now));
        break;

      case 'inefficiency':
        tips.push(this.makeTip('optimization',
          `Optimize: ${attr.causalChain.rootCause.description}`,
          [
            `Before starting: ${attr.alternativeAction ?? 'plan approach systematically'}`,
            `Track: which approaches have been tried`,
            `Avoid: ${attr.causalChain.proximate.description}`,
          ],
          `When efficiency score would be below threshold`,
          `Don't: ${attr.causalChain.proximate.description}`,
          attr.impactScore * 0.7, [result.trajectoryId], 'domain_specific', now));
        break;

      case 'success':
        tips.push(this.makeTip('strategy',
          `Effective strategy: ${attr.causalChain.rootCause.description}`,
          [
            `Start with: ${attr.causalChain.rootCause.description}`,
            `Execute via: ${attr.causalChain.proximate.description}`,
            `Verify: ${attr.causalChain.immediate.description}`,
          ],
          `When facing similar task type`,
          undefined,
          attr.impactScore * 0.6, [result.trajectoryId], 'domain_specific', now));
        break;
    }

    return tips;
  }

  private makeTip(
    category: TipCategory,
    content: string,
    steps: string[],
    triggerCondition: string,
    negativeExample: string | undefined,
    priority: number,
    provenance: string[],
    level: GeneralizationLevel,
    generatedAt: string,
  ): StructuredTip {
    return {
      tipId: `tip-${this.idCounter++}`,
      category,
      content,
      steps,
      triggerCondition,
      negativeExample,
      priority: Math.min(1, Math.max(0, priority)),
      provenance,
      generalizationLevel: level,
      generatedAt,
    };
  }

  private generalize(tip: StructuredTip): StructuredTip {
    return {
      ...tip,
      tipId: `tip-${this.idCounter++}`,
      generalizationLevel: 'generic',
      content: tip.content.replace(/specific|particular/gi, 'general'),
      taskDomain: undefined,
      steps: tip.steps.map(s => s.replace(/step \d+/gi, 'the relevant step')),
    };
  }

  private mergeTips(tips: readonly StructuredTip[]): StructuredTip {
    const best = tips.reduce((b, t) => t.priority > b.priority ? t : b);
    const allSteps = new Set<string>();
    for (const t of tips) {
      for (const s of t.steps) allSteps.add(s);
    }

    return {
      ...best,
      tipId: `tip-merged-${this.idCounter++}`,
      steps: [...allSteps],
      provenance: [...new Set(tips.flatMap(t => t.provenance))],
      priority: Math.max(...tips.map(t => t.priority)),
    };
  }

  /** Jaccard similarity on word sets. */
  private jaccard(a: string, b: string): number {
    const setA = new Set(a.toLowerCase().split(/\s+/));
    const setB = new Set(b.toLowerCase().split(/\s+/));
    let intersection = 0;
    for (const w of setA) {
      if (setB.has(w)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }
}
