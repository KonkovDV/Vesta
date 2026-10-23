/**
 * MAS Runtime Core - context pruning helpers.
 *
 * Layer: Application (business orchestration).
 *
 * Scope: T003 / cognitive pruning MVP:
 * - relies on approximate token estimates;
 * - deterministically compacts older messages into a synthetic summary;
 * - does not call LLMs directly (LLM-based summarization can be added later).
 */

import type { MasMessage, MasContextWindow } from '../types/mas-types';
import type { ResolvedTokenBudget } from './token-budget';
import { estimateMessageTokens } from './token-budget';

/**
 * Configuration for structural (non-LLM) context pruning.
 */
export interface PruningConfig {
  /** Number of most recent non-pinned messages to keep as-is. */
  keepRecentMessages: number;
  /** Maximum total characters to include into the synthetic summary. */
  maxSummaryCharacters: number;
}

/**
 * Default pruning configuration derived from T003 design doc:
 * - keep last 25 messages in full;
 * - summarize older messages into a single synthetic item,
 *   capped at ~4000 characters (~1000 tokens).
 */
export const DEFAULT_PRUNING_CONFIG: PruningConfig = {
  keepRecentMessages: 25,
  maxSummaryCharacters: 4_000,
};

export interface PrunePlan {
  shouldPrune: boolean;
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  /** Final ordered list of messages after pruning is applied. */
  keptMessages: MasMessage[];
}

/**
 * Build a pruning plan for the given messages and token budget.
 *
 * The plan is purely structural and does not mutate the input messages array.
 */
export function planPruneContextWindow(
  messages: MasMessage[],
  budget: ResolvedTokenBudget,
  config: PruningConfig,
): PrunePlan {
  const tokensBefore = messages.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0,
  );

  const messagesBefore = messages.length;

  if (messagesBefore === 0 || tokensBefore <= budget.warningTokens) {
    return {
      shouldPrune: false,
      tokensBefore,
      tokensAfter: tokensBefore,
      messagesBefore,
      messagesAfter: messagesBefore,
      keptMessages: messages,
    };
  }

  const pinned: MasMessage[] = [];
  const nonPinned: MasMessage[] = [];

  for (const message of messages) {
    const pinnedFlag =
      message.metadata &&
      (message.metadata.pinned === true ||
        message.metadata['mas_pinned'] === true);

    if (pinnedFlag) {
      pinned.push(message);
    } else {
      nonPinned.push(message);
    }
  }

  const keepRecent = Math.min(config.keepRecentMessages, nonPinned.length);
  const recent =
    keepRecent > 0 ? nonPinned.slice(nonPinned.length - keepRecent) : [];
  const older = nonPinned.slice(0, nonPinned.length - keepRecent);

  if (older.length === 0) {
    // When there is nothing to summarize we deliberately keep the original
    // window (typically only pinned or very recent messages). This preserves
    // invariants like "pinned messages are never dropped" even if the caller
    // misconfigured the budget.
    return {
      shouldPrune: false,
      tokensBefore,
      tokensAfter: tokensBefore,
      messagesBefore,
      messagesAfter: messagesBefore,
      keptMessages: messages,
    };
  }

  const summaryText = buildSummaryText(older, config.maxSummaryCharacters);

  const summaryMessage: MasMessage = {
    role: 'system',
    content: `[CONTEXT SUMMARY]\n${summaryText}`,
    metadata: {
      source: 'mas_context_pruner_v1',
      original_message_count: older.length,
    },
  };

  let keptMessages: MasMessage[] = [...pinned, summaryMessage, ...recent];

  let tokensAfter = keptMessages.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0,
  );

  if (tokensAfter > budget.maxContextTokens) {
    // Prefer dropping the oldest non-pinned recent messages before touching
    // pinned content or the synthetic summary. This keeps the most recent
    // conversational turns while still respecting the hard budget in typical
    // cases.
    const pinnedAndSummaryCount = pinned.length + 1;
    const mutableKept = keptMessages.slice();

    while (
      tokensAfter > budget.maxContextTokens &&
      mutableKept.length > pinnedAndSummaryCount
    ) {
      // Remove the oldest recent message (immediately after the summary).
      mutableKept.splice(pinnedAndSummaryCount, 1);
      tokensAfter = mutableKept.reduce(
        (sum, m) => sum + estimateMessageTokens(m),
        0,
      );
    }

    // If even pinned + summary overflow the budget, keep them anyway to avoid
    // destroying critical instructions; such cases should be prevented by
    // higher-level TokenBudget configuration.
    keptMessages = mutableKept;
  }

  return {
    shouldPrune: true,
    tokensBefore,
    tokensAfter,
    messagesBefore,
    messagesAfter: keptMessages.length,
    keptMessages,
  };
}

/**
 * Apply a previously computed prune plan to a MAS context window,
 * enriching its metadata with pruning diagnostics.
 */
export function applyPrunePlanToContextWindow(
  window: MasContextWindow,
  plan: PrunePlan,
): MasContextWindow {
  if (!plan.shouldPrune) {
    return window;
  }

  const baseMetadata = window.metadata ?? {};

  return {
    ...window,
    messages: plan.keptMessages,
    metadata: {
      ...baseMetadata,
      pruning: {
        applied: true,
        tokensBefore: plan.tokensBefore,
        tokensAfter: plan.tokensAfter,
        messagesBefore: plan.messagesBefore,
        messagesAfter: plan.messagesAfter,
      },
    },
  };
}

function buildSummaryText(
  messages: MasMessage[],
  maxSummaryCharacters: number,
): string {
  if (messages.length === 0 || maxSummaryCharacters <= 0) {
    return '';
  }

  const lines: string[] = [];
  let remaining = maxSummaryCharacters;

  for (const m of messages) {
    const role = m.role ?? 'system';
    const rawText =
      typeof m.content === 'string' ? m.content : safeStringify(m.content);

    if (!rawText) {
      continue;
    }

    let snippet = rawText.replace(/\s+/g, ' ').trim();
    if (snippet.length > remaining) {
      snippet = snippet.slice(0, Math.max(0, remaining - 3)) + '...';
    }

    const line = `${role}: ${snippet}`;
    if (line.length > remaining) {
      break;
    }

    lines.push(line);
    remaining -= line.length + 1;

    if (remaining <= 0) {
      break;
    }
  }

  return lines.join('\n');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}