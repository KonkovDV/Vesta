import type { Request, Response, NextFunction, IRouter } from 'express-serve-static-core';
const express = require('express');
import { container } from '../../../core/di/container';
import type { TalentAcquisitionController } from '../controllers/hr/TalentAcquisitionController';
import type { EmployeeEngagementController } from '../controllers/hr/EmployeeEngagementController';

export function createHrRoutes(): IRouter {
  const router = express.Router();

  router.post('/talent-acquisition', (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<TalentAcquisitionController>('TalentAcquisitionController');
    controller.handle(req, res).catch(next);
  });

  router.post('/employee-engagement', (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<EmployeeEngagementController>('EmployeeEngagementController');
    controller.handle(req, res).catch(next);
  });

  return router;
}
