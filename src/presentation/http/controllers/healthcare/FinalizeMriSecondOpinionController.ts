import type { Request, Response } from 'express-serve-static-core';
import type { ILogger } from '../../../../core/decorators/ILogger';
import { MriCaseFinalizedPayloadSchema } from '../../../../core/events/mri-second-opinion.schemas';
import { RequestContext } from '../../../../application/context/request-context';
import { DomainError } from '../../../../domain/errors/DomainError';
import { FinalizeMriSecondOpinionUseCase } from '../../../../application/services/FinalizeMriSecondOpinionUseCase';

function getCorrelationId(req: Request): string | undefined {
  try {
    return String(RequestContext.getCorrelationId());
  } catch {
    const headerValue = req.headers['x-correlation-id'];
    return typeof headerValue === 'string' && headerValue.length > 0 ? headerValue : undefined;
  }
}

export class FinalizeMriSecondOpinionController {
  constructor(
    private readonly useCase: FinalizeMriSecondOpinionUseCase,
    private readonly logger: ILogger,
  ) {}

  handle = async (req: Request, res: Response): Promise<void> => {
    try {
      const caseId = req.params.caseId;
      if (!caseId || typeof caseId !== 'string') {
        res.status(400).json({ error: { code: 'VALIDATION', message: 'caseId is required' } });
        return;
      }

      const bodyResult = MriCaseFinalizedPayloadSchema.safeParse(req.body ?? {});
      if (!bodyResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: 'finalization payload is invalid',
            issues: bodyResult.error.issues,
          },
        });
        return;
      }

      const result = await this.useCase.execute({
        caseId,
        outcome: bodyResult.data.outcome,
        finalSummary: bodyResult.data.finalSummary,
        correlationId: getCorrelationId(req),
      });

      res.status(200).json({
        data: result,
        meta: {
          workflowState: 'finalized',
          deliveryBlocked: result.hasBlockingFlags,
          finalOutcome: result.outcome,
        },
      });
    } catch (e) {
      if (e instanceof DomainError) {
        res.status(e.httpStatusCode).json({ error: { code: e.code, message: e.message } });
        return;
      }

      this.logger.error('FinalizeMriSecondOpinionController error', { error: e });
      const message = e instanceof Error ? e.message : 'Internal Server Error';
      res.status(500).json({ error: { code: 'INTERNAL', message } });
    }
  };
}