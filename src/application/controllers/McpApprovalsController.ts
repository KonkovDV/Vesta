import type * as core from 'express-serve-static-core';
import { routeParam } from '../../core/http/route-param';
import type { ILogger } from '../../core/decorators/ILogger';
import type { IUserApprovalInterceptor } from '../../domain/security/IUserApprovalInterceptor';

type Request = core.Request;
type Response = core.Response;

export class McpApprovalsController {
  constructor(
    private readonly interceptor: IUserApprovalInterceptor,
    private readonly logger?: ILogger,
  ) {}

  async listPending(req: Request, res: Response): Promise<void> {
    const correlationId = this.extractCorrelationId(req);
    try {
      const approvals = await this.interceptor.getPendingApprovals();
      res.json({ ok: true, data: approvals, count: approvals.length });
    } catch (error) {
      this.handleError('mcp_approvals_list_failed', error, res, correlationId);
    }
  }

  async approve(req: Request, res: Response): Promise<void> {
    await this.resolve(req, res, 'approved');
  }

  async deny(req: Request, res: Response): Promise<void> {
    await this.resolve(req, res, 'denied');
  }

  private async resolve(req: Request, res: Response, decision: 'approved' | 'denied'): Promise<void> {
    const correlationId = this.extractCorrelationId(req);
    const requestId = routeParam(req.params.id);
    const body = (req.body ?? {}) as { decidedBy?: string; note?: string };

    if (!requestId || !body.decidedBy) {
      this.logger?.warn('mcp_approvals_validation_failed', {
        correlationId,
        requestId,
        decision,
      });
      res.status(400).json({ ok: false, error: 'Missing approval id or decidedBy' });
      return;
    }

    try {
      const result = await this.interceptor.resolve({
        requestId,
        decision,
        resolvedBy: body.decidedBy,
        note: body.note,
      });

      if (!result) {
        this.logger?.warn('mcp_approvals_request_not_found', {
          correlationId,
          requestId,
          decision,
        });
        res.status(404).json({ ok: false, error: 'Approval request not found' });
        return;
      }

      res.json({ ok: true, data: result });
    } catch (error) {
      this.handleError(`mcp_approvals_${decision}_failed`, error, res, correlationId);
    }
  }

  private extractCorrelationId(req: Request): string | undefined {
    const header = req.headers?.['x-correlation-id'];
    if (typeof header === 'string' && header.length > 0 && header.length <= 128) {
      return header;
    }
    return undefined;
  }

  private handleError(event: string, error: unknown, res: Response, correlationId?: string): void {
    this.logger?.error(event, {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}