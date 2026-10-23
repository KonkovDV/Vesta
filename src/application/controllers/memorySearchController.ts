import express from 'express';
import * as core from 'express-serve-static-core';
import { AuthService } from '../services/AuthService';
import { BaseController } from './BaseController';
import { RequestContext } from '../context/request-context';
import type { SemanticSearchUseCase } from '../memory/semantic-search.usecase';
import { SemanticSearchRequestSchema } from '../validators/api-schemas';
import { ProtocolUtils, ProtocolErrorCode } from '../../protocol/index';

type Request = core.Request;
type Response = core.Response;

export class MemorySearchController extends BaseController {
  constructor(
    authService: AuthService,
    private readonly semanticSearchUseCase: SemanticSearchUseCase,
    logger?: import('../../core/decorators/ILogger').ILogger,
  ) {
    super(authService, logger);
  }

  async semanticSearch(req: Request, res: Response): Promise<void> {
    try {
      await this.authenticateRequestTyped(req);

      const parseResult = SemanticSearchRequestSchema.safeParse(req.body);
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

      const { query, topK } = parseResult.data;

      const result = await this.semanticSearchUseCase.searchSemantic(
        query,
        RequestContext,
        { topK },
      );

      res.status(200).json({ results: result.items });
    } catch (error) {
      this.handleControllerError(error, res);
    }
  }
}