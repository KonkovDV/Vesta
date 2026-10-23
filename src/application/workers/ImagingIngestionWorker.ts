import path from 'node:path';

import type { IArchiveExtractor } from '../../domain/healthcare/ports/IArchiveExtractor';
import type { IDicomMetadataExtractor } from '../../domain/healthcare/ports/IDicomMetadataExtractor';
import type { IImagingInboxWatcher } from '../../domain/healthcare/ports/IImagingInboxWatcher';
import { ClinicalQuestion } from '../../domain/healthcare/value-objects/ClinicalQuestion';
import { ImagingStudyRef } from '../../domain/healthcare/value-objects/ImagingStudyRef';
import type { GenerateMriSecondOpinionUseCase } from '../services/GenerateMriSecondOpinionUseCase';
import {
  recordMriIngestionJob,
  recordMriIngestionStage,
} from '../../monitoring/healthcare-mri-metrics';

export interface ImagingIngestionWorkerOptions {
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly enabled: boolean;
  readonly extractionRootDir: string;
}

interface WorkerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export class ImagingIngestionWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private stopped = false;

  constructor(
    private readonly inboxWatcher: IImagingInboxWatcher,
    private readonly archiveExtractor: IArchiveExtractor,
    private readonly metadataExtractor: IDicomMetadataExtractor,
    private readonly generateUseCase: GenerateMriSecondOpinionUseCase,
    private readonly options: ImagingIngestionWorkerOptions,
    private readonly logger: WorkerLogger,
  ) {}

  async start(): Promise<void> {
    if (!this.options.enabled) {
      this.logger.info('[ImagingIngestionWorker] Disabled by feature flag');
      return;
    }

    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.pollIntervalMs);
    this.timer.unref();

    this.logger.info('[ImagingIngestionWorker] Started', {
      batchSize: this.options.batchSize,
      pollIntervalMs: this.options.pollIntervalMs,
      extractionRootDir: this.options.extractionRootDir,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('[ImagingIngestionWorker] Stopped');
  }

  async tick(): Promise<number> {
    if (this.processing || this.stopped) return 0;
    this.processing = true;

    try {
      const items = await this.inboxWatcher.pollPendingStudies(this.options.batchSize);
      let processed = 0;

      for (const item of items) {
        await this.processItem(item);
        processed++;
      }

      return processed;
    } finally {
      this.processing = false;
    }
  }

  private async processItem(
    item: Awaited<ReturnType<IImagingInboxWatcher['pollPendingStudies']>>[number],
  ): Promise<void> {
    const extractionDir = path.join(this.options.extractionRootDir, item.sourceId);
    let extractedRoot: string | null = null;

    try {
      const extractStart = Date.now();
      const extraction = await this.archiveExtractor.extract(item.archivePath ?? item.sourcePath, extractionDir);
      extractedRoot = extraction.rootDirectory;
      recordMriIngestionStage('archive_extract', Date.now() - extractStart);

      const metadataStart = Date.now();
      const extractedStudy = await this.metadataExtractor.extractStudy(extraction.rootDirectory, item);
      recordMriIngestionStage('dicom_metadata_extract', Date.now() - metadataStart);

      const study = ImagingStudyRef.create({
        studyInstanceUid: extractedStudy.study.studyInstanceUid,
        modality: extractedStudy.study.modality,
        bodyPartExamined: extractedStudy.study.bodyPartExamined,
        studyDate: new Date(extractedStudy.study.studyDate),
        seriesCount: extractedStudy.study.seriesCount,
        instanceCount: extractedStudy.study.instanceCount,
        accessionNumber: extractedStudy.study.accessionNumber,
        referringPhysician: extractedStudy.study.referringPhysician,
      });

      const clinicalQuestion = this.resolveClinicalQuestion(item, extractedStudy.derivedClinicalQuestion);
      const generateStart = Date.now();
      const result = await this.generateUseCase.execute({
        study,
        clinicalQuestion,
        correlationId: item.sourceId,
      });
      recordMriIngestionStage('generate_second_opinion', Date.now() - generateStart);

      await this.inboxWatcher.markAccepted(item.sourceId, {
        caseId: result.caseId,
        studyInstanceUid: study.studyInstanceUid,
      });
      recordMriIngestionJob('filesystem', 'accepted');
      this.logger.info('[ImagingIngestionWorker] Ingestion accepted', {
        sourceId: item.sourceId,
        caseId: result.caseId,
        studyInstanceUid: study.studyInstanceUid,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.inboxWatcher.markRejected(item.sourceId, reason);
      recordMriIngestionJob('filesystem', 'failed');
      this.logger.error('[ImagingIngestionWorker] Ingestion failed', {
        sourceId: item.sourceId,
        error: reason,
      });
    } finally {
      if (extractedRoot) {
        try {
          await this.archiveExtractor.cleanup(extractedRoot);
        } catch (cleanupError) {
          this.logger.warn?.('[ImagingIngestionWorker] Cleanup failed', {
            rootDirectory: extractedRoot,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
    }
  }

  private resolveClinicalQuestion(
    item: Awaited<ReturnType<IImagingInboxWatcher['pollPendingStudies']>>[number],
    derivedQuestion?: {
      questionText: string;
      clinicalContext?: string;
      priorStudyUids?: readonly string[];
      urgency: 'routine' | 'urgent' | 'stat';
    },
  ): ClinicalQuestion {
    if (item.clinicalQuestion) {
      return ClinicalQuestion.create({
        questionText: item.clinicalQuestion.questionText,
        clinicalContext: item.clinicalQuestion.clinicalContext,
        priorStudyUids: [...item.clinicalQuestion.priorStudyUids],
        urgency: item.clinicalQuestion.urgency,
      });
    }

    if (derivedQuestion) {
      return ClinicalQuestion.create({
        questionText: derivedQuestion.questionText,
        clinicalContext: derivedQuestion.clinicalContext,
        priorStudyUids: [...(derivedQuestion.priorStudyUids ?? [])],
        urgency: derivedQuestion.urgency,
      });
    }

    return ClinicalQuestion.create({
      questionText: 'Routine second opinion review requested',
      clinicalContext: item.requestedBy
        ? `Auto-ingested study submitted by ${item.requestedBy}`
        : 'Auto-ingested study without explicit clinical prompt',
      urgency: 'routine',
    });
  }
}