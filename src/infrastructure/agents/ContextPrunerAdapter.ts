/**
 * Context Pruner — Infrastructure adapter for IContextPruner.
 *
 * Two-phase context pruning: soft trim (head+tail) → hard clear (placeholder).
 * Protects recent assistant messages, first user message, and image blocks.
 *
 * @layer Infrastructure (Agents)
 * @phase OpenClaw Extraction V4 — Sprint 2
 * @donor external/openclaw/src/agents/pi-extensions/context-pruning/pruner.ts (9.3KB)
 * @owasp Agentic Top 10 2026: Context Window Overflow
 */

import type {
  IContextPruner,
  AgenticMessage,
  ContextPruningSettings,
  ContentBlock,
} from '../../domain/agents/context-pruner.port';
import { DEFAULT_PRUNING_SETTINGS } from '../../domain/agents/context-pruner.port';

// ─── Constants ───────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN_ESTIMATE = 4;
const IMAGE_CHAR_ESTIMATE = 8_000;

// ─── Internal Helpers ────────────────────────────────────────────────────────

function mergeSettings(partial?: Partial<ContextPruningSettings>): ContextPruningSettings {
  if (!partial) return DEFAULT_PRUNING_SETTINGS;
  return {
    softTrimRatio: partial.softTrimRatio ?? DEFAULT_PRUNING_SETTINGS.softTrimRatio,
    hardClearRatio: partial.hardClearRatio ?? DEFAULT_PRUNING_SETTINGS.hardClearRatio,
    keepLastAssistants: partial.keepLastAssistants ?? DEFAULT_PRUNING_SETTINGS.keepLastAssistants,
    minPrunableToolChars:
      partial.minPrunableToolChars ?? DEFAULT_PRUNING_SETTINGS.minPrunableToolChars,
    softTrim: partial.softTrim ?? DEFAULT_PRUNING_SETTINGS.softTrim,
    hardClear: partial.hardClear ?? DEFAULT_PRUNING_SETTINGS.hardClear,
    tools: partial.tools ?? DEFAULT_PRUNING_SETTINGS.tools,
  };
}

function collectTextSegments(content: readonly ContentBlock[]): string[] {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts;
}

function estimateJoinedTextLength(parts: string[]): number {
  if (parts.length === 0) return 0;
  let len = 0;
  for (const p of parts) len += p.length;
  len += Math.max(0, parts.length - 1); // \n separators
  return len;
}

function takeHeadFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) return '';
  let remaining = maxChars;
  let out = '';
  for (let i = 0; i < parts.length && remaining > 0; i++) {
    if (i > 0) {
      out += '\n';
      remaining -= 1;
      if (remaining <= 0) break;
    }
    const p = parts[i];
    if (p.length <= remaining) {
      out += p;
      remaining -= p.length;
    } else {
      out += p.slice(0, remaining);
      remaining = 0;
    }
  }
  return out;
}

function takeTailFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) return '';
  let remaining = maxChars;
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const p = parts[i];
    if (p.length <= remaining) {
      out.push(p);
      remaining -= p.length;
    } else {
      out.push(p.slice(p.length - remaining));
      remaining = 0;
      break;
    }
    if (remaining > 0 && i > 0) {
      out.push('\n');
      remaining -= 1;
    }
  }
  out.reverse();
  return out.join('');
}

function hasImageBlocks(content: readonly ContentBlock[]): boolean {
  for (const block of content) {
    if (block.type === 'image') return true;
  }
  return false;
}

function estimateTextAndImageChars(content: readonly ContentBlock[]): number {
  let chars = 0;
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length;
    if (block.type === 'image') chars += IMAGE_CHAR_ESTIMATE;
  }
  return chars;
}

function estimateMessageChars(message: AgenticMessage): number {
  const content = message.content;
  if (typeof content === 'string') return content.length;

  if (message.role === 'assistant') {
    let chars = 0;
    for (const b of content) {
      if (b.type === 'text' && typeof b.text === 'string') chars += b.text.length;
      if (b.type === 'thinking' && typeof b.thinking === 'string') chars += b.thinking.length;
      if (b.type === 'toolCall') {
        try {
          chars += JSON.stringify(b.arguments ?? {}).length;
        } catch {
          chars += 128;
        }
      }
    }
    return chars;
  }

  return estimateTextAndImageChars(content);
}

