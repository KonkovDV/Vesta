import type { PluginExecutionContext } from './plugin-types';
import { RequestContext } from '../context/request-context';
import { EventFactory } from '../../domain/events/event-store.interface';
import type { EventStoreService } from '../services/EventStoreService';
import { PluginCorrelationFallbackError } from './tool-events.publisher';
import { readStr } from '../../core/config/app-config';
import type { ILogger } from '../../core/decorators/ILogger';

function isPluginCorrelationFallbackAllowed(): boolean {
  const flag = (readStr('PLUGINS_ALLOW_CORRELATION_FALLBACK', '') ?? '').toLowerCase();
  const nodeEnv = (readStr('NODE_ENV', 'development') ?? 'development').toLowerCase();
  if (nodeEnv === 'production') {
    return flag === '1' || flag === 'true';
  }
  return true;
}

export class SandboxEventsPublisher {
  constructor(
    private readonly eventStoreService: EventStoreService,
    private readonly logger?: ILogger,
  ) {}

  async publishSandboxViolation(input: {
    pluginName: string;
    violationType: 'execution_timeout';
    timeoutMs?: number;
    pluginId?: string;
    toolName?: string;
    context: PluginExecutionContext;
  }): Promise<void> {
    try {
      const { correlationId, correlationSource, traceLostPlugins } = this.resolveCorrelationId(
        input.context,
      );
      const aggregateId = this.resolveAggregateId(input.context);

      // TODO(PLG-MCP.2): once SandboxViolationEventSchema / validateSandboxViolationEvent()
      // are introduced in core typed events (see
      // 05-PLUGIN_SYSTEM/14-typed-events-registry.md and
      // 05-PLUGIN_SYSTEM/typed-events-mvp.md), validate payload via the core
      // schema instead of constructing it ad-hoc here.
      const payload: Record<string, unknown> = {
        type: 'sandbox.violation',
        plugin_name: input.pluginName,
        plugin_id: input.pluginId ?? input.pluginName,
        tool_name: input.toolName ?? input.pluginName,
        violation_type: input.violationType,
        correlation_id: correlationId,
        timestamp: new Date().toISOString(),
        tenant_id: input.context.tenantId,
        session_id: input.context.sessionId,
        actor: input.context.userId,
        correlation_source: correlationSource,
        trace_lost: traceLostPlugins ? { plugins: true } : undefined,
      };

      if (typeof input.timeoutMs === 'number') {
        payload.timeout_ms = input.timeoutMs;
      }

      const event = EventFactory.createBaseEvent(
        aggregateId,
        'sandbox.violation',
        payload,
        correlationId,
      );

      await this.eventStoreService.saveDomainEvents([event]);
    } catch (error) {
      if (error instanceof PluginCorrelationFallbackError) {
        if (this.logger) {
          this.logger.error(
            '[RCTX-PLUGINS] Fallback correlationId is disabled for sandbox.violation event',
            {
              pluginName: input.pluginName,
              pluginId: input.pluginId,
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
      // best-effort: sandbox events must never break primary plugin flow
    }
  }

  private resolveAggregateId(context: PluginExecutionContext): string {
    return context.sessionId ?? context.userId ?? 'sandbox';
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
      const fallbackId = `sandbox:${Date.now()}`;
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

    const fallbackId = `corr_violation:sandbox:${Date.now()}`;

    if (this.logger) {
      this.logger.warn(
        '[RCTX-PLUGINS] correlationId lost for sandbox.violation event, using fallback in production',
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
}