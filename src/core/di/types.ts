/**
 * DI Container Types - Core abstractions for dependency injection
 * Layer: Core
 *
 * Provides:
 * - IDisposable interface for resource cleanup
 * - IChildContainer interface for hierarchical containers
 * - Disposal event types for lifecycle management
 *
 * @security Child containers isolate plugin registrations from parent
 * to prevent privilege escalation and unauthorized access.
 */

import type { ServiceToken } from './container';

/**
 * Interface for providing an ambient scope ID (e.g., from AsyncLocalStorage).
 * Used by the DI Container to automatically resolve 'scoped' dependencies
 * when no explicit scopeId is provided.
 */
export interface IAmbientScopeProvider {
  /** Returns the current active scope ID, or undefined if not in a scope */
  getScopeId(): string | undefined;
}

/**
 * Disposable interface for resources requiring cleanup
 * Implement to ensure proper resource disposal and prevent memory leaks
 */
export interface IDisposable {
  /**
   * Dispose of resources and cleanup
   * - Remove event listeners
   * - Close connections
   * - Clear caches
   * - Release memory
   */
  dispose(): void;
}

/**
 * Disposal event types for container lifecycle
 */
export type ContainerDisposalEventType =
  | 'container:disposing'
  | 'container:disposed'
  | 'container:child-disposing'
  | 'container:child-disposed';

/**
 * Container disposal event payload
 */
export interface ContainerDisposalEvent {
  /** Event type */
  type: ContainerDisposalEventType;
  /** Container identifier */
  containerId: string;
  /** Timestamp of disposal */
  timestamp: number;
  /** Number of services disposed */
  servicesDisposed: number;
  /** Optional error if disposal failed */
  error?: Error;
}

/**
 * Minimal container interface for hierarchical DI
 * Core contract for parent-child container relationships
 */
export interface IContainer {
  /** Resolve a service by token */
  resolve<T = unknown>(token: ServiceToken, scopeId?: string): T;
  /** Check if service is registered */
  has(token: ServiceToken): boolean;
  /** Check if service is registered (alias) */
  isRegistered(token: ServiceToken): boolean;
}

/**
 * Child container interface with disposal support
 * Extends IContainer with parent reference and cleanup
 *
 * @security Child container:
 * - Cannot access parent's private registrations
 * - Child disposal doesn't affect parent
 * - Parent disposal cascades to children
 */
export interface IChildContainer extends IContainer, IDisposable {
  /** Unique identifier for this child container */
  readonly id: string;

  /** Parent container reference (weak to prevent cycles) */
  readonly parent: IContainer;

  /**
   * Register a service in this child container
   * Overrides parent registration if exists
   */
  register<T>(token: ServiceToken, factory: (c: IChildContainer) => T, lifecycle?: 'singleton' | 'transient' | 'scoped'): void;

  /**
   * Create a nested child container
   * Used for plugin sub-components and nested scopes
   */
  createChild(scopeId?: string): IChildContainer;

  /**
   * Check if this container has been disposed
   */
  readonly isDisposed: boolean;

  /**
   * Subscribe to disposal events
   * @returns Unsubscribe function
   */
  onDisposing(handler: (event: ContainerDisposalEvent) => void): () => void;

  /**
   * Subscribe to post-disposal events
   * @returns Unsubscribe function
   */
  onDisposed(handler: (event: ContainerDisposalEvent) => void): () => void;
}

/**
 * Plugin-scoped container interface
 * Restricted container for plugin isolation
 */
export interface IPluginScopedContainer extends IChildContainer {
  /** Plugin ID this container is scoped to */
  readonly pluginId: string;

  /**
   * Expose a parent service to this plugin container
   * Only exposed services are accessible to plugins
   */
  exposeService<T>(token: ServiceToken, instance: T): void;

  /**
   * Check if service is exposed to this plugin
   */
  isExposed(token: ServiceToken): boolean;
}

/**
 * Disposal options for fine-grained cleanup
 */
export interface DisposalOptions {
  /** Dispose parent container as well (default: false) */
  disposeParent?: boolean;
  /** Timeout for disposal operations in ms (default: 5000) */
  timeoutMs?: number;
  /** Dispose singletons created by this container (default: true) */
  disposeSingletons?: boolean;
  /** Dispose scoped instances (default: true) */
  disposeScoped?: boolean;
}

/**
 * Result of container disposal
 */
export interface DisposalResult {
  /** Whether disposal succeeded */
  success: boolean;
  /** Number of singleton instances disposed */
  singletonsDisposed: number;
  /** Number of scoped instances disposed */
  scopedDisposed: number;
  /** Number of registrations cleared */
  registrationsCleared: number;
  /** Errors during disposal */
  errors: Error[];
  /** Disposal duration in ms */
  durationMs: number;
}
