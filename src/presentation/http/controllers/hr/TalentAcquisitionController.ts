import type { Request, Response } from 'express-serve-static-core';
import type { TalentAcquisitionUseCase } from '../../../../application/usecases/hr';
import type { ILogger } from '../../../../core/decorators/ILogger';

export class TalentAcquisitionController {
  constructor(
    private readonly useCase: TalentAcquisitionUseCase,
    private readonly logger: ILogger,
  ) {}

  handle = async (req: Request, res: Response): Promise<void> => {
    try {
      const { jobId, candidateProfile, jobRequirements } = req.body ?? {};

      if (!jobId || typeof jobId !== 'string') {
        res.status(400).json({ error: { code: 'VALIDATION', message: 'jobId is required' } });
        return;
      }

      const result = await this.useCase.execute({
        jobId,
        candidateProfile: candidateProfile ?? {},
        jobRequirements: jobRequirements ?? {},
      });

      if (result.ok) {
        res.status(200).json({ data: result.data });
      } else {
        const status = result.error?.code === 'VALIDATION' ? 400 : 500;
        res.status(status).json({ error: result.error });
      }
    } catch (e) {
      this.logger.error('TalentAcquisitionController error', { error: e });
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal Server Error' } });
    }
  };
}
