/**
 * MAS Runtime Core - Task Decomposer contract.
 *
 * Layer: Application (business orchestration).
 *
 * Task Decomposer converts normalized MAS requests and context
 * into a structured task plan understood by Master Agent.
 *
 * This is a pure contract; implementations are located in impl layer.
 */

import type {
  TaskDecompositionInput,
  MasTaskPlan,
} from '../types/mas-types';

/**
 * Task Decomposer interface.
 */
export interface ITaskDecomposer {
  /**
   * Decompose a normalized MAS request and context into a task plan.
   *
   * Implementations should be deterministic for given input and must not
   * perform direct I/O (Memory/LLM/network); they operate on normalized
   * DTOs and defer side effects to other components.
   */
  decomposeTask(input: TaskDecompositionInput): Promise<MasTaskPlan>;
}

/**
 * DI token for ITaskDecomposer.
 *
 * Used by infrastructure DI bootstrap to register TaskDecomposerV1 and
 * by application-layer services (e.g. MasterAgent) to resolve the
 * decomposer from the shared container.
 */
export const taskDecomposerToken = 'ITaskDecomposer' as const;
export type TaskDecomposerDiToken = typeof taskDecomposerToken;