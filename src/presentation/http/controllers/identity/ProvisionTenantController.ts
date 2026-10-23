import type { Request, Response } from 'express-serve-static-core';
import { ProvisionTenantUseCase, ProvisionTenantRequest } from '../../../../application/identity/usecases/ProvisionTenantUseCase';
import { TenantTier } from '../../../../domain/identity/Tenant';

import { ILogger } from '../../../../core/decorators/ILogger';

export class ProvisionTenantController {
  constructor(
      private readonly useCase: ProvisionTenantUseCase,
      private readonly logger: ILogger
  ) {}

  handle = async (req: Request, res: Response): Promise<void> => {
    try {
      // 1. Map/Validate Request
      const requestDto: ProvisionTenantRequest = {
        name: req.body.name,
        tier: req.body.tier as TenantTier,
        adminEmail: req.body.adminEmail,
        adminName: req.body.adminName,
        settings: req.body.settings
      };

      // 2. Execute Use Case
      const result = await this.useCase.execute(requestDto);

      // 3. Handle Result
      if (result.isSuccess) {
        res.status(201).json(result.getValue());
      } else {
        const error = result.error as string;
        if (error.includes('already exists')) {
            res.status(409).json({ error });
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
