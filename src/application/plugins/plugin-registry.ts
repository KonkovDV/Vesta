import type { PluginRoute, PluginDescriptor } from './plugin-types';
import {
  PluginManifestValidationError,
  type IPluginManifestStore,
  type PluginManifestId,
} from '../../domain/plugins/manifest/plugin-manifest-store.interface';
import type { IManifestPolicyEnforcer } from '../plugins/manifest-policy.enforcer';

export interface IPluginRegistry {
  /**
   * Resolve a plugin descriptor by route or string name.
   *
   * v1 contract:
   * - requires an explicit version (either in PluginRoute or in "name@version" string);
   * - throws PluginResolveError when version is missing or manifest is not found.
   */
  resolvePlugin(routeOrName: string | PluginRoute): Promise<PluginDescriptor>;
}

/**
 * Technical error used when plugin resolution fails at registry level.
 *
 * This error is intentionally simple; UnifiedPluginRegistry is responsible
 * for normalizing it into a NormalizedResult.
 */
export class PluginResolveError extends Error {
  constructor(
    message: string,
    public readonly pluginName?: string,
    public readonly pluginVersion?: string,
  ) {
    super(message);
    this.name = 'PluginResolveError';
  }
}

export class PluginRegistry implements IPluginRegistry {
  constructor(
    private readonly manifestStore: IPluginManifestStore,
    // NOTE: manifestPolicyEnforcer is wired here for future PLG-NEXT.3 usage,
    // but MUST NOT be used inside v1 runtime. Enforcement happens in UnifiedPluginRegistry.
    private readonly manifestPolicyEnforcer?: IManifestPolicyEnforcer,
  ) {}

  async resolvePlugin(routeOrName: string | PluginRoute): Promise<PluginDescriptor> {
    // v1: минимальный контракт.
    // - требуем явную версию (либо в PluginRoute, либо в строке "name@version");
    // - если версия отсутствует → бросаем понятную ошибку (PluginResolveError).
    const { name, version } = this.normalizeRouteOrName(routeOrName);

    const id: PluginManifestId = { name, version };

    let snapshot;
    try {
      snapshot = await this.manifestStore.getById(id);
    } catch (error) {
      if (error instanceof PluginManifestValidationError) {
        // Manifest v2 schema validation failed in the underlying store.
        // Treat this as a resolve-level error so that callers never receive
        // a descriptor for an invalid plugin.
        throw new PluginResolveError(
          (error as Error).message,
          name,
          version,
        );
      }

      throw new PluginResolveError(
        `Failed to load plugin manifest for ${name}@${version}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        name,
        version,
      );
    }

    if (!snapshot) {
      throw new PluginResolveError(
        `Plugin manifest not found for ${name}@${version}`,
        name,
        version,
      );
    }

    // v1: простейший PluginDescriptor, основанный на manifest id.
    // entrypoint.ref может быть скорректирован в следующих итерациях,
    // когда появятся реальные реализации плагинов.
    const descriptor: PluginDescriptor = {
      id: snapshot.id,
      type: 'phoenix-plugin',
      displayName: snapshot.id.name,
      entrypoint: {
        ref: `${snapshot.id.name}@${snapshot.id.version}`,
      },
      manifest: snapshot,
      // tags могут быть заполнены из manifest в следующих версиях.
      tags: [],
    };

    return descriptor;
  }

  private normalizeRouteOrName(
    routeOrName: string | PluginRoute,
  ): { name: string; version: string } {
    if (typeof routeOrName === 'string') {
      const value = routeOrName.trim();
      if (!value) {
        throw new PluginResolveError('Plugin route must be a non-empty string');
      }

      // Поддерживаем потенциальные scoped имена вида "@scope/name@1.0.0":
      // используем последнюю "@" как разделитель name/version.
      const atIndex = value.lastIndexOf('@');
      if (atIndex <= 0 || atIndex === value.length - 1) {
        throw new PluginResolveError(
          'Plugin version is required for string route. Use "name@version" format.',
        );
      }

      const name = value.slice(0, atIndex).trim();
      const version = value.slice(atIndex + 1).trim();

      if (!name || !version) {
        throw new PluginResolveError(
          'Plugin route must be in "name@version" format with non-empty parts.',
        );
      }

      return { name, version };
    }

    const name = routeOrName.name?.trim();
    if (!name) {
      throw new PluginResolveError(
        'PluginRoute.name is required and must be a non-empty string',
      );
    }

    const version = routeOrName.version?.trim();
    if (!version) {
      throw new PluginResolveError(
        `PluginRoute.version is required for plugin "${name}"`,
        name,
      );
    }

    return { name, version };
  }
}