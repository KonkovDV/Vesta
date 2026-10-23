import { injectable, inject } from 'inversify';
import * as path from 'path';
import { existsSync } from 'node:fs';
import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import { z } from 'zod';
// import { TYPES } from '../../di/types'; // Removing missing import
import type { ILogger } from '../../core/decorators/ILogger';
import type { 
  IMicroPhoenixPlugin, 
  PluginManifest 
} from '../../domain/plugins/microphoenix-plugin.port';
import type { IPluginContext, IPluginEventBus } from '../../domain/plugins/plugin-context.port';
import { isMicroPhoenixPlugin } from '../../domain/plugins/microphoenix-plugin.port';
import { PluginRegistry } from './PluginRegistry';
import { PluginLifecycleManager } from '../di/plugin-container';
import { IContainer } from '../../core/di/types';

// Schema for manifest.json
const ManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+/, "Must be semver"),
  description: z.string().optional(),
  author: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  // Entry point relative to plugin root, defaults to index.js/ts
  main: z.string().optional(),
});

import { IToolRegistry } from '../../domain/agents/tools.interface';

class PluginLoadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(cause instanceof Error ? `${message}: ${cause.message}` : message);
    this.name = 'PluginLoadError';
  }
}

class PluginDiscoverySkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginDiscoverySkip';
  }
}

