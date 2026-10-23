/**
 * Context Window Guard — Domain port for evaluating context window limits
 * and generating warn/block decisions for LLM agent execution.
 *
 * Prevents agent failures due to insufficient context window budget
 * by checking available tokens against configurable thresholds.
 *
 * @layer Domain (Agents)
 * @phase OpenClaw Extraction V3 — Sprint 2
 * @donor external/openclaw/src/agents/context-window-guard.ts (82L)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Source of the context window limit value.
 */
export type ContextWindowSource = 'model_metadata' | 'config_override' | 'default';

/**
 * Resolved context window information.
 */
export interface ContextWindowInfo {
  /** Available context window size in tokens */
  readonly tokens: number;
  /** Source of the token count */
  readonly source: ContextWindowSource;
}

/**
 * Result of context window guard evaluation.
 */
export interface ContextWindowGuardResult {
  /** Available context window in tokens */
  readonly tokens: number;
  /** How the token count was determined */
  readonly source: ContextWindowSource;
  /** Whether to display a warning to the user */
  readonly shouldWarn: boolean;
  /** Whether to block execution entirely */
  readonly shouldBlock: boolean;
  /** Human-readable reason if warning or blocking */
  readonly reason?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Minimum viable context window — below this, execution is blocked */
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;

/** Warning threshold — below this, user is warned but execution proceeds */
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

// ─── Interface ───────────────────────────────────────────────────────────────

export interface IContextWindowGuard {
  /**
   * Resolve context window info from model metadata or config.
   *
   * @param modelId - The model identifier to look up
   * @param configOverride - Optional explicit override from config
   */
  resolveContextWindowInfo(modelId: string, configOverride?: number): ContextWindowInfo;

  /**
   * Evaluate whether current context window is sufficient.
   * Returns warn/block decisions based on thresholds.
   */
  evaluateGuard(info: ContextWindowInfo): ContextWindowGuardResult;
}
