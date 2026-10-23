/**
 * Hermes-Style System Prompt Layers — composable prompt enrichment.
 *
 * Provides additional layers that can be composed with the existing
 * AdaptiveSystemPromptBuilder to add Hermes-Agent patterns:
 *
 * 1. Tip guidelines — inject trajectory-informed tips (CC-036) for continuity
 * 2. Memory snapshot freezing — inject recalled memories at build time
 * 3. Context file security scanning — strip threats before inclusion
 * 4. Platform-specific hints — runtime environment hints
 * 5. Compression-aware annotations — note when context is compressed
 * 6. Tool availability summary — list available tools concisely
 * 7. Session continuity — inject todo / prior context state
 * 8. Token budget awareness — trim/drop sections to fit budget
 *
 * @layer Application (Services / System Prompt)
 * @gap G26
 */

import { scanContentForThreats, type ThreatScanResult } from '../../../domain/security/content-threat-scanner';
import { stripInvisibleUnicode } from '../../../core/utils/text/invisible-unicode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single layer that contributes text to the system prompt. */
export interface PromptLayer {
  /** Unique identifier for the layer. */
  id: string;
  /** Display name for diagnostics/logging. */
  name: string;
  /** Priority (lower = earlier in prompt). */
  priority: number;
  /** Whether this layer is required (cannot be dropped for budget). */
  required: boolean;
  /** Build the layer's content. Returns empty string to skip. */
  build(context: PromptBuildContext): string;
}

/** Context passed to each layer's build method. */
export interface PromptBuildContext {
  /** Current session/conversation ID. */
  sessionId?: string;
  /** Platform: 'cli' | 'telegram' | 'discord' etc. */
  platform?: string;
  /** Model being used. */
  model?: string;
  /** Available tool names. */
  availableTools: Set<string>;
  /** Recalled memory snippets to freeze into the prompt. */
  memorySnapshot?: MemorySnippet[];
  /** Context files to embed (will be security-scanned). */
  contextFiles?: ContextFile[];
  /** Current todo list state (from TodoStore.formatForInjection). */
  todoState?: string | null;
  /** Number of context compressions in this session. */
  compressionCount?: number;
  /** Token budget for the entire system prompt. */
  tokenBudget?: number;
  /** Custom data from the caller. */
  extra?: Record<string, unknown>;
}

export interface MemorySnippet {
  content: string;
  source?: string;
  score?: number;
}

export interface ContextFile {
  path: string;
  content: string;
  role?: 'instruction' | 'reference' | 'user-provided';
}

export interface AssembledPrompt {
  text: string;
  layersIncluded: string[];
  layersDropped: string[];
  securityScanResults: ThreatScanResult[];
  estimatedTokens: number;
}

// ---------------------------------------------------------------------------
// Built-in layers
// ---------------------------------------------------------------------------

/**
 * Layer 0: Tip Guidelines — inject trajectory-informed tips (CC-036)
 * into the prompt so the model benefits from accumulated wisdom.
 *
 * Reads TipInjectionResult from ctx.extra?.tipInjection.
 * @see IAdaptiveMemoryRetrieval — CC-036 domain port (source of tips)
 */
export function createTipGuidelinesLayer(): PromptLayer {
  return {
    id: 'tip_guidelines',
    name: 'Tip Guidelines',
    priority: 15,
    required: false,
    build(ctx) {
      const injection = ctx.extra?.tipInjection as
        | { guidelinesSection: string; tipsInjected: number }
        | null
        | undefined;

      if (!injection || !injection.tipsInjected || !injection.guidelinesSection) {
        return '';
      }

      return injection.guidelinesSection;
    },
  };
}

/**
 * Layer 1: Memory Snapshot — freeze recalled memories into the prompt
 * so the model has them even if memory tools are not called.
 */
export function createMemorySnapshotLayer(): PromptLayer {
  return {
    id: 'memory_snapshot',
    name: 'Memory Snapshot',
    priority: 20,
    required: false,
    build(ctx) {
      if (!ctx.memorySnapshot || ctx.memorySnapshot.length === 0) return '';

      const lines = ['## Memory Snapshot (auto-recalled)'];
      for (const snippet of ctx.memorySnapshot) {
        const clean = stripInvisibleUnicode(snippet.content);
        const source = snippet.source ? ` (${snippet.source})` : '';
        lines.push(`- ${clean}${source}`);
      }
      lines.push('');
      return lines.join('\n');
    },
  };
}

/**
 * Layer 2: Context Files — embed context files with security scanning.
 * Files with detected threats are excluded and logged.
 */
