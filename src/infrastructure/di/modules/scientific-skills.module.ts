/**
 * Scientific Skills DI Module
 *
 * Registers Python skill bridge and scientific skill plugin.
 * Layer: Infrastructure/DI
 */

import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { container } from '../../../core/di/container';
import { getConfig } from '../../../config';
import { createPythonSkillSecurityMetrics } from '../../../monitoring';
import type { ILogger } from '../../../core/decorators/ILogger';
import type { IPythonSkillBridge } from '../../../domain/plugins/scientific/python-skill-bridge.port';
import type { IScientificSkillPlugin } from '../../../domain/plugins/scientific/scientific-skill-plugin.port';
import {
  PYTHON_SKILL_BRIDGE_TOKEN,
  SCIENTIFIC_SKILL_PLUGIN_TOKEN,
} from '../../../domain/plugins/scientific';

// Infrastructure implementations
import { PythonSkillBridge } from '../../adapters/scientific/PythonSkillBridge';
import { ScientificSkillPlugin } from '../../plugins/scientific/ScientificSkillPlugin';

/**
 * Register scientific skills services.
 * Called during bootstrap phase.
 */
export function registerScientificSkillsServices(): void {
  // Register Python Skill Bridge
  container.register<IPythonSkillBridge>(
    PYTHON_SKILL_BRIDGE_TOKEN,
    (c) => {
      const logger = c.isRegistered(DI_TOKENS.ILogger)
        ? c.resolve<ILogger>(DI_TOKENS.ILogger)
        : undefined;
      const securityMetrics = createPythonSkillSecurityMetrics();
      const config = getConfig();

      const maxConcurrentRaw = config.PYTHON_SKILL_MAX_CONCURRENT_PROCESSES;
      let maxConcurrentProcesses: number | undefined;

      if (maxConcurrentRaw && maxConcurrentRaw.length > 0) {
        const parsed = Number.parseInt(maxConcurrentRaw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          maxConcurrentProcesses = parsed;
        }
      }

      return new PythonSkillBridge({
        logger,
        securityMetrics,
        maxConcurrentProcesses,
      });
    },
    {
      lifecycle: 'singleton',
      tags: ['scientific', 'bridge', 'python'],
      description: 'Python skill execution bridge',
    },
  );

  // Register Scientific Skill Plugin
  container.register<IScientificSkillPlugin>(
    SCIENTIFIC_SKILL_PLUGIN_TOKEN,
    (c) => {
      const bridge = c.resolve<IPythonSkillBridge>(PYTHON_SKILL_BRIDGE_TOKEN);
      return new ScientificSkillPlugin(bridge as PythonSkillBridge);
    },
    {
      lifecycle: 'singleton',
      tags: ['scientific', 'plugin'],
      description: 'Scientific skills plugin wrapper',
    },
  );
}
