import express from 'express';
import * as core from 'express-serve-static-core';

import { ConversationController } from '../controllers/ConversationController';

type ExpressRequest = core.Request;
type ExpressResponse = core.Response;

export type RegisterUploadRoutesOptions = {
  app: express.Application;
  authMw: core.RequestHandler;
  rateLimitMw: core.RequestHandler;
  uploadMw: core.RequestHandler;
  conversationController: ConversationController;
};

export function registerUploadRoutes(
  options: RegisterUploadRoutesOptions,
): void {
  const {
    app,
    authMw,
    rateLimitMw,
    uploadMw,
    conversationController,
  } = options;

  app.post('/bff/upload', authMw, rateLimitMw, uploadMw, (req: ExpressRequest, res: ExpressResponse) =>
    conversationController.uploadFile(req, res)
  );
}