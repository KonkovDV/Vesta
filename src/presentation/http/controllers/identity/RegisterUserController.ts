import type { Request, Response } from 'express-serve-static-core';
import { RegisterUserUseCase, RegisterUserRequest } from '../../../../application/identity/usecases/RegisterUserUseCase';
import { requestContextTenantId, resolveScopedTenant } from '../../../../application/middleware/auth';

import { ILogger } from '../../../../core/decorators/ILogger';

export class RegisterUserController {
  constructor(
      private readonly useCase: RegisterUserUseCase,
      private readonly logger: ILogger
  ) {}

  handle = async (req: Request, res: Response): Promise<void> => {
    try {
      // 1. Map/Validate Request
      const bodyTenantId = typeof req.body?.tenantId === 'string' && req.body.tenantId.trim().length > 0
        ? req.body.tenantId.trim()
        : undefined;
      const scope = resolveScopedTenant(req, bodyTenantId, requestContextTenantId);
      if (!scope.allowed) {
        res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'tenantId does not match the authenticated tenant' },
        });
        return;
      }
      const requestDto: RegisterUserRequest = {
        email: req.body.email,
        name: req.body.name,
        tenantId: scope.tenantId ?? '',
      };

      // 2. Execute Use Case
      const result = await this.useCase.execute(requestDto);

      // 3. Handle Result
      if (result.isSuccess) {
        res.status(201).json(result.getValue());
      } else {
        const error = result.error as string; // Casting for simplicity
        if (error.includes('already exists')) {
            res.status(409).json({ error });
        } else if (error.includes('not found')) {
            res.status(404).json({ error });
        } else {
            res.status(400).json({ error });
        }
      }
    } catch (e) {
      this.logger.error('Full Error:', { error: e });
      res.status(500).json({ error: 'Internal Server Error' });
    }
  };
}
