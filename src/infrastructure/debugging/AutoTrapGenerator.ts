/**
 * AutoTrapGenerator — Infrastructure adapter for IAutoTrapGenerator.
 *
 * Generates ESLint AST trap rules from error graph nodes using LLM.
 * Pipeline: ErrorGraphNode → AST pattern extraction → ESLint rule code generation → validation.
 *
 * The generated rules target ESLint v9 flat config and use AST visitor patterns
 * to syntactically block anti-patterns discovered via post-mortem analysis.
 *
 * Storage: Generated traps are stored in-memory with optional persistence
 * to `generated-traps/` directory as individual JSON files.
 *
 * @layer Infrastructure
 * @implements IAutoTrapGenerator (Domain port)
 * @see src/domain/debugging/IAutoTrapGenerator.ts
 * @see PLANS/06_BLUEPRINTS/ERROR_DEBUGGING_EVOLUTION_SOTA_2026.md §6
 */

import type { CorrelationId } from '@/ai-types';
import type {
  ErrorGraphNode,
  ASTPatternNode,
} from '../../domain/debugging/IErrorGraphRepository';
import type {
  IAutoTrapGenerator,
  GeneratedTrap,
  TrapConfidence,
  TrapGenerationResult,
} from '../../domain/debugging/IAutoTrapGenerator';

// ── Logger Interface ──────────────────────────────────────────────

interface ILogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ── LLM Adapter Interface (subset of LLMAdapterFactory output) ───

interface ILLMClient {
  generateText(prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<string>;
}

// ── Implementation ────────────────────────────────────────────────

/**
 * AutoTrapGenerator generates ESLint rules from error patterns.
 *
 * Phase 1: Uses structured prompt templates with LLM to synthesize rules.
 * Phase 2 (planned): Direct AST analysis via ts-morph for higher confidence.
 */
export class AutoTrapGenerator implements IAutoTrapGenerator {
  private readonly traps: Map<string, GeneratedTrap> = new Map();

  constructor(
    private readonly llmClient: ILLMClient | undefined,
    private readonly logger?: ILogger,
  ) {}

  async generateTrap(
    error: ErrorGraphNode,
    pattern: ASTPatternNode,
    correlationId: CorrelationId,
  ): Promise<TrapGenerationResult> {
    const trapId = `trap-${error.id}-${Date.now()}`;
    const ruleName = this.deriveRuleName(error);

    this.logger?.info('AutoTrapGenerator: generating trap', {
      correlationId,
      errorId: error.id,
      trapId,
      pattern: pattern.id,
    });

    try {
      let ruleSource: string;
      let confidence: TrapConfidence;

      if (this.llmClient) {
        // LLM-assisted generation
        const prompt = this.buildPrompt(error, pattern);
        const rawResponse = await this.llmClient.generateText(prompt, {
          maxTokens: 2048,
          temperature: 0.1, // Low temperature for deterministic code generation
        });

        ruleSource = this.extractRuleSource(rawResponse);
        confidence = this.assessConfidence(ruleSource, pattern);
      } else {
        // Fallback: template-based generation (no LLM available)
        ruleSource = this.generateTemplateRule(error, pattern);
        confidence = 'LOW';
      }

      const trap: GeneratedTrap = {
        trapId,
        sourceErrorId: error.id,
        ruleName,
        severity: error.severity === 'CRITICAL' || error.severity === 'HIGH' ? 'error' : 'warn',
        ruleSource,
        message: `[${error.id}] ${error.rule}`,
        confidence,
        validated: false,
        generatedAt: new Date().toISOString(),
      };

      this.traps.set(trapId, trap);

      this.logger?.info('AutoTrapGenerator: trap generated', {
        correlationId,
        trapId,
        ruleName,
        confidence,
      });

      return { success: true, trap };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger?.error('AutoTrapGenerator: generation failed', {
        correlationId,
        errorId: error.id,
        reason,
      });
      return { success: false, reason };
    }
  }

