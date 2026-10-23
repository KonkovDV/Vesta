import { container } from '../../../core/di/container';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import { GenerateMriSecondOpinionUseCase } from '../../../application/services/GenerateMriSecondOpinionUseCase';
import { ImagingIngestionWorker } from '../../../application/workers/ImagingIngestionWorker';
import { MriDeliveryWorker } from '../../../application/workers/MriDeliveryWorker';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import type { IArchiveExtractor } from '../../../domain/healthcare/ports/IArchiveExtractor';
import type { IClinicalReportDeliveryService } from '../../../domain/healthcare/ports/IClinicalReportDeliveryService';
import type { IClinicalReportRenderer } from '../../../domain/healthcare/ports/IClinicalReportRenderer';
import type { IDicomMetadataExtractor } from '../../../domain/healthcare/ports/IDicomMetadataExtractor';
import type { IImagingInboxWatcher } from '../../../domain/healthcare/ports/IImagingInboxWatcher';
import type { IMriDeliveryJobQueue } from '../../../domain/healthcare/ports/IMriDeliveryJobQueue';
import type { IMriSecondOpinionCaseRepository } from '../../../domain/healthcare/ports/IMriSecondOpinionCaseRepository';
import type { IPlatformAdapter } from '../../../domain/platform/IPlatformAdapter';
import { InMemoryMriDeliveryJobQueue } from '../../healthcare/delivery/InMemoryMriDeliveryJobQueue';
import { InMemoryMriCaseRepository } from '../../healthcare/InMemoryMriCaseRepository';
import { StubSecondOpinionInferenceService } from '../../healthcare/StubSecondOpinionInferenceService';
import { DefaultClinicalSafetyPolicy } from '../../healthcare/DefaultClinicalSafetyPolicy';
import { FilesystemClinicalReportDeliveryService } from '../../healthcare/delivery/FilesystemClinicalReportDeliveryService';
import { MinimalDicomMetadataExtractor } from '../../healthcare/imaging/MinimalDicomMetadataExtractor';
import { FilesystemImagingInboxWatcher } from '../../healthcare/ingestion/FilesystemImagingInboxWatcher';
import { SystemArchiveExtractor } from '../../healthcare/ingestion/SystemArchiveExtractor';
import { PuppeteerClinicalReportRenderer } from '../../healthcare/reporting/PuppeteerClinicalReportRenderer';

const healthcareBootstrapLog = getBootstrapLogger('healthcare-module');

function getBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  return value.toLowerCase() === 'true';
}

function getNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createWorkerLogger() {
  return {
    info(message: string, meta?: Record<string, unknown>) {
      healthcareBootstrapLog.info(message, meta);
    },
    warn(message: string, meta?: Record<string, unknown>) {
      healthcareBootstrapLog.warn(message, meta);
    },
    error(message: string, meta?: Record<string, unknown>) {
      healthcareBootstrapLog.error(message, meta);
    },
  };
}

export async function initializeHealthcareWorkers(): Promise<void> {
  const workerTokens = [DI_TOKENS.ImagingIngestionWorker, DI_TOKENS.MriDeliveryWorker] as const;

  for (const token of workerTokens) {
    if (!container.isRegistered(token)) {
      continue;
    }

    try {
      const worker = container.resolve<{ start: () => Promise<void> }>(token);
      await worker.start();
    } catch (error) {
      healthcareBootstrapLog.warn('Healthcare worker initialization failed, continuing without worker', {
        token,
        error,
      });
    }
  }
}

/**
 * Healthcare DI module.
 *
 * Wires the MRI second-opinion domain ports to the currently available
 * infrastructure adapters so the feature is deliverable through DI.
 */
