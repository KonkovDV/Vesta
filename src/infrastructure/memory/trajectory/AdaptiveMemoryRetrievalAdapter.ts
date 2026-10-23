/**
 * AdaptiveMemoryRetrievalAdapter — In-memory context-aware tip retrieval.
 *
 * Retrieves relevant tips for a given task description using keyword-based similarity
 * (Jaccard on word sets). Supports category filtering, domain filtering, priority
 * weighting, and top-k selection. Formats matched tips as "guidelines" for prompt injection.
 *
 * 4-Tier Ebbinghaus Memory Architecture:
 *   Tier 1 (Episodic): Raw tips <24h, volatile, full retrieval
 *   Tier 2 (Semantic): Validated tips with R≥0.95, medium-term retention (30 days)
 *   Tier 3 (Procedural): Cross-domain consolidated tips, long-term (90 days)
 *   Tier 4 (Meta-cognitive): Permanent strategic invariants, never decay
 *
 * Decay Function (Ebbinghaus-inspired):
 *   Tips in Tier 1/2 that are never retrieved or marked unhelpful decay over time.
 *   Decay factor = e^(-t/halfLife) where t = hours since generation.
 *   Half-lives: Tier 1 = 24h, Tier 2 = 720h (30d), Tier 3 = 2160h (90d), Tier 4 = ∞
 *
 * @layer Infrastructure (Memory)
 * @pattern CC-036 Adaptive Memory Retrieval (TIM arXiv:2603.10600 §3.3)
 * @see src/domain/memory/IAdaptiveMemoryRetrieval.ts — domain port
 * @see arXiv:2603.10600 § 3.3 — Runtime Retrieval
 */

import type {
  IAdaptiveMemoryRetrieval,
  InjectedTipSourceKind,
  ScoredTip,
  TipRetrievalResult,
  TipInjectionResult,
  TipRetrievalConfig,
  RetrievalStats,
} from '../../../domain/memory/IAdaptiveMemoryRetrieval';
import { DEFAULT_RETRIEVAL_CONFIG } from '../../../domain/memory/IAdaptiveMemoryRetrieval';
import type { StructuredTip, TipCategory } from '../../../domain/memory/IContextualTipGenerator';
import type { IDynamicCognitiveBudget } from '../../../domain/agents/IDynamicCognitiveBudget';
import type { ILessonStore } from '../../../domain/memory/ILessonStore';
import type { ITipStore, TipFeedbackState } from '../../../domain/memory/ITipStore';
import type { ConsolidatedPrinciple } from '../../../domain/memory/IWisdomConsolidator';

// ── Dependencies ──────────────────────────────────────────────────

