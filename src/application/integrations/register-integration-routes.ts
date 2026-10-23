import express from 'express';
import * as core from 'express-serve-static-core';

import { PluginController } from '../controllers/PluginController';
import { SlackEntController } from '../controllers/slackEntController';
import { createSlackSignatureMiddleware } from '../middleware/slack-signature.middleware';

type ExpressRequest = core.Request;
type ExpressResponse = core.Response;

export type RegisterIntegrationRoutesOptions = {
  app: express.Application;
  authMw: core.RequestHandler;
  rateLimitMw: core.RequestHandler;
  pluginController: PluginController;
  slackEntController: SlackEntController;
};

export function registerIntegrationRoutes(
  options: RegisterIntegrationRoutesOptions,
): void {
  const {
    app,
    authMw,
    rateLimitMw,
    pluginController,
    slackEntController,
  } = options;
  const slackSignatureMw = createSlackSignatureMiddleware();

  app.post('/api/plugins/execute', authMw, rateLimitMw, (req: ExpressRequest, res: ExpressResponse) =>
    pluginController.execute(req, res)
  );
  app.post('/ent/slack/slash', slackSignatureMw, (req: ExpressRequest, res: ExpressResponse) =>
    slackEntController.handleSlash(req, res)
  );
}