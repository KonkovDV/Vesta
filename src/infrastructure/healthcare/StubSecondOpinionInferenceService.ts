import {
  ISecondOpinionInferenceService,
  InferenceResult,
} from '../../domain/healthcare/ports/ISecondOpinionInferenceService';
import { ImagingStudyRef } from '../../domain/healthcare/value-objects/ImagingStudyRef';
import { ClinicalQuestion } from '../../domain/healthcare/value-objects/ClinicalQuestion';
import { RadiologyReportSummary } from '../../domain/healthcare/value-objects/RadiologyReportSummary';
import { SecondOpinionAssessment } from '../../domain/healthcare/value-objects/SecondOpinionAssessment';

/**
 * Stub implementation of ISecondOpinionInferenceService.
 *
 * Returns a deterministic assessment for testing and development.
 * Real implementation will invoke a multimodal LLM or specialized
 * radiology model (e.g., Med-PaLM 2, BiomedCLIP, RadImageNet).
 *
 * @sota-stub
 * Stub ID: STUB-MRI-INFERENCE-001
 * Dependency blocker: Production multimodal LLM integration + DICOM pixel data pipeline
 * Target resolution: Phase 2 (Google Drive data ingestion + model deployment)
 * Severity: MEDIUM (reduces capability — returns static assessment)
 *
 * @layer Infrastructure
 */
export class StubSecondOpinionInferenceService implements ISecondOpinionInferenceService {
  async generateSecondOpinion(
    study: ImagingStudyRef,
    clinicalQuestion: ClinicalQuestion,
    _originalReport?: RadiologyReportSummary,
  ): Promise<InferenceResult> {
    const assessment = SecondOpinionAssessment.create({
      summary: `AI-generated second opinion for ${study.modality} study of ${study.bodyPartExamined}. ` +
        `Clinical question: "${clinicalQuestion.questionText}". ` +
        `This is a stub assessment pending real model integration.`,
      findings: [
        `${study.modality} study analyzed: ${study.instanceCount} instances across ${study.seriesCount} series`,
        'No acute abnormality identified in stub analysis',
        'Comparison with prior studies pending real model integration',
      ],
      agreementLevel: 'cannot_determine',
      confidenceBand: 'insufficient_data',
      differentialDiagnoses: [],
      recommendations: ['Recommend real AI model evaluation when available'],
      limitations: [
        'This is a stub implementation — no actual image analysis performed',
        'Real model integration required for clinical use',
      ],
      citedReferences: [],
    });

    return {
      assessment,
      modelId: 'stub-mri-inference-v0.0.1',
      latencyMs: 0,
    };
  }
}
