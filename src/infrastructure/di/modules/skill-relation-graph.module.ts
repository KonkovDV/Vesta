/**
 * Skill Relation Graph DI Module.
 *
 * Registers CC-037 adapter for inter-skill relation modeling.
 * Production: PostgresSkillRelationGraphAdapter (requires IDatabaseConnection).
 * Fallback: SkillRelationGraphAdapter (in-memory, for tests/missing DB).
 *
 * @module infrastructure/di/modules
 * @pattern CC-037 Skill Relation Graph (FITNESS-K: 79)
 * @academic SkillNet (arXiv:2603.04448) — Donor #28 EXTRACT-K
 */

import { container } from '../../../core/di/container';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import type { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';
import { SkillRelationGraphAdapter } from '../../agents/SkillRelationGraphAdapter';
import { PostgresSkillRelationGraphAdapter } from '../../agents/PostgresSkillRelationGraphAdapter';

export function registerSkillRelationGraphModule(): void {
  if (container.isRegistered(DI_TOKENS.ISkillRelationGraph)) return;

  container.register(
    DI_TOKENS.ISkillRelationGraph,
    () => {
      try {
        if (container.isRegistered(DI_TOKENS.IDatabaseConnection)) {
          const db = container.resolve<IDatabaseConnection>(DI_TOKENS.IDatabaseConnection);
          return new PostgresSkillRelationGraphAdapter(db);
        }
      } catch {
        // Fall through to in-memory adapter
      }
      return new SkillRelationGraphAdapter();
    },
    { lifecycle: 'singleton', tags: ['skills', 'graph', 'relations'] },
  );
}
