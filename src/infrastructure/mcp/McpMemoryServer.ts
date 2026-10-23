/**
 * McpMemoryServer — MCP protocol server exposing memory operations.
 *
 * Layer: Infrastructure
 *
 * Implements IMcpServer with 5 memory tools:
 * - add_memories: Store new memory
 * - search_memory: Semantic search across memories
 * - list_memories: List all accessible memories
 * - delete_memories: Delete specific memories by ID
 * - delete_all_memories: Bulk-delete all user memories
 *
 * Phase 7: Ported from OpenMemory mcp_server.py (Python → TypeScript).
 * Donor: external/mem0/openmemory/api/app/mcp_server.py (493L)
 *
 * Architecture:
 * - Uses IMem0Provider via DI (not direct SDK calls)
 * - Structured logging via IStructuredLogger pattern
 * - Prometheus metrics for MCP operations
 * - No direct database access — delegates to existing memory services
 */

import type {
  IMcpServer,
  McpToolDefinition,
  McpToolResult,
  McpSessionContext,
} from '../../domain/mcp/IMcpServer';
import type { IAdaptiveMemoryRetrieval } from '../../domain/memory/IAdaptiveMemoryRetrieval';
import type { IArchivalMemory } from '../../domain/memory/IArchivalMemory';
import type { IGraphMemoryEngine } from '../../domain/memory/IGraphMemoryEngine';
import type { IWorkingMemory } from '../../domain/memory/IWorkingMemory';
import type { IMem0Provider } from '../memory/provider/UnifiedMem0Provider';
import { logger } from '../logging/logger';
import { getOrCreateCounter, getOrCreateHistogram } from '../../monitoring';
import { sanitizeError } from './shared/mcp-utils';

// ── Validation Limits ────────────────────────────────────────────────

/** FIX: MCPS-H4 — Max memory text length to prevent OOM/DoS. */
const MAX_MEMORY_TEXT_LENGTH = 100_000;
/** FIX: MCPS-H5 — Max memory IDs per delete batch to prevent abuse. */
const MAX_MEMORY_IDS = 100;

// ── Metrics ─────────────────────────────────────────────────────────

type McpOperation =
  | 'add_memories'
  | 'search_memory'
  | 'list_memories'
  | 'delete_memories'
  | 'delete_all_memories'
  | 'memory_status'
  | 'memory_wake_up'
  | 'unknown';
type McpOutcome = 'success' | 'error';

interface McpMemoryServerDeps {
  readonly workingMemory?: IWorkingMemory;
  readonly archivalMemory?: IArchivalMemory;
  readonly graphMemoryEngine?: IGraphMemoryEngine;
  readonly adaptiveMemoryRetrieval?: IAdaptiveMemoryRetrieval;
}

const mcpRequestsTotal = getOrCreateCounter(
  'mcp_memory_requests_total',
  'Total MCP memory tool invocations by operation and outcome',
  ['operation', 'outcome'],
);

const mcpRequestDurationSeconds = getOrCreateHistogram(
  'mcp_memory_request_duration_seconds',
  'Duration of MCP memory tool invocations in seconds',
  ['operation', 'outcome'],
);

// ── Tool Schemas ────────────────────────────────────────────────────

const ADD_MEMORIES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'The text content to store as a memory',
    },
  },
  required: ['text'],
};

const SEARCH_MEMORY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search query to find relevant memories',
    },
  },
  required: ['query'],
};

const LIST_MEMORIES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

const DELETE_MEMORIES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    memory_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Array of memory IDs to delete',
    },
  },
  required: ['memory_ids'],
};

const DELETE_ALL_MEMORIES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

const MEMORY_STATUS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tenant_id: {
      type: 'string',
      description: 'Optional tenant scope override. Defaults to the current MCP userId.',
    },
    session_id: {
      type: 'string',
      description: 'Optional session scope override. Defaults to the current MCP session.',
    },
  },
};

const MEMORY_WAKE_UP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tenant_id: {
      type: 'string',
      description: 'Optional tenant scope override. Defaults to the current MCP userId.',
    },
    session_id: {
      type: 'string',
      description: 'Optional session scope override. Defaults to the current MCP session.',
    },
    query: {
      type: 'string',
      description: 'Optional focus query used for archival retrieval and adaptive guidance.',
    },
    graph_entity: {
      type: 'string',
      description: 'Optional entity name used for temporal graph recall.',
    },
    working_limit: {
      type: 'integer',
      description: 'Maximum number of working-memory entries to include. Default: 5.',
    },
    archival_limit: {
      type: 'integer',
      description: 'Maximum number of archival hits to include. Default: 5.',
    },
    graph_limit: {
      type: 'integer',
      description: 'Maximum number of graph facts to include. Default: 5.',
    },
  },
};

