/**
 * Zod validation schemas for MRI Second Opinion domain events.
 *
 * Runtime validation for the CDS "second opinion" workflow:
 * Study submission → AI inference → human review → final assessment.
 *
 * Academic basis:
 * - DICOM PS3.3 (ISO 12052:2022) for Study/Series UID semantics
 * - HL7 FHIR R5 ImagingStudy for interoperability alignment
 * - ACR Practice Parameters for structured reporting
 * - PI-RADS v2.1 / BI-RADS 5th Ed / LI-RADS v2018 for assessment categories
 * - FD&C Act §520(o)(1)(E) (added by 21st Century Cures Act §3060) for FDA CDS exemption criteria
 *
 * @layer Core (validation schemas)
 * @module healthcare/mri-second-opinion
 * @see src/domain/healthcare/aggregates/MriSecondOpinionCase.ts — aggregate
 */

import { z } from 'zod';

// ── DICOM UID Pattern (PS3.5 §9.1) ────────────────────────────────
// UIDs: dot-separated numeric components, max 64 chars
const dicomUidPattern = /^[0-9]+(\.[0-9]+)*$/;

// ── Imaging Study Reference ────────────────────────────────────────

export const ImagingStudyRefSchema = z.object({
  studyInstanceUid: z.string().regex(dicomUidPattern, 'Invalid DICOM UID format (PS3.5 §9.1)').max(64),
  modality: z.string().min(1).max(16),
  bodyPartExamined: z.string().min(1).max(64),
  studyDate: z.string().datetime(),
  seriesCount: z.number().int().nonnegative(),
  instanceCount: z.number().int().nonnegative(),
  accessionNumber: z.string().max(16).optional(),
  referringPhysician: z.string().max(128).optional(),
}).strict();

// ── Clinical Question ──────────────────────────────────────────────

export const ClinicalQuestionSchema = z.object({
  questionText: z.string().min(1).max(2000),
  clinicalContext: z.string().max(4000).optional(),
  priorStudyUids: z.array(z.string().regex(dicomUidPattern).max(64)).default([]),
  urgency: z.enum(['routine', 'urgent', 'stat']),
}).strict();

// ── Radiology Report Summary ───────────────────────────────────────

export const RadiologyReportSummarySchema = z.object({
  findings: z.string().min(1).max(8000),
  impression: z.string().min(1).max(4000),
  assessmentCategory: z.string().max(32).optional(),
  radLexCodes: z.array(z.string().min(1)).default([]),
  snomedCodes: z.array(z.string().min(1)).default([]),
}).strict();

// ── Second Opinion Assessment ──────────────────────────────────────

export const SecondOpinionAssessmentSchema = z.object({
  summary: z.string().min(1).max(8000),
  findings: z.array(z.string().min(1)).min(1),
  agreementLevel: z.enum([
    'full_agreement',
    'partial_agreement',
    'significant_disagreement',
    'cannot_determine',
  ]),
  confidenceBand: z.enum(['high', 'moderate', 'low', 'insufficient_data']),
  differentialDiagnoses: z.array(z.string().min(1)).default([]),
  recommendations: z.array(z.string().min(1)).default([]),
  limitations: z.array(z.string().min(1)).default([]),
  citedReferences: z.array(z.string().min(1)).default([]),
}).strict();

// ── Human Review Disposition ───────────────────────────────────────

export const HumanReviewDispositionSchema = z.object({
  reviewerRole: z.string().min(1).max(128),
  decision: z.enum(['accepted', 'modified', 'rejected', 'escalated']),
  modifications: z.string().max(4000).optional(),
  clinicalNotes: z.string().max(4000).optional(),
  reviewedAt: z.string().datetime(),
}).strict();

// ── Event Payload Schemas ──────────────────────────────────────────

export const MriStudySubmittedPayloadSchema = z.object({
  study: ImagingStudyRefSchema,
  clinicalQuestion: ClinicalQuestionSchema,
  originalReport: RadiologyReportSummarySchema.optional(),
}).strict();

export const MriInferenceCompletedPayloadSchema = z.object({
  assessment: SecondOpinionAssessmentSchema,
  modelId: z.string().min(1),
  inferenceLatencyMs: z.number().nonnegative(),
}).strict();

export const MriHumanReviewCompletedPayloadSchema = z.object({
  disposition: HumanReviewDispositionSchema,
  finalAssessment: SecondOpinionAssessmentSchema.optional(),
}).strict();

export const MriCaseFinalizedPayloadSchema = z.object({
  outcome: z.enum(['delivered', 'withdrawn', 'expired']),
  finalSummary: z.string().min(1).max(8000),
}).strict();

export const MriSafetyFlagRaisedPayloadSchema = z.object({
  flagCode: z.string().min(1).max(64),
  severity: z.enum(['info', 'warning', 'critical']),
  description: z.string().min(1).max(2000),
  blocksDelivery: z.boolean(),
}).strict();

// ── Inferred Types ─────────────────────────────────────────────────

export type ImagingStudyRefInput = z.infer<typeof ImagingStudyRefSchema>;
export type ClinicalQuestionInput = z.infer<typeof ClinicalQuestionSchema>;
export type RadiologyReportSummaryInput = z.infer<typeof RadiologyReportSummarySchema>;
export type SecondOpinionAssessmentInput = z.infer<typeof SecondOpinionAssessmentSchema>;
export type HumanReviewDispositionInput = z.infer<typeof HumanReviewDispositionSchema>;
export type MriStudySubmittedPayload = z.infer<typeof MriStudySubmittedPayloadSchema>;
export type MriInferenceCompletedPayload = z.infer<typeof MriInferenceCompletedPayloadSchema>;
export type MriHumanReviewCompletedPayload = z.infer<typeof MriHumanReviewCompletedPayloadSchema>;
export type MriCaseFinalizedPayload = z.infer<typeof MriCaseFinalizedPayloadSchema>;
export type MriSafetyFlagRaisedPayload = z.infer<typeof MriSafetyFlagRaisedPayloadSchema>;
