import { ImagingStudyRef } from '../value-objects/ImagingStudyRef';
import { ClinicalQuestion } from '../value-objects/ClinicalQuestion';
import { RadiologyReportSummary } from '../value-objects/RadiologyReportSummary';
import { SecondOpinionAssessment } from '../value-objects/SecondOpinionAssessment';

/**
 * Port for AI-powered second opinion inference.
 *
 * Abstracts the actual inference backend (multimodal LLM,
 * specialized radiology model, ensemble, etc.).
 *
 * The inference service:
 * 1. Receives the imaging study reference + clinical question
 * 2. May optionally receive the original radiologist's report
 * 3. Returns a structured SecondOpinionAssessment
 *
 * FDA CDS note: this service generates clinician-review-required CDS output that
 * MUST be reviewed by a qualified healthcare professional before
 * clinical action. The system does NOT make autonomous clinical decisions.
 *
 * @layer Domain (port)
 */

export interface InferenceResult {
  readonly assessment: SecondOpinionAssessment;
  readonly modelId: string;
  readonly latencyMs: number;
}

export interface ISecondOpinionInferenceService {
  /**
   * Generate a second opinion assessment for a given imaging study.
   *
   * @param study - Reference to the DICOM imaging study
   * @param clinicalQuestion - The referring physician's question
   * @param originalReport - Optional original radiology report for comparison
   * @returns Structured assessment with agreement level and confidence band
   * @throws {Error} If inference fails or times out
   */
  generateSecondOpinion(
    study: ImagingStudyRef,
    clinicalQuestion: ClinicalQuestion,
    originalReport?: RadiologyReportSummary,
  ): Promise<InferenceResult>;
}
