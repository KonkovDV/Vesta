import type { Request, Response, NextFunction, IRouter } from 'express-serve-static-core';
const express = require('express');
import { container } from '../../../core/di/container';
import type { DiagnosisSupportController } from '../controllers/healthcare/DiagnosisSupportController';
import type { GenerateMriSecondOpinionController } from '../controllers/healthcare/GenerateMriSecondOpinionController';
import type { CompleteMriHumanReviewController } from '../controllers/healthcare/CompleteMriHumanReviewController';
import type { FinalizeMriSecondOpinionController } from '../controllers/healthcare/FinalizeMriSecondOpinionController';

export function createHealthcareRoutes(): IRouter {
  const router = express.Router();

  router.post('/diagnosis', (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<DiagnosisSupportController>('DiagnosisSupportController');
    controller.handle(req, res).catch(next);
  });

  router.post('/mri-second-opinion', (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<GenerateMriSecondOpinionController>('GenerateMriSecondOpinionController');
    controller.handle(req, res).catch(next);
  });

  router.post('/mri-second-opinion/:caseId/review', (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<CompleteMriHumanReviewController>('CompleteMriHumanReviewController');
    controller.handle(req, res).catch(next);
  });

  router.post('/mri-second-opinion/:caseId/finalize', (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<FinalizeMriSecondOpinionController>('FinalizeMriSecondOpinionController');
    controller.handle(req, res).catch(next);
  });

  return router;
}