/** Optional dependencies for enhanced retrieval. */
export interface RetrievalDeps {
  /** Dynamic cognitive budget for criticality-aware threshold modulation (CC-028). */
  readonly budget?: IDynamicCognitiveBudget;
  /** Durable tip store for cross-session retrieval fallback. */
  readonly tipStore?: ITipStore;
  /** Durable lesson store for persisted macro-principle projection. */
  readonly lessonStore?: ILessonStore;
  /** Optional logger for startup hydration diagnostics. */
  readonly logger?: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

// ── Priority Labels ───────────────────────────────────────────────

const PRIORITY_LABELS: ReadonlyArray<{ min: number; label: string }> = [
  { min: 0.8, label: 'CRITICAL' },
  { min: 0.6, label: 'HIGH' },
  { min: 0.4, label: 'MEDIUM' },
  { min: 0.0, label: 'LOW' },
];

function priorityLabel(priority: number): string {
  for (const { min, label } of PRIORITY_LABELS) {
    if (priority >= min) return label;
  }
  return 'LOW';
}

// ── 4-Tier Ebbinghaus Memory Model ────────────────────────────

/** Memory tier classification per Ebbinghaus 2.1 decay model. */
export type MemoryTier = 1 | 2 | 3 | 4;

/** Half-lives in hours for each memory tier. */
const TIER_HALF_LIVES: Record<MemoryTier, number> = {
  1: 24,       // Episodic: 24 hours
  2: 720,      // Semantic: 30 days
  3: 2160,     // Procedural: 90 days
  4: Infinity, // Meta-cognitive: permanent
};

/** Tier labels for formatted output. */
const TIER_LABELS: Record<MemoryTier, string> = {
  1: 'Episodic',
  2: 'Semantic',
  3: 'Procedural',
  4: 'Meta-cognitive',
};

const PROJECTED_PRINCIPLE_PREFIX = 'principle:';

// ── Adapter ───────────────────────────────────────────────────────

export class AdaptiveMemoryRetrievalAdapter implements IAdaptiveMemoryRetrieval {
  private totalRetrievals = 0;
  private totalTipsReturned = 0;
  private totalRelevanceSum = 0;
  private readonly categoryHits = new Map<TipCategory, number>();
  private readonly budget: IDynamicCognitiveBudget | undefined;
  private readonly logger: RetrievalDeps['logger'];
  private readonly tipStore: ITipStore | undefined;
  private readonly lessonStore: ILessonStore | undefined;
  private readonly tipFeedback = new Map<string, TipFeedbackState>();
  private readonly archivedTipIds = new Set<string>();
  private readonly persistedTipCache: StructuredTip[] = [];
  private readonly persistedPrincipleCache: StructuredTip[] = [];
  private readonly hydrationPromise: Promise<void>;
  private totalDecayed = 0;

  constructor(deps?: RetrievalDeps) {
    this.budget = deps?.budget;
    this.logger = deps?.logger;
    this.tipStore = deps?.tipStore;
    this.lessonStore = deps?.lessonStore;
    this.hydrationPromise = this.hydratePersistedState();
  }

  whenReady(): Promise<void> {
    return this.hydrationPromise;
  }

  /**
   * Classify a tip into a memory tier based on its properties.
   *
   * Tier 4 (Meta-cognitive): generic tips with priority ≥0.9 (strategic invariants)
   * Tier 3 (Procedural): generic tips crossing domains
   * Tier 2 (Semantic): domain-specific tips with adequate content
   * Tier 1 (Episodic): all other tips (raw, volatile)
   */
  classifyTier(tip: StructuredTip): MemoryTier {
    // Tier 4: high-priority generic tips → permanent strategic invariants
    if (tip.generalizationLevel === 'generic' && tip.priority >= 0.9) return 4;
    // Tier 3: generic cross-domain tips → procedural long-term
    if (tip.generalizationLevel === 'generic') return 3;
    // Tier 2: domain-specific tips with good content → semantic medium-term
    if (tip.content.length >= 20 && tip.steps.length >= 2) return 2;
    // Tier 1: everything else → episodic volatile
    return 1;
  }

  /**
   * Compute Ebbinghaus decay factor for a tip based on its tier and age.
   * decay = e^(-t / halfLife) where t = age in hours.
   *
   * @returns decay factor in [0, 1]; 1 = no decay, 0 = fully decayed
   */
  computeDecay(tip: StructuredTip, now: Date = new Date()): number {
    const tier = this.classifyTier(tip);
    const halfLife = TIER_HALF_LIVES[tier];
    if (halfLife === Infinity) return 1.0; // Tier 4 never decays

    const ageMs = now.getTime() - new Date(tip.generatedAt).getTime();
    const ageHours = Math.max(0, ageMs / (1000 * 60 * 60));
    return Math.exp(-ageHours / halfLife);
  }

  /**
   * Check if a tip should be archived (decayed below threshold).
   * Tips with decay factor < 0.1 are considered expired.
   * Tips marked as unhelpful in feedback decay 3x faster.
   */
  shouldArchive(tip: StructuredTip, now: Date = new Date()): boolean {
    const tier = this.classifyTier(tip);
    if (tier === 4) return false; // Meta-cognitive never archived

    let decay = this.computeDecay(tip, now);

    // Unhelpful feedback accelerates decay (3x)
    const feedback = this.tipFeedback.get(tip.tipId);
    if (feedback?.used && !feedback.helpful) {
      decay = Math.pow(decay, 3);
    }

    return decay < 0.1;
  }

