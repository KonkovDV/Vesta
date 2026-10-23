/**
 * Context Window Guard — Infrastructure adapter for IContextWindowGuard.
 *
 * Evaluates context window limits and generates warn/block decisions
 * for LLM agent execution. Prevents agent failures due to insufficient
 * context window budget.
 *
 * Thresholds:
 *  - HARD_MIN: 16K tokens → block execution
 *  - WARN_BELOW: 32K tokens → display warning
 *
 * @layer Infrastructure (Agents)
 * @phase OpenClaw Extraction V3 — Sprint 2
 * @donor external/openclaw/src/agents/context-window-guard.ts (82L)
 */

import type {
  IContextWindowGuard,
  ContextWindowInfo,
  ContextWindowGuardResult,
} from '../../domain/agents/context-window-guard.port';
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
} from '../../domain/agents/context-window-guard.port';

// ─── Default Context Windows (tokens) ────────────────────────────────────────

const DEFAULT_CONTEXT_WINDOW = 128_000; // Modern models default

/**
 * Well-known model context window sizes.
 * Used as fallback when model metadata is unavailable.
 */
const KNOWN_MODEL_WINDOWS: Record<string, number> = {
  'gpt-4o-mini': 128_000,
  'gpt-4o': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4-32k': 32_768,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  'claude-4-opus': 200_000,
  'claude-4-sonnet': 200_000,
  'claude-3.5-sonnet': 200_000,
  'claude-3.5-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-1.5-pro': 2_000_000,
  'gemini-1.5-flash': 1_000_000,
};

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * ContextWindowGuardAdapter — evaluates context window limits.
 *
 * Constructor injection: no external dependencies.
 * Registered in DI as singleton (stateless).
 */
export class ContextWindowGuardAdapter implements IContextWindowGuard {

  resolveContextWindowInfo(modelId: string, configOverride?: number): ContextWindowInfo {
    // Config override takes precedence
    if (configOverride !== undefined && configOverride > 0) {
      return { tokens: configOverride, source: 'config_override' };
    }

    // Check known model windows
    const normalizedModelId = modelId.toLowerCase().trim();
    for (const [key, tokens] of Object.entries(KNOWN_MODEL_WINDOWS)) {
      if (normalizedModelId.includes(key)) {
        return { tokens, source: 'model_metadata' };
      }
    }

    // Default fallback
    return { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' };
  }

  evaluateGuard(info: ContextWindowInfo): ContextWindowGuardResult {
    const shouldBlock = info.tokens < CONTEXT_WINDOW_HARD_MIN_TOKENS;
    const shouldWarn = !shouldBlock && info.tokens < CONTEXT_WINDOW_WARN_BELOW_TOKENS;

    let reason: string | undefined;
    if (shouldBlock) {
      reason = `Context window too small (${info.tokens} tokens). ` +
        `Minimum required: ${CONTEXT_WINDOW_HARD_MIN_TOKENS} tokens. ` +
        `Execution blocked to prevent failures.`;
    } else if (shouldWarn) {
      reason = `Context window is below recommended threshold (${info.tokens} tokens < ${CONTEXT_WINDOW_WARN_BELOW_TOKENS}). ` +
        `Agent may experience truncation or degraded performance.`;
    }

    return {
      tokens: info.tokens,
      source: info.source,
      shouldWarn,
      shouldBlock,
      reason,
    };
  }
}
