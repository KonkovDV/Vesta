import type { NormalizedResult } from '../../core/plugins/normalized-result';
import type { PluginRoute, PluginDescriptor, PluginExecutionContext, IToolEventsPublisher } from './plugin-types';
import type { IPluginRegistry } from './plugin-registry';
import type { IPluginExecutor } from './plugin-executor';
import { PluginSandboxTimeoutError } from './plugin-executor';
import type { IRequestContext } from '../context/request-context';
import { RequestContext, RequestContextUtils } from '../context/request-context';
import type {
  IManifestPolicyEnforcer,
  ManifestEnforcementDecision,
} from '../plugins/manifest-policy.enforcer';
import type { SandboxEventsPublisher } from './sandbox-events.publisher';
import type { IPluginAuditEventsPublisher } from './plugin-audit-events.publisher';
import {
  getPluginSandboxViolationsCounter,
  getToolCallsCounter,
  getToolCallDurationHistogram,
} from '../../monitoring';
import type { IUnifiedToolRegistry } from './unified-tool-registry';
import type { IMCPRouterAgent } from '../mcp/mcp-router-agent';
import type { ILogger } from '../../core/decorators/ILogger';

export interface UnifiedPluginCallOptions {
  timeoutMs?: number;
  tags?: string[];
}

export interface IUnifiedPluginRegistry {
  call<TInput = unknown, TData = unknown>(
    routeOrName: string | PluginRoute,
    payload: TInput,
    requestContext: IRequestContext,
    options?: UnifiedPluginCallOptions,
  ): Promise<NormalizedResult<TData>>;
}

// Re-export IToolEventsPublisher from plugin-types to maintain backward compatibility
// Interface moved to plugin-types.ts to break circular dependency (TASK-023)
export type { IToolEventsPublisher } from './plugin-types';

function getOptionalContextIdentifier(
  ctxData: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = ctxData[key];
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : undefined;
}

export class UnifiedPluginRegistry implements IUnifiedPluginRegistry {
  constructor(
    private readonly pluginRegistry: IPluginRegistry,
    private readonly pluginExecutor: IPluginExecutor,
    // TODO (PLG-NEXT.3): use manifestPolicyEnforcer.enforce({ pluginId: descriptor.id, ... })
    private readonly manifestPolicyEnforcer?: IManifestPolicyEnforcer,
    // TODO (PLG-NEXT.4): wire toolEventsPublisher to typed tool.* events
    private readonly toolEventsPublisher?: IToolEventsPublisher,
    private readonly sandboxEventsPublisher?: SandboxEventsPublisher,
    private readonly pluginAuditEventsPublisher?: IPluginAuditEventsPublisher,
    /**
     * UnifiedToolRegistry (optional) — единый реестр tool-ов (локальные + MCP).
     * В M0 используется:
     * - для регистрации локальных плагинов как tool.kind = 'local';
     * - для определения MCP-инструментов по kind = 'mcp'.
     */
    private readonly toolRegistry?: IUnifiedToolRegistry,
    /**
     * MCPRouterAgent (optional) — маршрутизатор MCP-инструментов.
     * Включается только когда установлен вместе с UnifiedToolRegistry.
     */
    private readonly mcpRouterAgent?: IMCPRouterAgent,
    private readonly logger?: ILogger,
  ) {}

