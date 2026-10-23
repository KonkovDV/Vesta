import type { Request, Response } from 'express-serve-static-core';
import type { DiagnosisSupportUseCase } from '../../../../application/usecases/healthcare/DiagnosisSupportUseCase';
import type { ILogger } from '../../../../core/decorators/ILogger';

export class DiagnosisSupportController {
  constructor(
    private readonly useCase: DiagnosisSupportUseCase,
    private readonly logger: ILogger,
  ) {}

  handle = async (req: Request, res: Response): Promise<void> => {
    try {
      const { patientId, symptoms } = req.body ?? {};

      if (!patientId || typeof patientId !== 'string') {
        res.status(400).json({ error: { code: 'VALIDATION', message: 'patientId is required' } });
        return;
      }
      if (!Array.isArray(symptoms) || symptoms.length === 0) {
        res.status(400).json({ error: { code: 'VALIDATION', message: 'symptoms array is required' } });
        return;
      }

      const { RequestContext } = await import('../../../../application/context/request-context');
      const result = await this.useCase.analyzePatient(patientId, symptoms, RequestContext);

      res.status(200).json({ data: result });
    } catch (e) {
      this.logger.error('DiagnosisSupportController error', { error: e });
      const message = e instanceof Error ? e.message : 'Internal Server Error';
      res.status(500).json({ error: { code: 'INTERNAL', message } });
    }
  };
}