  retrieveRelevantTips(
    taskDescription: string,
    tips: readonly StructuredTip[],
    config: TipRetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
  ): TipRetrievalResult {
    const candidateTips = tips.length > 0
      ? this.mergePrincipleTips(tips)
      : [...this.persistedTipCache, ...this.persistedPrincipleCache];

    // Dynamic budget (CC-028): modulate thresholds based on task criticality
    if (this.budget) {
      const assessment = this.budget.assessCriticality(taskDescription);
      if (assessment.score >= 0.7) {
        config = { ...config, similarityThreshold: Math.max(0.1, config.similarityThreshold - 0.15), topK: config.topK + 3 };
      } else if (assessment.score <= 0.3) {
        config = { ...config, similarityThreshold: Math.min(0.8, config.similarityThreshold + 0.1), topK: Math.max(1, config.topK - 2) };
      }
    }

    const taskWords = this.tokenize(taskDescription);
    const now = new Date();

    // Score each tip (with tier-based decay filtering)
    let scored: ScoredTip[] = [];
    for (const tip of candidateTips) {
      // Skip archived tips
      if (this.archivedTipIds.has(tip.tipId)) continue;

      // Apply Ebbinghaus decay: archive expired tips
      if (this.shouldArchive(tip, now)) {
        this.archivedTipIds.add(tip.tipId);
        this.totalDecayed++;
        continue;
      }
      // Category filter
      if (config.categoryFilter && config.categoryFilter.length > 0) {
        if (!config.categoryFilter.includes(tip.category)) continue;
      }
      // Domain filter
      if (config.domainFilter && tip.taskDomain && tip.taskDomain !== config.domainFilter) {
        continue;
      }

      const contentWords = this.tokenize(`${tip.content} ${tip.triggerCondition}`);
      let relevance = this.jaccard(taskWords, contentWords);

      // Priority weighting: boost high-priority tips
      if (config.priorityWeighting) {
        relevance = relevance * 0.7 + tip.priority * 0.3;
      }

      // Apply Ebbinghaus decay modulation to relevance
      const decayFactor = this.computeDecay(tip, now);
      relevance *= decayFactor;

      if (relevance >= config.similarityThreshold) {
        scored.push({
          tip,
          relevanceScore: Math.round(relevance * 1000) / 1000,
          matchReason: this.buildMatchReason(taskWords, contentWords, tip),
        });
      }
    }

    // Sort by relevance descending, take top-k
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
    scored = scored.slice(0, config.topK);

    // Update stats
    this.totalRetrievals++;
    this.totalTipsReturned += scored.length;
    for (const s of scored) {
      this.totalRelevanceSum += s.relevanceScore;
      this.categoryHits.set(s.tip.category, (this.categoryHits.get(s.tip.category) ?? 0) + 1);
    }

    return {
      taskDescription,
      tips: scored,
      strategyUsed: config.strategy,
      totalTipsSearched: candidateTips.length,
      retrievedAt: new Date().toISOString(),
    };
  }

