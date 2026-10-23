/**
 * MAS Runtime Core - token budget and lightweight token counting utilities.
 *
 * Layer: Application (business orchestration).
 *
 * Scope: T003 / cognitive pruning MVP:
 * - no external tokenizer dependencies;
 * - approximate token counting using character length heuristic;
 * - session-scoped budget for MAS context windows.
 */

import type {
  MasMessage,
  MasSessionContext,
  TokenBudget,
} from '../types/mas-types';

/**
 * Effective resolved token budget for a single MAS context window.
 */
export interface ResolvedTokenBudget {
  /** Hard upper bound for tokens in a single MAS context window. */
  maxContextTokens: number;
  /** Threshold above which pruning should be triggered. */
  warningTokens: number;
}

/**
 * Default limits for gpt-5.* family (128K context) with safety margin.
 *
 * Values chosen to:
 * - avoid 128K hard limit for prompt+completion;
 * - leave room for tools / system overhead.
 */
const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;
const DEFAULT_WARNING_RATIO = 0.8;

/**
 * Guard rails for misconfigured budgets:
 * - GLOBAL_MAX_CONTEXT_TOKENS keeps MAS within model limits even when
 *   session-level TokenBudget is accidentally set too high;
 * - MIN_CONTEXT_TOKENS avoids pathological cases where the context window
 *   becomes unusably small and breaks MAS reasoning.
 */
const GLOBAL_MAX_CONTEXT_TOKENS = DEFAULT_MAX_CONTEXT_TOKENS;
const MIN_CONTEXT_TOKENS = 1_000;

/**
 * Derive an effective token budget for the given MAS session.
 *
 * Semantics:
 * - session.tokenBudget.totalTokens, if present, is treated as maxContextTokens;
 * - otherwise, DEFAULT_MAX_CONTEXT_TOKENS is used;
 * - warning threshold is taken from tokenBudget.componentBudgets?.contextWarning
 *   when provided, or computed as DEFAULT_WARNING_RATIO * maxContextTokens.
 */
export function resolveTokenBudget(
  session?: MasSessionContext,
): ResolvedTokenBudget {
  const budget: TokenBudget | undefined = session?.tokenBudget;

  const configuredTotal =
    budget?.totalTokens && Number.isFinite(budget.totalTokens)
      ? budget.totalTokens
      : undefined;

  let maxContextTokens =
    configuredTotal && configuredTotal > 0
      ? configuredTotal
      : DEFAULT_MAX_CONTEXT_TOKENS;

  // Keep MAS within model limits and avoid unusably small windows even when
  // TokenBudget is misconfigured at the caller level.
  if (maxContextTokens > GLOBAL_MAX_CONTEXT_TOKENS) {
    maxContextTokens = GLOBAL_MAX_CONTEXT_TOKENS;
  } else if (maxContextTokens < MIN_CONTEXT_TOKENS) {
    maxContextTokens = MIN_CONTEXT_TOKENS;
  }

  const rawWarning =
    budget?.componentBudgets &&
    typeof budget.componentBudgets['contextWarning'] === 'number'
      ? budget.componentBudgets['contextWarning']
      : undefined;

  const explicitWarning =
    typeof rawWarning === 'number' &&
    Number.isFinite(rawWarning) &&
    rawWarning > 0
      ? rawWarning
      : undefined;

  const warningTokens =
    explicitWarning !== undefined
      ? Math.min(explicitWarning, maxContextTokens)
      : Math.floor(maxContextTokens * DEFAULT_WARNING_RATIO);

  return {
    maxContextTokens,
    warningTokens,
  };
}

import { countTokens } from '../../../core/utils/tokenizer';

/**
 * Approximate token count for a single MAS message.
 *
 * Uses `gpt-tokenizer` via Core utility for accurate BPE comparison.
 * Strings are counted directly; objects are stringified first.
 */
export function estimateMessageTokens(message: MasMessage): number {
  const text =
    typeof message.content === 'string'
      ? message.content
      : safeStringify(message.content);

  // Very small messages should still be counted as at least 1 token.
  if (!text) {
    return 1;
  }

  const tokens = countTokens(text);
  // istanbul ignore next -- defensive minimum; countTokens always returns ≥1 for non-empty text
  return tokens > 0 ? tokens : 1;
}

/**
 * Approximate token count for a list of MAS messages.
 */
export function estimateTokensForMessages(messages: MasMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/**
 * Decide whether pruning should be triggered for the given context window.
 *
 * Trigger rule:
 * - if estimatedTokens > budget.warningTokens → prune;
 * - otherwise keep the context as-is.
 */
export function shouldPruneForBudget(
  estimatedTokens: number,
  budget: ResolvedTokenBudget,
): boolean {
  return estimatedTokens > budget.warningTokens;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}