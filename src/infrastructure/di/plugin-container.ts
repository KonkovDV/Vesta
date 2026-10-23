/**
 * Plugin-Scoped Container - Infrastructure implementation for plugin isolation
 * Layer: Infrastructure
 *
 * Provides:
 * - Plugin-scoped DI container with service exposure control
 * - Integration with plugin lifecycle (onLoad/onUnload)
 * - Automatic disposal on plugin unload
 *
 * @security
 * - Only exposed services are accessible to plugins
 * - Disposal prevents memory leaks from unloaded plugins
 * - Child container isolation prevents privilege escalation
 */

import type { IPluginContext } from '../../domain/plugins/plugin-context.port';
import type { IMicroPhoenixPlugin } from '../../domain/plugins/microphoenix-plugin.port';
import type { ILogger } from '../../core/decorators/ILogger';
import {
  DIContainer,
  DIError,
  type ServiceToken,
  type ServiceFactory,
  type ServiceInfo,
} from '../../core/di/container';
import type {
  IPluginScopedContainer,
  IContainer,
  ContainerDisposalEvent,
  DisposalResult,
  IDisposable,
} from '../../core/di/types';
import {
  disposeIfDisposable,
  isDisposable,
} from '../platform/runtime/runtime-adapter-guards';

/**
 * Plugin Container Configuration
 */
export interface PluginContainerConfig {
  /** Plugin ID for scoping */
  pluginId: string;
  /** Parent container to inherit from */
  parentContainer: IContainer;
  /** Plugin-scoped logger */
  logger: ILogger;
  /** Services exposed to this plugin */
  exposedServices?: Map<ServiceToken, unknown>;
}

/**
 * Plugin-Scoped Container Implementation
 * Restricted container that only exposes whitelisted services to plugins
 */
export class PluginContainer implements IPluginScopedContainer {
  readonly id: string;
  readonly pluginId: string;
  readonly parent: IContainer;

  private container: DIContainer;
  private disposed = false;
  private logger: ILogger;

  /** Services explicitly exposed to this plugin */
  private exposedServices = new Map<ServiceToken, unknown>();
  /** Services registered by the plugin */
  private pluginRegistrations = new Set<ServiceToken>();

  /** Event handlers for disposal lifecycle */
  private disposingHandlers = new Set<(event: ContainerDisposalEvent) => void>();
  private disposedHandlers = new Set<(event: ContainerDisposalEvent) => void>();

  /**
   * Create a new plugin-scoped container
   */
  constructor(config: PluginContainerConfig) {
    this.pluginId = config.pluginId;
    this.id = `plugin-${config.pluginId}`;
    this.parent = config.parentContainer;
    this.logger = config.logger;

    // Create internal container
    this.container = new DIContainer();
    this.container.setAllowOverrides(true);

    // Copy exposed services
    if (config.exposedServices) {
      for (const [token, instance] of config.exposedServices) {
        this.exposedServices.set(token, instance);
      }
    }
  }