  formatForInjection(retrievalResult: TipRetrievalResult): TipInjectionResult {
    if (retrievalResult.tips.length === 0) {
      return {
        guidelinesSection: '',
        tipsInjected: 0,
        categoriesRepresented: [],
        tipIds: [],
        injectedTips: [],
      };
    }

    const categories = new Set<TipCategory>();
    const lines: string[] = ['## Guidelines (from past experience)', ''];

    for (const { tip, relevanceScore } of retrievalResult.tips) {
      categories.add(tip.category);
      const label = priorityLabel(tip.priority);
      const sourceKind = this.classifySourceKind(tip);
      const guidanceLabel = sourceKind === 'principle' ? 'Principle' : 'Tip';
      lines.push(`[${label}] ${tip.category.toUpperCase()} ${guidanceLabel}: ${tip.content}`);
      if (tip.steps.length > 0) {
        for (const step of tip.steps) {
          lines.push(`  - ${step}`);
        }
      }
      lines.push(`  Trigger: ${tip.triggerCondition}`);
      if (tip.negativeExample) {
        lines.push(`  Avoid: ${tip.negativeExample}`);
      }
      lines.push(`  (relevance: ${relevanceScore})`);
      lines.push('');
    }

    return {
      guidelinesSection: lines.join('\n'),
      tipsInjected: retrievalResult.tips.length,
      categoriesRepresented: [...categories],
      tipIds: retrievalResult.tips.map(({ tip }) => tip.tipId),
      injectedTips: retrievalResult.tips.map(({ tip }) => ({
        tipId: tip.tipId,
        sourceKind: this.classifySourceKind(tip),
        category: tip.category,
      })),
    };
  }

  retrieveAndInject(
    taskDescription: string,
    tips: readonly StructuredTip[],
    config: TipRetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
  ): TipInjectionResult {
    const retrieval = this.retrieveRelevantTips(taskDescription, tips, config);
    return this.formatForInjection(retrieval);
  }

  getStats(): RetrievalStats {
    const topCategories = [...this.categoryHits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cat]) => cat);

