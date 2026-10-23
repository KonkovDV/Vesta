/**
 * MicroPhoenix Plugin Interface - core contract for plugin lifecycle
 * Layer: Domain (contracts)
 *
 * Defines the fundamental interface that all MicroPhoenix plugins MUST implement.
 * Provides lifecycle hooks for safe initialization and cleanup.
 *
 * Architecture:
 * - Domain layer defines this contract (port)
 * - Infrastructure provides adapters/implementations
 * - Application layer orchestrates plugin lifecycle
 *
 * @example
 * ```typescript
 * export class MyPlugin implements IMicroPhoenixPlugin {
 *   readonly manifest: PluginManifest = {
 *     name: 'my-plugin',
 *     version: '1.0.0'
 *   };
 *
 *   async onLoad(context: IPluginContext): Promise<void> {
 *     // Initialize plugin with isolated context
 *     this.logger = context.logger;
 *     this.config = context.config;
 *   }
 *
 *   async onUnload(): Promise<void> {
 *     // Cleanup resources
 *   }
 * }
 * ```
 */

import type { IPluginContext } from './plugin-context.port';
import type { IAgentTool } from '../agents/tools.interface';
export type { IPluginContext };

/**
 * Plugin manifest - minimal metadata required for all plugins
 * Extended by concrete implementations for specific plugin types
 */
export interface PluginManifest {
  /** Plugin name (unique identifier) */
  readonly name: string;

  /** Semantic version (semver format) */
  readonly version: string;

  /** Plugin dependencies (optional) - array of plugin name:version ranges */
  readonly dependencies?: readonly string[];

  /** Human-readable description (optional) */
  readonly description?: string;

  /** Plugin author (optional) */
  readonly author?: string;

  /** Plugin tags for categorization (optional) */
  readonly tags?: readonly string[];
}

/**
 * Branded type for plugin instance IDs
 * Ensures type safety when tracking plugin instances
 */
export type PluginInstanceId = string & { __brand: 'PluginInstanceId' };

/**
 * Plugin state lifecycle
 * Tracks plugin through initialization → active → unloading → unloaded
 */
export type PluginState =
  | 'uninitialized'   // Plugin created but onLoad not called
  | 'loading'         // onLoad in progress
  | 'active'          // onLoad completed successfully
  | 'unloading'       // onUnload in progress
  | 'unloaded'        // onUnload completed
  | 'error';          // onLoad or onUnload threw error

/**
 * Core MicroPhoenix plugin interface
 * All plugins MUST implement this interface to be loaded by the runtime
 *
 * @security
 * - onLoad receives isolated IPluginContext - no direct core container access
 * - All async operations must complete within lifecycle timeouts
 * - Exceptions in lifecycle hooks transition plugin to 'error' state
 */
export interface IMicroPhoenixPlugin {
  /**
   * Plugin manifest containing metadata
   * Read-only after plugin instantiation
   */
  readonly manifest: PluginManifest;

  /**
   * Lifecycle hook: Called when plugin is being loaded
   *
   * Use this hook to:
   * - Initialize plugin state
   * - Register plugin-provided services in the child container
   * - Subscribe to plugin-scoped events
   * - Validate configuration
   *
   * @param context - Isolated plugin context containing:
   *   - container: Child DI container for plugin services
   *   - logger: Plugin-scoped logger
   *   - config: Validated plugin configuration
   *   - events: Plugin-scoped event bus
   *
   * @throws {Error} If initialization fails - plugin transitions to 'error' state
   *
   * @security Context is isolated; plugins cannot access core services directly
   *
   * @example
   * ```typescript
   * async onLoad(context: IPluginContext): Promise<void> {
   *   // Access validated config
   *   const apiKey = context.config.apiKey as string;
   *
   *   // Use scoped logger
   *   context.logger.info('Initializing plugin', { plugin: this.manifest.name });
   *
   *   // Subscribe to plugin events
   *   await context.events.subscribe('custom.event', this.handleEvent);
   * }
   * ```
   */
  onLoad?(context: IPluginContext): Promise<void>;

  /**
   * Lifecycle hook: Called when plugin is being unloaded
   *
   * Use this hook to:
   * - Clean up resources (timers, connections, file handles)
   * - Unsubscribe from events
   * - Flush pending operations
   * - Release external resources
   *
   * @throws {Error} If cleanup fails - logged but plugin still transitions to 'unloaded'
   *
   * @security Must not throw - implementors should catch and log internal errors
   *
   * @example
   * ```typescript
   * async onUnload(): Promise<void> {
   *   try {
   *     await this.connection.close();
   *   } catch (error) {
   *     // Log but don't throw - cleanup must complete
   *     this.logger?.error('Cleanup error', { error });
   *   }
   * }
   * ```
   */
  onUnload?(): Promise<void>;

  /**
   * Optional: Plugin state accessor
   * Runtime may use this to check plugin health
   */
  readonly state?: PluginState;

  /**
   * Optional: Last error if plugin is in 'error' state
   * Populated when onLoad or onUnload throws
   */
  readonly lastError?: Error;

  /**
   * Optional: Generic Tools exposed by this plugin
   * The runtime will automatically register these in the ToolRegistry
   * @since Phase 21.2
   */
  readonly tools?: IAgentTool[];
}

/**
 * Type guard for IMicroPhoenixPlugin
 * Validates that an object implements the required interface
 *
 * @param obj - Object to check
 * @returns true if obj implements IMicroPhoenixPlugin
 */
export function isMicroPhoenixPlugin(obj: unknown): obj is IMicroPhoenixPlugin {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }

  const plugin = obj as Record<string, unknown>;
  const manifest = plugin.manifest as Record<string, unknown> | undefined;

  // Required: manifest with name and version
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    typeof manifest.name !== 'string' ||
    typeof manifest.version !== 'string'
  ) {
    return false;
  }

  // Optional methods: if present, must be functions
  if (plugin.onLoad !== undefined && typeof plugin.onLoad !== 'function') {
    return false;
  }
  if (plugin.onUnload !== undefined && typeof plugin.onUnload !== 'function') {
    return false;
  }

  return true;
}
