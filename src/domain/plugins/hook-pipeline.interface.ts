/**
 * Hook Pipeline Domain Interface
 *
 * Unified contract for all hook dispatch:
 * - `fire-and-forget`: parallel execution, errors swallowed (old void mode)
 * - `sequential`: priority-sorted sequential, first error aborts (old HookManager pattern)
 * - `modify`: sequential with payload transformation, returns modified payload
 *
 * Consolidates ILifecycleHookManager (9 hooks) + PluginHookRunner (20 hooks) + 3 new subagent hooks.
 *
 * @layer Domain
 * @phase 13 — Plugin Hook Pipeline (OpenClaw extraction)
 * @donor external/openclaw/src/plugins/hooks.ts — adapted for unified dispatch model
 */

// ─── Hook Mode ───────────────────────────────────────────────────────────────

/**
 * Execution mode for hook dispatch.
 */
export type HookMode = 'fire-and-forget' | 'sequential' | 'modify';

// ─── Hook Names ──────────────────────────────────────────────────────────────

/**
 * All 23 hook points in the unified pipeline.
 *
 * 20 from PluginHookRunner + 3 new subagent hooks.
 * ILifecycleHookManager's 9 hooks map onto these (see HOOK_METADATA).
 */
export type UnifiedHookName =
  // Agent
  | 'before_model_resolve'
  | 'before_prompt_build'
  | 'before_agent_start'
  | 'agent_end'
  | 'llm_input'
  | 'llm_output'
  | 'before_compaction'
  | 'after_compaction'
  | 'before_reset'
  // Message
  | 'message_received'
  | 'message_sending'
  | 'message_sent'
  // Tool
  | 'before_tool_call'
  | 'after_tool_call'
  | 'tool_result_persist'
  | 'before_message_write'
  // Session
  | 'session_start'
  | 'session_end'
  // Gateway
  | 'gateway_start'
  | 'gateway_stop'
  // Subagent (Phase 13 — new)
  | 'subagent_spawning'
  | 'subagent_spawned'
  | 'subagent_ended';

/**
 * Default execution mode per hook name.
 *
 * This metadata table defines the natural execution mode for each hook.
 * Can be overridden by explicit `mode` parameter in `emit()`.
 */
export const HOOK_METADATA: Record<UnifiedHookName, { defaultMode: HookMode; description: string }> = {
  // Agent hooks
  before_model_resolve: { defaultMode: 'modify', description: 'Plugin override for model/provider selection' },
  before_prompt_build: { defaultMode: 'modify', description: 'Inject system prompt or prepend context' },
  before_agent_start: { defaultMode: 'modify', description: 'Model/prompt overrides before agent starts' },
  agent_end: { defaultMode: 'fire-and-forget', description: 'Agent execution completed' },
  llm_input: { defaultMode: 'fire-and-forget', description: 'LLM request sent (telemetry)' },
  llm_output: { defaultMode: 'fire-and-forget', description: 'LLM response received (telemetry)' },
  before_compaction: { defaultMode: 'fire-and-forget', description: 'Before context window compaction' },
  after_compaction: { defaultMode: 'fire-and-forget', description: 'After context window compaction' },
  before_reset: { defaultMode: 'fire-and-forget', description: 'Before session reset' },
  // Message hooks
  message_received: { defaultMode: 'fire-and-forget', description: 'Inbound message received' },
  message_sending: { defaultMode: 'modify', description: 'Outbound message about to be sent (can modify/cancel)' },
  message_sent: { defaultMode: 'fire-and-forget', description: 'Outbound message sent (telemetry)' },
  // Tool hooks
  before_tool_call: { defaultMode: 'modify', description: 'Before tool execution (can block or modify params)' },
  after_tool_call: { defaultMode: 'fire-and-forget', description: 'After tool execution' },
  tool_result_persist: { defaultMode: 'modify', description: 'Transform tool result before persistence (sync)' },
  before_message_write: { defaultMode: 'modify', description: 'Before message persisted (can block or modify)' },
  // Session hooks
  session_start: { defaultMode: 'fire-and-forget', description: 'Session opened' },
  session_end: { defaultMode: 'fire-and-forget', description: 'Session closed' },
  // Gateway hooks
  gateway_start: { defaultMode: 'fire-and-forget', description: 'Gateway started' },
  gateway_stop: { defaultMode: 'fire-and-forget', description: 'Gateway stopped' },
  // Subagent hooks (new in Phase 13)
  subagent_spawning: { defaultMode: 'modify', description: 'Before subagent spawn (can modify config or block)' },
  subagent_spawned: { defaultMode: 'fire-and-forget', description: 'Subagent spawned (telemetry)' },
  subagent_ended: { defaultMode: 'fire-and-forget', description: 'Subagent execution ended' },
};

// ─── Hook Handler Registration ───────────────────────────────────────────────

/**
 * Handler registration for the unified pipeline.
 */
export interface HookRegistration {
  readonly id: string;
  readonly hookName: UnifiedHookName;
  readonly handler: (event: unknown, ctx?: unknown) => unknown | Promise<unknown>;
  readonly priority: number;
  readonly source: string; // plugin id or 'system'
}

// ─── Port Interface ──────────────────────────────────────────────────────────

/**
 * Unified hook pipeline interface.
 *
 * Replaces dual invocation of ILifecycleHookManager + PluginHookRunner
 * with a single DI-resolved service.
 */
export interface IHookPipeline {
  /**
   * Emit a hook event.
   *
   * Mode behavior:
   * - 'fire-and-forget': parallel execution, errors logged but swallowed
   * - 'sequential': priority-sorted sequential, first error aborts chain
   * - 'modify': (use `transform()` instead for type safety)
   *
   * Defaults to the hook's natural mode from HOOK_METADATA.
   */
  emit(hook: UnifiedHookName, payload: unknown, mode?: HookMode, ctx?: unknown): Promise<void>;

  /**
   * Transform payload through hook handlers sequentially.
   * Always runs in 'modify' mode — returns the transformed payload.
   */
  transform<T>(hook: UnifiedHookName, payload: T, ctx?: unknown): Promise<T>;

  /**
   * Register a handler for a hook.
   * @returns Registration ID for unregistration
   */
  register(
    hookName: UnifiedHookName,
    handler: (event: unknown, ctx?: unknown) => unknown | Promise<unknown>,
    options?: { priority?: number; source?: string },
  ): string;

  /**
   * Unregister a handler by registration ID.
   */
  unregister(registrationId: string): boolean;

  /**
   * Check if any handlers are registered for a hook.
   */
  hasHandlers(hookName: UnifiedHookName): boolean;

  /**
   * Get handler count for a hook.
   */
  getHandlerCount(hookName: UnifiedHookName): number;

  /**
   * Get all registered hook names.
   */
  getRegisteredHooks(): UnifiedHookName[];
}
