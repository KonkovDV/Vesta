import type { PluginDescriptor, PluginExecutionContext } from './plugin-types';
import type { NormalizedResultCore } from '../../core/plugins/normalized-result';
import { readInt } from '../../core/config/app-config';

export interface IPluginExecutor {
  execute<TInput = unknown, TData = unknown>(
    descriptor: PluginDescriptor,
    input: TInput,
    context: PluginExecutionContext,
  ): Promise<NormalizedResultCore<TData>>;
}

const DEFAULT_PLUGIN_SANDBOX_TIMEOUT_MS = 10_000;

function resolveDefaultSandboxTimeoutMs(): number {
  const value = readInt('PLUGIN_SANDBOX_TIMEOUT_MS', DEFAULT_PLUGIN_SANDBOX_TIMEOUT_MS);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_PLUGIN_SANDBOX_TIMEOUT_MS;
  }
  return value;
}

/**
 * Error thrown when plugin execution exceeds the configured sandbox timeout.
 *
 * This error type is handled specially by UnifiedPluginRegistry to surface a
 * distinct sandbox error_type to callers and observability.
 */
export class PluginSandboxTimeoutError extends Error {
  constructor(
    message: string,
    public readonly pluginName?: string,
    public readonly timeoutMs?: number,
  ) {
    super(message);
    this.name = 'PluginSandboxTimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Minimal in-memory plugin executor.
 *
 * v1:
 * - keeps a map of handlers keyed by entrypoint.ref;
 * - returns NormalizedResultCore with typed success/error_detail;
 * - does not know anything about manifests or policies.
 *
 * v1.1:
 * - enforces a simple wall-clock sandbox timeout around plugin handler
 *   execution. On timeout, a PluginSandboxTimeoutError is thrown instead of
 *   returning a normal failure result.
 */
export class PluginExecutor implements IPluginExecutor {
  constructor(
    private readonly handlers: Map<
      string,
      (input: unknown, ctx: PluginExecutionContext) => Promise<unknown> | unknown
    > = new Map(),
    /**
     * Wall-clock sandbox timeout for plugin execution in milliseconds.
     *
     * Default is 10 seconds. It can be overridden via the
     * PHOENIX_PLUGIN_SANDBOX_TIMEOUT_MS environment variable (must be a
     * positive integer), or via the constructor argument in tests.
     */
    private readonly timeoutMs: number = resolveDefaultSandboxTimeoutMs(),
  ) {}

  registerHandler(
    ref: string,
    handler: (input: unknown, ctx: PluginExecutionContext) => Promise<unknown> | unknown,
  ): void {
    this.handlers.set(ref, handler);
  }

  async execute<TInput, TData>(
    descriptor: PluginDescriptor,
    input: TInput,
    context: PluginExecutionContext,
  ): Promise<NormalizedResultCore<TData>> {
    const handler = this.handlers.get(descriptor.entrypoint.ref);
    if (!handler) {
      return {
        success: false,
        data: null,
        error_detail: {
          error_type: 'PluginHandlerNotFound',
          plugin_name: descriptor.id.name,
          plugin_version: descriptor.id.version,
          entrypoint_ref: descriptor.entrypoint.ref,
        },
      };
    }

    try {
      const result = await this.runHandlerWithTimeout(handler, descriptor, input, context);
      return {
        success: true,
        data: result as TData,
      };
    } catch (error) {
      if (error instanceof PluginSandboxTimeoutError) {
        // Let the caller (UnifiedPluginRegistry) distinguish sandbox timeouts
        // from regular handler failures.
        throw error;
      }

      return {
        success: false,
        data: null,
        error_detail: {
          error_type: error instanceof Error ? error.name : 'UnknownError',
          error_message: error instanceof Error ? error.message : String(error),
          plugin_name: descriptor.id.name,
          plugin_version: descriptor.id.version,
        },
      };
    }
  }

  private runHandlerWithTimeout(
    handler: (input: unknown, ctx: PluginExecutionContext) => Promise<unknown> | unknown,
    descriptor: PluginDescriptor,
    input: unknown,
    context: PluginExecutionContext,
  ): Promise<unknown> {
    const effectiveTimeoutMs = this.timeoutMs;

    // If timeout is disabled or misconfigured, fall back to direct execution.
    if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
      return Promise.resolve(handler(input, context));
    }

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;

        const error = new PluginSandboxTimeoutError(
          `Plugin "${descriptor.id.name}" execution exceeded sandbox timeout of ${effectiveTimeoutMs}ms`,
          descriptor.id.name,
          effectiveTimeoutMs,
        );
        reject(error);
      }, effectiveTimeoutMs);

      Promise.resolve()
        .then(() => handler(input, context))
        .then(
          (result) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(result);
          },
          (error) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            reject(error);
          },
        );
    });
  }
}