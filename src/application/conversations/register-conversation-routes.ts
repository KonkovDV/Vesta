import express from 'express';
import * as core from 'express-serve-static-core';

import { ConversationController } from '../controllers/ConversationController';

type ExpressRequest = core.Request;
type ExpressResponse = core.Response;

export type RegisterConversationRoutesOptions = {
  app: express.Application;
  authMw: core.RequestHandler;
  conversationController: ConversationController;
};

export function registerConversationRoutes(
  options: RegisterConversationRoutesOptions,
): void {
  const {
    app,
    authMw,
    conversationController,
  } = options;

  app.get('/bff/conversations', authMw, (req: ExpressRequest, res: ExpressResponse) =>
    conversationController.getConversations(req, res)
  );
  app.post('/bff/conversations', authMw, (req: ExpressRequest, res: ExpressResponse) =>
    conversationController.createConversation(req, res)
  );
  app.get('/bff/conversations/:id', authMw, (req: ExpressRequest, res: ExpressResponse) =>
    conversationController.getConversation(req, res)
  );
  app.put('/bff/conversations/:id', authMw, (req: ExpressRequest, res: ExpressResponse) =>
    conversationController.updateConversation(req, res)
  );
  app.delete('/bff/conversations/:id', authMw, (req: ExpressRequest, res: ExpressResponse) =>
    conversationController.deleteConversation(req, res)
  );
  app.post('/bff/conversations/export', authMw, (req: ExpressRequest, res: ExpressResponse) =>
    conversationController.exportConversations(req, res)
  );
  app.post('/bff/conversations/import', authMw, (req: ExpressRequest, res: ExpressResponse) =>
    conversationController.importConversations(req, res)
  );
}