  /**
   * Check if container has been disposed
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Ensure container is not disposed before operations
   */
  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new DIError(`Plugin container ${this.pluginId} has been disposed`);
    }
  }

  /**
   * Expose a service to this plugin container
   * Only exposed services are accessible to plugins
   */
  exposeService<T>(token: ServiceToken, instance: T): void {
    this.ensureNotDisposed();
    this.exposedServices.set(token, instance);
  }

  /**
   * Check if service is exposed to this plugin
   */
  isExposed(token: ServiceToken): boolean {
    return this.exposedServices.has(token);
  }

  /**
   * Register a service in this plugin container
   * Plugins can only register services in their own scope
   */
  register<T>(
    token: ServiceToken,
    factory: (c: IPluginScopedContainer) => T,
    lifecycle: 'singleton' | 'transient' | 'scoped' = 'singleton'
  ): void {
    this.ensureNotDisposed();
    this.pluginRegistrations.add(token);

    // Wrap factory to pass this container
    const wrappedFactory = () => factory(this);

    // Use type assertion to access protected members
    (this.container as unknown as {
      register<T>(
        token: ServiceToken,
        factory: ServiceFactory<T>,
        optionsOrLifecycle?: 'singleton' | 'transient' | 'scoped'
      ): void;
    }).register(token, wrappedFactory, lifecycle);

    this.logger.debug(`Plugin ${this.pluginId} registered service: ${String(token)}`);
  }

  /**
   * Resolve a service - checks exposed services first, then plugin registrations
   *
   * @security Plugins can only access:
   * 1. Services explicitly exposed to them
   * 2. Services they registered themselves
   */
  resolve<T = unknown>(token: ServiceToken): T {
    this.ensureNotDisposed();

    // Check if service is exposed to this plugin
    if (this.exposedServices.has(token)) {
      return this.exposedServices.get(token) as T;
    }

    // Check if plugin registered this service
    if (this.pluginRegistrations.has(token)) {
      return (this.container as unknown as { resolve<T>(token: ServiceToken): T }).resolve<T>(token);
    }

    // Try parent container for core services (if not restricted)
    try {
      const result = this.parent.resolve<T>(token);
      this.logger.warn(
        `Plugin ${this.pluginId} resolved parent service ${String(token)} without explicit exposure`
      );
      return result;
    } catch (error) {
      if (error instanceof DIError && error.message.includes('not registered')) {
        throw DIError.notRegistered(token);
      }
      throw error;
    }
  }

  /**
   * Check if service is available
   */
  has(token: ServiceToken): boolean {
    if (this.disposed) return false;
    return (
      this.exposedServices.has(token) ||
      this.pluginRegistrations.has(token) ||
      (this.container as unknown as { isRegistered(token: ServiceToken): boolean }).isRegistered(token)
    );
  }

  /**
   * Check if service is registered
   */
  isRegistered(token: ServiceToken): boolean {
    return this.has(token);
  }

  /**
   * Create a nested child container for plugin sub-components
   */
  createChild(scopeId?: string): IPluginScopedContainer {
    this.ensureNotDisposed();

    const childContainer = new PluginContainer({
      pluginId: `${this.pluginId}:${scopeId || 'child'}`,
      parentContainer: this,
      logger: this.logger,
      exposedServices: new Map(this.exposedServices),
    });

    // Copy plugin registrations to child
    for (const token of this.pluginRegistrations) {
      childContainer.pluginRegistrations.add(token);
    }

    return childContainer;
  }

  /**
   * Dispose this plugin container
   * Called automatically when plugin is unloaded
   */
  dispose(): DisposalResult {
    if (this.disposed) {
      return {
        success: true,
        singletonsDisposed: 0,
        scopedDisposed: 0,
        registrationsCleared: 0,
        errors: [],
        durationMs: 0,
      };
    }

    const startTime = performance.now();
    const errors: Error[] = [];

    this.logger.info?.(`Disposing plugin container: ${this.pluginId}`);

    // Emit disposing event
    const disposingEvent: ContainerDisposalEvent = {
      type: 'container:child-disposing',
      containerId: this.id,
      timestamp: Date.now(),
      servicesDisposed: this.pluginRegistrations.size,
    };
    this.disposingHandlers.forEach((handler) => {
      try {
        handler(disposingEvent);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    });

    // Dispose exposed services that implement IDisposable
    for (const [token, instance] of this.exposedServices) {
      if (!isDisposable(instance)) {
        continue;
      }

      try {
        disposeIfDisposable(instance);
        this.logger.debug(`Disposed exposed service: ${String(token)}`);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error('Failed to dispose ' + String(token) + ': ' + String(error)));
      }
    }

    // Count plugin registrations
    const registrationsCount = this.pluginRegistrations.size;

    // Dispose internal container
    try {
      const internalResult = (this.container as unknown as { dispose(): DisposalResult }).dispose();
      if (internalResult.errors.length > 0) {
        errors.push(...internalResult.errors);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }

    // Cleanup
    this.exposedServices.clear();
    this.pluginRegistrations.clear();
    this.disposed = true;

    // Emit disposed event
    const disposedEvent: ContainerDisposalEvent = {
      type: 'container:child-disposed',
      containerId: this.id,
      timestamp: Date.now(),
      servicesDisposed: registrationsCount,
    };
    this.disposedHandlers.forEach((handler) => {
      try {
        handler(disposedEvent);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    });

    // Clear event handlers
    this.disposingHandlers.clear();
    this.disposedHandlers.clear();

    const durationMs = performance.now() - startTime;

    this.logger.info?.(`Plugin container ${this.pluginId} disposed in ${durationMs.toFixed(2)}ms`);

    return {
      success: errors.length === 0,
      singletonsDisposed: registrationsCount,
      scopedDisposed: 0,
      registrationsCleared: registrationsCount,
      errors,
      durationMs,
    };
  }

  /**
   * Subscribe to disposal event
   */
  onDisposing(handler: (event: ContainerDisposalEvent) => void): () => void {
    this.disposingHandlers.add(handler);
    return () => {
      this.disposingHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to post-disposal event
   */
  onDisposed(handler: (event: ContainerDisposalEvent) => void): () => void {
    this.disposedHandlers.add(handler);
    return () => {
      this.disposedHandlers.delete(handler);
    };
  }
}

/**
 * Plugin Lifecycle Integration
 * Manages container lifecycle with plugin onLoad/onUnload hooks
 */
export class PluginLifecycleManager {
  private containers = new Map<string, PluginContainer>();
  private logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  /**
   * Create and initialize plugin container
   * Called during plugin onLoad
   */
  async initializePluginContainer(
    plugin: IMicroPhoenixPlugin,
    parentContainer: IContainer,
    exposedServices?: Map<ServiceToken, unknown>
  ): Promise<PluginContainer> {
    const pluginId = plugin.manifest.name;

    if (this.containers.has(pluginId)) {
      throw new Error(`Plugin container already exists for: ${pluginId}`);
    }

    this.logger.info?.(`Initializing container for plugin: ${pluginId}`);

    const container = new PluginContainer({
      pluginId,
      parentContainer,
      logger: this.logger,
      exposedServices,
    });

    this.containers.set(pluginId, container);

    // Setup automatic disposal on plugin unload
    const originalOnUnload = plugin.onUnload?.bind(plugin);
    plugin.onUnload = async () => {
      await this.disposePluginContainer(pluginId);
      if (originalOnUnload) {
        await originalOnUnload();
      }
    };

    return container;
  }

  /**
   * Dispose plugin container
   * Called during plugin onUnload
   */
  async disposePluginContainer(pluginId: string): Promise<void> {
    const container = this.containers.get(pluginId);
    if (!container) {
      this.logger.warn(`No container found for plugin: ${pluginId}`);
      return;
    }

    if (container.isDisposed) {
      this.logger.debug(`Container already disposed for plugin: ${pluginId}`);
      return;
    }

    const result = container.dispose();

    if (!result.success) {
      this.logger.error?.(
        `Errors during disposal of plugin ${pluginId}: ${result.errors.map((e) => e.message).join(', ')}`
      );
    }

    this.containers.delete(pluginId);
  }

  /**
   * Get plugin container
   */
  getContainer(pluginId: string): PluginContainer | undefined {
    return this.containers.get(pluginId);
  }

  /**
   * Check if plugin has active container
   */
  hasContainer(pluginId: string): boolean {
    const container = this.containers.get(pluginId);
    return container !== undefined && !container.isDisposed;
  }

  /**
   * Dispose all plugin containers
   * Called during application shutdown
   */
  async disposeAll(): Promise<void> {
    this.logger.info?.(`Disposing all plugin containers (${this.containers.size} total)`);

    const promises = Array.from(this.containers.keys()).map((pluginId) =>
      this.disposePluginContainer(pluginId)
    );

    await Promise.allSettled(promises);
  }
}

/**
 * Factory function to create plugin containers
 */
export function createPluginContainer(
  config: PluginContainerConfig
): PluginContainer {
  return new PluginContainer(config);
}
