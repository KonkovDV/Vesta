import type { MriDeliveryJob } from '../../../core/events/mri-second-opinion-operations.schemas';

export interface IMriDeliveryJobQueue {
  enqueue(job: MriDeliveryJob): Promise<void>;
  dequeueBatch(limit: number): Promise<readonly MriDeliveryJob[]>;
  markCompleted(jobId: string): Promise<void>;
  markFailed(jobId: string, reason: string): Promise<void>;
}