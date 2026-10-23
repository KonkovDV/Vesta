import type { Request, Response } from 'express-serve-static-core';
import type { LeadScoringUseCase } from '../../../../application/usecases/sales';
import type { ILogger } from '../../../../core/decorators/ILogger';

export class LeadScoringController {
  constructor(
    private readonly useCase: LeadScoringUseCase,
    private readonly logger: ILogger,
  ) {}

  handle = async (req: Request, res: Response): Promise<void> => {
    try {
      const { leadId, companyData, interactionHistory } = req.body ?? {};

      if (!leadId || typeof leadId !== 'string') {
        res.status(400).json({ error: { code: 'VALIDATION', message: 'leadId is required' } });
        return;
      }

      const result = await this.useCase.execute({
        leadId,
        companyData: companyData ?? {},
        interactionHistory: Array.isArray(interactionHistory) ? interactionHistory : [],
      });

      if (result.ok) {
        res.status(200).json({ data: result.data });
      } else {
        const status = result.error?.code === 'VALIDATION' ? 400 : 500;
        res.status(status).json({ error: result.error });
      }
    } catch (e) {
      this.logger.error('LeadScoringController error', { error: e });
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal Server Error' } });
    }
  };
}
