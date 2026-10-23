/**
 * CriticFeedbackService — Application service for Proactive AST-Critic Feedback.
 *
 * Intercepts raw diagnostics (TSC, ESLint, architecture violations, DI errors),
 * enriches them with AST context and DI knowledge, and returns structured
 * fix suggestions to the Coder agent.
 *
 * This closes the Self-Evolving Feedback Loop (Eco-Evolve pattern, 2026 SOTA):
 *   Raw Error → AST Analysis → DI Token Lookup → CriticFeedback → Coder
 *
 * @layer Application (service — orchestrates domain ports + infrastructure adapters)
 * @horizon H0/H1: Critic Agent Feedback Loop
 * @see src/domain/audit/ICriticFeedbackService.ts — domain port
 * @see src/infrastructure/mcp/audit/ast-checker.ts — AST analysis
 */

import type { CorrelationId } from '@/ai-types';
import type {
  ICriticFeedbackService,
  AgentDiagnostic,
  CriticFeedback,
  CriticBatchResult,
  FixSuggestion,
  SuggestionConfidence,
} from '@/domain/audit/ICriticFeedbackService';

// ── Minimal Dependencies (via constructor injection) ──────────────

interface CriticLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Read-only DI token map for resolving token suggestions.
 * Injected from DI_TOKENS at construction time.
 */
interface DITokenMap {
  readonly entries: ReadonlyMap<string, string>;
}

/**
 * DEPRECATED_TOKENS set from DI_TOKENS.ts for detecting deprecated token usage.
 */
interface DeprecatedTokenSet {
  readonly tokens: ReadonlySet<string>;
}

// ── Well-Known Replacements (KNOWN_BUGS-derived) ──────────────────

/**
 * Static map of deprecated → replacement tokens.
 * Derived from KNOWN_BUGS.md entries (A-001, S-002) and DI_TOKENS.ts annotations.
 */
const DEPRECATED_REPLACEMENTS: ReadonlyMap<string, { replacement: string; file: string }> = new Map([
  ['ILogger', { replacement: 'IStructuredLogger', file: 'src/core/logging/IStructuredLogger.ts' }],
  ['CacheService', { replacement: 'RedisClient', file: 'src/infrastructure/cache/' }],
  ['MetricsCollector', { replacement: 'IMetricsCollector', file: 'src/domain/observability/' }],
  ['IRepository', { replacement: 'IMasSessionStore', file: 'src/application/agents/state/' }],
  ['EventBus.publish', { replacement: 'IEventStore.saveEvents()', file: 'src/domain/events/event-store.interface.ts' }],
]);

// ── Known TSC Error Patterns ──────────────────────────────────────

interface TSCPattern {
  code: string;
  rootCause: string;
  suggestion: (diagnostic: AgentDiagnostic) => FixSuggestion | undefined;
}

const TSC_PATTERNS: readonly TSCPattern[] = [
  {
    code: 'TS2304', // Cannot find name 'X'
    rootCause: 'Missing import or undefined symbol',
    suggestion: (d) => {
      const nameMatch = d.message.match(/Cannot find name '(\w+)'/);
      if (!nameMatch) return undefined;
      const name = nameMatch[1];
      const replacement = DEPRECATED_REPLACEMENTS.get(name);
      if (replacement) {
        return {
          description: `'${name}' is deprecated. Use '${replacement.replacement}' from ${replacement.file}`,
          confidence: 'high' as SuggestionConfidence,
          newCode: `import type { ${replacement.replacement} } from '${replacement.file}';`,
        };
      }
      return {
        description: `Add missing import for '${name}'. Check @/ai-types for re-exports.`,
        confidence: 'medium' as SuggestionConfidence,
        newCode: `import type { ${name} } from '@/ai-types';`,
      };
    },
  },
  {
    code: 'TS2345', // Argument of type X not assignable to Y
    rootCause: 'Type mismatch in function argument',
    suggestion: () => ({
      description: 'Check interface definitions in domain layer. Ensure branded types are used correctly.',
      confidence: 'medium' as SuggestionConfidence,
    }),
  },
  {
    code: 'TS2339', // Property X does not exist on type Y
    rootCause: 'Missing method or property on interface/class',
    suggestion: (d) => {
      const propMatch = d.message.match(/Property '(\w+)' does not exist on type '(\w+)'/);
      if (!propMatch) return undefined;
      return {
        description: `Add '${propMatch[1]}' to the domain interface '${propMatch[2]}' first (Domain → Implementation rule).`,
        confidence: 'high' as SuggestionConfidence,
      };
    },
  },
  {
    code: 'TS2307', // Cannot find module X
    rootCause: 'Missing module or incorrect import path',
    suggestion: (d) => {
      const moduleMatch = d.message.match(/Cannot find module '([^']+)'/);
      if (!moduleMatch) return undefined;
      const mod = moduleMatch[1];
      if (mod.startsWith('@/')) {
        return {
          description: `Check that the file exists under src/. @/ is aliased to src/ in tsconfig.json.`,
          confidence: 'high' as SuggestionConfidence,
        };
      }
      return {
        description: `Module '${mod}' not found. Run 'npm install' or check the import path.`,
        confidence: 'medium' as SuggestionConfidence,
      };
    },
  },
];

// ── ESLint Pattern Overrides ──────────────────────────────────────

const ESLINT_PATTERNS: ReadonlyMap<string, string> = new Map([
  ['no-restricted-imports', 'Architecture violation: this import crosses layer boundaries. Check AI_CHEATSHEET.md §9.'],
  ['@typescript-eslint/no-unused-vars', 'Remove unused variable or prefix with underscore if intentional.'],
  ['no-console', 'Use IStructuredLogger via DI instead of console.log.'],
]);

