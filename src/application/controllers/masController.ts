import express from 'express';
import * as core from 'express-serve-static-core';
import { AuthService } from '../services/AuthService';
import { RateLimitService } from '../services/RateLimitService';
import { BaseController } from './BaseController';
import { RequestContext } from '../context/request-context';
import type {
  MasGeneratePlanUseCase,
  MasGeneratePlanInput,
  MasPlanDto,
} from '../mas/usecases/mas-generate-plan.usecase';
import { MasGeneratePlanRequestSchema } from '../validators/api-schemas';
import { ProtocolUtils, ProtocolErrorCode } from '../../protocol/index';

/**
 * MAS BFF Controller.
 *
 * Endpoint:
 *   POST /bff/mas/generate-plan
 * Body:
 *   { "goal": "string", "maxSteps": 5 }
 *
 * Response:
 *   { "plan": MasPlanDto }
 */
type Request = core.Request;
type Response = core.Response;

export class MasController extends BaseController {
  constructor(
    authService: AuthService,
    private readonly rateLimitService: RateLimitService,
    private readonly masGeneratePlanUseCase: MasGeneratePlanUseCase,
    logger?: import('../../core/decorators/ILogger').ILogger,
  ) {
    super(authService, logger);
  }

  async generatePlan(req: Request, res: Response): Promise<void> {
    try {
      const authContext = await this.authenticateRequestTyped(req);
      await this.rateLimitService.checkLimit(authContext.userId, 'mas_generate_plan');

      const parseResult = MasGeneratePlanRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json(
          ProtocolUtils.error(
            ProtocolErrorCode.VALIDATION_ERROR,
            'Invalid request body',
            parseResult.error.flatten()
          )
        );
        return;
      }

      const { goal, maxSteps } = parseResult.data;

      const input: MasGeneratePlanInput = { goal, maxSteps };

      const plan: MasPlanDto = await this.masGeneratePlanUseCase.execute(
        input,
        RequestContext,
      );

      res.status(200).json({ plan });
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }
}