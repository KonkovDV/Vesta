/**
 * MAS event names the journal and the Redis stream agree on.
 * Layer: Domain
 */

export const MAS_EVENT_TOPICS = [
  'mas.session.started',
  'mas.session.completed',
  'mas.session.failed',
  'mas.task.plan_created',
  'mas.task.plan_failed',
  'mas.session.memory_finalized',
  'mas.session.memory_finalization_failed',
  'mas.memory.context_used',
  'mas.task.started',
  'mas.task.completed',
  'mas.task.failed',
  'mas.task_execution.failed',
  'mas.task_execution.dead_lettered',
  'mas.execution_step.failed',
  'agent.status',
  'agent.handoff',
  'agent.conflict',
] as const;

export type MasEventType = (typeof MAS_EVENT_TOPICS)[number];