  async call<TInput, TData>(
    routeOrName: string | PluginRoute,
    payload: TInput,
    requestContext: IRequestContext,
    options?: UnifiedPluginCallOptions,
  ): Promise<NormalizedResult<TData>> {
    const startedAt = Date.now();
    const execCtx = this.buildExecutionContext(requestContext);

    const toolCallsCounter = getToolCallsCounter();
    const toolCallDurationHistogram = getToolCallDurationHistogram();

    let descriptor: PluginDescriptor;
    try {
      descriptor = await this.pluginRegistry.resolvePlugin(routeOrName);
    } catch (error) {
      return this.normalizeResolveError<TData>(error, routeOrName, execCtx);
    }

    const toolName = descriptor.id.name;
    const toolId = `${descriptor.id.name}@${descriptor.id.version}`;

    // Попытка зарегистрировать локальный tool в UnifiedToolRegistry (если он ещё не зарегистрирован).
    // В M0 это best-effort: сбои не должны ломать плагинный флоу.
    let toolRecordKind: 'local' | 'mcp' | undefined;
    if (this.toolRegistry) {
      try {
        const existing = this.toolRegistry.getToolById(toolId);
        if (!existing) {
          this.toolRegistry.registerTool({
            toolId,
            kind: 'local',
            pluginDescriptor: descriptor,
          });
          const registered = this.toolRegistry.getToolById(toolId);
          toolRecordKind = registered?.kind;
        } else {
          toolRecordKind = existing.kind;
        }
      } catch {
        // ignore registry errors in M0
      }
    }

    const isMcpTool =
      !!this.mcpRouterAgent &&
      toolRecordKind === 'mcp';

    if (this.toolEventsPublisher) {
      await this.toolEventsPublisher.publishToolCalled({
        toolName,
        args: payload,
        context: execCtx,
      });
    }

    if (this.manifestPolicyEnforcer) {
      const decision = await this.manifestPolicyEnforcer.enforce({
        pluginId: descriptor.id,
        // M0: только identity; tenant/region/прочие атрибуты будут добавлены в следующих версиях.
      });

      if (decision.status === 'deny') {
        const denyResult = this.normalizePolicyDeny<TData>(decision, descriptor, execCtx);

        if (this.toolEventsPublisher) {
          const durationMs = Date.now() - startedAt;
          await this.toolEventsPublisher.publishToolResult({
            toolName,
            success: false,
            durationMs,
            result: undefined,
            error: {
              type: 'ManifestPolicyDeny',
              reason: decision.reason,
            },
            context: execCtx,
          });
        }

        if (this.pluginAuditEventsPublisher) {
          await this.pluginAuditEventsPublisher.publishPolicyDenied({
            pluginName: descriptor.id.name,
            policy: 'manifest_policy',
            action: 'plugins.execute',
            reason: decision.reason,
            context: execCtx,
          });
        }

        try {
          const durationSeconds = (Date.now() - startedAt) / 1000;
          toolCallsCounter.labels(toolName, String(false)).inc();
          toolCallDurationHistogram.labels(toolName, String(false)).observe(durationSeconds);
        } catch {
          // best-effort: metrics must not break plugin flow
        }

        return denyResult;
      }
    }

    try {
      if (isMcpTool && this.mcpRouterAgent) {
        const routerResult = await this.mcpRouterAgent.routeToolCall({
          toolId,
          payload,
          context: execCtx,
        });

        const normalizedMcp = this.normalizeMcpResult<TData>(
          routerResult,
          descriptor,
          execCtx,
        );

        if (this.toolEventsPublisher) {
          const durationMs = Date.now() - startedAt;
          const eventResultPayload = {
            source: 'mcp' as const,
            toolId,
            routerResult,
          };

          void this.toolEventsPublisher.publishToolResult({
            toolName,
            success: true,
            durationMs,
            result: eventResultPayload,
            error: undefined,
            context: execCtx,
          }).catch(e => this.logger?.warn('publishToolResult failed', { error: e }));
        }

        try {
          const durationSeconds = (Date.now() - startedAt) / 1000;
          toolCallsCounter.labels(toolName, String(true)).inc();
          toolCallDurationHistogram.labels(toolName, String(true)).observe(durationSeconds);
        } catch {
          // best-effort
        }

        return normalizedMcp;
      }

      const coreResult = await this.pluginExecutor.execute<TInput, TData>(
        descriptor,
        payload,
        execCtx,
      );

      const normalized = this.normalizeCoreResult<TData>(coreResult, descriptor, execCtx);

      if (this.toolEventsPublisher) {
        const durationMs = Date.now() - startedAt;
        void this.toolEventsPublisher.publishToolResult({
          toolName,
          success: coreResult.success,
          durationMs,
          result: coreResult.success ? coreResult.data : undefined,
          error: !coreResult.success ? coreResult.error_detail : undefined,
          context: execCtx,
        }).catch(e => this.logger?.warn('publishToolResult failed', { error: e }));
      }

      try {
        const durationSeconds = (Date.now() - startedAt) / 1000;
        toolCallsCounter.labels(toolName, String(coreResult.success)).inc();
        toolCallDurationHistogram
          .labels(toolName, String(coreResult.success))
          .observe(durationSeconds);
      } catch {
        // best-effort
      }

      return normalized;
    } catch (error) {
      const normalized = this.normalizeExecutionError<TData>(error, descriptor, execCtx);

      if (error instanceof PluginSandboxTimeoutError) {
        try {
          const counter = getPluginSandboxViolationsCounter();
          counter.labels(descriptor.id.name, 'execution_timeout').inc();
        } catch {
          // best-effort: метрики не должны ломать плагинный флоу
        }

        if (this.sandboxEventsPublisher) {
          void this.sandboxEventsPublisher.publishSandboxViolation({
            pluginName: descriptor.id.name,
            violationType: 'execution_timeout',
            timeoutMs: error.timeoutMs,
            pluginId: toolId,
            toolName,
            context: execCtx,
          }).catch(e => this.logger?.warn('publishSandboxViolation failed', { error: e }));
        }
      }

      if (this.toolEventsPublisher) {
        const durationMs = Date.now() - startedAt;
        void this.toolEventsPublisher.publishToolResult({
          toolName,
          success: false,
          durationMs,
          result: undefined,
          error,
          context: execCtx,
        }).catch(e => this.logger?.warn('publishToolResult failed', { error: e }));
      }

      try {
        const durationSeconds = (Date.now() - startedAt) / 1000;
        toolCallsCounter.labels(toolName, String(false)).inc();
        toolCallDurationHistogram.labels(toolName, String(false)).observe(durationSeconds);
      } catch {
        // best-effort
      }

      return normalized;
    } finally {
      // Reserved for future metrics / tool events wiring.
      const _durationMs = Date.now() - startedAt;
      void _durationMs;
      void options;
    }
  }

