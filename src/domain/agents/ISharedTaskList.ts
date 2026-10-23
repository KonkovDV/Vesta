/**
 * ISharedTaskList — Domain port for cross-agent task coordination.
 *
 * CC-013 Agent Teams: multiple agents coordinate via a shared
 * event-sourced task list. Companion to ISwarmOrchestrator — the
 * orchestrator decomposes goals into tasks; the shared task list
 * allows agents to claim, complete, and fail tasks independently.
 *
 * SOTA 2026 Basis: CrewAI delegation model, Google ADK task queues,
 * LangGraph shared state. Event-sourced for deterministic replay.
 *
 * @layer Domain (Agents)
 * @pattern CC-013 Agent Teams (FITNESS-K: 73.5)
 * @see src/domain/swarm/ISwarmOrchestrator.ts — goal decomposition companion
 * @see src/domain/events/event-store.interface.ts — event-sourced persistence
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Lifecycle status of a shared task.
 */
export type SharedTaskStatus =
  | 'pending'
  | 'claimed'
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Priority level for task scheduling.
 */
export type SharedTaskPriority = 'critical' | 'high' | 'normal' | 'low';

/**
 * A task within a shared agent team task list.
 */
export interface SharedTask {
  readonly taskId: string;
  readonly teamId: string;
  readonly description: string;
  readonly status: SharedTaskStatus;
  readonly priority: SharedTaskPriority;
  readonly assignedAgentId?: string;
  readonly dependencies: readonly string[];
  readonly result?: string;
  readonly error?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Input for creating a new shared task (auto-generated fields excluded).
 */
export interface SharedTaskInput {
  readonly description: string;
  readonly priority: SharedTaskPriority;
  readonly dependencies?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Filter criteria for listing tasks.
 */
export interface SharedTaskFilter {
  readonly teamId?: string;
  readonly status?: readonly SharedTaskStatus[];
  readonly assignedAgentId?: string;
  readonly priority?: readonly SharedTaskPriority[];
}

/**
 * Summary statistics for a team's task list.
 */
export interface TeamTaskSummary {
  readonly teamId: string;
  readonly total: number;
  readonly pending: number;
  readonly claimed: number;
  readonly inProgress: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * ISharedTaskList — cross-agent task coordination with event-sourced state.
 *
 * Task lifecycle: pending → claimed → in-progress → completed | failed
 *                 pending → cancelled
 *
 * Agents claim tasks atomically (first-writer-wins). Dependencies are
 * checked before a task can be claimed — all dependency tasks must be
 * in 'completed' status.
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface ISharedTaskList {
  /**
   * Add a new task to the team's shared list.
   *
   * @param teamId - Team identifier for multi-team isolation
   * @param input - Task description, priority, and dependencies
   * @returns Created task with generated taskId and 'pending' status
   */
  addTask(teamId: string, input: SharedTaskInput): Promise<SharedTask>;

  /**
   * Claim a pending task for execution by an agent.
   * Fails if task is not pending or dependencies are not met.
   *
   * @param taskId - Task to claim
   * @param agentId - Agent claiming the task
   * @returns Updated task with 'claimed' status
   * @throws Error if task is not claimable or dependencies unmet
   */
  claimTask(taskId: string, agentId: string): Promise<SharedTask>;

  /**
   * Mark a claimed/in-progress task as completed.
   *
   * @param taskId - Task to complete
   * @param result - Optional result summary
   * @returns Updated task with 'completed' status
   * @throws Error if task is not in claimed/in-progress status
   */
  completeTask(taskId: string, result?: string): Promise<SharedTask>;

  /**
   * Mark a claimed/in-progress task as failed.
   *
   * @param taskId - Task to fail
   * @param error - Error description
   * @returns Updated task with 'failed' status
   * @throws Error if task is not in claimed/in-progress status
   */
  failTask(taskId: string, error: string): Promise<SharedTask>;

  /**
   * Cancel a pending or claimed task.
   *
   * @param taskId - Task to cancel
   * @param reason - Optional cancellation reason
   * @returns Updated task with 'cancelled' status
   * @throws Error if task is already completed/failed
   */
  cancelTask(taskId: string, reason?: string): Promise<SharedTask>;

  /**
   * Get a single task by ID.
   *
   * @param taskId - Task identifier
   * @returns Task or undefined if not found
   */
  getTask(taskId: string): SharedTask | undefined;

  /**
   * List tasks matching filter criteria.
   *
   * @param filter - Optional filter (team, status, agent, priority)
   * @returns Matching tasks sorted by priority (critical first)
   */
  listTasks(filter?: SharedTaskFilter): SharedTask[];

  /**
   * Get summary statistics for a team's task list.
   *
   * @param teamId - Team identifier
   * @returns Aggregate counts by status
   */
  getTeamSummary(teamId: string): TeamTaskSummary;
}
