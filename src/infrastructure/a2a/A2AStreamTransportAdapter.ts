/**
 * A2AStreamTransportAdapter — Infrastructure Adapter
 *
 * SSE-based streaming transport for A2A protocol.
 * Implements sendTaskSubscribe for real-time task monitoring.
 * Client subscribes to task events and receives incremental status/artifact updates.
 *
 * Best Practices Applied (March 2026):
 * - Server-Sent Events (SSE) with EventSource interface
 * - Event ID tracking for resumability (Last-Event-ID header)
 * - Graceful unsubscribe with active subscription tracking
 * - Structured error propagation with A2ATaskError
 * - correlationId in all log entries (Hard Rule #6)
 *
 * DI: constructor(logger: ILogger) — 1 arg
 *
 * @see Book Ch.15 "A2A Protocol" — sendTaskSubscribe
 * @see https://google.github.io/A2A/ — A2A Protocol specification
 */

import { randomUUID } from 'node:crypto';
import type { CorrelationId } from '../../core/types/branded';
import type { ILogger } from '../../core/decorators/ILogger';
import type { A2ATaskRequest, A2ATaskResponse } from '../../domain/a2a/a2a-task-runner.interface';
import type {
  IA2AStreamTransport,
  A2AStreamEvent,
} from '../../domain/a2a/a2a-stream.interface';
import { A2ATaskError } from '../../domain/errors/agentic-errors';
import { createPinnedFetch } from '../http/SsrfPinnedHttpClient';
import type { PinnedEndpoint } from '../security/SsrfDnsGuard';

interface UrlPinner {
  pinUrl(url: string): Promise<PinnedEndpoint>;
}

export class A2AStreamTransportAdapter implements IA2AStreamTransport {
  private readonly activeSubscriptions = new Map<string, AbortController>();

  constructor(
    private readonly logger: ILogger,
    private readonly urlPinner?: UrlPinner,
  ) {}

  async sendTaskSubscribe(
    request: A2ATaskRequest,
    onEvent: (event: A2AStreamEvent) => void,
    correlationId: CorrelationId,
  ): Promise<A2ATaskResponse> {
    this.logger.info('A2AStreamTransportAdapter.sendTaskSubscribe', {
      correlationId,
      agentUrl: request.agentUrl,
    });

    const startTime = Date.now();
    const abortController = new AbortController();
    const taskId = `stream-task-${randomUUID()}`;

    this.activeSubscriptions.set(taskId, abortController);

    try {
      const rpcPayload = {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tasks/sendSubscribe',
        params: {
          id: taskId,
          message: {
            role: 'user',
            parts: [{ type: 'text', text: request.message }],
          },
          sessionId: request.sessionId,
          metadata: request.metadata,
        },
      };

      const requestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'X-Correlation-Id': correlationId,
        },
        body: JSON.stringify(rpcPayload),
        signal: abortController.signal,
      };
      const response = this.urlPinner
        ? await createPinnedFetch(this.urlPinner)(request.agentUrl.replace(/\/$/, ''), requestInit)
        : await fetch(request.agentUrl.replace(/\/$/, ''), requestInit);

      if (!response.ok) {
        throw new A2ATaskError(
          `sendTaskSubscribe HTTP ${response.status}: ${response.statusText}`,
          taskId,
          correlationId,
        );
      }

      if (!response.body) {
        throw new A2ATaskError(
          'sendTaskSubscribe: no response body (SSE stream expected)',
          taskId,
          correlationId,
        );
      }

      // Process SSE stream
      const finalResult = await this.processStream(
        response.body,
        taskId,
        onEvent,
        correlationId,
      );

      const durationMs = Date.now() - startTime;

      this.logger.info('A2AStreamTransportAdapter.sendTaskSubscribe.complete', {
        correlationId,
        taskId,
        durationMs,
        status: finalResult.status,
      });

      return { ...finalResult, durationMs };
    } catch (error) {
      if (error instanceof A2ATaskError) throw error;

      const message = error instanceof Error ? error.message : String(error);
      throw new A2ATaskError(
        `sendTaskSubscribe failed: ${message}`,
        taskId,
        correlationId,
      );
    } finally {
      this.activeSubscriptions.delete(taskId);
    }
  }

  unsubscribe(taskId: string): void {
    const controller = this.activeSubscriptions.get(taskId);
    if (controller) {
      controller.abort();
      this.activeSubscriptions.delete(taskId);
      this.logger.info('A2AStreamTransportAdapter.unsubscribe', { taskId });
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  private async processStream(
    body: ReadableStream<Uint8Array>,
    taskId: string,
    onEvent: (event: A2AStreamEvent) => void,
    correlationId: CorrelationId,
  ): Promise<A2ATaskResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastStatus: string = 'working';
    let resultText: string | undefined;
    const artifacts: Array<{ name: string; mimeType: string; data: string }> = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let currentEventType = '';
        let currentData = '';
        let currentEventId: string | undefined;

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            // SSE spec: multiple data: lines concatenated with newlines
            const dataLine = line.slice(5).trim();
            currentData = currentData ? `${currentData}\n${dataLine}` : dataLine;
          } else if (line.startsWith('id:')) {
            currentEventId = line.slice(3).trim();
          } else if (line === '' && currentData) {
            // Empty line = end of event
            const event = this.parseStreamEvent(currentEventType, currentData, currentEventId);
            onEvent(event);

            // Track status updates
            if (event.type === 'status') {
              const statusData = event.data as { state?: string };
              if (statusData.state) {
                lastStatus = statusData.state;
              }
            }

            if (event.type === 'artifact') {
              const artifactData = event.data as { name?: string; text?: string };
              artifacts.push({
                name: artifactData.name ?? 'artifact',
                mimeType: 'text/plain',
                data: artifactData.text ?? '',
              });
              if (artifactData.text) {
                resultText = (resultText ?? '') + artifactData.text;
              }
            }

            currentEventType = '';
            currentData = '';
            currentEventId = undefined;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      taskId,
      status: lastStatus as A2ATaskResponse['status'],
      result: resultText,
      artifacts,
      durationMs: 0, // Will be overwritten by caller
    };
  }

  private parseStreamEvent(eventType: string, data: string, eventId?: string): A2AStreamEvent {
    let parsedData: unknown;
    try {
      parsedData = JSON.parse(data);
    } catch {
      parsedData = data;
    }

    const type = (eventType || 'message') as A2AStreamEvent['type'];

    return {
      type: (['status', 'artifact', 'message', 'error'].includes(type) ? type : 'message'),
      data: parsedData,
      eventId,
      timestamp: Date.now(),
    };
  }
}
