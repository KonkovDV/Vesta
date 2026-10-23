// ── Shared MCP Utilities ───────────────────────────────────────
// Extracted from MicroPhoenixMcpServer + MicroPhoenixDocsMcpServer
// to eliminate code duplication (DRY principle).

import type { ServerContext } from '@modelcontextprotocol/server';

/** Tool handler context from MCP server v2. */
export type McpToolExtra = ServerContext;

/**
 * Canonical architecture layers — SSOT (Single Source of Truth).
 * Used by: LayerRulesLoader, LAYER_DEPS (Docs Server), DependencyGraphIndex, tests.
 * 10-Layer architecture, but MCP tools expose 4 code layers + tests layer.
 */
export const CANONICAL_LAYERS = ['domain', 'application', 'core', 'infrastructure'] as const;
export type CanonicalLayer = typeof CANONICAL_LAYERS[number];

/**
 * Layer dependency map — SSOT for all MCP components.
 * Domain depends on Core only; Application on Domain+Core; etc.
 * The 'tests' layer is included because MCP tools need it for file placement guidance.
 */
export const LAYER_DEPS: Readonly<Record<string, readonly string[]>> = {
  domain: ['core'],
  application: ['domain', 'core', 'monitoring'],
  core: [],
  infrastructure: ['domain', 'application', 'core', 'monitoring'],
  monitoring: ['core'],
  tests: ['domain', 'application', 'core', 'infrastructure', 'monitoring'],
} as const;

/** MCP convention: logs go to stderr, stdout is reserved for JSON-RPC. */
export function mcpLog(event: string, data?: Record<string, unknown>): void {
  const entry = { event, ts: new Date().toISOString(), ...data };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

/** MCP spec 2025-11-25 ToolAnnotations — all tools are read-only. */
export const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * MCP spec 2025-11-25 ToolAnnotations — read-only tools with task support.
 * For long-running tools (e.g., preflight) that benefit from task-augmented execution.
 * @see https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
 */
export const READ_ONLY_TOOL_ANNOTATIONS_WITH_TASK = {
  ...READ_ONLY_TOOL_ANNOTATIONS,
} as const;

/**
 * MCP spec 2025-11-25 — execution metadata for tools that support tasks.
 * @see SEP-1686 — experimental tasks for durable request tracking
 */
export const TASK_EXECUTION_OPTIONAL = {
  taskSupport: 'optional' as const,
} as const;

/**
 * Formats an unhandled tool error into MCP-compliant isError response.
 * MCP spec 2025-11-25: "Tool Execution Errors: Reported in tool results with isError: true."
 * SEP-1303: Input validation errors → Tool Execution Errors (not Protocol Errors) for model self-correction.
 *
 * @param toolName - Tool that threw the error
 * @param err - The caught error (Error | unknown)
 * @param toYaml - Serializer function (injected to avoid cross-path import issues)
 */
export function handleToolError(
  toolName: string,
  err: unknown,
  toYaml: (obj: unknown) => string,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  mcpLog('mcp.tool.error', { tool: toolName, error: message });
  const detail = message.length > 200 ? message.slice(0, 200) + '...' : message;
  return {
    content: [
      {
        type: 'text' as const,
        text: toYaml({ error: `Internal error in ${toolName}`, detail }),
      },
    ],
    isError: true,
  };
}

/**
 * Detect architecture layer from a source file path.
 *
 * FIX: MCPS-M7 — Extracted to shared utility to eliminate duplication
 * between MicroPhoenixDocsMcpServer and other MCP components.
 *
 * @param filePath - File path (Unix or Windows separators)
 * @returns Canonical layer name or 'unknown'
 */
export function detectLayer(filePath: string): string {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  if (p.includes('src/domain/')) return 'domain';
  if (p.includes('src/application/')) return 'application';
  if (p.includes('src/core/')) return 'core';
  if (p.includes('src/infrastructure/')) return 'infrastructure';
  if (p.includes('src/monitoring/')) return 'monitoring';
  if (p.includes('tests/')) return 'tests';
  return 'unknown';
}

// ─── Credential Patterns (OWASP LLM07) ──────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9_\-.~+/]+=*/gi,
  /Authorization:\s*\S+/gi,
  /(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi,
  /ghp_[A-Za-z0-9]{36}/g,   // GitHub PAT
  /sk-[A-Za-z0-9]{20,}/g,    // OpenAI key
  /postgres(?:ql)?:\/\/[^\s]+/gi,  // Postgres connection strings
  /redis:\/\/[^\s]+/gi,            // Redis connection strings
];

/**
 * Strip credentials and sensitive data from error messages.
 * Prevents information leakage to LLM / external callers (OWASP LLM07).
 *
 * @param msg - Raw error message that may contain secrets
 * @returns Sanitized message with credentials replaced by [REDACTED]
 */
export function sanitizeError(msg: string): string {
  let sanitized = msg;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

/**
 * Canonical toYaml serializer — re-exported from SSOT location for convenience.
 * Import from here or from '../context/utils/yaml' — both resolve to the same canonical source.
 */
export { toYaml } from '../context/utils/yaml';
