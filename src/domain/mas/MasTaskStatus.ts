/**
 * MAS Durable Execution - task execution status enum.
 *
 * Layer: Domain (MAS durable execution model).
 */
export enum MasTaskStatus {
  Pending = 'Pending',
  Running = 'Running',
  Completed = 'Completed',
  Failed = 'Failed',
  Cancelled = 'Cancelled',
  DeadLettered = 'DeadLettered',
}