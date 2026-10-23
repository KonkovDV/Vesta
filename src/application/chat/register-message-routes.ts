import express from 'express';
import * as core from 'express-serve-static-core';

import { ChatController } from '../controllers/chatController';

type ExpressRequest = core.Request;
type ExpressResponse = core.Response;

export type RegisterMessageRoutesOptions = {
  app: express.Application;
  authMw: core.RequestHandler;
  rateLimitMw: core.RequestHandler;
  chatController: ChatController;
};

export function registerMessageRoutes(
  options: RegisterMessageRoutesOptions,
): void {
  const {
    app,
    authMw,
    rateLimitMw,
    chatController,
  } = options;

  app.post('/bff/messages/send', authMw, rateLimitMw, (req: ExpressRequest, res: ExpressResponse) =>
    chatController.sendMessage(req, res)
  );
  app.post('/bff/messages/:id/regenerate', authMw, (req: ExpressRequest, res: ExpressResponse) =>
    chatController.regenerateMessage(req, res)
  );
  app.post('/bff/generation/stop', authMw, (req: ExpressRequest, res: ExpressResponse) =>
    chatController.stopGeneration(req, res)
  );
  app.post('/bff/feedback/tips', authMw, (req: ExpressRequest, res: ExpressResponse) =>
    chatController.handleTipFeedback(req, res)
  );
}