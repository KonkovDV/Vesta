import type { Buffer } from 'node:buffer';

import type { SafetyFlag } from '../aggregates/MriSecondOpinionCase';

export interface RenderClinicalReportInput {
  readonly caseId: string;
  readonly studyInstanceUid: string;
  readonly modality: string;
  readonly bodyPartExamined: string;
  readonly clinicalQuestion: string;
  readonly urgency: 'routine' | 'urgent' | 'stat';
  readonly finalSummary: string;
  readonly outcome: 'delivered' | 'withdrawn' | 'expired';
  readonly modelId?: string;
  readonly reviewerRole?: string;
  readonly reviewerDecision?: 'accepted' | 'modified' | 'rejected' | 'escalated';
  readonly safetyFlags: readonly SafetyFlag[];
}

export interface RenderClinicalReportResult {
  readonly fileName: string;
  readonly bytes: Buffer;
  readonly mimeType: 'application/pdf';
}

export interface IClinicalReportRenderer {
  render(input: RenderClinicalReportInput): Promise<RenderClinicalReportResult>;
}