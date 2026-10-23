import fs from 'node:fs/promises';
import path from 'node:path';

import { IdGenerator } from '../../../core/utils/IdGenerator';
import type {
  DeliverClinicalReportInput,
  DeliverClinicalReportResult,
  IClinicalReportDeliveryService,
} from '../../../domain/healthcare/ports/IClinicalReportDeliveryService';

export class FilesystemClinicalReportDeliveryService implements IClinicalReportDeliveryService {
  constructor(private readonly outputDir: string) {}

  async deliver(input: DeliverClinicalReportInput): Promise<DeliverClinicalReportResult> {
    const targetDir = path.join(this.outputDir, input.caseId);
    await fs.mkdir(targetDir, { recursive: true });

    const destinationPath = path.join(targetDir, input.report.fileName);
    await fs.writeFile(destinationPath, input.report.bytes);

    return {
      deliveryId: IdGenerator.generateWithPrefix('mri_delivery'),
      destinationPath,
      deliveredAt: new Date(),
    };
  }
}