/**
 * Hook Pipeline DI Module — Registration for unified hook pipeline
 *
 * Registers:
 * - IHookPipeline → UnifiedHookPipelineRunner
 * - IPluginSlotManager → PluginSlotManager
 * - PluginLifecycleService
 *
 * Migration wiring: bridges ILifecycleHookManager → IHookPipeline
 * via adapter registration so existing consumers continue working.
 *
 * @layer Infrastructure (DI)
 * @phase 13 — Plugin Hook Pipeline (OpenClaw extraction)
 */

import type { IContainer } from '../../../core/di/types';
import { UnifiedHookPipelineRunner } from '../../../application/plugins/UnifiedHookPipelineRunner';
import { PluginSlotManager } from '../../../application/plugins/PluginSlotManager';
import { PluginLifecycleService as PluginLifecycleServiceClass } from '../../../application/plugins/PluginLifecycleService';
import type { IHookPipeline } from '../../../domain/plugins/hook-pipeline.interface';
import type { IPluginSlotManager } from '../../../application/plugins/PluginSlotManager';
import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { HookManager } from '../../hooks/HookManager';

/**
 * Register hook pipeline services in the DI container.
 */
export function registerHookPipelineModule(container: {
  register: <T>(token: string, factory: (c: IContainer) => T, options?: Record<string, unknown>) => void;
  isRegistered: (token: string) => boolean;
  resolve: <T>(token: string) => T;
}): void {
  // 1. Unified Hook Pipeline
  if (!container.isRegistered(DI_TOKENS.IHookPipeline)) {
    container.register<IHookPipeline>('IHookPipeline', (c) => {
      let logger: { debug?: (m: string, meta?: Record<string, unknown>) => void; warn: (m: string, meta?: Record<string, unknown>) => void; error: (m: string, meta?: Record<string, unknown>) => void } | undefined;
      try {
        logger = c.resolve(DI_TOKENS.ILogger);
      } catch {
        // Logger not available — run without
      }
      return new UnifiedHookPipelineRunner(logger);
    }, {
      lifecycle: 'singleton',
      tags: ['plugins', 'hooks', 'phase-13'],
      description: 'Unified hook pipeline: 23 hook points, 3 execution modes (Phase 13)',
    });
  }

  // 2. Plugin Slot Manager
  if (!container.isRegistered(DI_TOKENS.IPluginSlotManager)) {
    container.register<IPluginSlotManager>('IPluginSlotManager', () => {
      return new PluginSlotManager();
    }, {
      lifecycle: 'singleton',
      tags: ['plugins', 'slots', 'phase-13'],
      description: 'Exclusive slot system for plugin capabilities (Phase 13)',
    });
  }

  if (!container.isRegistered(DI_TOKENS.ILifecycleHookManager)) {
    container.register(DI_TOKENS.ILifecycleHookManager, (c) => {
      let logger: { warn: (message: string) => void; error: (message: string) => void } | undefined;
      try {
        logger = c.resolve(DI_TOKENS.ILogger);
      } catch {
        logger = undefined;
      }
      return new HookManager(logger ? { logger } : {});
    }, {
      lifecycle: 'singleton',
      tags: ['plugins', 'hooks', 'lifecycle'],
      description: 'Internal lifecycle hooks used by recall and capture',
    });
  }

  // 3. Plugin Lifecycle Service (depends on IHookPipeline + IPluginSlotManager)
  if (!container.isRegistered(DI_TOKENS.PluginLifecycleManager)) {
    container.register(DI_TOKENS.PluginLifecycleManager, (c) => {
      const pipeline = c.resolve<IHookPipeline>(DI_TOKENS.IHookPipeline);
      const slotManager = c.resolve<IPluginSlotManager>(DI_TOKENS.IPluginSlotManager);
      return new PluginLifecycleServiceClass(pipeline, slotManager);
    }, {
      lifecycle: 'singleton',
      tags: ['plugins', 'lifecycle', 'phase-13'],
      description: 'Plugin install/update/remove lifecycle with slot coordination (Phase 13)',
    });
  }
}
