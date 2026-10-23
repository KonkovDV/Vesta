/**
 * A2ATaskRunnerAdapter — Infrastructure Adapter
 *
 * Sends tasks to remote A2A-compliant agents via JSON-RPC (sendTask).
 * Discovers remote agents via /.well-known/agent.json (A2A protocol).
 *
 * Best Practices Applied (March 2026):
 * - A2A Protocol RC v1.0 (Linux Foundation): JSON-RPC 2.0 over HTTP
 * - Agent discovery via well-known endpoint before task submission
 * - Polling with exponential backoff for async tasks
 * - Structured error propagation with A2ATaskError
 * - correlationId in all log entries (Hard Rule #6)
 *
 * DI: constructor(logger: ILogger, configLoader: ConfigLoader) — 2 args
 *
 * @see Book Ch.15 "A2A Agent-to-Agent Protocol"
 * @see https://google.github.io/A2A/ — A2A Protocol specification
 */

import { randomUUID } from 'node:crypto';
import type { CorrelationId } from '../../core/types/branded';
import type { ILogger } from '../../core/decorators/ILogger';
import type { ConfigLoader } from '../../config/ConfigLoader';
import type { AgentCard } from '../../domain/a2a/IAgentCardProvider';
import type {
  IA2ATaskRunner,
  A2ATaskRequest,
  A2ATaskResponse,
} from '../../domain/a2a/a2a-task-runner.interface';
import { A2ATaskError } from '../../domain/errors/agentic-errors';
import { pinnedExchange } from '../http/SsrfPinnedHttpClient';
import type { PinnedEndpoint } from '../security/SsrfDnsGuard';

interface UrlPinner {
  pinUrl(url: string): Promise<PinnedEndpoint>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_BASE_INTERVAL_MS = 1_000;
const POLL_BACKOFF_FACTOR = 1.5;
const POLL_MAX_INTERVAL_MS = 15_000;
const MAX_POLL_ATTEMPTS = 30;

export class A2ATaskRunnerAdapter implements IA2ATaskRunner {
  constructor(
    private readonly logger: ILogger,
    private readonly configLoader: ConfigLoader,
    private readonly urlPinner?: UrlPinner,
  ) {}

  async discoverAgent(
    url: string,
    correlationId: CorrelationId,
  ): Promise<AgentCard> {
    this.logger.info('A2ATaskRunnerAdapter.discoverAgent', {
      correlationId,
      url,
    });

    const agentCardUrl = url.replace(/\/$/, '') + '/.well-known/agent.json';

    try {
      const headers = {
        Accept: 'application/json',
        'X-Correlation-Id': correlationId,
      };
      const card = this.urlPinner
        ? await this.readPinnedJson(agentCardUrl, headers)
        : await this.readFetchedJson(agentCardUrl, headers);

      this.logger.info('A2ATaskRunnerAdapter.discoverAgent.complete', {
        correlationId,
        agentId: card.agentId,
        name: card.name,
        skillCount: card.skills?.length ?? 0,
      });

      return card;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new A2ATaskError(
        `Failed to discover agent at ${url}: ${message}`,
        'discovery',
        correlationId,
      );
    }
  }

  async sendTask(
    request: A2ATaskRequest,
    correlationId: CorrelationId,
  ): Promise<A2ATaskResponse> {
    this.logger.info('A2ATaskRunnerAdapter.sendTask', {
      correlationId,
      agentUrl: request.agentUrl,
      hasSessionId: !!request.sessionId,
    });

    const startTime = Date.now();

    try {
      // Send initial task via JSON-RPC
      const rpcResponse = await this.sendJsonRpc(
        request.agentUrl,
        'tasks/send',
        {
          id: `task-${randomUUID()}`,
          message: {
            role: 'user',
            parts: [{ type: 'text', text: request.message }],
          },
          sessionId: request.sessionId,
          metadata: request.metadata,
        },
        correlationId,
      );

      const taskId = rpcResponse.id as string;
      let status = (rpcResponse.status as { state?: string } | undefined)?.state as string;

      // Poll for completion if task is async (FIX-R03: exponential backoff)
      let pollAttempts = 0;
      while (status === 'submitted' || status === 'working') {
        if (pollAttempts >= MAX_POLL_ATTEMPTS) {
          throw new Error(`Task ${taskId} timed out after ${MAX_POLL_ATTEMPTS} poll attempts`);
        }

        const backoffMs = this.calculateBackoff(pollAttempts);
        await this.delay(backoffMs);
        const pollResult = await this.sendJsonRpc(
          request.agentUrl,
          'tasks/get',
          { id: taskId },
          correlationId,
        );

        status = (pollResult.status as { state?: string } | undefined)?.state as string;
        pollAttempts++;

        if (status === 'completed' || status === 'failed' || status === 'canceled') {
          const durationMs = Date.now() - startTime;

          this.logger.info('A2ATaskRunnerAdapter.sendTask.complete', {
            correlationId,
            taskId,
            status,
            durationMs,
            pollAttempts,
          });

          return this.mapTaskResponse(pollResult, durationMs);
        }
      }

      const durationMs = Date.now() - startTime;
      return this.mapTaskResponse(rpcResponse, durationMs);
    } catch (error) {
      if (error instanceof A2ATaskError) throw error;

      const message = error instanceof Error ? error.message : String(error);
      throw new A2ATaskError(
        `sendTask failed for ${request.agentUrl}: ${message}`,
        'unknown',
        correlationId,
      );
    }
  }

