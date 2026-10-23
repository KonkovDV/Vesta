/**
 * MAS Durable Execution - per-step execution status enum.
 *
 * Layer: Domain (MAS durable execution model).
 *
 * This status reflects the lifecycle of an individual execution step
 * inside a durable MAS task execution.
 */
export enum MasExecutionStatus {
  /**
   * Step is planned but has not been started yet.
   */
  Planned = 'Planned',

  /**
   * Step is currently in progress (owned by some worker/executor).
   */
  InProgress = 'InProgress',

  /**
   * Step has completed successfully.
   */
  Completed = 'Completed',

  /**
   * Step has failed and will not be retried anymore
   * (either retries exhausted or considered non‑recoverable).
   */
  Failed = 'Failed',

  /**
   * Step was explicitly cancelled by orchestration logic or caller.
   */
  Cancelled = 'Cancelled',

  /**
   * Step cannot proceed because of external conditions
   * (e.g. upstream dependency, circuit, policy).
   */
  Blocked = 'Blocked',

  /**
   * Step was intentionally skipped (e.g. failed dependency in plan).
   */
  Skipped = 'Skipped',
}