  private buildExecutionContext(requestContext: IRequestContext): PluginExecutionContext {
    let rawCtxData: Record<string, unknown> | null = null;

    try {
      const candidate = requestContext.getContext();
      if (candidate && typeof candidate === 'object') {
        rawCtxData = candidate as unknown as Record<string, unknown>;
      }
    } catch (error) {
      // В продовой HTTP-цепочке RequestContext должен быть инициализирован.
      // Логируем только когда нам явно передали AsyncLocal RequestContext.
      if (this.logger && requestContext === RequestContext) {
        this.logger.warn(
          '[RCTX-PLUGINS] Failed to read RequestContext.getContext() in buildExecutionContext',
          {
            error:
              error instanceof Error
                ? { message: error.message, stack: error.stack }
                : { message: String(error) },
          },
        );
      }
    }

    const ctxData = rawCtxData ?? {};
    const correlationFromContext =
      getOptionalContextIdentifier(ctxData, 'correlationId');

    let correlationFromAsyncLocal: string | undefined;
    const isAsyncLocalInstance = requestContext === RequestContext;

    if (isAsyncLocalInstance) {
      try {
        const fromStatic = RequestContext.getCorrelationId();
        if (fromStatic) {
          correlationFromAsyncLocal = String(fromStatic);
        }
      } catch (error) {
        if (this.logger) {
          this.logger.warn(
            '[RCTX-PLUGINS] RequestContext.getCorrelationId() failed while building PluginExecutionContext',
            {
              error:
                error instanceof Error
                  ? { message: error.message, stack: error.stack }
                  : { message: String(error) },
            },
          );
        }
      }
    }

    let finalCorrelationId: string | undefined;

    const hasValidContextCorr =
      typeof correlationFromContext === 'string' &&
      RequestContextUtils.isValidCorrelationId(correlationFromContext);

    const hasValidAsyncCorr =
      typeof correlationFromAsyncLocal === 'string' &&
      RequestContextUtils.isValidCorrelationId(correlationFromAsyncLocal);

    if (hasValidContextCorr && hasValidAsyncCorr) {
      if (correlationFromContext !== correlationFromAsyncLocal && this.logger) {
        this.logger.warn(
          '[RCTX-PLUGINS] correlationId mismatch between RequestContext.getContext() and RequestContext.getCorrelationId()',
          {
            fromContext: correlationFromContext,
            fromAsyncLocal: correlationFromAsyncLocal,
          },
        );
      }
      finalCorrelationId = correlationFromAsyncLocal;
    } else if (hasValidAsyncCorr) {
      finalCorrelationId = correlationFromAsyncLocal;
    } else if (hasValidContextCorr) {
      finalCorrelationId = correlationFromContext;
    } else if (isAsyncLocalInstance) {
      // RequestContext инициализирован или передан как AsyncLocal-инстанс,
      // но корректный correlationId отсутствует.
      if (this.logger) {
        this.logger.warn(
          '[RCTX-PLUGINS] Initialized RequestContext without valid correlationId for plugin execution',
          {
            fromContext: correlationFromContext,
            fromAsyncLocal: correlationFromAsyncLocal,
          },
        );
      }
    }

    return {
      requestContext,
      correlationId: finalCorrelationId ?? 'unknown',
      userId: getOptionalContextIdentifier(ctxData, 'userId'),
      sessionId: getOptionalContextIdentifier(ctxData, 'sessionId'),
      tenantId: getOptionalContextIdentifier(ctxData, 'tenantId'),
      masSessionId: getOptionalContextIdentifier(ctxData, 'masSessionId'),
      masTraceId: getOptionalContextIdentifier(ctxData, 'masTraceId'),
    };
  }

