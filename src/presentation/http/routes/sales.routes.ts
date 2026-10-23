import type { Request, Response, NextFunction, IRouter } from 'express-serve-static-core';
const express = require('express');
import { container } from '../../../core/di/container';
import type { LeadScoringController } from '../controllers/sales/LeadScoringController';
import type { SalesForecastingController } from '../controllers/sales/SalesForecastingController';

export function createSalesRoutes(): IRouter {
  const router = express.Router();

  router.post('/lead-scoring', (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<LeadScoringController>('LeadScoringController');
    controller.handle(req, res).catch(next);
  });

  router.post('/forecasting', (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<SalesForecastingController>('SalesForecastingController');
    controller.handle(req, res).catch(next);
  });

  return router;
}
