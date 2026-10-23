/**
 * Ingestion Routes — REST API for multimodal content ingestion.
 * 
 * Mounts at: /api/v1/memory/ingest
 * 
 * Layer: Presentation/HTTP
 */

import type { Request, Response, NextFunction, IRouter } from 'express-serve-static-core';
 
const express = require('express');
import { container } from '../../../core/di/container';
import { IngestionController } from '../controllers/ingestion/IngestionController';

export function createIngestionRoutes(): IRouter {
  const router = express.Router();

  // POST /api/v1/memory/ingest/pdf
  router.post('/pdf', (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<IngestionController>('IngestionController');
    controller.ingestPdf(req, res).catch(next);
  });

  // POST /api/v1/memory/ingest/image
  router.post('/image', (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<IngestionController>('IngestionController');
    controller.ingestImage(req, res).catch(next);
  });

  // POST /api/v1/memory/ingest/text
  router.post('/text', (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<IngestionController>('IngestionController');
    controller.ingestText(req, res).catch(next);
  });

  // POST /api/v1/memory/ingest/url
  router.post('/url', (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<IngestionController>('IngestionController');
    controller.ingestUrl(req, res).catch(next);
  });

  // GET /api/v1/memory/ingest/types
  router.get('/types', (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<IngestionController>('IngestionController');
    controller.getSupportedTypes(req, res).catch(next);
  });

  return router;
}