export function createContextFilesLayer(): PromptLayer {
  return {
    id: 'context_files',
    name: 'Context Files',
    priority: 30,
    required: false,
    build(ctx) {
      if (!ctx.contextFiles || ctx.contextFiles.length === 0) return '';

      const lines = ['## Context Files'];
      const scanResults: ThreatScanResult[] = [];

      for (const file of ctx.contextFiles) {
        const scan = scanContentForThreats(file.content);
        scanResults.push(scan);

        if (scan.hasThreat) {
          lines.push(`<!-- Skipped ${file.path}: security scan detected ${scan.threats.length} threat(s) -->`);
          continue;
        }

        const clean = stripInvisibleUnicode(file.content);
        lines.push(`### ${file.path}`);
        lines.push(clean);
        lines.push('');
      }

      // Attach scan results to context for reporting
      if (ctx.extra) {
        ctx.extra['contextFileScanResults'] = scanResults;
      }

      lines.push('');
      return lines.join('\n');
    },
  };
}

/**
 * Layer 3: Platform Hints — runtime environment context.
 */
export function createPlatformHintsLayer(): PromptLayer {
  return {
    id: 'platform_hints',
    name: 'Platform Hints',
    priority: 50,
    required: false,
    build(ctx) {
      const parts: string[] = [];

      if (ctx.platform) {
        parts.push(`Platform: ${ctx.platform}`);
      }
      if (ctx.model) {
        parts.push(`Model: ${ctx.model}`);
      }
      if (ctx.availableTools.size > 0) {
        parts.push(`Tools available: ${ctx.availableTools.size}`);
      }

      if (parts.length === 0) return '';
      return `## Environment\n${parts.join(' | ')}\n\n`;
    },
  };
}

/**
 * Layer 4: Compression Notice — inform the model about compressed history.
 */
export function createCompressionNoticeLayer(): PromptLayer {
  return {
    id: 'compression_notice',
    name: 'Compression Notice',
    priority: 90,
    required: false,
    build(ctx) {
      const count = ctx.compressionCount ?? 0;
      if (count === 0) return '';

      return [
        '## Context Compression Notice',
        `Context has been compressed ${count} time(s). Some earlier conversation details`,
        'may be summarized. If you need precise earlier context, check memory or ask the user.',
        '',
      ].join('\n');
    },
  };
}

/**
 * Layer 5: Todo State — inject preserved todo list.
 */
export function createTodoStateLayer(): PromptLayer {
  return {
    id: 'todo_state',
    name: 'Todo State',
    priority: 85,
    required: false,
    build(ctx) {
      if (!ctx.todoState) return '';
      return `## Task Tracking\n${ctx.todoState}\n\n`;
    },
  };
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

/**
 * Assemble a system prompt from multiple layers, respecting priority
 * order and an optional token budget.
 *
 * @param layers       Array of prompt layers
 * @param context      Build context
 * @param estimateTokens  Token count estimator
 * @returns AssembledPrompt
 */
export function assembleSystemPrompt(
  layers: PromptLayer[],
  context: PromptBuildContext,
  estimateTokens: (text: string) => number = roughEstimate,
): AssembledPrompt {
  // Sort by priority (ascending)
  const sorted = [...layers].sort((a, b) => a.priority - b.priority);

  const included: string[] = [];
  const dropped: string[] = [];
  const parts: string[] = [];
  const allScanResults: ThreatScanResult[] = [];
  let currentTokens = 0;
  const budget = context.tokenBudget ?? Infinity;

  // Ensure extra is initialized
  if (!context.extra) context.extra = {};

  for (const layer of sorted) {
    const content = layer.build(context);
    if (!content) continue;

    const tokens = estimateTokens(content);

    if (currentTokens + tokens > budget && !layer.required) {
      dropped.push(layer.id);
      continue;
    }

    parts.push(content);
    included.push(layer.id);
    currentTokens += tokens;
  }

  // Collect scan results from context files layer
  if (context.extra['contextFileScanResults']) {
    allScanResults.push(...(context.extra['contextFileScanResults'] as ThreatScanResult[]));
  }

  return {
    text: parts.join('\n'),
    layersIncluded: included,
    layersDropped: dropped,
    securityScanResults: allScanResults,
    estimatedTokens: currentTokens,
  };
}

/**
 * Create the default set of Hermes prompt layers.
 */
export function createDefaultPromptLayers(): PromptLayer[] {
  return [
    createTipGuidelinesLayer(),
    createMemorySnapshotLayer(),
    createContextFilesLayer(),
    createPlatformHintsLayer(),
    createCompressionNoticeLayer(),
    createTodoStateLayer(),
  ];
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function roughEstimate(text: string): number {
  return Math.ceil(text.length / 4) + 4;
}