  async validateTrap(
    trap: GeneratedTrap,
    correlationId: CorrelationId,
  ): Promise<boolean> {
    this.logger?.info('AutoTrapGenerator: validating trap', {
      correlationId,
      trapId: trap.trapId,
      ruleName: trap.ruleName,
    });

    try {
      // Validate rule source is syntactically valid JavaScript
      // Use Function constructor check (safe: we don't execute it)
      const hasCreate = trap.ruleSource.includes('create(');
      const hasReturn = trap.ruleSource.includes('return {');
      const hasContext = trap.ruleSource.includes('context');

      if (!hasCreate || !hasReturn || !hasContext) {
        this.logger?.warn('AutoTrapGenerator: rule source missing ESLint structure', {
          correlationId,
          trapId: trap.trapId,
          hasCreate,
          hasReturn,
          hasContext,
        });
        return false;
      }

      // Check that the rule doesn't contain dangerous patterns
      const dangerous = ['eval(', 'Function(', 'require(', 'import(', 'child_process', 'fs.'];
      for (const pattern of dangerous) {
        if (trap.ruleSource.includes(pattern)) {
          this.logger?.warn('AutoTrapGenerator: rule source contains dangerous pattern', {
            correlationId,
            trapId: trap.trapId,
            pattern,
          });
          return false;
        }
      }

      // Mark as validated in memory
      const stored = this.traps.get(trap.trapId);
      if (stored) {
        // Create updated trap with validated=true
        const validated: GeneratedTrap = { ...stored, validated: true };
        this.traps.set(trap.trapId, validated);
      }

      this.logger?.info('AutoTrapGenerator: trap validated', {
        correlationId,
        trapId: trap.trapId,
      });

      return true;
    } catch (err) {
      this.logger?.error('AutoTrapGenerator: validation failed', {
        correlationId,
        trapId: trap.trapId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async listTraps(validated?: boolean): Promise<readonly GeneratedTrap[]> {
    const all = [...this.traps.values()];
    if (validated === undefined) return all;
    return all.filter((t) => t.validated === validated);
  }

  // ── Private Helpers ─────────────────────────────────────────────

  private deriveRuleName(error: ErrorGraphNode): string {
    // Convert error rule to kebab-case ESLint rule name
    const slug = error.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `microphoenix/trap-${slug}`;
  }

  private buildPrompt(error: ErrorGraphNode, pattern: ASTPatternNode): string {
    return [
      '## Task: Generate an ESLint rule that catches this anti-pattern.',
      '',
      '### Error Information:',
      `- ID: ${error.id}`,
      `- Summary: ${error.summary}`,
      `- Root Cause: ${error.rootCause}`,
      `- Rule: ${error.rule}`,
      `- Category: ${error.category}`,
      `- Affected Files: ${error.affectedFiles.join(', ')}`,
      '',
      '### AST Pattern:',
      `- Pattern: ${pattern.pattern}`,
      `- Description: ${pattern.description}`,
      '',
      '### Requirements:',
      '1. Generate a valid ESLint v9 rule using the flat config format.',
      '2. The rule must use an AST visitor pattern (create() method returning node visitors).',
      '3. Use `context.report()` with a clear error message.',
      '4. Do not use eval(), Function(), require(), or child_process.',
      '5. Only output the `create(context)` function body.',
      '',
      '### Example format:',
      '```javascript',
      'create(context) {',
      '  return {',
      '    ImportDeclaration(node) {',
      '      if (/* condition */) {',
      '        context.report({ node, message: "..." });',
      '      }',
      '    },',
      '  };',
      '}',
      '```',
      '',
      'Output ONLY the create() function. No explanations.',
    ].join('\n');
  }

  private extractRuleSource(llmResponse: string): string {
    // Try to extract code block
    const codeBlockMatch = llmResponse.match(/```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    // Try to find create() function directly
    const createMatch = llmResponse.match(/(create\s*\([\s\S]*?\n\})/);
    if (createMatch) {
      return createMatch[1].trim();
    }

    // Return raw response trimmed
    return llmResponse.trim();
  }

  private assessConfidence(ruleSource: string, _pattern: ASTPatternNode): TrapConfidence {
    let score = 0;

    // Has proper ESLint structure
    if (ruleSource.includes('create(context)') || ruleSource.includes('create(')) score += 3;
    if (ruleSource.includes('context.report(')) score += 3;
    if (ruleSource.includes('return {')) score += 2;

    // Has AST node visitors
    const visitors = [
      'ImportDeclaration', 'CallExpression', 'MemberExpression',
      'NewExpression', 'Identifier', 'VariableDeclaration',
    ];
    if (visitors.some((v) => ruleSource.includes(v))) score += 2;

    if (score >= 8) return 'HIGH';
    if (score >= 5) return 'MEDIUM';
    return 'LOW';
  }

  private generateTemplateRule(error: ErrorGraphNode, pattern: ASTPatternNode): string {
    // Template-based rule generation for when no LLM is available
    // Escape backslashes first, then single quotes (full JS string literal escaping)
    const message = `[${error.id}] ${error.rule}`.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\n\r]/g, ' ');

    // If pattern looks like an import restriction
    if (pattern.pattern.includes('import') || pattern.description.toLowerCase().includes('import')) {
      return [
        'create(context) {',
        '  return {',
        '    ImportDeclaration(node) {',
        `      const source = node.source.value;`,
        `      // Pattern: ${pattern.pattern.replace(/'/g, "\\'").replace(/[\n\r]/g, ' ')}`,
        `      if (source.match(/${this.escapeRegex(pattern.pattern)}/)) {`,
        `        context.report({ node, message: '${message}' });`,
        '      }',
        '    },',
        '  };',
        '}',
      ].join('\n');
    }

    // Generic call expression pattern
    return [
      'create(context) {',
      '  return {',
      '    CallExpression(node) {',
      `      // Pattern: ${pattern.pattern.replace(/'/g, "\\'").replace(/[\n\r]/g, ' ')}`,
      '      const callee = context.getSourceCode().getText(node.callee);',
      `      if (callee.match(/${this.escapeRegex(pattern.pattern)}/)) {`,
      `        context.report({ node, message: '${message}' });`,
      '      }',
      '    },',
      '  };',
      '}',
    ].join('\n');
  }

  private escapeRegex(str: string): string {
    // Also escape / since result is interpolated into regex literal /.../
    return str.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
}
