/**
 * IAutoTrapGenerator — Domain port for LLM-generated ESLint AST traps.
 *
 * When a new error is recorded in the error graph (IErrorGraphRepository),
 * the Auto-Trap Agent generates a custom ESLint rule that syntactically
 * blocks the problematic pattern forever.
 *
 * Pipeline: ErrorGraphNode → AST pattern extraction → ESLint rule generation → validation
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @vector V5: Predictive Auto-Traps (GraphRAG KNOWN_BUGS)
 * @horizon Q3 2026
 * @see PLANS/06_BLUEPRINTS/ERROR_DEBUGGING_EVOLUTION_SOTA_2026.md §6
 * @see eslint.config.mjs — target for generated rules
 */

import type { CorrelationId } from '@/ai-types';
import type { ErrorGraphNode, ASTPatternNode } from './IErrorGraphRepository';

// ── Types ─────────────────────────────────────────────────────────

/** Confidence level of the generated trap. */
export type TrapConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** A generated ESLint-compatible trap rule. */
export interface GeneratedTrap {
  /** Unique trap ID (derived from error ID). */
  readonly trapId: string;
  /** Source error that triggered generation. */
  readonly sourceErrorId: string;
  /** ESLint rule name (e.g. "microphoenix/no-direct-eventbus-publish"). */
  readonly ruleName: string;
  /** ESLint rule severity: "error" | "warn". */
  readonly severity: 'error' | 'warn';
  /** AST selector or visitor pattern (ESLint rule create() body). */
  readonly ruleSource: string;
  /** Human-readable message shown when rule triggers. */
  readonly message: string;
  /** Confidence that this rule correctly captures the anti-pattern. */
  readonly confidence: TrapConfidence;
  /** Whether the rule has been validated against known test cases. */
  readonly validated: boolean;
  /** ISO-8601 generation timestamp. */
  readonly generatedAt: string;
}

/** Result of trap generation attempt. */
export interface TrapGenerationResult {
  readonly success: boolean;
  readonly trap?: GeneratedTrap;
  readonly reason?: string;
}

// ── Port ──────────────────────────────────────────────────────────

/**
 * Generates ESLint AST trap rules from error graph nodes.
 * Uses LLM (via ILlmJudge or LLMAdapterFactory) for pattern→rule translation.
 */
export interface IAutoTrapGenerator {
  /**
   * Generate a trap rule for the given error and its AST pattern.
   * May use LLM to synthesize the ESLint visitor pattern.
   */
  generateTrap(
    error: ErrorGraphNode,
    pattern: ASTPatternNode,
    correlationId: CorrelationId,
  ): Promise<TrapGenerationResult>;

  /**
   * Validate a generated trap against known positive/negative test cases.
   * Returns true if the rule correctly catches the anti-pattern
   * without false positives on valid code.
   */
  validateTrap(
    trap: GeneratedTrap,
    correlationId: CorrelationId,
  ): Promise<boolean>;

  /**
   * List all generated traps, optionally filtered by validation status.
   */
  listTraps(validated?: boolean): Promise<readonly GeneratedTrap[]>;
}
