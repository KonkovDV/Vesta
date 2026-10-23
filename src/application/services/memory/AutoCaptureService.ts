/**
 * AutoCaptureService — Extracts and persists memories from completed agent conversations.
 *
 * Subscribes to the `agent_end` lifecycle event, extracts the last N messages,
 * strips XML memory blocks, and saves to Mem0 with session run_id.
 *
 * @module application/services/memory
 * @phase Phase 3 — Auto-Recall & Auto-Capture
 *
 * Ported from Mem0 OpenClaw plugin (@mem0/openclaw-mem0) — external/mem0/openclaw/index.ts:1362-1405
 * Closes GAP: G2 (Auto-Capture), G18 (Multi-block content), G19 (XML stripping), G20 (Session tracking)
 */

import type { IMem0Provider } from '../../../domain/memory/IMem0Provider';
import type { IHookPipeline } from '../../../domain/plugins/hook-pipeline.interface';
import type { Mem0BuilderConfig } from '../../ports/Mem0OptionsBuilder';
import { buildAddOptions } from '../../ports/Mem0OptionsBuilder';

// ── Regex for stripping injected memory blocks ─────────────────────

/**
 * Strips `<relevant-memories>` XML blocks injected by AutoRecallService.
 * Prevents memory echo — memories about memories.
 *
 * Ported from Mem0 plugin index.ts:1393
 */
const MEMORY_XML_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

/**
 * Maximum number of messages to extract for memory capture.
 * Ported from Mem0 plugin index.ts:1375
 */
const MAX_CAPTURE_MESSAGES = 10;

// ── Event types ────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
}

interface ConversationMessage {
  role?: string;
  content?: string | ContentBlock[];
}

interface CaptureHookEvent {
  success?: boolean;
  messages?: ConversationMessage[];
  conversationId?: string;
  userId?: string;
  [key: string]: unknown;
}

// ── Logger ─────────────────────────────────────────────────────────

interface IAutoCaptureLogger {
  info(message: string): void;
  warn(message: string): void;
  debug?(message: string): void;
}

// ── Service ────────────────────────────────────────────────────────

/**
 * Auto-Capture: extracts memories from completed agent conversations
 * and persists them to Mem0.
 *
 * Features:
 * - Guards: only processes successful conversations with messages
 * - Last 10 messages, filtered to user/assistant roles
 * - Multi-block content support (Array<{type, text}> → joined text)
 * - XML stripping to prevent memory echo
 * - Session run_id tracking for session-scoped memories
 * - Graceful degradation (never throws)
 * - Configurable via config.autoCapture
 */
export class AutoCaptureService {
  /**
   * Session ID for session-scoped memory storage.
   * Shared with AutoRecallService via DI or accessor.
   */
  private currentSessionId: string | undefined;

  constructor(
    private readonly hookPipeline: IHookPipeline,
    private readonly provider: IMem0Provider,
    private readonly config: Mem0BuilderConfig & { autoCapture: boolean },
    private readonly logger: IAutoCaptureLogger,
  ) {}

  /**
   * Set the current session ID (typically shared from AutoRecallService).
   */
  setCurrentSessionId(sessionId: string | undefined): void {
    this.currentSessionId = sessionId;
  }

  /**
   * Get the current session ID.
   */
  getCurrentSessionId(): string | undefined {
    return this.currentSessionId;
  }

  /**
   * Initialize the service — register the agent_end and before_compaction hooks.
   */
  initialize(): void {
    if (!this.config.autoCapture) {
      this.logger.info('[mem0] Auto-capture disabled by configuration');
      return;
    }

    this.hookPipeline.register(
      'agent_end',
      async (event) => {
        await this.handleCaptureEvent(event as CaptureHookEvent, true, 'agent_end');
      },
      { priority: 50, source: 'system' },
    );

    this.hookPipeline.register(
      'before_compaction',
      async (event) => {
        await this.handleCaptureEvent(event as CaptureHookEvent, false, 'before_compaction');
      },
      { priority: 40, source: 'system' },
    );

    this.logger.info('[mem0] Auto-capture hooks registered on agent_end and before_compaction');
  }

  /**
   * Handle the agent_end event — extract messages which Mem0 will process.
   *
   * Guard: event.success must be truthy, messages must be non-empty.
   * Ported from Mem0 plugin index.ts:1364 —
   *   if (!event.success || !event.messages || event.messages.length === 0) return;
   */
  private async handleCaptureEvent(
    event: CaptureHookEvent,
    requireSuccess: boolean,
    trigger: 'agent_end' | 'before_compaction',
  ): Promise<void> {
    if (requireSuccess && !event.success) return;
    if (!event.messages || event.messages.length === 0) return;

    // Sync session ID from event context (fixes GAP 2: session ID desync)
    if (event.conversationId) {
      this.currentSessionId = event.conversationId;
    }

    try {
      // Take last N messages, filter to user/assistant roles (Mem0 plugin index.ts:1375)
      const relevantMessages = event.messages
        .slice(-MAX_CAPTURE_MESSAGES)
        .filter(
          (m) => m.role === 'user' || m.role === 'assistant',
        );

      if (relevantMessages.length === 0) return;

      // Extract text content from messages (Mem0 plugin index.ts:1380-1392)
      const textContent = relevantMessages
        .map((m) => {
          const content = this.extractContent(m);
          return m.role + ': ' + content;
        })
        .join('\n');

      // Strip injected memory XML to prevent echo (Mem0 plugin index.ts:1393)
      const cleanContent = textContent.replace(MEMORY_XML_RE, '').trim();

      if (cleanContent.length < 10) {
        this.logger.debug?.('[mem0] Capture skipped: content too short after cleaning');
        return;
      }

      // Save to Mem0 with session run_id and entity graph building
      // enable_graph is configured at builder level; we also extract userId from event
      const options = buildAddOptions(
        this.config,
        event.userId,
        this.currentSessionId,
        {
          metadata: {
            capture_trigger: trigger,
          },
        },
      );

      const result = await this.provider.add(
        [{ role: 'user', content: cleanContent }],
        options,
      );

      const eventCounts = (result.results ?? []).reduce(
        (acc, r) => {
          acc[r.event] = (acc[r.event] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      this.logger.info(
        `[mem0] Captured ${relevantMessages.length} messages via ${trigger} → ${JSON.stringify(eventCounts)}`,
      );
    } catch (err) {
      // Graceful degradation — never throw from hooks
      this.logger.warn(`[mem0] Capture failed: ${String(err)}`);
    }
  }

  /**
   * Extract text content from a message, handling multi-block arrays.
   *
   * Handles two content formats:
   * 1. `string` — direct text
   * 2. `Array<{type: string, text?: string}>` — multi-block (Mem0 plugin index.ts:1380-1388)
   *    Each block with type "text" has its text concatenated with `\n`.
   */
  private extractContent(message: ConversationMessage): string {
    if (typeof message.content === 'string') return message.content;

    if (Array.isArray(message.content)) {
      return message.content
        .filter((block): block is ContentBlock & { text: string } =>
          block.type === 'text' && typeof block.text === 'string',
        )
        .map((block) => block.text)
        .join('\n');
    }

    return String(message.content ?? '');
  }
}