export function registerHealthcareModule(): void {
  if (!container.isRegistered(DI_TOKENS.IMriSecondOpinionCaseRepository)) {
    container.register(
      DI_TOKENS.IMriSecondOpinionCaseRepository,
      () => new InMemoryMriCaseRepository(),
      {
        lifecycle: 'singleton',
        tags: ['healthcare', 'repository', 'memory'],
        description: 'In-memory MRI second-opinion case repository',
      },
    );
  }

  if (!container.isRegistered(DI_TOKENS.ISecondOpinionInferenceService)) {
    container.register(
      DI_TOKENS.ISecondOpinionInferenceService,
      () => new StubSecondOpinionInferenceService(),
      {
        lifecycle: 'singleton',
        tags: ['healthcare', 'inference', 'stub'],
        description: 'Stub MRI second-opinion inference service',
      },
    );
  }

  if (!container.isRegistered(DI_TOKENS.IClinicalSafetyPolicy)) {
    container.register(
      DI_TOKENS.IClinicalSafetyPolicy,
      () => new DefaultClinicalSafetyPolicy(),
      {
        lifecycle: 'singleton',
        tags: ['healthcare', 'safety-policy'],
        description: 'Default MRI clinical safety policy',
      },
    );
  }

  if (!container.isRegistered(DI_TOKENS.IImagingInboxWatcher)) {
    container.register(
      DI_TOKENS.IImagingInboxWatcher,
      () => new FilesystemImagingInboxWatcher(
        {
          inboxDir: process.env.MRI_INGESTION_INBOX_DIR ?? 'runtime/healthcare/mri/inbox',
          processedDir: process.env.MRI_INGESTION_PROCESSED_DIR ?? 'runtime/healthcare/mri/processed',
          rejectedDir: process.env.MRI_INGESTION_REJECTED_DIR ?? 'runtime/healthcare/mri/rejected',
        },
        createWorkerLogger(),
      ),
      {
        lifecycle: 'singleton',
        tags: ['healthcare', 'ingestion', 'filesystem'],
        description: 'Filesystem-based MRI ingestion inbox watcher',
      },
    );
  }

  if (!container.isRegistered(DI_TOKENS.IArchiveExtractor)) {
    container.register(
      DI_TOKENS.IArchiveExtractor,
      (c) => new SystemArchiveExtractor(
        c.resolve<IPlatformAdapter>(DI_TOKENS.IPlatformAdapter),
      ),
      {
        lifecycle: 'singleton',
        tags: ['healthcare', 'ingestion', 'archive'],
        description: 'System archive extractor for MRI ingestion payloads',
      },
    );
  }

  if (!container.isRegistered(DI_TOKENS.IDicomMetadataExtractor)) {
    container.register(
      DI_TOKENS.IDicomMetadataExtractor,
      () => new MinimalDicomMetadataExtractor(),
      {
        lifecycle: 'singleton',
        tags: ['healthcare', 'imaging', 'dicom'],
        description: 'Minimal DICOM metadata extractor for MRI ingestion',
      },
    );
  }

  if (!container.isRegistered(DI_TOKENS.IClinicalReportRenderer)) {
    container.register(
      DI_TOKENS.IClinicalReportRenderer,
      () => new PuppeteerClinicalReportRenderer(),
      {
        lifecycle: 'singleton',
        tags: ['healthcare', 'reporting', 'pdf'],
        description: 'Puppeteer-based MRI clinical report renderer',
      },
    );
  }

  if (!container.isRegistered(DI_TOKENS.IClinicalReportDeliveryService)) {
    container.register(
      DI_TOKENS.IClinicalReportDeliveryService,
      () => new FilesystemClinicalReportDeliveryService(
        process.env.MRI_REPORT_OUTPUT_DIR ?? 'runtime/healthcare/mri/delivered',
      ),
      {
        lifecycle: 'singleton',
        tags: ['healthcare', 'delivery', 'filesystem'],
        description: 'Filesystem delivery sink for finalized MRI reports',
      },
    );
  }

  if (!container.isRegistered(DI_TOKENS.IMriDeliveryJobQueue)) {
    container.register(
      DI_TOKENS.IMriDeliveryJobQueue,
      () => new InMemoryMriDeliveryJobQueue(),
      {
        lifecycle: 'singleton',
        tags: ['healthcare', 'delivery', 'queue', 'memory'],
        description: 'In-memory delivery job queue for MRI finalization workflow',
      },
    );
  }

  if (!container.isRegistered(DI_TOKENS.ImagingIngestionWorker)) {
    container.register(
      DI_TOKENS.ImagingIngestionWorker,
      (c) => new ImagingIngestionWorker(
        c.resolve<IImagingInboxWatcher>(DI_TOKENS.IImagingInboxWatcher),
        c.resolve<IArchiveExtractor>(DI_TOKENS.IArchiveExtractor),
        c.resolve<IDicomMetadataExtractor>(DI_TOKENS.IDicomMetadataExtractor),
        c.resolve<GenerateMriSecondOpinionUseCase>('GenerateMriSecondOpinionUseCase'),
        {
          batchSize: getNumberEnv('MRI_INGESTION_BATCH_SIZE', 4),
          pollIntervalMs: getNumberEnv('MRI_INGESTION_POLL_INTERVAL_MS', 30000),
          enabled: getBooleanEnv('MRI_INGESTION_ENABLED', false),
          extractionRootDir: process.env.MRI_INGESTION_EXTRACTION_DIR ?? 'runtime/healthcare/mri/extracted',
        },
        createWorkerLogger(),
      ),
      {
        lifecycle: 'singleton',
        tags: ['healthcare', 'worker', 'ingestion'],
        description: 'Background ingestion worker for MRI second-opinion requests',
      },
    );
  }

  if (!container.isRegistered(DI_TOKENS.MriDeliveryWorker)) {
    container.register(
      DI_TOKENS.MriDeliveryWorker,
      (c) => new MriDeliveryWorker(
        c.resolve<IMriDeliveryJobQueue>(DI_TOKENS.IMriDeliveryJobQueue),
        c.resolve<IMriSecondOpinionCaseRepository>(DI_TOKENS.IMriSecondOpinionCaseRepository),
        c.resolve<IClinicalReportRenderer>(DI_TOKENS.IClinicalReportRenderer),
        c.resolve<IClinicalReportDeliveryService>(DI_TOKENS.IClinicalReportDeliveryService),
        {
          batchSize: getNumberEnv('MRI_DELIVERY_BATCH_SIZE', 8),
          pollIntervalMs: getNumberEnv('MRI_DELIVERY_POLL_INTERVAL_MS', 15000),
          enabled: getBooleanEnv('MRI_DELIVERY_ENABLED', false),
        },
        createWorkerLogger(),
      ),
      {
        lifecycle: 'singleton',
        tags: ['healthcare', 'worker', 'delivery'],
        description: 'Background delivery worker for finalized MRI reports',
      },
    );
  }
}