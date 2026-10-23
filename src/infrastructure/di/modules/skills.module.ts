/**
 * Skills DI Module
 *
 * Registers generic skill loading services.
 * Layer: Infrastructure/DI
 */

import { DI_TOKENS } from '@/core/di/DI_TOKENS';
import { container } from '../../../core/di/container';
import { getConfig } from '../../../config';
import { ISkillLoader } from '../../../domain/skills';
import { FileSystemSkillLoader } from '../../skills/file-system-skill-loader';
import { SkillRegistryService, ISkillRegistry } from '../../skills/skill-registry.service';

/**
 * Register generic skill services.
 * Called during bootstrap phase.
 */
export function registerSkillsServices(): void {
  // Register File System Skill Loader
  container.register<ISkillLoader>(
    'ISkillLoader',
    (c) => {
      // Optional: Load path from config if available
      // const config = getConfig();
      // const rootPath = config.SKILLS_PATH; 
      
      // Using default path resolution in FileSystemSkillLoader for now
      return new FileSystemSkillLoader();
    },
    {
      lifecycle: 'singleton',
      tags: ['skills', 'loader', 'infrastructure'],
      description: 'Loads skills from filesystem (markdown)',
    },
  );

  // Register Skill Registry
  container.register<ISkillRegistry>(
    'ISkillRegistry',
    (c) => new SkillRegistryService(
      c.resolve('ISkillLoader'),
      c.resolve(DI_TOKENS.IToolRegistry),
      c.resolve(DI_TOKENS.ILogger)
    ),
    {
      lifecycle: 'singleton',
      tags: ['skills', 'registry', 'infrastructure'],
      description: 'Orchestrates loading skills and registering them as Agent Tools',
    }
  );
}

/**
 * Initialize generic skill services.
 * Should be called after all registrations are complete.
 */
export async function initializeSkillsServices(): Promise<void> {
  try {
    const registry = container.resolve<ISkillRegistry>(DI_TOKENS.ISkillRegistry);
    await registry.initialize();
    console.log('✓ Skills initialized');
  } catch (error) {
    console.error('✗ Failed to initialize skills:', error);
    // Non-blocking failure for now? OR strict? 
    // Skills are critical for Phase C.
    // throw error; 
    // But for robustness, log and continue? 
    // Let's log error but not crash checking `initializeAgentRunnerServices` pattern.
  }
}
