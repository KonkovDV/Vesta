import type { Request, Response } from 'express-serve-static-core';
import type { ILogger } from '../../../../core/decorators/ILogger';
import {
  HumanReviewDispositionSchema,
  SecondOpinionAssessmentSchema,
} from '../../../../core/events/mri-second-opinion.schemas';
import { RequestContext } from '../../../../application/context/request-context';
import { DomainError } from '../../../../domain/errors/DomainError';
import { CompleteMriHumanReviewUseCase } from '../../../../application/services/CompleteMriHumanReviewUseCase';
import { HumanReviewDisposition } from '../../../../domain/healthcare/value-objects/HumanReviewDisposition';
import { SecondOpinionAssessment } from '../../../../domain/healthcare/value-objects/SecondOpinionAssessment';

function getCorrelationId(req: Request): string | undefined {
  try {
    return String(RequestContext.getCorrelationId());
  } catch {
    const headerValue = req.headers['x-correlation-id'];
    return typeof headerValue === 'string' && headerValue.length > 0 ? headerValue : undefined;
  }
}

export class CompleteMriHumanReviewController {
  constructor(
    private readonly useCase: CompleteMriHumanReviewUseCase,
    private readonly logger: ILogger,
  ) {}

  handle = async (req: Request, res: Response): Promise<void> => {
    try {
      const caseId = req.params.caseId;
      if (!caseId || typeof caseId !== 'string') {
        res.status(400).json({ error: { code: 'VALIDATION', message: 'caseId is required' } });
        return;
      }

      const body = req.body ?? {};
      const dispositionResult = HumanReviewDispositionSchema.safeParse(body.disposition);
      const assessmentResult = body.finalAssessment === undefined
        ? { success: true as const, data: undefined }
        : SecondOpinionAssessmentSchema.safeParse(body.finalAssessment);

      if (!dispositionResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: 'disposition payload is invalid',
            issues: dispositionResult.error.issues,
          },
        });
        return;
      }

      if (!assessmentResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: 'finalAssessment payload is invalid',
            issues: assessmentResult.error.issues,
          },
        });
        return;
      }

      const result = await this.useCase.execute({
        caseId,
        disposition: HumanReviewDisposition.create({
          ...dispositionResult.data,
          reviewedAt: new Date(dispositionResult.data.reviewedAt),
        }),
        finalAssessment: assessmentResult.data
          ? SecondOpinionAssessment.create(assessmentResult.data)
          : undefined,
        correlationId: getCorrelationId(req),
      });

      res.status(200).json({
        data: result,
        meta: {
          workflowState: 'review_completed',
          deliveryBlocked: result.hasBlockingFlags,
          clinicalUse: result.hasBlockingFlags
            ? 'finalization_must_not_deliver'
            : 'ready_for_finalization',
        },
      });
    } catch (e) {
      if (e instanceof DomainError) {
        res.status(e.httpStatusCode).json({ error: { code: e.code, message: e.message } });
        return;
      }

      this.logger.error('CompleteMriHumanReviewController error', { error: e });
      const message = e instanceof Error ? e.message : 'Internal Server Error';
      res.status(500).json({ error: { code: 'INTERNAL', message } });
    }
  };
}