import type express from 'express';
import { routeParam } from '../../core/http/route-param';
import type * as core from 'express-serve-static-core';
import type { ILogger } from '../../core/decorators/ILogger';
import type { DomainEvent } from '../../domain/events/event-store.interface';
import type { AuthenticatedRequest } from '../middleware/auth';
import { AgentRunCancelController, type AgentRunCancelWriter } from '../controllers/AgentRunCancelController';
import { agentRunRequestFromTask } from './agent-run-mcp';
import { streamId, type AgentRunService } from './AgentRunService';

export interface AgentRunEventReader extends AgentRunCancelWriter {
  getEvents(aggregateId: string): Promise<DomainEvent[]>;
}

export function registerAgentRunRoutes(options: {
  app: express.Application;
  authMw: core.RequestHandler;
  rateLimitMw: core.RequestHandler;
  events: AgentRunEventReader;
  runs?: Pick<AgentRunService, 'start'>;
  workspaceRoot?: string;
  logger?: ILogger;
  ssePollMs?: number;
  sseTimeoutMs?: number;
}): void {
  const guard = requireAgentRunScope;
  const controller = new AgentRunCancelController(options.events, options.logger);
  options.app.post(
    '/api/agents/runs',
    options.authMw,
    options.rateLimitMw,
    guard,
    (req, res, next) => {
      void startRun(req, res, options).catch(next);
    },
  );
  options.app.get(
    '/api/agents/runs/:id/events',
    options.authMw,
    options.rateLimitMw,
    guard,
    (req, res, next) => {
      void streamRun(req, res, options).catch(next);
    },
  );
  options.app.post(
    '/api/agents/runs/:id/cancel',
    options.authMw,
    options.rateLimitMw,
    (req, res, next) => {
      void controller.cancel(req, res).catch(next);
    },
  );
}

function requireAgentRunScope(req: core.Request, res: core.Response, next: core.NextFunction): void {
  const scopes = (req as AuthenticatedRequest).authContext?.scopes ?? [];
  if (!scopes.includes('agents.run')) {
    res.status(403).json({ ok: false, error: 'missing scope agents.run' });
    return;
  }
  next();
}

async function startRun(
  req: core.Request,
  res: core.Response,
  options: { runs?: Pick<AgentRunService, 'start'>; workspaceRoot?: string },
): Promise<void> {
  if (!options.runs) {
    res.status(503).json({ ok: false, error: 'agent run service is not registered' });
    return;
  }
  const task = typeof req.body?.task === 'string' ? req.body.task.trim() : '';
  if (!task) {
    res.status(400).json({ ok: false, error: 'task is required' });
    return;
  }
  const header = req.headers['x-correlation-id'];
  const correlationId = typeof header === 'string' && header.length >= 5 ? header : `agent-run-${Date.now()}`;
  const result = await options.runs.start(agentRunRequestFromTask({
    task,
    workspaceRoot: options.workspaceRoot ?? '',
    correlationId,
  }));
  res.status(201).json({
    ok: true,
    runId: result.runId,
    stream: streamId(result.runId),
    reason: result.reason,
    content: result.content ?? '',
  });
}

async function streamRun(
  req: core.Request,
  res: core.Response,
  options: { events: AgentRunEventReader; ssePollMs?: number; sseTimeoutMs?: number },
): Promise<void> {
  const runId = routeParam(req.params.id);
  if (!runId) {
    res.status(400).json({ ok: false, error: 'missing run id' });
    return;
  }
  const lastId = req.get('Last-Event-ID') ?? '';
  const pollMs = options.ssePollMs ?? 250;
  const timeoutMs = options.sseTimeoutMs ?? 30_000;
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const started = Date.now();
  const sent = new Set<string>();
  let finished = false;
  while (!finished && Date.now() - started <= timeoutMs) {
    const events = await options.events.getEvents(streamId(runId));
    const cursor = lastId ? events.findIndex((event) => event.eventId === lastId) : -1;
    const pending = cursor >= 0 ? events.slice(cursor + 1) : events;
    const delivered = cursor >= 0 ? events.slice(0, cursor + 1) : [];
    if (delivered.some((event) => event.type === 'AgentRunFinished') && pending.length === 0) {
      break;
    }
    for (const event of pending) {
      if (sent.has(event.eventId)) continue;
      sent.add(event.eventId);
      writeSse(res, event);
      if (event.type === 'AgentRunFinished') finished = true;
    }
    if (finished) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  res.end();
}

function writeSse(res: core.Response, event: DomainEvent): void {
  res.write(`id: ${event.eventId}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify({
    eventId: event.eventId,
    type: event.type,
    payload: event.payload,
  })}\n\n`);
}
