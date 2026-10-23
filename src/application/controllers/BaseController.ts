import express from 'express';
import * as core from 'express-serve-static-core';
import { AuthService } from '../services/AuthService';
import { ProtocolUtils, ProtocolErrorCode } from '../../protocol/index';
import type { ILogger } from '../../core/decorators/ILogger';

type Request = core.Request;
type Response = core.Response;
type AuthRequestLike = Parameters<AuthService['authenticateRequest']>[0];

export abstract class BaseController {
  constructor(protected authService: AuthService, protected logger?: ILogger) {}

  protected async authenticateRequestTyped(req: Request): Promise<{ userId: string }> {
    if (!this.authService) {
      throw new Error('AuthService not available');
    }
    const authInput: AuthRequestLike = {
      headers: req.headers,
      ip: req.ip,
      connection: req.connection,
      socket: req.socket,
      method: req.method,
      path: req.path,
      query: req.query,
      body: req.body,
    };
 
    const ctx = await this.authService.authenticateRequest(authInput);
    return { userId: ctx.userId };
  }

  protected handleControllerError(error: unknown, res: Response): void {
    const safe = this.safeError(error);

    if (this.logger) {
      this.logger.error('controller_error', {
        controller: this.constructor.name,
        error: safe,
      });
    }

    const message = safe.message;

    if (message === 'UNAUTHORIZED') {
      res
        .status(401)
        .json(
          ProtocolUtils.error(
            ProtocolErrorCode.UNAUTHORIZED,
            'Authentication required',
          ),
        );
      return;
    }

    if (message.includes('Rate limit exceeded')) {
      res.status(429).json(ProtocolUtils.error(ProtocolErrorCode.RATE_LIMIT_EXCEEDED, message));
      return;
    }

    res.status(500).json(ProtocolUtils.error(ProtocolErrorCode.INTERNAL_ERROR, message));
  }

  protected handleResultError(
    result: { ok: boolean; error?: { code?: string; message?: string } },
    res: Response,
  ): void {
    const code = result.error?.code || 'UNEXPECTED';
    const status =
      code === 'FORBIDDEN'
        ? 403
        : code === 'NOT_FOUND'
        ? 404
        : code === 'VALIDATION'
        ? 400
        : 500;

    res.status(status).json(
      ProtocolUtils.error(
        status === 404
          ? ProtocolErrorCode.NOT_FOUND
          : status === 403
          ? ProtocolErrorCode.FORBIDDEN
          : status === 400
          ? ProtocolErrorCode.VALIDATION_ERROR
          : ProtocolErrorCode.INTERNAL_ERROR,
        result.error?.message || 'operation_failed',
      ),
    );
  }

  private safeError(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) {
      return { message: error.message, stack: error.stack };
    }
    return { message: String(error) };
  }
}
