/**
 * WisdomExporterAdapter — In-memory wisdom export to LSP diagnostic format.
 *
 * Serializes Tier 3-4 accumulated wisdom (Procedural + Meta-cognitive) into
 * structured diagnostic rules compatible with LSP DiagnosticSeverity.
 *
 * Severity mapping:
 *   priority ≥ 0.8 → "error" (CRITICAL)
 *   priority ≥ 0.6 → "warning" (HIGH)
 *   priority ≥ 0.4 → "info" (MEDIUM)
 *   priority < 0.4 → "hint" (LOW)
 *
 * @layer Infrastructure (Memory)
 * @pattern TIM Wisdom Export (Horizon 3 — LSP Bridge)
 * @see src/domain/memory/IWisdomExporter.ts — domain port
 */

import type {
  IWisdomExporter,
  WisdomDiagnosticRule,
  WisdomExportResult,
  WisdomExportConfig,
  WisdomExportStats,
  WisdomSeverity,
} from '../../../domain/memory/IWisdomExporter';
import { DEFAULT_EXPORT_CONFIG } from '../../../domain/memory/IWisdomExporter';
import type { StructuredTip, TipCategory } from '../../../domain/memory/IContextualTipGenerator';
import type { ILessonStore } from '../../../domain/memory/ILessonStore';
import type { ConsolidatedPrinciple } from '../../../domain/memory/IWisdomConsolidator';

// ── Hard Invariant Seed Rules ─────────────────────────────────────
// Static diagnostic rules for MicroPhoenix Hard Invariants.
// These are always exported regardless of Wisdom Base state,
// providing Opus 4.6 with instant "red underline" feedback
// when code violates architectural rules.
// Academic: "Cognitive Exoskeleton" pattern — external memory
// compensates for LLM hallucination of confidence (arXiv:2603.10047).

const HARD_INVARIANT_SEED_RULES: readonly WisdomDiagnosticRule[] = [
  {
    ruleId: 'HI-003-domain-infra-import',
    severity: 'error',
    message: 'Hard Invariant #3: Domain must NOT import from Infrastructure. Use DI ports.',
    triggerPattern: "from.*['\"]@?/?(src/)?infrastructure/",
    category: 'recovery',
    source: 'TIM/hard-invariant',
    memoryTier: 4,
    exportedAt: '2026-03-17T00:00:00.000Z',
  },
  {
    ruleId: 'HI-002-new-service',
    severity: 'error',
    message: 'Hard Invariant #2: Never use new Service() in Domain/Application. Use container.resolve(TOKEN).',
    triggerPattern: 'new\\s+\\w+(Service|Adapter|Repository|Store)\\s*\\(',
    category: 'recovery',
    source: 'TIM/hard-invariant',
    memoryTier: 4,
    exportedAt: '2026-03-17T00:00:00.000Z',
  },
  {
    ruleId: 'HI-011-process-env',
    severity: 'error',
    message: 'Hard Invariant #11: No process.env in Domain/Application. Use IConfigLoader via DI.',
    triggerPattern: 'process\\.env\\.',
    category: 'recovery',
    source: 'TIM/hard-invariant',
    memoryTier: 4,
    exportedAt: '2026-03-17T00:00:00.000Z',
  },
  {
    ruleId: 'HI-004-direct-publish',
    severity: 'error',
    message: 'Hard Invariant #4: Never use EventBus.publish() directly. Use IEventStore.saveEvents() (Outbox).',
    triggerPattern: 'EventBus\\.publish\\s*\\(',
    category: 'recovery',
    source: 'TIM/hard-invariant',
    memoryTier: 4,
    exportedAt: '2026-03-17T00:00:00.000Z',
  },
  {
    ruleId: 'HI-005-get-instance',
    severity: 'warning',
    message: 'Hard Invariant #5: No .getInstance() for LLM. Use DI token LLMAdapterFactory.',
    triggerPattern: '\\.getInstance\\s*\\(',
    category: 'strategy',
    source: 'TIM/hard-invariant',
    memoryTier: 4,
    exportedAt: '2026-03-17T00:00:00.000Z',
  },
  {
    ruleId: 'HI-007-direct-prom-client',
    severity: 'warning',
    message: 'Hard Invariant #7: No direct prom-client. Use src/monitoring/index.ts.',
    triggerPattern: "from\\s+['\"]prom-client['\"]",
    category: 'strategy',
    source: 'TIM/hard-invariant',
    memoryTier: 4,
    exportedAt: '2026-03-17T00:00:00.000Z',
  },
  {
    ruleId: 'HI-017-process-platform',
    severity: 'warning',
    message: 'Hard Invariant #17: No process.platform in Domain/Application/Core. Use IPlatformAdapter via DI.',
    triggerPattern: 'process\\.platform|os\\.platform\\(\\)',
    category: 'recovery',
    source: 'TIM/hard-invariant',
    memoryTier: 4,
    exportedAt: '2026-03-17T00:00:00.000Z',
  },
  {
    ruleId: 'HI-019-json-schema-outputschema',
    severity: 'error',
    message: 'Hard Invariant #19: MCP outputSchema must use raw Zod shapes, not JSON Schema format.',
    triggerPattern: "outputSchema.*type:\\s*['\"]object['\"]",
    category: 'recovery',
    source: 'TIM/hard-invariant',
    memoryTier: 4,
    exportedAt: '2026-03-17T00:00:00.000Z',
  },
  {
    ruleId: 'HI-016-stub-no-tag',
    severity: 'warning',
    message: 'Hard Invariant #16: Adapters with simulated I/O must have @sota-stub JSDoc tag.',
    triggerPattern: 'Buffer\\.alloc\\(0\\)',
    category: 'optimization',
    source: 'TIM/hard-invariant',
    memoryTier: 4,
    exportedAt: '2026-03-17T00:00:00.000Z',
  },
  {
    ruleId: 'HI-012-custom-uuid',
    severity: 'hint',
    message: 'Hard Invariant #12: Use IdGenerator/TokenGenerator only. No custom UUID/crypto for IDs.',
    triggerPattern: "import.*from\\s+['\"]uuid['\"]",
    category: 'strategy',
    source: 'TIM/hard-invariant',
    memoryTier: 4,
    exportedAt: '2026-03-17T00:00:00.000Z',
  },
  {
    ruleId: 'AP-001-pg-pool-direct',
    severity: 'error',
    message: 'Anti-Pattern: No direct pg Pool import. Use IDatabaseConnection via DI.',
    triggerPattern: "import.*Pool.*from\\s+['\"]pg['\"]",
    category: 'recovery',
    source: 'TIM/anti-pattern',
    memoryTier: 4,
    exportedAt: '2026-03-17T00:00:00.000Z',
  },
];

