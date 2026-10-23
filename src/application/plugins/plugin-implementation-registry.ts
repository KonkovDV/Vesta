import type { ILogger } from '../../core/decorators/ILogger';
import type { PluginExecutionContext, IPlugin } from './plugin-types';
import { PluginManifestSchema } from './plugin-types';
import type { PluginExecutor } from './plugin-executor';
import { EntityAlreadyExistsError, ValidationError } from '../../domain/errors/DomainError';

type PluginHandlerRegistry = Pick<PluginExecutor, 'registerHandler'>;

/**
 * Runtime-реестр конкретных реализаций плагинов (TASK-024).
 *
 * Ответственность:
 * - валидация манифеста плагина (PluginManifestSchema);
 * - гарантия уникальности имени плагина;
 * - проверка зависимостей (dependencies[] уже зарегистрированы);
 * - регистрация handler-а в PluginExecutor под ref = `${name}@${version}`.
 */
export interface IPluginImplementationRegistry {
  registerPlugin(plugin: IPlugin): void;
  getPluginByName(name: string): IPlugin | undefined;
}

export class PluginImplementationRegistry implements IPluginImplementationRegistry {
  private readonly pluginsByName = new Map<string, IPlugin>();

  constructor(
    private readonly executor: PluginHandlerRegistry,
    private readonly logger?: ILogger,
  ) {}

  registerPlugin(plugin: IPlugin): void {
    const parsedManifest = PluginManifestSchema.parse(plugin.manifest);
    const { name, version, dependencies } = parsedManifest;

    if (this.pluginsByName.has(name)) {
      if (this.logger) {
        this.logger.error('[PLUGINS] Duplicate plugin registration', {
          pluginName: name,
        });
      }
      throw new EntityAlreadyExistsError('Plugin', name);
    }

    if (dependencies && dependencies.length > 0) {
      const missingDependencies = dependencies.filter(
        (dependencyName) => !this.pluginsByName.has(dependencyName),
      );

      if (missingDependencies.length > 0) {
        if (this.logger) {
          this.logger.error('[PLUGINS] Plugin dependencies not satisfied', {
            pluginName: name,
            missingDependencies,
          });
        }
        throw new ValidationError(
          `Plugin "${name}" has unresolved dependencies: ${missingDependencies.join(', ')}`,
          missingDependencies.map((dependencyName) => ({
            field: 'dependencies',
            message: `Missing dependency: ${dependencyName}`,
            value: dependencyName,
          })),
        );
      }
    }

    const entrypointRef = `${name}@${version}`;

    this.executor.registerHandler(
      entrypointRef,
      (input: unknown, context: PluginExecutionContext) => plugin.execute(input, context),
    );

    this.pluginsByName.set(name, plugin);
  }

  getPluginByName(name: string): IPlugin | undefined {
    return this.pluginsByName.get(name);
  }
}