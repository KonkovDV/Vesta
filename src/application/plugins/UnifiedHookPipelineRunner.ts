/**
 * UnifiedHookPipelineRunner — Consolidated hook dispatch
 *
 * Replaces the dual invocation of ILifecycleHookManager (9 hooks, sequential) +
 * PluginHookRunner (20 hooks, void/modify/sync modes) with a single pipeline.
 *
 * All 23 hook points are routed through this runner:
 * - fire-and-forget: parallel execution, errors swallowed
 * - sequential: priority-sorted sequential, first error aborts
 * - modify: sequential with payload transformation
 *
 * @layer Application
 * @phase 13 — Plugin Hook Pipeline (OpenClaw extraction)
 * @donor external/openclaw/src/plugins/hook-runner.ts — consolidated
 */

import type {
  IHookPipeline,
  UnifiedHookName,
  HookMode,
  HookRegistration,
} from '../../domain/plugins/hook-pipeline.interface';
import { HOOK_METADATA } from '../../domain/plugins/hook-pipeline.interface';
import { InfrastructureError } from '../../domain/errors/DomainError';

// ─── Error Type ──────────────────────────────────────────────────────────────

export class PluginHookExecutionError extends InfrastructureError {
  constructor(
    hookName: string,
    source: string,
    message: string,
    options?: { correlationId?: string; cause?: Error },
  ) {
    super(`Hook '${hookName}' handler from '${source}' failed: ${message}`, {
      correlationId: options?.correlationId,
      metadata: { hookName, source },
      cause: options?.cause,
    });
  }
}

// ─── Logger Interface ────────────────────────────────────────────────────────

interface PipelineLogger {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class UnifiedHookPipelineRunner implements IHookPipeline {
  private readonly registrations = new Map<UnifiedHookName, HookRegistration[]>();
  private idCounter = 0;
  private readonly logger?: PipelineLogger;

  constructor(logger?: PipelineLogger) {
    this.logger = logger;
  }

  // ─── Registration ────────────────────────────────────────────────────

  register(
    hookName: UnifiedHookName,
    handler: (event: unknown, ctx?: unknown) => unknown | Promise<unknown>,
    options?: { priority?: number; source?: string },
  ): string {
    const id = `uhook_${++this.idCounter}`;
    const registration: HookRegistration = {
      id,
      hookName,
      handler,
      priority: options?.priority ?? 0,
      source: options?.source ?? 'system',
    };

    let handlers = this.registrations.get(hookName);
    if (!handlers) {
      handlers = [];
      this.registrations.set(hookName, handlers);
    }
    handlers.push(registration);

    this.logger?.debug?.(`[HookPipeline] Registered ${hookName} handler (id=${id}, priority=${registration.priority}, source=${registration.source})`);
    return id;
  }

  unregister(registrationId: string): boolean {
    for (const [key, handlers] of this.registrations.entries()) {
      const idx = handlers.findIndex((h) => h.id === registrationId);
      if (idx >= 0) {
        handlers.splice(idx, 1);
        if (handlers.length === 0) this.registrations.delete(key);
        this.logger?.debug?.(`[HookPipeline] Unregistered handler ${registrationId}`);
        return true;
      }
    }
    return false;
  }

  hasHandlers(hookName: UnifiedHookName): boolean {
    const handlers = this.registrations.get(hookName);
    return Boolean(handlers && handlers.length > 0);
  }

  getHandlerCount(hookName: UnifiedHookName): number {
    return this.registrations.get(hookName)?.length ?? 0;
  }

  getRegisteredHooks(): UnifiedHookName[] {
    return Array.from(this.registrations.keys());
  }

  // ─── Emit ────────────────────────────────────────────────────────────

  async emit(
    hook: UnifiedHookName,
    payload: unknown,
    mode?: HookMode,
    ctx?: unknown,
  ): Promise<void> {
    const handlers = this.getSortedHandlers(hook);
    if (handlers.length === 0) return;

    const effectiveMode = mode ?? HOOK_METADATA[hook]?.defaultMode ?? 'fire-and-forget';

    this.logger?.debug?.(`[HookPipeline] Emitting ${hook} (${handlers.length} handlers, mode=${effectiveMode})`);

    switch (effectiveMode) {
      case 'fire-and-forget':
        await this.runFireAndForget(hook, handlers, payload, ctx);
        break;
      case 'sequential':
        await this.runSequential(hook, handlers, payload, ctx);
        break;
      case 'modify':
        await this.runModify(hook, handlers, payload, ctx);
        break;
    }
  }

  // ─── Transform ───────────────────────────────────────────────────────

  async transform<T>(hook: UnifiedHookName, payload: T, ctx?: unknown): Promise<T> {
    const handlers = this.getSortedHandlers(hook);
    if (handlers.length === 0) return payload;

    this.logger?.debug?.(`[HookPipeline] Transforming ${hook} (${handlers.length} handlers)`);

    let current: T = payload;

    for (const reg of handlers) {
      try {
        const result = await reg.handler(current, ctx);
        if (result !== undefined && result !== null) {
          current = result as T;
        }
      } catch (err) {
        this.logger?.error(`[HookPipeline] Transform ${hook} handler from ${reg.source} failed: ${String(err)}`, {
          hookName: hook,
          source: reg.source,
          handlerId: reg.id,
        });
        throw new PluginHookExecutionError(hook, reg.source, String(err), {
          cause: err instanceof Error ? err : undefined,
        });
      }
    }

    return current;
  }

  // ─── Execution Modes ─────────────────────────────────────────────────

  private async runFireAndForget(
    hook: UnifiedHookName,
    handlers: HookRegistration[],
    payload: unknown,
    ctx?: unknown,
  ): Promise<void> {
    const promises = handlers.map(async (reg) => {
      try {
        await reg.handler(payload, ctx);
      } catch (err) {
        this.logger?.error(`[HookPipeline] ${hook} handler from ${reg.source} failed (swallowed): ${String(err)}`, {
          hookName: hook,
          source: reg.source,
        });
      }
    });

    await Promise.all(promises);
  }

  private async runSequential(
    hook: UnifiedHookName,
    handlers: HookRegistration[],
    payload: unknown,
    ctx?: unknown,
  ): Promise<void> {
    for (const reg of handlers) {
      try {
        await reg.handler(payload, ctx);
      } catch (err) {
        this.logger?.error(`[HookPipeline] ${hook} handler from ${reg.source} failed (aborting chain): ${String(err)}`, {
          hookName: hook,
          source: reg.source,
        });
        throw new PluginHookExecutionError(hook, reg.source, String(err), {
          cause: err instanceof Error ? err : undefined,
        });
      }
    }
  }

  private async runModify(
    hook: UnifiedHookName,
    handlers: HookRegistration[],
    payload: unknown,
    ctx?: unknown,
  ): Promise<void> {
    // Modify mode in emit() doesn't return the result; use transform() for that.
    // Here we just run sequentially allowing handlers to mutate state via ctx.
    for (const reg of handlers) {
      try {
        await reg.handler(payload, ctx);
      } catch (err) {
        this.logger?.error(`[HookPipeline] ${hook} handler from ${reg.source} failed: ${String(err)}`, {
          hookName: hook,
          source: reg.source,
        });
        // Modify mode swallows errors by default (like void)
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private getSortedHandlers(hook: UnifiedHookName): HookRegistration[] {
    const handlers = this.registrations.get(hook);
    if (!handlers || handlers.length === 0) return [];
    return handlers.slice().sort((a, b) => b.priority - a.priority);
  }
}
