import type express from 'express';
import { routeParam } from '../../core/http/route-param';
import type * as core from 'express-serve-static-core';
import type { ILogger } from '../../core/decorators/ILogger';
import type { DomainEvent } from '../../domain/events/event-store.interface';
import { requireScope, type AuthenticatedRequest } from '../middleware/auth';
import { AgentRunCancelController, type AgentRunCancelWriter } from '../controllers/AgentRunCancelController';
import { agentRunRequestFromTask } from './agent-run-mcp';
import { streamId, type AgentRunService } from './AgentRunService';

export type AgentRunRoutesService = Pick<AgentRunService, 'start'> & Partial<Pick<AgentRunService, 'resume' | 'decideApproval'>>;

/** Scope that may record a decision on a tool call of a run the caller can access. */
export const AGENT_RUN_APPROVE_SCOPE = 'agents.approve';

export interface AgentRunEventReader extends AgentRunCancelWriter {
  getEvents(aggregateId: string): Promise<DomainEvent[]>;
}

export function registerAgentRunRoutes(options: {
  app: express.Application;
  authMw: core.RequestHandler;
  rateLimitMw: core.RequestHandler;
  events: AgentRunEventReader;
  runs?: AgentRunRoutesService;
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
    '/api/agents/runs/:id/approvals/:toolCallId',
    options.authMw,
    options.rateLimitMw,
    requireScope(AGENT_RUN_APPROVE_SCOPE),
    (req, res, next) => {
      void decideAndResume(req, res, options).catch(next);
    },
  );
  options.app.post(
    '/api/agents/runs/:id/cancel',
    options.authMw,
    options.rateLimitMw,
    guard,
    (req, res, next) => {
      void (async () => {
        const runId = routeParam(req.params.id);
        // An unknown run or a run of another principal answers 404, and no event is written.
        if (!runId || !(await canAccessRun(req, options.events, runId))) {
          res.status(404).json({ ok: false, error: 'run not found' });
          return;
        }
        await controller.cancel(req, res);
      })().catch(next);
    },
  );
}

/** Scope that may read runs recorded before AgentRunStarted carried an owner. */
export const AGENT_RUN_ADMIN_SCOPE = 'agents.admin';

/**
 * The caller may read or cancel a run it started (same user, and same tenant when
 * the run has one). A run without a recorded owner needs agents.admin.
 */
export async function canAccessRun(
  req: core.Request,
  events: Pick<AgentRunEventReader, 'getEvents'>,
  runId: string,
): Promise<boolean> {
  const auth = (req as AuthenticatedRequest).authContext;
  if (!auth) return false;
  const stream = await events.getEvents(streamId(runId));
  const started = stream.find((event) => event.type === 'AgentRunStarted');
  if (!started) return false;
  const payload = started.payload as { ownerId?: unknown; tenantId?: unknown };
  if (typeof payload.ownerId !== 'string') {
    return auth.scopes.includes(AGENT_RUN_ADMIN_SCOPE);
  }
  if (payload.ownerId !== auth.userId) return false;
  return typeof payload.tenantId !== 'string' || payload.tenantId === (auth.tenantId ?? undefined);
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
  options: { runs?: AgentRunRoutesService; workspaceRoot?: string },
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
  const auth = (req as AuthenticatedRequest).authContext;
  const result = await options.runs.start({
    ...agentRunRequestFromTask({
      task,
      workspaceRoot: options.workspaceRoot ?? '',
      correlationId,
    }),
    ownerId: auth?.userId,
    tenantId: auth?.tenantId ?? undefined,
  });
  res.status(201).json({
    ok: true,
    runId: result.runId,
    stream: streamId(result.runId),
    reason: result.reason,
    content: result.content ?? '',
  });
}

/**
 * Records a person's decision on one tool call, then resumes the run. The body must
 * carry the argumentsHash of the ToolApprovalRequested event the person was shown;
 * a different hash is refused, so the decision applies to those arguments only.
 */
async function decideAndResume(
  req: core.Request,
  res: core.Response,
  options: { events: AgentRunEventReader; runs?: AgentRunRoutesService; workspaceRoot?: string },
): Promise<void> {
  const runs = options.runs;
  if (!runs?.decideApproval || !runs.resume) {
    res.status(503).json({ ok: false, error: 'agent run approvals are not available' });
    return;
  }
  const runId = routeParam(req.params.id);
  const toolCallId = routeParam(req.params.toolCallId);
  if (!runId || !toolCallId || !(await canAccessRun(req, options.events, runId))) {
    res.status(404).json({ ok: false, error: 'run not found' });
    return;
  }
  const decision = req.body?.decision;
  const argumentsHash = req.body?.argumentsHash;
  if ((decision !== 'approved' && decision !== 'denied') || typeof argumentsHash !== 'string' || argumentsHash.length === 0) {
    res.status(400).json({ ok: false, error: 'decision (approved|denied) and argumentsHash are required' });
    return;
  }
  const auth = (req as AuthenticatedRequest).authContext;
  const header = req.headers['x-correlation-id'];
  const correlationId = typeof header === 'string' && header.length >= 5 ? header : `approval-${runId}`;
  try {
    await runs.decideApproval(runId, toolCallId, decision, correlationId, {
      expectedArgumentsHash: argumentsHash,
      decidedBy: auth?.userId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/has no approval request/.test(message)) {
      res.status(404).json({ ok: false, error: 'approval request not found' });
      return;
    }
    if (/hash mismatch|already decided/.test(message)) {
      res.status(409).json({ ok: false, error: message.replace(/^Agent run \S+ /, '') });
      return;
    }
    throw error;
  }
  const { messages: _messages, ...resumeRequest } = agentRunRequestFromTask({
    task: '',
    workspaceRoot: options.workspaceRoot ?? '',
    correlationId,
  });
  const result = await runs.resume(runId, resumeRequest);
  res.status(200).json({ ok: true, runId, reason: result.reason, content: result.content ?? '' });
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
  if (!(await canAccessRun(req, options.events, runId))) {
    res.status(404).json({ ok: false, error: 'run not found' });
    return;
  }
  const lastId = req.get('Last-Event-ID') ?? '';
  const pollMs = options.ssePollMs ?? 250;
  const timeoutMs = options.sseTimeoutMs ?? 30_000;
  // Without this the loop keeps reading the stream for the whole timeout after the client left.
  // res 'close' fires on disconnect; req 'close' fires as soon as the request body is read.
  let clientGone = false;
  res.on('close', () => { clientGone = true; });
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const started = Date.now();
  const sent = new Set<string>();
  let finished = false;
  while (!finished && !clientGone && Date.now() - started <= timeoutMs) {
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
