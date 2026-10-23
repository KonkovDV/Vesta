import type { Request, Response } from 'express-serve-static-core';
import type { EmployeeEngagementUseCase } from '../../../../application/usecases/hr';
import type { ILogger } from '../../../../core/decorators/ILogger';

export class EmployeeEngagementController {
  constructor(
    private readonly useCase: EmployeeEngagementUseCase,
    private readonly logger: ILogger,
  ) {}

  handle = async (req: Request, res: Response): Promise<void> => {
    try {
      const { employeeId, surveyData, performanceMetrics } = req.body ?? {};

      if (!employeeId || typeof employeeId !== 'string') {
        res.status(400).json({ error: { code: 'VALIDATION', message: 'employeeId is required' } });
        return;
      }

      const result = await this.useCase.execute({
        employeeId,
        surveyData: surveyData ?? {},
        performanceMetrics: Array.isArray(performanceMetrics) ? performanceMetrics : [],
      });

      if (result.ok) {
        res.status(200).json({ data: result.data });
      } else {
        const status = result.error?.code === 'VALIDATION' ? 400 : 500;
        res.status(status).json({ error: result.error });
      }
    } catch (e) {
      this.logger.error('EmployeeEngagementController error', { error: e });
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal Server Error' } });
    }
  };
}
