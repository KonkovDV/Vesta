import type { PluginExecutionContext } from './plugin-types';
import { RequestContext } from '../context/request-context';
import { EventFactory } from '../../domain/events/event-store.interface';
import type { EventStoreService } from '../services/EventStoreService';
import { validateToolCalledEvent, validateToolResultEvent } from '../../core/events/typed';
import type { IToolEventsPublisher } from './plugin-types';
import { readStr } from '../../core/config/app-config';
import type { ILogger } from '../../core/decorators/ILogger';

export class PluginCorrelationFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginCorrelationFallbackError';
  }
}

function isPluginCorrelationFallbackAllowed(): boolean {
  const flag = (readStr('PLUGINS_ALLOW_CORRELATION_FALLBACK', '') ?? '').toLowerCase();
  const nodeEnv = (readStr('NODE_ENV', 'development') ?? 'development').toLowerCase();
  if (nodeEnv === 'production') {
    return flag === '1' || flag === 'true';
  }
  return true;
}

export class ToolEventsPublisher implements IToolEventsPublisher {
  constructor(
    private readonly eventStoreService: EventStoreService,
    private readonly logger?: ILogger,
  ) {}

  async publishToolCalled(input: {
    toolName: string;
    args: unknown;
    context: PluginExecutionContext;
  }): Promise<void> {
    try {
      const { correlationId, correlationSource, traceLostPlugins } = this.resolveCorrelationId(
        input.context,
      );
      const payload = validateToolCalledEvent({
        type: 'tool.called',
        tool_name: input.toolName,
        args: input.args,
        correlation_id: correlationId,
        tenant_id: input.context.tenantId,
        session_id: input.context.sessionId,
        actor: input.context.userId,
        correlation_source: correlationSource,
        trace_lost: traceLostPlugins ? { plugins: true } : undefined,
      });

      const event = EventFactory.createBaseEvent(
        this.resolveAggregateId(input.context),
        'tool.called',
        payload,
        correlationId,
      );

      await this.eventStoreService.saveDomainEvents([event]);
    } catch (error) {
      if (error instanceof PluginCorrelationFallbackError) {
        if (this.logger) {
          this.logger.error(
            '[RCTX-PLUGINS] Fallback correlationId is disabled for tool.called event',
            {
              toolName: input.toolName,
              tenantId: input.context.tenantId,
              sessionId: input.context.sessionId,
              userId: input.context.userId,
              message: error.message,
            },
          );
        }
        return;
      }
      // best-effort: события инструментов не должны ломать бизнес-логику
    }
  }

  async publishToolResult(input: {
    toolName: string;
    success: boolean;
    durationMs?: number;
    result?: unknown;
    error?: unknown;
    context: PluginExecutionContext;
  }): Promise<void> {
    try {
      const { correlationId, correlationSource, traceLostPlugins } = this.resolveCorrelationId(
        input.context,
      );
      const payload = validateToolResultEvent({
        type: 'tool.result',
        tool_name: input.toolName,
        success: input.success,
        duration_ms: input.durationMs,
        result: input.result,
        error: this.toToolError(input.error),
        correlation_id: correlationId,
        tenant_id: input.context.tenantId,
        session_id: input.context.sessionId,
        actor: input.context.userId,
        correlation_source: correlationSource,
        trace_lost: traceLostPlugins ? { plugins: true } : undefined,
      });

      const event = EventFactory.createBaseEvent(
        this.resolveAggregateId(input.context),
        'tool.result',
        payload,
        correlationId,
      );

      await this.eventStoreService.saveDomainEvents([event]);
    } catch (error) {
      if (error instanceof PluginCorrelationFallbackError) {
        if (this.logger) {
          this.logger.error(
            '[RCTX-PLUGINS] Fallback correlationId is disabled for tool.result event',
            {
              toolName: input.toolName,
              tenantId: input.context.tenantId,
              sessionId: input.context.sessionId,
              userId: input.context.userId,
              success: input.success,
              message: error.message,
            },
          );
        }
        return;
      }
      // best-effort
    }
  }

  private resolveAggregateId(context: PluginExecutionContext): string {
    return context.sessionId ?? context.userId ?? 'tool';
  }

  private resolveCorrelationId(context: PluginExecutionContext): {
    correlationId: string;
    correlationSource: 'plugin_context' | 'request_context' | 'fallback_dev' | 'fallback_prod';
    traceLostPlugins: boolean;
  } {
    if (context.correlationId && context.correlationId !== 'unknown') {
      return {
        correlationId: context.correlationId,
        correlationSource: 'plugin_context',
        traceLostPlugins: false,
      };
    }

    try {
      const fromCtx = RequestContext.getCorrelationId();
      if (fromCtx) {
        return {
          correlationId: String(fromCtx),
          correlationSource: 'request_context',
          traceLostPlugins: false,
        };
      }
    } catch {
      // ignore, will generate fallback id
    }

    const nodeEnvRaw = readStr('NODE_ENV', 'development') ?? 'development';
    const nodeEnv = nodeEnvRaw.toLowerCase();
    const isProd = nodeEnv === 'production';

    if (!isProd) {
      const fallbackId = `tool:${Date.now()}`;
      return {
        correlationId: fallbackId,
        correlationSource: 'fallback_dev',
        traceLostPlugins: true,
      };
    }

    if (!isPluginCorrelationFallbackAllowed()) {
      throw new PluginCorrelationFallbackError(
        '[RCTX-PLUGINS] Fallback correlationId is disabled in production (PLUGINS_ALLOW_CORRELATION_FALLBACK=false)',
      );
    }

    const fallbackId = `corr_violation:tool:${Date.now()}`;

    if (this.logger) {
      this.logger.warn(
        '[RCTX-PLUGINS] correlationId lost for tool.* event, using fallback in production',
        {
          fallbackId,
          nodeEnv,
        },
      );
    }

    return {
      correlationId: fallbackId,
      correlationSource: 'fallback_prod',
      traceLostPlugins: true,
    };
  }

  private toToolError(
    raw: unknown,
  ): { message: string; code?: string; details?: unknown } | undefined {
    if (!raw) {
      return undefined;
    }

    if (raw instanceof Error) {
      return {
        message: raw.message,
        code: raw.name,
        details: {
          name: raw.name,
          stack: raw.stack,
        },
      };
    }

    if (typeof raw === 'object' && raw !== null) {
      const anyRaw = raw as Record<string, unknown>;

      if (typeof anyRaw.message === 'string') {
        return {
          message: anyRaw.message,
          code: typeof anyRaw.code === 'string' ? anyRaw.code : String(anyRaw.type),
          details: raw,
        };
      }

      if (typeof anyRaw.type === 'string' || typeof anyRaw.reason === 'string') {
        const reason = anyRaw.reason ? `: ${String(anyRaw.reason)}` : '';
        return {
          message: `${String(anyRaw.type)}${reason}`,
          code: String(anyRaw.type),
          details: raw,
        };
      }
    }

    return {
      message: typeof raw === 'string' ? raw : JSON.stringify(raw),
      details: raw,
    };
  }
}