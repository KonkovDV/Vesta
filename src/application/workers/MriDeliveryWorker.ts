import type { IClinicalReportDeliveryService } from '../../domain/healthcare/ports/IClinicalReportDeliveryService';
import type { IClinicalReportRenderer } from '../../domain/healthcare/ports/IClinicalReportRenderer';
import type { IMriSecondOpinionCaseRepository } from '../../domain/healthcare/ports/IMriSecondOpinionCaseRepository';
import type { IMriDeliveryJobQueue } from '../../domain/healthcare/ports/IMriDeliveryJobQueue';
import { recordMriDeliveryJob } from '../../monitoring/healthcare-mri-metrics';

export interface MriDeliveryWorkerOptions {
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly enabled: boolean;
}

interface WorkerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export class MriDeliveryWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private stopped = false;

  constructor(
    private readonly jobQueue: IMriDeliveryJobQueue,
    private readonly repository: IMriSecondOpinionCaseRepository,
    private readonly renderer: IClinicalReportRenderer,
    private readonly deliveryService: IClinicalReportDeliveryService,
    private readonly options: MriDeliveryWorkerOptions,
    private readonly logger: WorkerLogger,
  ) {}

  async start(): Promise<void> {
    if (!this.options.enabled) {
      this.logger.info('[MriDeliveryWorker] Disabled by feature flag');
      return;
    }

    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.pollIntervalMs);
    this.timer.unref();

    this.logger.info('[MriDeliveryWorker] Started', {
      batchSize: this.options.batchSize,
      pollIntervalMs: this.options.pollIntervalMs,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('[MriDeliveryWorker] Stopped');
  }

  async tick(): Promise<number> {
    if (this.processing || this.stopped) return 0;
    this.processing = true;

    try {
      const jobs = await this.jobQueue.dequeueBatch(this.options.batchSize);
      let processed = 0;

      for (const job of jobs) {
        await this.processJob(job);
        processed++;
      }

      return processed;
    } finally {
      this.processing = false;
    }
  }

  private async processJob(
    job: Awaited<ReturnType<IMriDeliveryJobQueue['dequeueBatch']>>[number],
  ): Promise<void> {
    const start = Date.now();

    try {
      const mriCase = await this.repository.findById(job.caseId);
      if (!mriCase) {
        throw new Error(`MRI case not found: ${job.caseId}`);
      }

      if (!mriCase.finalSummary || mriCase.finalOutcome !== 'delivered') {
        throw new Error(`MRI case ${job.caseId} is not ready for delivery`);
      }

      const rendered = await this.renderer.render({
        caseId: job.caseId,
        studyInstanceUid: mriCase.study.studyInstanceUid,
        modality: mriCase.study.modality,
        bodyPartExamined: mriCase.study.bodyPartExamined,
        clinicalQuestion: mriCase.clinicalQuestion.questionText,
        urgency: mriCase.clinicalQuestion.urgency,
        finalSummary: mriCase.finalSummary,
        outcome: 'delivered',
        modelId: mriCase.modelId ?? undefined,
        reviewerRole: mriCase.humanReview?.reviewerRole,
        reviewerDecision: mriCase.humanReview?.decision,
        safetyFlags: mriCase.safetyFlags,
      });

      const delivery = await this.deliveryService.deliver({
        caseId: job.caseId,
        correlationId: job.correlationId,
        report: rendered,
      });

      await this.jobQueue.markCompleted(job.jobId);
      recordMriDeliveryJob('success', Date.now() - start);
      this.logger.info('[MriDeliveryWorker] Delivery completed', {
        caseId: job.caseId,
        jobId: job.jobId,
        deliveryId: delivery.deliveryId,
        destinationPath: delivery.destinationPath,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.jobQueue.markFailed(job.jobId, reason);
      recordMriDeliveryJob('failure', Date.now() - start);
      this.logger.error('[MriDeliveryWorker] Delivery failed', {
        caseId: job.caseId,
        jobId: job.jobId,
        error: reason,
      });
    }
  }
}