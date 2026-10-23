/**
 * PluginLifecycleService — Install / Update / Remove lifecycle for plugins
 *
 * Extends the existing PluginRegistry (115L, 11 methods) with full lifecycle
 * management: install, update, remove with slot coordination and hook cleanup.
 *
 * @layer Application
 * @phase 13 — Plugin Hook Pipeline (OpenClaw extraction)
 * @donor external/openclaw/src/plugins/loader.ts + registry.ts — lifecycle extraction
 */

import type { IHookPipeline, UnifiedHookName } from '../../domain/plugins/hook-pipeline.interface';
import type { IPluginSlotManager, PluginSlotName } from './PluginSlotManager';
import {
  EntityAlreadyExistsError,
  EntityNotFoundError,
  InfrastructureError,
  BusinessRuleViolationError,
} from '../../domain/errors/DomainError';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Plugin manifest for lifecycle operations.
 */
export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly hooks?: Array<{
    readonly hookName: UnifiedHookName;
    readonly handler: (event: unknown, ctx?: unknown) => unknown | Promise<unknown>;
    readonly priority?: number;
  }>;
  readonly slots?: PluginSlotName[];
  readonly onActivate?: () => Promise<void>;
  readonly onDeactivate?: () => Promise<void>;
}

/**
 * Plugin state in the lifecycle.
 */
export type PluginState = 'installed' | 'active' | 'inactive' | 'error';

/**
 * Installed plugin record.
 */
export interface InstalledPlugin {
  readonly manifest: PluginManifest;
  readonly state: PluginState;
  readonly hookRegistrationIds: string[];
  readonly installedAt: Date;
  readonly updatedAt: Date;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class PluginLifecycleService {
  private readonly plugins = new Map<string, InstalledPlugin>();
  private readonly hookPipeline: IHookPipeline;
  private readonly slotManager: IPluginSlotManager;

  constructor(hookPipeline: IHookPipeline, slotManager: IPluginSlotManager) {
    this.hookPipeline = hookPipeline;
    this.slotManager = slotManager;
  }

  /**
   * Install and activate a plugin.
   *
   * Steps:
   * 1. Check for existing installation
   * 2. Claim required slots (fail if occupied)
   * 3. Register hooks
   * 4. Call onActivate lifecycle hook
   */
  async install(manifest: PluginManifest): Promise<InstalledPlugin> {
    if (this.plugins.has(manifest.id)) {
      throw new EntityAlreadyExistsError('Plugin', manifest.id);
    }

    // Claim slots
    if (manifest.slots) {
      for (const slot of manifest.slots) {
        if (!this.slotManager.claim(slot, manifest.id)) {
          // Rollback previously claimed slots
          for (const s of manifest.slots) {
            this.slotManager.release(s, manifest.id);
          }
          const occupant = this.slotManager.getOccupant(slot);
          throw new BusinessRuleViolationError(
            'Plugin \'' + manifest.id + '\' cannot claim slot \'' + slot + '\' — already occupied by \'' + (occupant ?? 'unknown') + '\'',
            'plugin-slot-occupied',
            { metadata: { pluginId: manifest.id, slot, occupant } },
          );
        }
      }
    }

    // Register hooks
    const hookIds: string[] = [];
    if (manifest.hooks) {
      for (const hook of manifest.hooks) {
        const id = this.hookPipeline.register(hook.hookName, hook.handler, {
          priority: hook.priority,
          source: manifest.id,
        });
        hookIds.push(id);
      }
    }

    // Activate
    try {
      if (manifest.onActivate) {
        await manifest.onActivate();
      }
    } catch (err) {
      // Rollback on activation failure
      for (const id of hookIds) {
        this.hookPipeline.unregister(id);
      }
      if (manifest.slots) {
        for (const slot of manifest.slots) {
          this.slotManager.release(slot, manifest.id);
        }
      }
      throw new InfrastructureError(
        `Plugin '${manifest.id}' activation failed: ${String(err)}`,
        { cause: err instanceof Error ? err : undefined, metadata: { pluginId: manifest.id } },
      );
    }

    const now = new Date();
    const installed: InstalledPlugin = {
      manifest,
      state: 'active',
      hookRegistrationIds: hookIds,
      installedAt: now,
      updatedAt: now,
    };

    this.plugins.set(manifest.id, installed);
    return installed;
  }

  /**
   * Update a plugin (deactivate old → install new).
   */
  async update(manifest: PluginManifest): Promise<InstalledPlugin> {
    const existing = this.plugins.get(manifest.id);
    if (!existing) {
      throw new EntityNotFoundError('Plugin', manifest.id);
    }

    // Deactivate old version
    await this.deactivate(manifest.id);

    // Remove old record
    this.plugins.delete(manifest.id);

    // Install new version
    return this.install(manifest);
  }

  /**
   * Remove a plugin completely.
   */
  async remove(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new EntityNotFoundError('Plugin', pluginId);
    }

    await this.deactivate(pluginId);
    this.plugins.delete(pluginId);
  }

  /**
   * Get an installed plugin by ID.
   */
  getPlugin(pluginId: string): InstalledPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * List all installed plugins.
   */
  listPlugins(): InstalledPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get count of installed plugins.
   */
  getPluginCount(): number {
    return this.plugins.size;
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private async deactivate(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;

    // Call onDeactivate
    try {
      if (plugin.manifest.onDeactivate) {
        await plugin.manifest.onDeactivate();
      }
    } catch {
      // Deactivation errors are non-fatal
    }

    // Unregister hooks
    for (const id of plugin.hookRegistrationIds) {
      this.hookPipeline.unregister(id);
    }

    // Release slots
    if (plugin.manifest.slots) {
      for (const slot of plugin.manifest.slots) {
        this.slotManager.release(slot, pluginId);
      }
    }
  }
}
