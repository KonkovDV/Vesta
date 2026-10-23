/**
 * Lifecycle hook port. HookManager in infrastructure implements it.
 * Layer: Domain
 */

export type LifecycleEventKey =
  | 'before_reply'
  | 'after_reply'
  | 'before_tool'
  | 'after_tool'
  | 'session_start'
  | 'session_end'
  | 'agent_start'
  | 'agent_end'
  | 'error';

export type LifecycleHookHandler<T = unknown> = (event: T) => void | Promise<void>;

export interface ILifecycleHookManager {
  register<T = unknown>(
    eventKey: LifecycleEventKey,
    handler: LifecycleHookHandler<T>,
    priority?: number,
  ): string;
  unregister(registrationId: string): boolean;
  trigger<T = unknown>(eventKey: LifecycleEventKey, event: T): Promise<void>;
}
