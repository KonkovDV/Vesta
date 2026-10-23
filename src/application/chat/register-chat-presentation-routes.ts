import express from 'express';
import * as core from 'express-serve-static-core';

import { ChatController } from '../controllers/chatController';

type ExpressRequest = core.Request;
type ExpressResponse = core.Response;

type ChatControllerWithRawFacades = ChatController & {
  getServerPropsRaw?: (req: ExpressRequest, res: ExpressResponse) => void | Promise<void>;
  getSlotsRaw?: (req: ExpressRequest, res: ExpressResponse) => void | Promise<void>;
  getModels?: (req: ExpressRequest, res: ExpressResponse) => void | Promise<void>;
};

export type RegisterChatPresentationRoutesOptions = {
  app: express.Application;
  authMw: core.RequestHandler;
  rateLimitMw: core.RequestHandler;
  chatController: ChatController;
};

export function registerChatPresentationRoutes(
  options: RegisterChatPresentationRoutesOptions,
): void {
  const {
    app,
    authMw,
    rateLimitMw,
    chatController,
  } = options;
  const extendedCtrl = chatController as ChatControllerWithRawFacades;

  app.post('/v1/chat/completions', authMw, rateLimitMw, (req: ExpressRequest, res: ExpressResponse) =>
    chatController.chatCompletions(req, res)
  );

  app.get('/props', authMw, (req: ExpressRequest, res: ExpressResponse) => {
    if (typeof extendedCtrl.getServerPropsRaw === 'function') {
      return extendedCtrl.getServerPropsRaw(req, res);
    }
    return chatController.getServerProps(req, res);
  });

  app.get('/slots', authMw, (req: ExpressRequest, res: ExpressResponse) => {
    if (typeof extendedCtrl.getSlotsRaw === 'function') {
      return extendedCtrl.getSlotsRaw(req, res);
    }
    return chatController.getSlots(req, res);
  });

  app.get('/v1/models', authMw, (req: ExpressRequest, res: ExpressResponse) => {
    if (typeof extendedCtrl.getModels === 'function') {
      return extendedCtrl.getModels(req, res);
    }
    return res.status(501).json({ error: { message: 'Not Implemented' } });
  });

  app.post('/bff/chat/completions', authMw, rateLimitMw, (req: ExpressRequest, res: ExpressResponse) =>
    chatController.chatCompletions(req, res)
  );
  app.get('/bff/props', authMw, (req: ExpressRequest, res: ExpressResponse) => chatController.getServerProps(req, res));
  app.get('/bff/slots', authMw, (req: ExpressRequest, res: ExpressResponse) => chatController.getSlots(req, res));
}