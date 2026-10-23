import type { MriDeliveryJob } from '../../../core/events/mri-second-opinion-operations.schemas';
import type { IMriDeliveryJobQueue } from '../../../domain/healthcare/ports/IMriDeliveryJobQueue';

export class InMemoryMriDeliveryJobQueue implements IMriDeliveryJobQueue {
  private readonly queued: MriDeliveryJob[] = [];
  private readonly inFlight = new Map<string, MriDeliveryJob>();
  private readonly failures = new Map<string, string>();

  async enqueue(job: MriDeliveryJob): Promise<void> {
    this.queued.push(job);
  }

  async dequeueBatch(limit: number): Promise<readonly MriDeliveryJob[]> {
    const jobs = this.queued.splice(0, limit);
    for (const job of jobs) {
      this.inFlight.set(job.jobId, job);
    }
    return jobs;
  }

  async markCompleted(jobId: string): Promise<void> {
    this.inFlight.delete(jobId);
    this.failures.delete(jobId);
  }

  async markFailed(jobId: string, reason: string): Promise<void> {
    this.inFlight.delete(jobId);
    this.failures.set(jobId, reason);
  }

  get size(): number {
    return this.queued.length;
  }

  getFailureReason(jobId: string): string | undefined {
    return this.failures.get(jobId);
  }
}