function resolvePluginEntry(pluginPath: string, entryPoint: string): string {
  const requested = path.resolve(pluginPath, entryPoint);
  if (existsSync(requested)) return requested;
  if (requested.endsWith('.js')) {
    const source = `${requested.slice(0, -'.js'.length)}.ts`;
    if (existsSync(source)) return source;
  }
  return requested;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function createPluginEventBus(): IPluginEventBus {
  return {
    publish: async () => {},
    subscribe: async () => 'stub',
    unsubscribe: async () => {},
  };
}

function isNamedExportRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type PluginConstructor = new () => IMicroPhoenixPlugin;

@injectable()
export class PluginLoader {
  constructor(
    @inject('ILogger') private logger: ILogger,
    @inject(PluginRegistry) private registry: PluginRegistry,
    @inject(PluginLifecycleManager) private lifecycleManager: PluginLifecycleManager,
    @inject('IContainer') private rootContainer: IContainer,
    @inject('IToolRegistry') private toolRegistry: IToolRegistry
  ) {}

  /**
   * Load all plugins from a directory
   */
  async loadDirectory(directory: string): Promise<void> {
    this.logger.info?.(`Scanning plugin directory: ${directory}`);
    try {
      const files = await fs.readdir(directory, { withFileTypes: true });
      const dirs = files.filter((f: Dirent) => f.isDirectory() || f.isSymbolicLink());

      for (const dir of dirs) {
        const pluginPath = path.join(directory, dir.name);
        try {
          await this.loadPlugin(pluginPath);
        } catch (err) {
          if (err instanceof PluginDiscoverySkip) {
            this.logger.debug(`Skipping non-plugin directory ${pluginPath}: ${err.message}`);
            continue;
          }

          this.logger.error(`Failed to load plugin from ${pluginPath}`, { error: err });
        }
      }
    } catch (err) {
      this.logger.error(`Failed to read plugin directory ${directory}`, { error: err });
      throw err;
    }
  }

  /**
   * Load a single plugin from a path
   */
  async loadPlugin(pluginPath: string): Promise<void> {
    this.logger.debug(`Loading plugin from ${pluginPath}`);

    // 1. Read and Validate Manifest
    const manifestPath = path.join(pluginPath, 'manifest.json');
    let manifestData: unknown;
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      manifestData = JSON.parse(content);
    } catch (e) {
      if (!isErrnoException(e) || e.code !== 'ENOENT') throw e;
      // If no manifest.json, try package.json
      const pkgPath = path.join(pluginPath, 'package.json');
      let pkgContent: string;
      try {
        pkgContent = await fs.readFile(pkgPath, 'utf-8');
      } catch (pkgError) {
        if (isErrnoException(pkgError) && pkgError.code === 'ENOENT') {
          throw new PluginDiscoverySkip('no manifest.json or package.json found');
        }
        throw pkgError;
      }
      const pkg = JSON.parse(pkgContent) as Partial<PluginManifest> & { main?: string };
      manifestData = {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        author: pkg.author,
        main: pkg.main
      };
    }

    const validation = ManifestSchema.safeParse(manifestData);
    if (!validation.success) {
      throw new PluginLoadError(`Invalid manifest for ${pluginPath}`, validation.error);
    }
    const fileManifest = validation.data;

    // Check if already registered
    if (this.registry.getPlugin(fileManifest.name)) {
      this.logger.warn(`Plugin ${fileManifest.name} already loaded. Skipping.`);
      return;
    }

    // 2. Import Module
    const entryPoint = fileManifest.main || 'index.js';
    const modulePath = resolvePluginEntry(pluginPath, entryPoint);
    
    let moduleExports: Record<string, unknown>;
    try {
      // Dynamic import supports both CJS and ESM
      moduleExports = await this.importModule(modulePath);
    } catch (err) {
      throw new PluginLoadError(`Failed to import plugin entry point ${modulePath}`, err);
    }

    // 3. Find Plugin Class
    // Look for 'default' export or a named export that looks like a plugin
    let PluginClass: PluginConstructor | undefined = this.isPluginClass(moduleExports.default)
      ? moduleExports.default
      : undefined;
    if (!PluginClass || !this.isPluginClass(PluginClass)) {
      // Search named exports
      for (const key of Object.keys(moduleExports)) {
        if (this.isPluginClass(moduleExports[key])) {
          PluginClass = moduleExports[key];
          break;
        }
      }
    }

    if (!PluginClass) {
      throw new PluginLoadError(`No valid plugin class export found in ${modulePath}`);
    }

    // 4. Instantiate
    const pluginInstance = new PluginClass();
    if (!isMicroPhoenixPlugin(pluginInstance)) {
      throw new PluginLoadError('Plugin class instance does not satisfy IMicroPhoenixPlugin interface');
    }

    // Verify consistency
    if (pluginInstance.manifest.name !== fileManifest.name) {
      this.logger.warn(`Manifest mismatch: File says ${fileManifest.name}, Class says ${pluginInstance.manifest.name}`);
    }

    // 5. Register & Initialize
    this.registry.register(pluginInstance);
    this.registry.updateState(pluginInstance.manifest.name, 'loading');

    try {
      const container = await this.lifecycleManager.initializePluginContainer(
        pluginInstance,
        this.rootContainer,
        // TODO: Pass exposed services map if needed, e.g. from config
        new Map() 
      );
      
      // The context creation logic is likely inside initializePluginContainer or we need to bridge it.
      // Looking at PluginLifecycleManager, it creates the container but...
      // wait, PluginContainer IS the context logic provider (roughly).
      // We need to construct the actual IPluginContext object to pass to onLoad.
      // Let's assume PluginContainer has a way to produce it or IS compatible.
      // Looking at `plugin-context.port.ts`, IPluginContext has { container, logger, config, events }.
      // Use a Factory or construct directly here.
      
      const context: IPluginContext = {
        container: container,
        logger: this.logger,  // Should be proxied/scoped logger
        config: {},           // TODO: Load plugin config from system
        contextId: container.id,
        pluginId: pluginInstance.manifest.name,
        tools: this.toolRegistry,
        events: createPluginEventBus(),
      };

      if (pluginInstance.onLoad) {
        await pluginInstance.onLoad(context);
      }

      // 6. Auto-register Tools (Phase 21.2)
      if (pluginInstance.tools && Array.isArray(pluginInstance.tools)) {
        this.logger.debug?.(`[PluginLoader] Auto-registering ${pluginInstance.tools.length} tools for ${pluginInstance.manifest.name}`);
        for (const tool of pluginInstance.tools) {
           this.toolRegistry.register(tool);
        }
      }

      this.registry.updateState(pluginInstance.manifest.name, 'active');
      this.logger.info?.(`Successfully loaded plugin: ${pluginInstance.manifest.name}`);

    } catch (err) {
      this.registry.updateState(pluginInstance.manifest.name, 'error', err as Error);
       // Attempt cleanup
       await this.lifecycleManager.disposePluginContainer(pluginInstance.manifest.name);
      throw err;
    }
  }

  private isPluginClass(cls: unknown): cls is PluginConstructor {
    // Rudimentary check if it's a class (constructor)
    return typeof cls === 'function' && !!cls.prototype;
  }

  protected async importModule(modulePath: string): Promise<Record<string, unknown>> {
    const imported = await import(modulePath);
    return isNamedExportRecord(imported) ? imported : {};
  }
}
