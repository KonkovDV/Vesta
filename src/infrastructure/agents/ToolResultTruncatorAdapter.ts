/**
 * Tool Result Truncator — Infrastructure adapter for IToolResultTruncator.
 *
 * Smart truncation of oversized tool results using head+tail strategy.
 *
 * @layer Infrastructure (Agents)
 * @phase OpenClaw Extraction V4 — Sprint 2
 * @donor external/openclaw/src/agents/pi-embedded-runner/tool-result-truncation.ts (13.8KB)
 * @owasp Agentic Top 10 2026: Context Window Overflow, Resource Exhaustion
 */

import type {
  IToolResultTruncator,
  ToolResultMessage,
  ToolResultTruncationOptions,
} from '../../domain/agents/tool-result-truncator.port';
import {
  MAX_TOOL_RESULT_CONTEXT_SHARE,
  HARD_MAX_TOOL_RESULT_CHARS,
  DEFAULT_MIN_KEEP_CHARS,
} from '../../domain/agents/tool-result-truncator.port';

// ─── Constants ───────────────────────────────────────────────────────────────

const TRUNCATION_SUFFIX =
  '\n\n⚠️ [Content truncated — original was too large for the model\'s context window. ' +
  'The content above is a partial view. If you need more, request specific sections or use ' +
  'offset/limit parameters to read smaller chunks.]';

const MIDDLE_OMISSION_MARKER =
  '\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n';

// ─── Internal Helpers ────────────────────────────────────────────────────────

function hasImportantTail(text: string): boolean {
  const tail = text.slice(-2000).toLowerCase();
  return (
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/.test(tail) ||
    /\}\s*$/.test(tail.trim()) ||
    /\b(total|summary|result|complete|finished|done)\b/.test(tail)
  );
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class ToolResultTruncatorAdapter implements IToolResultTruncator {
  truncateToolResultText(
    text: string,
    maxChars: number,
    options?: ToolResultTruncationOptions,
  ): string {
    const suffix = options?.suffix ?? TRUNCATION_SUFFIX;
    const minKeepChars = options?.minKeepChars ?? DEFAULT_MIN_KEEP_CHARS;

    if (text.length <= maxChars) {
      return text;
    }

    const budget = Math.max(minKeepChars, maxChars - suffix.length);

    // Head+tail strategy when tail contains important content
    if (hasImportantTail(text) && budget > minKeepChars * 2) {
      const tailBudget = Math.min(Math.floor(budget * 0.3), 4_000);
      const headBudget = budget - tailBudget - MIDDLE_OMISSION_MARKER.length;

      if (headBudget > minKeepChars) {
        let headCut = headBudget;
        const headNewline = text.lastIndexOf('\n', headBudget);
        if (headNewline > headBudget * 0.8) {
          headCut = headNewline;
        }

        let tailStart = text.length - tailBudget;
        const tailNewline = text.indexOf('\n', tailStart);
        if (tailNewline !== -1 && tailNewline < tailStart + tailBudget * 0.2) {
          tailStart = tailNewline + 1;
        }

        return text.slice(0, headCut) + MIDDLE_OMISSION_MARKER + text.slice(tailStart) + suffix;
      }
    }

    // Default: preserve the beginning
    let cutPoint = budget;
    const lastNewline = text.lastIndexOf('\n', budget);
    if (lastNewline > budget * 0.8) {
      cutPoint = lastNewline;
    }
    return text.slice(0, cutPoint) + suffix;
  }

  calculateMaxToolResultChars(contextWindowTokens: number): number {
    const maxTokens = Math.floor(contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE);
    const maxChars = maxTokens * 4; // ~4 chars per token heuristic
    return Math.min(maxChars, HARD_MAX_TOOL_RESULT_CHARS);
  }

  getToolResultTextLength(msg: ToolResultMessage): number {
    if (!msg || msg.role !== 'toolResult') {
      return 0;
    }
    if (!Array.isArray(msg.content)) {
      return 0;
    }
    let totalLength = 0;
    for (const block of msg.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        totalLength += block.text.length;
      }
    }
    return totalLength;
  }

  truncateToolResultMessage(
    msg: ToolResultMessage,
    maxChars: number,
    options?: ToolResultTruncationOptions,
  ): ToolResultMessage {
    const suffix = options?.suffix ?? TRUNCATION_SUFFIX;
    const minKeepChars = options?.minKeepChars ?? DEFAULT_MIN_KEEP_CHARS;

    if (!Array.isArray(msg.content)) {
      return msg;
    }

    const totalTextChars = this.getToolResultTextLength(msg);
    if (totalTextChars <= maxChars) {
      return msg;
    }

    const newContent = msg.content.map((block) => {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') {
        return block;
      }
      const blockShare = block.text.length / totalTextChars;
      const blockBudget = Math.max(
        minKeepChars + suffix.length,
        Math.floor(maxChars * blockShare),
      );
      return {
        ...block,
        text: this.truncateToolResultText(block.text, blockBudget, { suffix, minKeepChars }),
      };
    });

    return { ...msg, content: newContent };
  }
}