function findAssistantCutoffIndex(
  messages: AgenticMessage[],
  keepLastAssistants: number,
): number | null {
  if (keepLastAssistants <= 0) return messages.length;
  let remaining = keepLastAssistants;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'assistant') continue;
    remaining--;
    if (remaining === 0) return i;
  }
  return null;
}

function findFirstUserIndex(messages: AgenticMessage[]): number | null {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') return i;
  }
  return null;
}

function makeToolPrunablePredicate(
  tools: 'all' | readonly string[],
): (toolName: string) => boolean {
  if (tools === 'all') return () => true;
  const set = new Set(tools);
  return (name: string) => set.has(name);
}

function asTextBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class ContextPrunerAdapter implements IContextPruner {
  estimateContextChars(messages: AgenticMessage[]): number {
    return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
  }

  pruneContextMessages(
    messages: AgenticMessage[],
    contextWindowTokens: number,
    settings?: Partial<ContextPruningSettings>,
    isToolPrunable?: (toolName: string) => boolean,
  ): AgenticMessage[] {
    if (!contextWindowTokens || contextWindowTokens <= 0) return messages;

    const s = mergeSettings(settings);
    const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
    if (charWindow <= 0) return messages;

    const cutoffIndex = findAssistantCutoffIndex(messages, s.keepLastAssistants);
    if (cutoffIndex === null) return messages;

    const firstUserIndex = findFirstUserIndex(messages);
    const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;

    const toolPrunableFn = isToolPrunable ?? makeToolPrunablePredicate(s.tools);

    let totalChars = this.estimateContextChars(messages);
    let ratio = totalChars / charWindow;
    if (ratio < s.softTrimRatio) return messages;

    const prunableToolIndexes: number[] = [];
    let next: AgenticMessage[] | null = null;

    // Phase 1: Soft trim
    for (let i = pruneStartIndex; i < cutoffIndex; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'toolResult') continue;
      if (!msg.toolName || !toolPrunableFn(msg.toolName)) continue;

      const content = msg.content;
      if (typeof content === 'string' || !Array.isArray(content)) continue;
      if (hasImageBlocks(content)) continue;

      prunableToolIndexes.push(i);

      const parts = collectTextSegments(content);
      const rawLen = estimateJoinedTextLength(parts);
      if (rawLen <= s.softTrim.maxChars) continue;

      const headChars = Math.max(0, s.softTrim.headChars);
      const tailChars = Math.max(0, s.softTrim.tailChars);
      if (headChars + tailChars >= rawLen) continue;

      const head = takeHeadFromJoinedText(parts, headChars);
      const tail = takeTailFromJoinedText(parts, tailChars);
      const trimmed = `${head}\n...\n${tail}`;
      const note = `\n\n[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;

      const updated: AgenticMessage = {
        ...msg,
        content: [asTextBlock(trimmed + note)],
      };

      const beforeChars = estimateMessageChars(msg);
      const afterChars = estimateMessageChars(updated);
      totalChars += afterChars - beforeChars;

      if (!next) next = messages.slice();
      next[i] = updated;
    }

    const outputAfterSoftTrim = next ?? messages;
    ratio = totalChars / charWindow;
    if (ratio < s.hardClearRatio) return outputAfterSoftTrim;
    if (!s.hardClear.enabled) return outputAfterSoftTrim;

    // Check minimum prunable chars threshold
    let prunableToolChars = 0;
    for (const i of prunableToolIndexes) {
      const msg = outputAfterSoftTrim[i];
      if (!msg || msg.role !== 'toolResult') continue;
      prunableToolChars += estimateMessageChars(msg);
    }
    if (prunableToolChars < s.minPrunableToolChars) return outputAfterSoftTrim;

    // Phase 2: Hard clear
    for (const i of prunableToolIndexes) {
      if (ratio < s.hardClearRatio) break;
      const msg = (next ?? messages)[i];
      if (!msg || msg.role !== 'toolResult') continue;

      const beforeChars = estimateMessageChars(msg);
      const cleared: AgenticMessage = {
        ...msg,
        content: [asTextBlock(s.hardClear.placeholder)],
      };
      if (!next) next = messages.slice();
      next[i] = cleared;
      const afterChars = estimateMessageChars(cleared);
      totalChars += afterChars - beforeChars;
      ratio = totalChars / charWindow;
    }

    return next ?? messages;
  }
}
