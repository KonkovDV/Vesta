import type { PluginExecutionContext } from './plugin-types';
import { RequestContext } from '../context/request-context';
import { EventFactory } from '../../domain/events/event-store.interface';
import type { EventStoreService } from '../services/EventStoreService';
import { PluginCorrelationFallbackError } from './tool-events.publisher';
import { readStr } from '../../core/config/app-config';
import type { ILogger } from '../../core/decorators/ILogger';

export interface PluginPolicyDeniedAuditInput {
  pluginName: string;
  policy: string;
  action: string;
  reason?: string;
  context: PluginExecutionContext;
}

export interface IPluginAuditEventsPublisher {
  publishPolicyDenied(input: PluginPolicyDeniedAuditInput): Promise<void>;
}

function isPluginCorrelationFallbackAllowed(): boolean {
  const flag = (readStr('PLUGINS_ALLOW_CORRELATION_FALLBACK', '') ?? '').toLowerCase();
  const nodeEnv = (readStr('NODE_ENV', 'development') ?? 'development').toLowerCase();
  if (nodeEnv === 'production') {
    return flag === '1' || flag === 'true';
  }
  return true;
}

/**
 * PluginAuditEventsPublisher — producer for plugin.audit.* typed events.
 *
 * M0: only plugin.audit.policy_denied for manifest/policy deny flows.
 * Best-effort: audit events must never break primary plugin flow.
 */
export class PluginAuditEventsPublisher implements IPluginAuditEventsPublisher {
  constructor(
    private readonly eventStoreService: EventStoreService,
    private readonly logger?: ILogger,
  ) {}

  async publishPolicyDenied(input: PluginPolicyDeniedAuditInput): Promise<void> {
    try {
      const { correlationId, correlationSource, traceLostPlugins } =
        this.resolveCorrelation(input.context);
      const aggregateId = this.resolveAggregateId(input.context);

      const payload: Record<string, unknown> = {
        type: 'plugin.audit.policy_denied',
        plugin_name: input.pluginName,
        policy: input.policy,
        action: input.action,
        timestamp: new Date().toISOString(),
        correlation_id: correlationId,
        tenant_id: input.context.tenantId,
        session_id: input.context.sessionId,
        actor: input.context.userId,
        correlation_source: correlationSource,
        trace_lost: traceLostPlugins ? { plugins: true } : undefined,
      };

      if (input.reason) {
        payload.reason = input.reason;
      }

      const event = EventFactory.createBaseEvent(
        aggregateId,
        'plugin.audit.policy_denied',
        payload,
        correlationId,
      );

      await this.eventStoreService.saveDomainEvents([event]);
    } catch (error) {
      if (error instanceof PluginCorrelationFallbackError) {
        if (this.logger) {
          this.logger.error(
            '[RCTX-PLUGINS] Fallback correlationId is disabled for plugin.audit event',
            {
              pluginName: input.pluginName,
              tenantId: input.context.tenantId,
              sessionId: input.context.sessionId,
              userId: input.context.userId,
              message: error.message,
            },
          );
        }
        return;
      }
      // best-effort: plugin audit events must never break primary plugin flow
    }
  }

  private resolveAggregateId(context: PluginExecutionContext): string {
    return context.sessionId ?? context.userId ?? 'plugin_audit';
  }

  private resolveCorrelation(context: PluginExecutionContext): {
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
      const fallbackId = `plugin_audit:${Date.now()}`;
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

    const fallbackId = `corr_violation:plugin_audit:${Date.now()}`;

    if (this.logger) {
      this.logger.warn(
        '[RCTX-PLUGINS] correlationId lost for plugin.audit.* event, using fallback in production',
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