import { injectable, inject } from 'inversify';
import * as path from 'path';
import type { ILogger } from '../../core/decorators/ILogger';
import { PluginLoader } from './PluginLoader';

@injectable()
export class PluginAutoLoader {
  constructor(
    @inject(PluginLoader) private loader: PluginLoader,
    @inject('ILogger') private logger: ILogger
  ) {}

  /**
   * Standard plugins ship next to this file (src/ or dist/), so the directory is
   * found from the module path. The working directory belongs to the project.
   */
  static resolvePluginsDirectory(
    _currentWorkingDirectory: string = process.cwd(),
    runtimeFilePath: string = __filename,
  ): string {
    return path.resolve(path.dirname(runtimeFilePath), '..', '..', 'plugins', 'standard');
  }

  async initialize(): Promise<void> {
    const pluginsDir = PluginAutoLoader.resolvePluginsDirectory();
    
    this.logger.info(`[PluginAutoLoader] Initializing plugins from: ${pluginsDir}`);

    try {
      await this.loader.loadDirectory(pluginsDir);
      this.logger.info('[PluginAutoLoader] Auto-loading completed successfully.');
    } catch (err) {
        this.logger.error('[PluginAutoLoader] Failed to auto-load plugins', { error: err });
        // We do NOT throw here to allow the app to start even if plugins fail
    }
  }
}
