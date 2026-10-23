import type * as core from 'express-serve-static-core';
import { routeParam } from '../../core/http/route-param';
import type { ILogger } from '../../core/decorators/ILogger';
import { EventFactory, type DomainEvent } from '../../domain/events/event-store.interface';
import { AgentRunCancelledSchema } from '../../core/events/agent-run.schemas';
import { streamId } from '../agents/AgentRunService';
import type { AuthenticatedRequest } from '../middleware/auth';

type Request = core.Request;
type Response = core.Response;

export interface AgentRunCancelWriter {
  appendEvent(event: DomainEvent): Promise<void>;
}

export class AgentRunCancelController {
  constructor(
    private readonly events: AgentRunCancelWriter,
    private readonly logger?: ILogger,
  ) {}

  async cancel(req: Request, res: Response): Promise<void> {
    const auth = (req as AuthenticatedRequest).authContext;
    if (!auth?.scopes.includes('agents.run')) {
      res.status(403).json({ ok: false, error: 'missing scope agents.run' });
      return;
    }
    const runId = routeParam(req.params.id);
    if (!runId) {
      res.status(400).json({ ok: false, error: 'missing run id' });
      return;
    }
    const header = req.headers['x-correlation-id'];
    const correlationId = typeof header === 'string' && header.length >= 5 ? header : `cancel-${runId}`;
    const payload = AgentRunCancelledSchema.parse({ runId, step: 0, correlationId });
    const event = EventFactory.createBaseEvent(streamId(runId), 'AgentRunCancelled', payload, correlationId);
    await this.events.appendEvent(event);
    this.logger?.log('agent_run_cancel_requested', { runId, correlationId });
    res.status(202).json({ ok: true, runId });
  }
}
