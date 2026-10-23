/**
 * Task Prioritizer — Domain Interface (Port)
 *
 * Prioritizes tasks using keyword heuristics + optional LLM fallback.
 * NOTE: This is NOT ITaskDecomposer (existing) — ITaskDecomposer splits tasks
 * into sub-tasks; ITaskPrioritizer scores/ranks tasks by priority.
 *
 * Best Practices Applied (March 2026):
 * - Keyword heuristic maps with weighted scoring (Ch.20 PM Agent)
 * - Multi-signal scoring: title + description + labels
 * - LLM fallback for ambiguous cases when keyword score < threshold
 *
 * @see Book Ch.20 "Project Management Agent" — Task Priority System
 * @see Gulli, "Agentic Design Patterns" (Springer 2026)
 */
import type { CorrelationId } from '@/core/types/branded';

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export interface TaskInput {
  readonly title: string;
  readonly description: string;
  readonly labels?: readonly string[];
  readonly estimatedEffortHours?: number;
}

export interface PrioritizedTask {
  readonly task: TaskInput;
  readonly priority: TaskPriority;
  readonly score: number;                    // 0–100
  readonly reasoning: string;
  readonly matchedKeywords: readonly string[];
}

export interface ITaskPrioritizer {
  /**
   * Batch-prioritize tasks, returning sorted by score descending.
   */
  prioritize(
    tasks: readonly TaskInput[],
    correlationId: CorrelationId,
  ): Promise<readonly PrioritizedTask[]>;

  /**
   * Prioritize a single task.
   */
  prioritizeSingle(
    task: TaskInput,
    correlationId: CorrelationId,
  ): Promise<PrioritizedTask>;
}