// ── Adapter ───────────────────────────────────────────────────────

export { HARD_INVARIANT_SEED_RULES };

const PROJECTED_PRINCIPLE_PREFIX = 'principle:';

export interface WisdomExporterDeps {
  readonly lessonStore?: ILessonStore;
  readonly logger?: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

export class WisdomExporterAdapter implements IWisdomExporter {
  private totalExports = 0;
  private totalRulesExported = 0;
  private readonly lessonStore: ILessonStore | undefined;
  private readonly logger: WisdomExporterDeps['logger'];
  private readonly persistedPrincipleTips: StructuredTip[] = [];
  private readonly hydrationPromise: Promise<void>;
  private readonly severityDist: Record<WisdomSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
    hint: 0,
  };
  private readonly categoryDist: Record<TipCategory, number> = {
    strategy: 0,
    recovery: 0,
    optimization: 0,
  };

  constructor(deps?: WisdomExporterDeps) {
    this.lessonStore = deps?.lessonStore;
    this.logger = deps?.logger;
    this.hydrationPromise = this.lessonStore
      ? this.hydratePrincipleTips().catch((error) => {
          this.logger?.warn('Wisdom exporter principle hydration failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
      : Promise.resolve();
  }

  whenReady(): Promise<void> {
    return this.hydrationPromise;
  }

  exportRules(
    tips: readonly StructuredTip[],
    tierClassifier: (tip: StructuredTip) => number,
    config: WisdomExportConfig = DEFAULT_EXPORT_CONFIG,
  ): WisdomExportResult {
    const now = new Date().toISOString();
    const rules: WisdomDiagnosticRule[] = [];
    const candidateTips = this.mergePrincipleTips(tips);

    // Inject Hard Invariant seed rules first (when enabled, default: true)
    if (config.includeSeedRules !== false) {
      for (const seedRule of HARD_INVARIANT_SEED_RULES) {
        if (rules.length >= config.maxRules) break;
        if (config.categoryFilter && config.categoryFilter.length > 0) {
          if (!config.categoryFilter.includes(seedRule.category)) continue;
        }
        rules.push(seedRule);
        this.severityDist[seedRule.severity]++;
        this.categoryDist[seedRule.category]++;
      }
    }

    for (const tip of candidateTips) {
      if (rules.length >= config.maxRules) break;

      const tier = tierClassifier(tip);
      if (tier < config.minTier) continue;
      if (tip.priority < config.minPriority) continue;
      if (config.categoryFilter && config.categoryFilter.length > 0) {
        if (!config.categoryFilter.includes(tip.category)) continue;
      }

      const severity = this.mapSeverity(tip.priority);

      rules.push({
        ruleId: tip.tipId,
        severity,
        message: tip.content,
        triggerPattern: tip.triggerCondition,
        category: tip.category,
        source: this.isProjectedPrincipleTip(tip)
          ? `TIM/principle/${tip.category}`
          : `TIM/${tip.category}`,
        memoryTier: tier,
        exportedAt: now,
      });

      this.severityDist[severity]++;
      this.categoryDist[tip.category]++;
    }

    this.totalExports++;
    this.totalRulesExported += rules.length;

    return {
      rules,
      totalTipsEvaluated: candidateTips.length,
      tipsExported: rules.length,
      exportedAt: now,
    };
  }

  getStats(): WisdomExportStats {
    return {
      totalExports: this.totalExports,
      totalRulesExported: this.totalRulesExported,
      severityDistribution: { ...this.severityDist },
      categoryDistribution: { ...this.categoryDist },
    };
  }

  reset(): void {
    this.totalExports = 0;
    this.totalRulesExported = 0;
    this.severityDist.error = 0;
    this.severityDist.warning = 0;
    this.severityDist.info = 0;
    this.severityDist.hint = 0;
    this.categoryDist.strategy = 0;
    this.categoryDist.recovery = 0;
    this.categoryDist.optimization = 0;
  }

  private mergePrincipleTips(tips: readonly StructuredTip[]): StructuredTip[] {
    if (this.persistedPrincipleTips.length === 0) {
      return [...tips];
    }

    const merged = [...tips];
    const seen = new Set(merged.map((tip) => tip.tipId));
    for (const projectedTip of this.persistedPrincipleTips) {
      if (seen.has(projectedTip.tipId)) {
        continue;
      }
      merged.push(projectedTip);
      seen.add(projectedTip.tipId);
    }

    return merged;
  }

  private isProjectedPrincipleTip(tip: StructuredTip): boolean {
    return tip.tipId.startsWith(PROJECTED_PRINCIPLE_PREFIX);
  }

  private async hydratePrincipleTips(): Promise<void> {
    const principles = await this.lessonStore?.listPrinciples();
    if (!principles || principles.length === 0) {
      return;
    }

    const existingIds = new Set(this.persistedPrincipleTips.map((tip) => tip.tipId));
    for (const principle of principles) {
      const projectedTip = this.projectPrincipleToTip(principle);
      if (existingIds.has(projectedTip.tipId)) {
        continue;
      }
      this.persistedPrincipleTips.push(projectedTip);
      existingIds.add(projectedTip.tipId);
    }
  }

  private projectPrincipleToTip(principle: ConsolidatedPrinciple): StructuredTip {
    const category = this.inferCategory(principle);

    return {
      tipId: `${PROJECTED_PRINCIPLE_PREFIX}${principle.principleId}`,
      category,
      content: principle.statement,
      steps: principle.prevention ? [principle.prevention] : [],
      triggerCondition: this.buildTriggerPattern(principle),
      negativeExample: undefined,
      priority: Math.max(0.85, Math.min(0.99, principle.reliabilityLevel)),
      provenance: [...principle.sourceLessonIds],
      generalizationLevel: 'generic',
      taskDomain: principle.rootCauseCategory,
      generatedAt: principle.consolidatedAt,
    };
  }

  private inferCategory(principle: ConsolidatedPrinciple): TipCategory {
    const signal = `${principle.rootCauseCategory} ${principle.statement} ${principle.prevention} ${principle.tags.join(' ')}`.toLowerCase();
    if (/(optimi|perform|latency|cache|efficien|throughput|budget)/.test(signal)) {
      return 'optimization';
    }
    if (/(recover|prevent|avoid|fix|error|fail|bug|violation|regression|incident|outbox|import|config|env)/.test(signal)) {
      return 'recovery';
    }
    return 'strategy';
  }

  private buildTriggerPattern(principle: ConsolidatedPrinciple): string {
    const keywords = new Set<string>();
    const sources = [principle.rootCauseCategory, ...principle.tags, principle.statement];
    for (const source of sources) {
      for (const token of source.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
        const normalized = token.toLowerCase();
        if (normalized.length < 4) {
          continue;
        }
        keywords.add(this.escapeRegex(normalized));
        if (keywords.size >= 6) {
          break;
        }
      }
      if (keywords.size >= 6) {
        break;
      }
    }

    if (keywords.size === 0) {
      return this.escapeRegex(principle.rootCauseCategory);
    }

    return `\\b(?:${[...keywords].join('|')})\\b`;
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private mapSeverity(priority: number): WisdomSeverity {
    if (priority >= 0.8) return 'error';
    if (priority >= 0.6) return 'warning';
    if (priority >= 0.4) return 'info';
    return 'hint';
  }
}