    return {
      totalRetrievals: this.totalRetrievals,
      avgTipsReturned: this.totalRetrievals > 0
        ? Math.round(this.totalTipsReturned / this.totalRetrievals * 100) / 100
        : 0,
      avgRelevanceScore: this.totalTipsReturned > 0
        ? Math.round(this.totalRelevanceSum / this.totalTipsReturned * 1000) / 1000
        : 0,
      topCategories,
    };
  }

  reset(): void {
    this.totalRetrievals = 0;
    this.totalTipsReturned = 0;
    this.totalRelevanceSum = 0;
    this.categoryHits.clear();
    this.tipFeedback.clear();
    this.archivedTipIds.clear();
    this.totalDecayed = 0;
  }

  private async hydrateTipCache(): Promise<void> {
    const persisted = await this.tipStore?.listTips();
    if (!persisted || persisted.length === 0) {
      return;
    }

    const existingIds = new Set(this.persistedTipCache.map((tip) => tip.tipId));
    for (const tip of persisted) {
      if (existingIds.has(tip.tipId)) {
        continue;
      }
      this.persistedTipCache.push(tip);
      existingIds.add(tip.tipId);
    }
  }

  private async hydrateTipFeedback(): Promise<void> {
    const persisted = await this.tipStore?.listTipFeedback?.();
    if (!persisted || persisted.length === 0) {
      return;
    }

    for (const feedback of persisted) {
      this.tipFeedback.set(feedback.tipId, feedback);
    }
  }

  private async hydratePersistedState(): Promise<void> {
    const operations: Promise<void>[] = [];

    if (this.tipStore) {
      operations.push(
        this.hydrateTipCache().catch((error) => {
          this.logger?.warn('Adaptive memory tip hydration failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
      operations.push(
        this.hydrateTipFeedback().catch((error) => {
          this.logger?.warn('Adaptive memory tip feedback hydration failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
    }

    if (this.lessonStore) {
      operations.push(
        this.hydratePrincipleCache().catch((error) => {
          this.logger?.warn('Adaptive memory principle hydration failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
    }

    await Promise.allSettled(operations);
  }

  private async hydratePrincipleCache(): Promise<void> {
    const principles = await this.lessonStore?.listPrinciples();
    if (!principles || principles.length === 0) {
      return;
    }

    const existingIds = new Set(this.persistedPrincipleCache.map((tip) => tip.tipId));
    for (const principle of principles) {
      const projectedTip = this.projectPrincipleToTip(principle);
      if (existingIds.has(projectedTip.tipId)) {
        continue;
      }
      this.persistedPrincipleCache.push(projectedTip);
      existingIds.add(projectedTip.tipId);
    }
  }

  private mergePrincipleTips(tips: readonly StructuredTip[]): StructuredTip[] {
    if (this.persistedPrincipleCache.length === 0) {
      return [...tips];
    }

    const merged = [...tips];
    const seen = new Set(merged.map((tip) => tip.tipId));
    for (const projectedTip of this.persistedPrincipleCache) {
      if (seen.has(projectedTip.tipId)) {
        continue;
      }
      merged.push(projectedTip);
      seen.add(projectedTip.tipId);
    }

    return merged;
  }

  private projectPrincipleToTip(principle: ConsolidatedPrinciple): StructuredTip {
    const signal = `${principle.rootCauseCategory} ${principle.statement} ${principle.prevention} ${principle.tags.join(' ')}`.toLowerCase();
    const category: TipCategory = /(optimi|perform|latency|cache|efficien|throughput|budget)/.test(signal)
      ? 'optimization'
      : /(recover|prevent|avoid|fix|error|fail|bug|violation|regression|incident|outbox|import|config|env)/.test(signal)
        ? 'recovery'
        : 'strategy';

    return {
      tipId: `${PROJECTED_PRINCIPLE_PREFIX}${principle.principleId}`,
      category,
      content: principle.statement,
      steps: principle.prevention ? [principle.prevention] : [],
      triggerCondition: principle.rootCauseCategory,
      negativeExample: undefined,
      priority: Math.max(0.85, Math.min(0.99, principle.reliabilityLevel)),
      provenance: [...principle.sourceLessonIds],
      generalizationLevel: 'generic',
      taskDomain: principle.rootCauseCategory,
      generatedAt: principle.consolidatedAt,
    };
  }

  private classifySourceKind(tip: StructuredTip): InjectedTipSourceKind {
    return tip.tipId.startsWith(PROJECTED_PRINCIPLE_PREFIX) ? 'principle' : 'tip';
  }

  /**
   * Record feedback on whether an injected tip was used and helpful.
   * Proactive audit (recommendation 3.2): closes the feedback loop so ineffective
   * tips can be deprecated and effective ones promoted.
   */
  recordTipFeedback(tipId: string, used: boolean, helpful: boolean): void {
    const feedback: TipFeedbackState = {
      tipId,
      used,
      helpful,
      recordedAt: new Date().toISOString(),
    };

    this.tipFeedback.set(tipId, feedback);
    void this.tipStore?.recordTipFeedback?.(feedback).catch((error) => {
      this.logger?.warn('Adaptive memory tip feedback persistence failed', {
        tipId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Get usage audit showing tip effectiveness across recorded feedback.
   */
  getUsageAudit(): {
    readonly totalFeedback: number;
    readonly usedCount: number;
    readonly helpfulCount: number;
    readonly helpfulRate: number;
    readonly unhelpfulTipIds: readonly string[];
  } {
    let used = 0;
    let helpful = 0;
    const unhelpful: string[] = [];

    for (const [tipId, feedback] of this.tipFeedback) {
      if (feedback.used) used++;
      if (feedback.helpful) helpful++;
      if (feedback.used && !feedback.helpful) unhelpful.push(tipId);
    }

    return {
      totalFeedback: this.tipFeedback.size,
      usedCount: used,
      helpfulCount: helpful,
      helpfulRate: this.tipFeedback.size > 0 ? helpful / this.tipFeedback.size : 0,
      unhelpfulTipIds: unhelpful,
    };
  }

  // ── Private ───────────────────────────────────────────────────

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2),
    );
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const word of a) {
      if (b.has(word)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  private buildMatchReason(
    taskWords: Set<string>,
    tipWords: Set<string>,
    tip: StructuredTip,
  ): string {
    const shared: string[] = [];
    for (const word of taskWords) {
      if (tipWords.has(word)) shared.push(word);
    }
    const keywordPart = shared.length > 0
      ? `keywords: ${shared.slice(0, 5).join(', ')}`
      : 'priority-weighted match';
    return `${tip.category} tip — ${keywordPart}`;
  }
}