  async getTask(
    agentUrl: string,
    taskId: string,
    correlationId: CorrelationId,
  ): Promise<A2ATaskResponse> {
    this.logger.info('A2ATaskRunnerAdapter.getTask', {
      correlationId,
      agentUrl,
      taskId,
    });

    try {
      const startTime = Date.now();
      const result = await this.sendJsonRpc(
        agentUrl,
        'tasks/get',
        { id: taskId },
        correlationId,
      );

      const durationMs = Date.now() - startTime;
      return this.mapTaskResponse(result, durationMs);
    } catch (error) {
      if (error instanceof A2ATaskError) throw error;

      const message = error instanceof Error ? error.message : String(error);
      throw new A2ATaskError(
        `getTask failed for task ${taskId}: ${message}`,
        taskId,
        correlationId,
      );
    }
  }

  async cancelTask(
    agentUrl: string,
    taskId: string,
    correlationId: CorrelationId,
  ): Promise<void> {
    this.logger.info('A2ATaskRunnerAdapter.cancelTask', {
      correlationId,
      agentUrl,
      taskId,
    });

    try {
      await this.sendJsonRpc(
        agentUrl,
        'tasks/cancel',
        { id: taskId },
        correlationId,
      );

      this.logger.info('A2ATaskRunnerAdapter.cancelTask.complete', {
        correlationId,
        taskId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new A2ATaskError(
        `cancelTask failed for task ${taskId}: ${message}`,
        taskId,
        correlationId,
      );
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  private async sendJsonRpc(
    agentUrl: string,
    method: string,
    params: Record<string, unknown>,
    correlationId: CorrelationId,
  ): Promise<Record<string, unknown>> {
    const rpcPayload = {
      jsonrpc: '2.0',
      id: randomUUID(), // protocol-level request ID (not domain entity)
      method,
      params,
    };

    const body = this.urlPinner
      ? await this.postPinned(agentUrl.replace(/\/$/, ''), rpcPayload, correlationId, params.id as string ?? 'unknown')
      : await this.postFetched(agentUrl.replace(/\/$/, ''), rpcPayload, correlationId, params.id as string ?? 'unknown');

    if (body.error) {
      throw new A2ATaskError(
        `A2A JSON-RPC ${method} error: ${body.error.message}`,
        params.id as string ?? 'unknown',
        correlationId,
      );
    }

    return body.result ?? {};
  }

  private async readPinnedJson(url: string, headers: Record<string, string>): Promise<AgentCard> {
    const pinned = await pinnedExchange(this.urlPinner!, {
      method: 'GET',
      url,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      headers,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (pinned.statusCode < 200 || pinned.statusCode >= 300) {
      throw new Error(`HTTP ${pinned.statusCode}`);
    }
    return JSON.parse(pinned.body) as AgentCard;
  }

  private async readFetchedJson(url: string, headers: Record<string, string>): Promise<AgentCard> {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json() as AgentCard;
  }

  private async postPinned(
    url: string,
    rpcPayload: Record<string, unknown>,
    correlationId: CorrelationId,
    taskId: string,
  ): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
    const pinned = await pinnedExchange(this.urlPinner!, {
      method: 'POST',
      url,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Correlation-Id': correlationId,
      },
      body: JSON.stringify(rpcPayload),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (pinned.statusCode < 200 || pinned.statusCode >= 300) {
      throw new A2ATaskError(`A2A JSON-RPC HTTP ${pinned.statusCode}`, taskId, correlationId);
    }
    return JSON.parse(pinned.body) as { result?: Record<string, unknown>; error?: { message: string } };
  }

  private async postFetched(
    url: string,
    rpcPayload: Record<string, unknown>,
    correlationId: CorrelationId,
    taskId: string,
  ): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Correlation-Id': correlationId,
      },
      body: JSON.stringify(rpcPayload),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new A2ATaskError(`A2A JSON-RPC HTTP ${response.status}`, taskId, correlationId);
    }
    return await response.json() as { result?: Record<string, unknown>; error?: { message: string } };
  }

  private mapTaskResponse(
    raw: Record<string, unknown>,
    durationMs: number,
  ): A2ATaskResponse {
    const status = raw.status as { state: string } | undefined;
    const artifacts = raw.artifacts as Array<{ name?: string; parts?: Array<{ type: string; text?: string }> }> | undefined;

    return {
      taskId: raw.id as string ?? 'unknown',
      status: (status?.state ?? 'failed') as A2ATaskResponse['status'],
      result: this.extractTextResult(artifacts),
      artifacts: (artifacts ?? []).map((a) => ({
        name: a.name ?? 'artifact',
        mimeType: 'text/plain',
        data: a.parts?.map((p) => p.text ?? '').join('') ?? '',
      })),
      durationMs,
    };
  }

  private extractTextResult(
    artifacts?: Array<{ parts?: Array<{ text?: string }> }>,
  ): string | undefined {
    if (!artifacts || artifacts.length === 0) return undefined;

    const texts: string[] = [];
    for (const artifact of artifacts) {
      for (const part of artifact.parts ?? []) {
        if (part.text) texts.push(part.text);
      }
    }

    return texts.length > 0 ? texts.join('\n') : undefined;
  }

  /**
   * FIX-R03: Exponential backoff with jitter for polling.
   * Base interval 1s, factor 1.5×, cap at 15s. Jitter ±10% to prevent thundering herd.
   */
  private calculateBackoff(attempt: number): number {
    const exponential = POLL_BASE_INTERVAL_MS * Math.pow(POLL_BACKOFF_FACTOR, attempt);
    const capped = Math.min(exponential, POLL_MAX_INTERVAL_MS);
    const jitter = capped * (0.9 + Math.random() * 0.2); // ±10% jitter
    return Math.round(jitter);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