// ── Tool Definitions ────────────────────────────────────────────────

const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'add_memories',
    description:
      'Add a new memory. Called when the user shares information about themselves, their preferences, or anything relevant for future conversations. Also called when the user asks to remember something.',
    inputSchema: ADD_MEMORIES_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'search_memory',
    description:
      'Search through stored memories. Called whenever the user asks anything that might relate to previously stored information.',
    inputSchema: SEARCH_MEMORY_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_memories',
    description: 'List all memories accessible to the current user.',
    inputSchema: LIST_MEMORIES_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'delete_memories',
    description: 'Delete specific memories by their IDs.',
    inputSchema: DELETE_MEMORIES_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'delete_all_memories',
    description: 'Delete all memories accessible to the current user.',
    inputSchema: DELETE_ALL_MEMORIES_SCHEMA,
    // FIX: MCPS-L2 — Calling delete_all_memories twice is actually idempotent
    // (second call deletes zero memories), so idempotentHint should be true.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'memory_status',
    description: 'Return a compact runtime overview of memory planes available to the current MCP session.',
    inputSchema: MEMORY_STATUS_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'memory_wake_up',
    description: 'Build a compact wake-up bundle from working memory, archival search, temporal graph facts, and adaptive guidance.',
    inputSchema: MEMORY_WAKE_UP_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];
const KNOWN_OPERATIONS = new Set<McpOperation>([
  'add_memories', 'search_memory', 'list_memories', 'delete_memories', 'delete_all_memories',
  'memory_status', 'memory_wake_up',
]);
// ── Server Implementation ───────────────────────────────────────────

export class McpMemoryServer implements IMcpServer {
  private readonly log = logger.child({ component: 'McpMemoryServer' });

  constructor(
    private readonly memoryProvider: IMem0Provider,
    private readonly deps: McpMemoryServerDeps = {},
  ) {}

