import type { Request, Response } from 'express-serve-static-core';
import type { ILogger } from '../../../../core/decorators/ILogger';
import {
  ClinicalQuestionSchema,
  ImagingStudyRefSchema,
  RadiologyReportSummarySchema,
} from '../../../../core/events/mri-second-opinion.schemas';
import { RequestContext } from '../../../../application/context/request-context';
import { DomainError } from '../../../../domain/errors/DomainError';
import {
  GenerateMriSecondOpinionUseCase,
} from '../../../../application/services/GenerateMriSecondOpinionUseCase';
import { ImagingStudyRef } from '../../../../domain/healthcare/value-objects/ImagingStudyRef';
import { ClinicalQuestion } from '../../../../domain/healthcare/value-objects/ClinicalQuestion';
import { RadiologyReportSummary } from '../../../../domain/healthcare/value-objects/RadiologyReportSummary';

function getCorrelationId(req: Request): string | undefined {
  try {
    return String(RequestContext.getCorrelationId());
  } catch {
    const headerValue = req.headers['x-correlation-id'];
    return typeof headerValue === 'string' && headerValue.length > 0 ? headerValue : undefined;
  }
}

export class GenerateMriSecondOpinionController {
  constructor(
    private readonly useCase: GenerateMriSecondOpinionUseCase,
    private readonly logger: ILogger,
  ) {}

  handle = async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body ?? {};
      const studyResult = ImagingStudyRefSchema.safeParse(body.study);
      const questionResult = ClinicalQuestionSchema.safeParse(body.clinicalQuestion);
      const reportResult = body.originalReport === undefined
        ? { success: true as const, data: undefined }
        : RadiologyReportSummarySchema.safeParse(body.originalReport);

      if (!studyResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: 'study payload is invalid',
            issues: studyResult.error.issues,
          },
        });
        return;
      }

      if (!questionResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: 'clinicalQuestion payload is invalid',
            issues: questionResult.error.issues,
          },
        });
        return;
      }

      if (!reportResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: 'originalReport payload is invalid',
            issues: reportResult.error.issues,
          },
        });
        return;
      }

      const result = await this.useCase.execute({
        study: ImagingStudyRef.create({
          ...studyResult.data,
          studyDate: new Date(studyResult.data.studyDate),
        }),
        clinicalQuestion: ClinicalQuestion.create(questionResult.data),
        originalReport: reportResult.data
          ? RadiologyReportSummary.create(reportResult.data)
          : undefined,
        correlationId: getCorrelationId(req),
      });

      res.status(201).json({
        data: result,
        meta: {
          workflowState: 'awaiting_human_review',
          deliveryBlocked: result.hasBlockingFlags,
          clinicalUse: result.hasBlockingFlags
            ? 'blocked_pending_manual_review'
            : 'manual_review_required',
          implementation: result.modelId.startsWith('stub-') ? 'stub' : 'production',
        },
      });
    } catch (e) {
      if (e instanceof DomainError) {
        res.status(e.httpStatusCode).json({ error: { code: e.code, message: e.message } });
        return;
      }

      this.logger.error('GenerateMriSecondOpinionController error', { error: e });
      const message = e instanceof Error ? e.message : 'Internal Server Error';
      res.status(500).json({ error: { code: 'INTERNAL', message } });
    }
  };
}