import { injectable, inject } from 'inversify';
// import { TYPES } from '../../di/types';
import type { ILogger } from '../../core/decorators/ILogger';
import type { 
  IMicroPhoenixPlugin, 
  PluginManifest, 
  PluginState 
} from '../../domain/plugins/microphoenix-plugin.port';
import { EntityAlreadyExistsError } from '../../domain/errors/DomainError';

export interface PluginInfo {
  id: string; // name@version
  manifest: PluginManifest;
  state: PluginState;
  instance?: IMicroPhoenixPlugin;
  error?: Error;
  loadedAt?: Date;
}

export interface PluginHookEntry {
  pluginId: string;
  hookName: string;
  handler: (...args: unknown[]) => unknown;
  priority?: number;
}

@injectable()
export class PluginRegistry {
  private plugins = new Map<string, PluginInfo>();
  private hooks: PluginHookEntry[] = [];

  constructor(
    @inject('ILogger') private logger: ILogger
  ) {}

  register(plugin: IMicroPhoenixPlugin): void {
    const id = `${plugin.manifest.name}`;
    
    if (this.plugins.has(id)) {
      throw new EntityAlreadyExistsError('Plugin', id);
    }

    this.plugins.set(id, {
      id,
      manifest: plugin.manifest,
      state: plugin.state || 'uninitialized',
      instance: plugin,
      loadedAt: new Date()
    });

    this.logger.info?.(`Registered plugin: ${id}`, { 
      version: plugin.manifest.version,
      tags: plugin.manifest.tags 
    });
  }

  unregister(pluginId: string): void {
    if (!this.plugins.has(pluginId)) {
      this.logger.warn(`Attempted to unregister unknown plugin: ${pluginId}`);
      return;
    }
    this.plugins.delete(pluginId);
    this.logger.info?.(`Unregistered plugin: ${pluginId}`);
  }

  getPlugin(pluginId: string): PluginInfo | undefined {
    return this.plugins.get(pluginId);
  }

  getAllPlugins(): PluginInfo[] {
    return Array.from(this.plugins.values());
  }

  updateState(pluginId: string, state: PluginState, error?: Error): void {
    const info = this.plugins.get(pluginId);
    if (!info) return;

    info.state = state;
    if (error) {
      info.error = error;
      this.logger.error(`Plugin ${pluginId} transitioned to error state`, { error });
    } else {
      this.logger.debug(`Plugin ${pluginId} state changed to: ${state}`);
    }
  }

  registerHook(entry: PluginHookEntry): void {
    const idx = this.hooks.findIndex(
      (h) => h.pluginId === entry.pluginId && h.hookName === entry.hookName,
    );
    if (idx >= 0) {
      this.hooks[idx] = entry;
    } else {
      this.hooks.push(entry);
    }
  }

  getHooks(): PluginHookEntry[] {
    return [...this.hooks];
  }

  getHooksForName(hookName: string): PluginHookEntry[] {
    return this.hooks
      .filter((h) => h.hookName === hookName)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  unregisterPluginHooks(pluginId: string): void {
    this.hooks = this.hooks.filter((h) => h.pluginId !== pluginId);
  }

  unregisterHook(pluginId: string, hookName: string): void {
    this.hooks = this.hooks.filter(
      (h) => !(h.pluginId === pluginId && h.hookName === hookName),
    );
  }

  clearHooks(): void {
    this.hooks = [];
  }
}
