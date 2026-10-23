/**
 * Scientific Skill Plugin Port
 *
 * Domain-layer contract for scientific skills plugin.
 * Infrastructure provides the implementation via DI.
 */

import type { IMicroPhoenixPlugin } from '../microphoenix-plugin.port';

/**
 * Port for scientific skills plugin.
 * Implemented by Infrastructure layer (ScientificSkillPlugin).
 *
 * Follows Clean Architecture: Domain defines the contract,
 * Infrastructure provides the implementation.
 */
export interface IScientificSkillPlugin extends IMicroPhoenixPlugin {
	execute(input: unknown, context: unknown): Promise<unknown> | unknown;
}

/**
 * DI token for ScientificSkillPlugin
 */
export const SCIENTIFIC_SKILL_PLUGIN_TOKEN = 'IScientificSkillPlugin' as const;
