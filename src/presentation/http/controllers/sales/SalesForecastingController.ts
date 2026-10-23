import type { Request, Response } from 'express-serve-static-core';
import type { SalesForecastingUseCase } from '../../../../application/usecases/sales';
import type { ILogger } from '../../../../core/decorators/ILogger';

export class SalesForecastingController {
  constructor(
    private readonly useCase: SalesForecastingUseCase,
    private readonly logger: ILogger,
  ) {}

  handle = async (req: Request, res: Response): Promise<void> => {
    try {
      const { period, historicalData } = req.body ?? {};

      if (!period || typeof period !== 'string') {
        res.status(400).json({ error: { code: 'VALIDATION', message: 'period is required' } });
        return;
      }
      if (!Array.isArray(historicalData) || historicalData.length === 0) {
        res.status(400).json({ error: { code: 'VALIDATION', message: 'historicalData is required' } });
        return;
      }

      const result = await this.useCase.execute({ period, historicalData });

      if (result.ok) {
        res.status(200).json({ data: result.data });
      } else {
        const status = result.error?.code === 'VALIDATION' ? 400 : 500;
        res.status(status).json({ error: result.error });
      }
    } catch (e) {
      this.logger.error('SalesForecastingController error', { error: e });
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal Server Error' } });
    }
  };
}
