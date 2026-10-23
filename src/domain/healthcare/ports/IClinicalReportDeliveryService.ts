import type { RenderClinicalReportResult } from './IClinicalReportRenderer';

export interface DeliverClinicalReportInput {
  readonly caseId: string;
  readonly correlationId?: string;
  readonly report: RenderClinicalReportResult;
}

export interface DeliverClinicalReportResult {
  readonly deliveryId: string;
  readonly destinationPath: string;
  readonly deliveredAt: Date;
}

export interface IClinicalReportDeliveryService {
  deliver(input: DeliverClinicalReportInput): Promise<DeliverClinicalReportResult>;
}