// ── Implementation ────────────────────────────────────────────────

export class CriticFeedbackService implements ICriticFeedbackService {
  private readonly diTokenNames: ReadonlySet<string>;

  constructor(
    private readonly diTokenMap: DITokenMap,
    private readonly deprecatedTokens: DeprecatedTokenSet,
    private readonly logger?: CriticLogger,
  ) {
    this.diTokenNames = new Set(diTokenMap.entries.keys());
  }

  async analyzeDiagnostic(
    diagnostic: AgentDiagnostic,
    correlationId: CorrelationId,
  ): Promise<CriticFeedback> {
    const start = Date.now();
    const suggestions: FixSuggestion[] = [];
    const relatedTokens: string[] = [];
    const relatedFiles: string[] = [];
    let rootCause = 'Unknown root cause';

    // 1. Check TSC patterns
    if (diagnostic.source === 'tsc') {
      const pattern = TSC_PATTERNS.find(p => p.code === diagnostic.code);
      if (pattern) {
        rootCause = pattern.rootCause;
        const suggestion = pattern.suggestion(diagnostic);
        if (suggestion) suggestions.push(suggestion);
      }

      // Check if the error mentions a DI token
      this.findDITokenMentions(diagnostic.message, relatedTokens, suggestions);
    }

    // 2. Check ESLint patterns
    if (diagnostic.source === 'eslint') {
      const override = ESLINT_PATTERNS.get(diagnostic.code);
      if (override) {
        rootCause = override;
        suggestions.push({
          description: override,
          confidence: 'high',
        });
      }
    }

    // 3. Check architecture violations
    if (diagnostic.source === 'architecture') {
      rootCause = 'Clean Architecture layer dependency violation';
      suggestions.push({
        description: 'Domain depends only on Core. Application depends on Domain+Core. Never import Infrastructure from Domain/Application.',
        confidence: 'high',
      });
      if (diagnostic.file) relatedFiles.push(diagnostic.file);
    }

    // 4. Check DI resolution failures
    if (diagnostic.source === 'di_resolution') {
      rootCause = 'DI container cannot resolve token';
      this.findDITokenMentions(diagnostic.message, relatedTokens, suggestions);
      relatedFiles.push('src/core/di/DI_TOKENS.ts', 'src/infrastructure/di/bootstrap.ts');
    }

    // Build summary
    const summary = this.buildSummary(diagnostic, rootCause, suggestions);

    this.logger?.info(`CriticFeedback: ${diagnostic.code} → ${suggestions.length} suggestions`, {
      correlationId,
      source: diagnostic.source,
      durationMs: Date.now() - start,
    });

    return {
      diagnostic,
      summary,
      rootCause,
      suggestions,
      relatedTokens,
      relatedFiles,
      analysisMs: Date.now() - start,
    };
  }

  async analyzeBatch(
    diagnostics: readonly AgentDiagnostic[],
    correlationId: CorrelationId,
  ): Promise<CriticBatchResult> {
    const start = Date.now();

    // Deduplicate by code+file+line
    const seen = new Set<string>();
    const unique: AgentDiagnostic[] = [];
    for (const d of diagnostics) {
      const key = `${d.code}:${d.file ?? ''}:${d.line ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(d);
      }
    }

    const feedbacks: CriticFeedback[] = [];
    for (const d of unique) {
      feedbacks.push(await this.analyzeDiagnostic(d, correlationId));
    }

    const actionable = feedbacks.filter(f => f.suggestions.length > 0);

    this.logger?.info(`CriticFeedback batch: ${diagnostics.length} → ${unique.length} unique → ${actionable.length} actionable`, {
      correlationId,
      totalMs: Date.now() - start,
    });

    return {
      feedbacks,
      totalDiagnostics: diagnostics.length,
      actionableDiagnostics: actionable.length,
      totalMs: Date.now() - start,
    };
  }

  // ── Private Helpers ──────────────────────────────────────────────

  private findDITokenMentions(
    message: string,
    relatedTokens: string[],
    suggestions: FixSuggestion[],
  ): void {
    for (const tokenName of this.diTokenNames) {
      if (message.includes(tokenName)) {
        relatedTokens.push(tokenName);

        // Check if deprecated
        const tokenValue = this.diTokenMap.entries.get(tokenName);
        if (tokenValue && this.deprecatedTokens.tokens.has(tokenValue)) {
          const replacement = DEPRECATED_REPLACEMENTS.get(tokenName);
          if (replacement) {
            suggestions.push({
              description: `Token '${tokenName}' is deprecated. Use '${replacement.replacement}' instead.`,
              confidence: 'high',
              targetFile: 'src/core/di/DI_TOKENS.ts',
            });
          } else {
            suggestions.push({
              description: `Token '${tokenName}' is deprecated (Phase 8-9 roadmap). Check DI_TOKENS.ts for alternatives.`,
              confidence: 'medium',
              targetFile: 'src/core/di/DI_TOKENS.ts',
            });
          }
        }
      }
    }
  }

  private buildSummary(
    diagnostic: AgentDiagnostic,
    rootCause: string,
    suggestions: readonly FixSuggestion[],
  ): string {
    const parts: string[] = [
      `[CRITIC_FEEDBACK] ${diagnostic.source.toUpperCase()} ${diagnostic.code}: ${rootCause}`,
    ];

    if (diagnostic.file) {
      parts.push(`File: ${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ''}`);
    }

    if (suggestions.length > 0) {
      const top = suggestions[0];
      parts.push(`Fix: ${top.description}`);
      if (top.newCode) {
        parts.push(`Code: ${top.newCode}`);
      }
    }

    return parts.join(' | ');
  }
}
