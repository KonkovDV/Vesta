import type { Request, Response, NextFunction, IRouter, RequestHandler } from 'express-serve-static-core';
const express = require('express');
import { requireScope } from '../../../application/middleware/auth';
import { RegisterUserController } from '../controllers/identity/RegisterUserController';
import { ProvisionTenantController } from '../controllers/identity/ProvisionTenantController';
import { container } from '../../../core/di/container';

export function createIdentityRoutes(authMw: RequestHandler): IRouter {
  const router = express.Router();

  // Lazy resolution from container to ensure dependencies are ready
  // In a real app, this might be done via a dedicated RouteResolver or Middleware
  
  router.post('/register', authMw, requireScope('admin.tenants'), (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<RegisterUserController>('RegisterUserController');
    controller.handle(req, res).catch(next);
  });

  router.post('/tenants/provision', authMw, requireScope('admin.tenants'), (req: Request, res: Response, next: NextFunction) => {
    const controller = container.resolve<ProvisionTenantController>('ProvisionTenantController');
    controller.handle(req, res).catch(next);
  });

  return router;
}