  private normalizeCoreResult<TData>(
    core: import('../../core/plugins/normalized-result').NormalizedResultCore<TData>,
    descriptor: PluginDescriptor,
    ctx: PluginExecutionContext,
  ): NormalizedResult<TData> {
    const coreWithMetadata = core as { metadata?: Record<string, unknown> };
    const coreMetadata = coreWithMetadata.metadata ?? {};
    return {
      ...core,
      metadata: {
        ...coreMetadata,
        plugin_name: descriptor.id.name,
        plugin_version: descriptor.id.version,
        correlation_id: ctx.correlationId,
      },
    };
  }

  private normalizeMcpResult<TData>(
    routerResult: { result: unknown; source: 'local' | 'mcp'; targetId: string },
    descriptor: PluginDescriptor,
    ctx: PluginExecutionContext,
  ): NormalizedResult<TData> {
    return {
      success: true,
      // В M0 возвращаем routerResult как есть в поле data, сохраняя MCP-форму результата.
      data: routerResult as TData,
      metadata: {
        plugin_name: descriptor.id.name,
        plugin_version: descriptor.id.version,
        correlation_id: ctx.correlationId,
      },
    };
  }

  private normalizeResolveError<TData>(
    error: unknown,
    routeOrName: string | PluginRoute,
    ctx: PluginExecutionContext,
  ): NormalizedResult<TData> {
    return {
      success: false,
      data: null,
      error_detail: {
        error_type: 'PluginResolveError',
        error_message: error instanceof Error ? error.message : String(error),
        route: typeof routeOrName === 'string' ? routeOrName : routeOrName.name,
        correlation_id: ctx.correlationId,
      },
      metadata: { error_normalized: true },
    };
  }

  private normalizePolicyDeny<TData>(
    decision: ManifestEnforcementDecision,
    descriptor: PluginDescriptor,
    ctx: PluginExecutionContext,
  ): NormalizedResult<TData> {
    return {
      success: false,
      data: null,
      error_detail: {
        error_type: 'ManifestPolicyDeny',
        reason: decision.reason,
        plugin_name: descriptor.id.name,
        plugin_version: descriptor.id.version,
        correlation_id: ctx.correlationId,
      },
      metadata: {
        error_normalized: true,
        manifest_policy_reason: decision.reason,
      },
    };
  }

  private normalizeExecutionError<TData>(
    error: unknown,
    descriptor: PluginDescriptor,
    ctx: PluginExecutionContext,
  ): NormalizedResult<TData> {
    if (error instanceof PluginSandboxTimeoutError) {
      return {
        success: false,
        data: null,
        error_detail: {
          error_type: 'PluginSandboxTimeout',
          error_message: error.message,
          reason: 'execution_timeout',
          timeout_ms: error.timeoutMs,
          plugin_name: error.pluginName ?? descriptor.id.name,
          plugin_version: descriptor.id.version,
          correlation_id: ctx.correlationId,
        },
        metadata: {
          error_normalized: true,
          sandbox_error: true,
        },
      };
    }

    return {
      success: false,
      data: null,
      error_detail: {
        error_type: error instanceof Error ? error.name : 'UnknownError',
        error_message: error instanceof Error ? error.message : String(error),
        plugin_name: descriptor.id.name,
        plugin_version: descriptor.id.version,
        correlation_id: ctx.correlationId,
      },
      metadata: { error_normalized: true },
    };
  }
}
