/**
 * Plugin Context Interface - container for plugin-scoped dependencies
 * Layer: Domain (contracts)
 *
 * Provides isolated context for plugin execution with:
 * - Child DI container for dependency isolation
 * - Scoped logger for audit trails
 * - Validated configuration
 * - Plugin-scoped event bus
 *
 * @security Plugin context MUST be isolated from core container to prevent
 * privilege escalation and unauthorized access to core services.
 */

import type { ILogger } from '../../core/decorators/ILogger';
import type { DomainEvent } from '../events/event-store.interface';
import type { IToolRegistry } from '../agents/tools.interface';

/**
 * Branded type for plugin-scoped container token
 * Ensures type safety between parent and child containers
 */
export type PluginContainerToken = symbol & { __brand: 'PluginContainer' };

/**
 * Minimal container interface for plugin-scoped DI
 * Restricted subset of full DIContainer to enforce isolation
 */
export interface IChildContainer {
  /**
   * Resolve a service from the plugin-scoped container
   * Only resolves services explicitly exposed to plugins
   *
   * @param token - Service token
   * @throws {Error} If service not registered or not accessible
   */
  resolve<T = unknown>(token: symbol | string): T;

  /**
   * Check if a service is available in this container
   * Safe check without throwing
   *
   * @param token - Service token
   */
  has(token: symbol | string): boolean;

  /**
   * Create a child container for nested plugin scopes
   * Used for plugin sub-components
   */
  createChild(scopeId: string): IChildContainer;
}

/**
 * Plugin-scoped event bus interface
 * Restricted event bus preventing plugins from accessing core events
 */
export interface IPluginEventBus {
  /**
   * Publish an event to the plugin-scoped event bus
   * Events are namespaced to prevent collision with core events
   *
   * @param event - Domain event to publish
   */
  publish<T extends DomainEvent>(event: T): Promise<void>;

  /**
   * Subscribe to plugin-scoped events
   *
   * @param eventType - Event type to subscribe to
   * @param handler - Event handler callback
   * @returns Subscription ID for unsubscribe
   */
  subscribe<T extends DomainEvent>(
    eventType: string,
    handler: (event: T) => Promise<void> | void
  ): Promise<string>;

  /**
   * Unsubscribe from events
   *
   * @param subscriptionId - ID returned from subscribe
   */
  unsubscribe(subscriptionId: string): Promise<void>;
}

/**
 * Plugin context providing isolated execution environment
 * Passed to plugins during lifecycle hooks
 */
export interface IPluginContext {
  /**
   * Child DI container scoped to this plugin instance
   * Isolated from core container - plugins cannot resolve core services directly
   *
   * @security Plugins MUST only access services through this container
   */
  readonly container: IChildContainer;

  /**
   * Plugin-scoped logger
   * Automatically prefixed with plugin ID for audit trails
   * Prevents log injection through sanitized metadata
   *
   * @security All log entries include correlationId for traceability
   */
  readonly logger: ILogger;

  /**
   * Validated plugin configuration
   * Schema validation performed before plugin load
   * Unknown properties are stripped during validation
   *
   * @security Config is read-only after validation to prevent tampering
   */
  readonly config: Readonly<Record<string, unknown>>;

  /**
   * Plugin-scoped event bus
   * Events are namespaced to plugin ID for isolation
   * Cannot subscribe to or publish core system events
   *
   * @security Event namespace enforced: `plugin.{pluginId}.{eventType}`
   */
  readonly events: IPluginEventBus;

  /**
   * Unique identifier for this plugin context instance
   * Used for correlation and audit logging
   */
  readonly contextId: string;

  /**
   * Plugin manifest ID (name:version)
   * Identifies the plugin this context belongs to
   */
  readonly pluginId: string;

  /**
   * Access to Tool Registry
   * Allows plugins to register new tools (capabilities)
   * @since Phase 18.2
   */
  readonly tools: IToolRegistry;
}