  /**
   * List all available MCP memory tools.
   */
  listTools(): McpToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  /**
   * Execute an MCP tool by name.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    context: McpSessionContext,
  ): Promise<McpToolResult> {
    const started = process.hrtime.bigint();
    // P7-4: Use bounded label to prevent Prometheus cardinality explosion
    const operation = (KNOWN_OPERATIONS.has(toolName as McpOperation)
      ? toolName
      : 'unknown') as McpOperation;

    try {
      let result: McpToolResult;

      switch (toolName) {
        case 'add_memories':
          result = await this.addMemories(args, context);
          break;
        case 'search_memory':
          result = await this.searchMemory(args, context);
          break;
        case 'list_memories':
          result = await this.listMemories(context);
          break;
        case 'delete_memories':
          result = await this.deleteMemories(args, context);
          break;
        case 'delete_all_memories':
          result = await this.deleteAllMemories(context);
          break;
        case 'memory_status':
          result = await this.memoryStatus(args, context);
          break;
        case 'memory_wake_up':
          result = await this.memoryWakeUp(args, context);
          break;
        default:
          result = {
            content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
            isError: true,
          };
      }

      this.observe(operation, result.isError ? 'error' : 'success', started);
      return result;
    } catch (error) {
      this.log.warn('MCP tool execution failed', {
        tool: toolName,
        error: error instanceof Error ? error.message : String(error),
        userId: context.userId,
        clientName: context.clientName,
      });
      this.observe(operation, 'error', started);
      // FIX: SEC-MEM-01 — Sanitize error messages to prevent credential/path leakage (OWASP LLM07).
      const rawMsg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${sanitizeError(rawMsg)}` }],
        isError: true,
      };
    }
  }

  // ── Tool Handlers ───────────────────────────────────────────────

  private async addMemories(
    args: Record<string, unknown>,
    context: McpSessionContext,
  ): Promise<McpToolResult> {
    const text = args.text as string | undefined;
    if (!text || typeof text !== 'string') {
      return { content: [{ type: 'text', text: 'Error: text parameter is required' }], isError: true };
    }
    // FIX: MCPS-H4 — Validate text length to prevent OOM/DoS via oversized payloads.
    if (text.length > MAX_MEMORY_TEXT_LENGTH) {
      return {
        content: [{ type: 'text', text: `Error: text exceeds maximum length of ${MAX_MEMORY_TEXT_LENGTH} characters` }],
        isError: true,
      };
    }

    const result = await this.memoryProvider.add(
      [{ role: 'user', content: text }],
      {
        user_id: context.userId,
        output_format: 'v1.1',
        metadata: {
          source_app: 'mcp',
          mcp_client: context.clientName,
        },
      },
    );

    this.log.info('MCP add_memories', {
      userId: context.userId,
      clientName: context.clientName,
      resultCount: result.results?.length ?? 0,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  private async searchMemory(
    args: Record<string, unknown>,
    context: McpSessionContext,
  ): Promise<McpToolResult> {
    const query = args.query as string | undefined;
    if (!query || typeof query !== 'string') {
      return { content: [{ type: 'text', text: 'Error: query parameter is required' }], isError: true };
    }

    const results = await this.memoryProvider.search(query, {
      user_id: context.userId,
      top_k: 10,
    });

    const formatted = results.map((r) => ({
      id: r.id,
      memory: r.content,
      score: r.score,
      created_at: r.createdAt,
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify({ results: formatted }, null, 2) }],
    };
  }

  private async listMemories(context: McpSessionContext): Promise<McpToolResult> {
    const memories = await this.memoryProvider.getAll({
      user_id: context.userId,
    });

    const formatted = memories.map((m) => ({
      id: m.id,
      memory: m.content,
      created_at: m.createdAt,
      categories: m.categories,
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
    };
  }

  private async deleteMemories(
    args: Record<string, unknown>,
    context: McpSessionContext,
  ): Promise<McpToolResult> {
    const memoryIds = args.memory_ids as string[] | undefined;
    if (!memoryIds || !Array.isArray(memoryIds) || memoryIds.length === 0) {
      return { content: [{ type: 'text', text: 'Error: memory_ids parameter is required (non-empty array)' }], isError: true };
    }
    // FIX: MCPS-H5 — Validate array element types (prevent injection of non-string values)
    // and enforce max batch size to prevent abuse.
    if (memoryIds.length > MAX_MEMORY_IDS) {
      return {
        content: [{ type: 'text', text: `Error: memory_ids exceeds maximum batch size of ${MAX_MEMORY_IDS}` }],
        isError: true,
      };
    }
    for (const id of memoryIds) {
      if (typeof id !== 'string' || id.trim().length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: each memory_id must be a non-empty string' }],
          isError: true,
        };
      }
    }

    let deletedCount = 0;
    const errors: string[] = [];

    for (const id of memoryIds) {
      try {
        await this.memoryProvider.delete(id);
        deletedCount++;
      } catch (error) {
        const errMsg = sanitizeError(error instanceof Error ? error.message : String(error));
        errors.push(`Failed to delete ${id}: ${errMsg}`);
        this.log.warn('mcp_delete_memory_error', { memoryId: id, error: errMsg });
      }
    }

    this.log.info('MCP delete_memories', {
      userId: context.userId,
      clientName: context.clientName,
      requested: memoryIds.length,
      deleted: deletedCount,
    });

    const message = errors.length > 0
      ? `Deleted ${deletedCount}/${memoryIds.length} memories. Errors: ${errors.join('; ')}`
      : `Successfully deleted ${deletedCount} memories`;

    return { content: [{ type: 'text', text: message }] };
  }

  private async deleteAllMemories(context: McpSessionContext): Promise<McpToolResult> {
    await this.memoryProvider.deleteAll({ user_id: context.userId });

    this.log.info('MCP delete_all_memories', {
      userId: context.userId,
      clientName: context.clientName,
    });

    return { content: [{ type: 'text', text: 'Successfully deleted all memories' }] };
  }

  private async memoryStatus(
    args: Record<string, unknown>,
    context: McpSessionContext,
  ): Promise<McpToolResult> {
    const tenantId = this.resolveTenantId(args, context);
    const sessionId = this.resolveSessionId(args, context);
    const accessibleMemories = (await this.memoryProvider.getAll({ user_id: context.userId })) ?? [];
    const workingEntries = this.deps.workingMemory
      ? await this.deps.workingMemory.getEntries({ tenantId, sessionId, limit: 25 })
      : [];
    const archivalStatus = this.deps.archivalMemory
      ? await this.deps.archivalMemory.getStatus()
      : { available: false, itemCount: 0 };
    const graphFacts = this.deps.graphMemoryEngine
      ? await this.deps.graphMemoryEngine.getAll(
          { tenantId, userId: context.userId, correlationId: context.sessionId },
          250,
        )
      : [];

    let adaptive: Record<string, unknown> = { available: false };
    if (this.deps.adaptiveMemoryRetrieval) {
      await this.deps.adaptiveMemoryRetrieval.whenReady?.();
      const stats = this.deps.adaptiveMemoryRetrieval.getStats();
      adaptive = {
        available: true,
        totalRetrievals: stats.totalRetrievals,
        avgTipsReturned: stats.avgTipsReturned,
        avgRelevanceScore: stats.avgRelevanceScore,
        topCategories: stats.topCategories,
      };
    }

    const structured = {
      scope: {
        userId: context.userId,
        tenantId,
        sessionId,
        clientName: context.clientName,
      },
      provider: {
        available: true,
        memoryCount: accessibleMemories.length,
      },
      workingMemory: {
        available: this.deps.workingMemory !== undefined,
        entryCount: workingEntries.length,
      },
      archivalMemory: archivalStatus,
      graphMemory: {
        available: this.deps.graphMemoryEngine !== undefined,
        factCount: graphFacts.length,
      },
      adaptiveRetrieval: adaptive,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
      structuredContent: structured,
    };
  }

  private async memoryWakeUp(
    args: Record<string, unknown>,
    context: McpSessionContext,
  ): Promise<McpToolResult> {
    const tenantId = this.resolveTenantId(args, context);
    const sessionId = this.resolveSessionId(args, context);
    const focusQuery = this.readStringArg(args, 'query') ?? this.readStringArg(args, 'graph_entity') ?? 'memory wake-up';
    const graphEntity = this.readStringArg(args, 'graph_entity');
    const workingLimit = this.readPositiveIntArg(args, 'working_limit', 5);
    const archivalLimit = this.readPositiveIntArg(args, 'archival_limit', 5);
    const graphLimit = this.readPositiveIntArg(args, 'graph_limit', 5);

    const workingEntries = this.deps.workingMemory
      ? await this.deps.workingMemory.getEntries({ tenantId, sessionId, limit: workingLimit })
      : [];
    const archivalHits = this.deps.archivalMemory
      ? await this.deps.archivalMemory.search(focusQuery, archivalLimit, tenantId)
      : [];
    const graphFacts = this.deps.graphMemoryEngine && graphEntity
      ? await this.deps.graphMemoryEngine.queryEntity(
          graphEntity,
          { tenantId, userId: context.userId, correlationId: context.sessionId },
          { direction: 'both', limit: graphLimit },
        )
      : [];

    let tipInjection: ReturnType<IAdaptiveMemoryRetrieval['retrieveAndInject']> | null = null;
    if (this.deps.adaptiveMemoryRetrieval) {
      await this.deps.adaptiveMemoryRetrieval.whenReady?.();
      tipInjection = this.deps.adaptiveMemoryRetrieval.retrieveAndInject(focusQuery, []);
    }

    const sections: string[] = ['## Memory Wake-Up'];
    if (workingEntries.length > 0) {
      sections.push(`### Working Memory\n${workingEntries.map((entry) => `- ${entry.summary}`).join('\n')}`);
    }
    if (archivalHits.length > 0) {
      sections.push(`### Archival Memory\n${archivalHits.map((hit) => `- ${hit.content} [${hit.source}]`).join('\n')}`);
    }
    if (graphFacts.length > 0) {
      sections.push(
        `### Graph Facts\n${graphFacts.map((fact) => `- ${fact.source} -> ${fact.relationship} -> ${fact.destination}${fact.validFrom ? ` (${fact.validFrom}${fact.validTo ? ` to ${fact.validTo}` : ' current'})` : ''}`).join('\n')}`,
      );
    }
    if (tipInjection?.guidelinesSection) {
      sections.push(`### Guidance\n${tipInjection.guidelinesSection}`);
    }

    const structured = {
      scope: {
        userId: context.userId,
        tenantId,
        sessionId,
      },
      focus: {
        query: focusQuery,
        graphEntity,
      },
      workingMemory: workingEntries,
      archivalHits,
      graphFacts,
      tipInjection,
    };

    return {
      content: [{ type: 'text', text: sections.join('\n\n') }],
      structuredContent: structured,
    };
  }

  // ── Observability ─────────────────────────────────────────────────

  private readStringArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private readPositiveIntArg(args: Record<string, unknown>, key: string, fallback: number): number {
    const value = args[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }

    return Math.max(1, Math.trunc(value));
  }

  private resolveTenantId(args: Record<string, unknown>, context: McpSessionContext): string {
    return this.readStringArg(args, 'tenant_id') ?? context.userId;
  }

  private resolveSessionId(args: Record<string, unknown>, context: McpSessionContext): string {
    return this.readStringArg(args, 'session_id') ?? context.sessionId;
  }

  private observe(operation: McpOperation, outcome: McpOutcome, started: bigint): void {
    const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    try {
      mcpRequestsTotal.labels(operation, outcome).inc();
      mcpRequestDurationSeconds.labels(operation, outcome).observe(durationSeconds);
    } catch {
      // best-effort metrics
    }
  }
}
