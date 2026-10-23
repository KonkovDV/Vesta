/**
 * SharedTaskListAdapter — Infrastructure adapter for CC-013 Agent Teams.
 *
 * In-memory implementation of ISharedTaskList providing cross-agent
 * task coordination. Tasks are stored in a Map keyed by taskId.
 * Atomic claim semantics: first-writer-wins via status check.
 *
 * @layer Infrastructure (Agents)
 * @pattern CC-013 Agent Teams (FITNESS-K: 73.5)
 * @see src/domain/agents/ISharedTaskList.ts — domain port
 */

import type {
  ISharedTaskList,
  SharedTask,
  SharedTaskInput,
  SharedTaskFilter,
  TeamTaskSummary,
} from '../../domain/agents/ISharedTaskList';

// ─── Helpers ─────────────────────────────────────────────────────

interface MinimalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

let taskCounter = 0;

function generateTaskId(): string {
  taskCounter += 1;
  return `stl-${Date.now()}-${taskCounter}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

// ─── Adapter ─────────────────────────────────────────────────────

export class SharedTaskListAdapter implements ISharedTaskList {
  private readonly tasks = new Map<string, SharedTask>();
  private readonly logger?: MinimalLogger;

  constructor(logger?: MinimalLogger) {
    this.logger = logger;
  }

  async addTask(teamId: string, input: SharedTaskInput): Promise<SharedTask> {
    const now = nowISO();
    const task: SharedTask = {
      taskId: generateTaskId(),
      teamId,
      description: input.description,
      status: 'pending',
      priority: input.priority,
      dependencies: input.dependencies ? [...input.dependencies] : [],
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(task.taskId, task);
    this.logger?.info('Task added', { taskId: task.taskId, teamId, priority: task.priority });
    return task;
  }

  async claimTask(taskId: string, agentId: string): Promise<SharedTask> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.status !== 'pending') {
      throw new Error(`Task ${taskId} is not claimable (status: ${task.status})`);
    }

    // Check dependencies
    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep || dep.status !== 'completed') {
        throw new Error(`Dependency ${depId} is not completed (status: ${dep?.status ?? 'not found'})`);
      }
    }

    const updated: SharedTask = {
      ...task,
      status: 'claimed',
      assignedAgentId: agentId,
      updatedAt: nowISO(),
    };
    this.tasks.set(taskId, updated);
    this.logger?.info('Task claimed', { taskId, agentId });
    return updated;
  }

  async completeTask(taskId: string, result?: string): Promise<SharedTask> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.status !== 'claimed' && task.status !== 'in-progress') {
      throw new Error(`Task ${taskId} cannot be completed (status: ${task.status})`);
    }

    const updated: SharedTask = {
      ...task,
      status: 'completed',
      result,
      updatedAt: nowISO(),
    };
    this.tasks.set(taskId, updated);
    this.logger?.info('Task completed', { taskId, agentId: task.assignedAgentId });
    return updated;
  }

  async failTask(taskId: string, error: string): Promise<SharedTask> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.status !== 'claimed' && task.status !== 'in-progress') {
      throw new Error(`Task ${taskId} cannot be failed (status: ${task.status})`);
    }

    const updated: SharedTask = {
      ...task,
      status: 'failed',
      error,
      updatedAt: nowISO(),
    };
    this.tasks.set(taskId, updated);
    this.logger?.warn('Task failed', { taskId, error, agentId: task.assignedAgentId });
    return updated;
  }

  async cancelTask(taskId: string, reason?: string): Promise<SharedTask> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.status === 'completed' || task.status === 'failed') {
      throw new Error(`Task ${taskId} cannot be cancelled (status: ${task.status})`);
    }

    const updated: SharedTask = {
      ...task,
      status: 'cancelled',
      error: reason,
      updatedAt: nowISO(),
    };
    this.tasks.set(taskId, updated);
    this.logger?.info('Task cancelled', { taskId, reason });
    return updated;
  }

  getTask(taskId: string): SharedTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(filter?: SharedTaskFilter): SharedTask[] {
    let results = Array.from(this.tasks.values());

    if (filter?.teamId) {
      results = results.filter(t => t.teamId === filter.teamId);
    }
    if (filter?.status && filter.status.length > 0) {
      const statusSet = new Set(filter.status);
      results = results.filter(t => statusSet.has(t.status));
    }
    if (filter?.assignedAgentId) {
      results = results.filter(t => t.assignedAgentId === filter.assignedAgentId);
    }
    if (filter?.priority && filter.priority.length > 0) {
      const prioritySet = new Set(filter.priority);
      results = results.filter(t => prioritySet.has(t.priority));
    }

    // Sort by priority (critical first)
    results.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99));

    return results;
  }

  getTeamSummary(teamId: string): TeamTaskSummary {
    const teamTasks = Array.from(this.tasks.values()).filter(t => t.teamId === teamId);

    return {
      teamId,
      total: teamTasks.length,
      pending: teamTasks.filter(t => t.status === 'pending').length,
      claimed: teamTasks.filter(t => t.status === 'claimed').length,
      inProgress: teamTasks.filter(t => t.status === 'in-progress').length,
      completed: teamTasks.filter(t => t.status === 'completed').length,
      failed: teamTasks.filter(t => t.status === 'failed').length,
      cancelled: teamTasks.filter(t => t.status === 'cancelled').length,
    };
  }
}
