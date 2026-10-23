/**
 * HookManager — lifecycle hook registration and trigger orchestration.
 *
 * Ported from OpenClaw hooks/internal-hooks.ts (8 KB).
 * Provides a simple event-key based hook system for internal lifecycle events
 * (before_reply, after_reply, before_tool, after_tool, etc.).
 *
 * Unlike the plugin hook runner (which is plugin-registry-aware), HookManager
 * is a standalone event bus for internal system hooks used by core services.
 *
 * Layer: Infrastructure (Hooks).
 *
 * Implements ILifecycleHookManager port (src/application/ports/ILifecycleHookManager.ts)
 * for DIP-compliant injection into Application services (AutoRecallService, AutoCaptureService).
 */

import type { ILifecycleHookManager } from '../../domain/hooks/ILifecycleHookManager';
import { HookExecutionError } from '../../domain/errors/DomainError';

// ── Types ────────────────────────────────────────────────────────────

export type HookEventKey =
  | 'before_reply'
  | 'after_reply'
  | 'before_tool'
  | 'after_tool'
  | 'session_start'
  | 'session_end'
  | 'agent_start'
  | 'agent_end'
  | 'error';

export type HookHandler<T = unknown> = (event: T) => void | Promise<void>;

export type HookRegistration = {
  id: string;
  eventKey: HookEventKey;
  handler: HookHandler;
  priority?: number;
};

export type HookManagerLogger = {
  debug?: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type HookManagerOptions = {
  logger?: HookManagerLogger;
  /** If true, errors in handlers are caught and logged. Default: true. */
  catchErrors?: boolean;
};

// ── HookManager class ────────────────────────────────────────────────

export class HookManager implements ILifecycleHookManager {
  private registrations = new Map<HookEventKey, HookRegistration[]>();
  private idCounter = 0;
  private readonly logger?: HookManagerLogger;
  private readonly catchErrors: boolean;

  constructor(options: HookManagerOptions = {}) {
    this.logger = options.logger;
    this.catchErrors = options.catchErrors ?? true;
  }

  /**
   * Register a hook handler for an event key.
   * Returns a unique registration ID that can be used to unregister.
   */
  register<T = unknown>(
    eventKey: HookEventKey,
    handler: HookHandler<T>,
    priority?: number,
  ): string {
    const id = `hook_${++this.idCounter}`;
    const registration: HookRegistration = {
      id,
      eventKey,
      handler: handler as HookHandler,
      priority,
    };

    let handlers = this.registrations.get(eventKey);
    if (!handlers) {
      handlers = [];
      this.registrations.set(eventKey, handlers);
    }
    handlers.push(registration);

    this.logger?.debug?.(`[HookManager] Registered ${eventKey} handler (id=${id}, priority=${priority ?? 0})`);
    return id;
  }

  /**
   * Unregister a specific hook by registration ID.
   */
  unregister(registrationId: string): boolean {
    for (const [key, handlers] of this.registrations.entries()) {
      const idx = handlers.findIndex((h) => h.id === registrationId);
      if (idx >= 0) {
        handlers.splice(idx, 1);
        if (handlers.length === 0) this.registrations.delete(key);
        this.logger?.debug?.(`[HookManager] Unregistered handler ${registrationId}`);
        return true;
      }
    }
    return false;
  }

  /**
   * Unregister all hooks for an event key.
   */
  unregisterAll(eventKey: HookEventKey): number {
    const handlers = this.registrations.get(eventKey);
    if (!handlers) return 0;
    const count = handlers.length;
    this.registrations.delete(eventKey);
    return count;
  }

  /**
   * Trigger all handlers for an event key. Runs sequentially by priority (DESC).
   */
  async trigger<T = unknown>(eventKey: HookEventKey, event: T): Promise<void> {
    const handlers = this.registrations.get(eventKey);
    if (!handlers || handlers.length === 0) return;

    // Sort by priority DESC (higher priority first)
    const sorted = handlers.slice().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    this.logger?.debug?.(`[HookManager] Triggering ${eventKey} (${sorted.length} handlers)`);

    for (const registration of sorted) {
      try {
        await registration.handler(event);
      } catch (err) {
        const msg = `[HookManager] ${eventKey} handler ${registration.id} failed: ${String(err)}`;
        if (this.catchErrors) {
          this.logger?.error(msg);
        } else {
          throw new HookExecutionError(eventKey, registration.id, {
            cause: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    }
  }

  /**
   * Trigger all handlers in parallel (fire-and-forget).
   */
  async triggerParallel<T = unknown>(eventKey: HookEventKey, event: T): Promise<void> {
    const handlers = this.registrations.get(eventKey);
    if (!handlers || handlers.length === 0) return;

    this.logger?.debug?.(`[HookManager] Triggering ${eventKey} parallel (${handlers.length} handlers)`);

    const promises = handlers.map(async (registration) => {
      try {
        await registration.handler(event);
      } catch (err) {
        const msg = `[HookManager] ${eventKey} handler ${registration.id} failed: ${String(err)}`;
        if (this.catchErrors) {
          this.logger?.error(msg);
        } else {
          throw new HookExecutionError(eventKey, registration.id, {
            cause: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    });

    if (this.catchErrors) {
      await Promise.allSettled(promises);
    } else {
       
      await Promise.all(promises);
    }
  }

  /**
   * Get all registered event keys.
   */
  getRegisteredEventKeys(): HookEventKey[] {
    return Array.from(this.registrations.keys());
  }

  /**
   * Get handler count for a specific event key.
   */
  getHandlerCount(eventKey: HookEventKey): number {
    return this.registrations.get(eventKey)?.length ?? 0;
  }

  /**
   * Check if any handlers are registered for an event key.
   */
  hasHandlers(eventKey: HookEventKey): boolean {
    const handlers = this.registrations.get(eventKey);
    return Boolean(handlers && handlers.length > 0);
  }

  /**
   * Clear all registrations.
   */
  clear(): void {
    this.registrations.clear();
    this.idCounter = 0;
  }
}
