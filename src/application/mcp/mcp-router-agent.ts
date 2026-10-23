import type { PluginExecutionContext } from '../plugins/plugin-types';
import type { IUnifiedToolRegistry, ToolRecord } from '../plugins/unified-tool-registry';
import { type EnrichedError } from '../../core/errors/enriched-error';
import { getMcpRouterLatencyHistogram, getMcpRouterRequestsCounter } from '../../monitoring';

export interface MCPRouteToolCallRequest {
  toolId: string;
  payload: unknown;
  context: PluginExecutionContext;
}

export interface MCPRouteToolCallResult {
  result: unknown;
  source: 'local' | 'mcp';
  targetId: string;
}

export interface IMCPRouterAgent {
  routeToolCall(request: MCPRouteToolCallRequest): Promise<MCPRouteToolCallResult>;
}

/**
 * MCPRouterAgent — минимальный маршрутизатор MCP-инструментов поверх UnifiedToolRegistry.
 *
 * v1:
 * - ищет tool по toolId в UnifiedToolRegistry;
 * - если kind === 'mcp' — возвращает фейковый результат, по которому можно проверить MCP-ветку;
 * - если kind === 'local' — возвращает маркёр локального инструмента (исполнение остаётся за UPR).
 */
export class MCPRouterAgent implements IMCPRouterAgent {
  constructor(private readonly toolRegistry: IUnifiedToolRegistry) {}

  async routeToolCall(request: MCPRouteToolCallRequest): Promise<MCPRouteToolCallResult> {
    const startedAt = process.hrtime.bigint();
    const counter = getMcpRouterRequestsCounter();
    const histogram = getMcpRouterLatencyHistogram();

    let resultLabel: 'success' | 'error' = 'success';
    let reasonLabel = 'unknown';

    try {
      const trimmedId = request.toolId.trim();
      if (!trimmedId) {
        const error = new Error('toolId must be a non-empty string') as EnrichedError;
        error.code = 'MCP_INVALID_TOOL_ID';
        reasonLabel = 'invalid_tool_id';
        throw error;
      }

      const record: ToolRecord | undefined = this.toolRegistry.getToolById(trimmedId);

      if (!record) {
        const error = new Error(
          `Tool not found in UnifiedToolRegistry for id "${trimmedId}"`,
        ) as EnrichedError;
        error.code = 'MCP_TOOL_NOT_FOUND';
        reasonLabel = 'not_found';
        throw error;
      }

      if (record.kind === 'mcp') {
        reasonLabel = 'mcp';
        return {
          source: 'mcp',
          targetId: record.toolId,
          result: {
            source: 'mcp',
            toolId: record.toolId,
            payload: request.payload,
          },
        };
      }

      // Для локальных tool MCPRouterAgent сейчас выступает как no-op адаптер.
      // Локальные плагины по-прежнему исполняются через UnifiedPluginRegistry / PluginExecutor;
      // роутер лишь даёт типизированный способ отличить ветку в тестах/observability.
      reasonLabel = 'local';
      return {
        source: 'local',
        targetId: record.toolId,
        result: {
          source: 'local',
          toolId: record.toolId,
          payload: request.payload,
        },
      };
    } catch (err) {
      resultLabel = 'error';
      const enriched = err as EnrichedError | undefined;
      if (reasonLabel === 'unknown') {
        if (enriched?.code === 'MCP_INVALID_TOOL_ID') {
          reasonLabel = 'invalid_tool_id';
        } else if (enriched?.code === 'MCP_TOOL_NOT_FOUND') {
          reasonLabel = 'not_found';
        } else {
          reasonLabel = 'exception';
        }
      }

      throw err;
    } finally {
      try {
        const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
        counter.labels(resultLabel, reasonLabel).inc();
        histogram.labels(resultLabel, reasonLabel).observe(durationSeconds);
      } catch {
        // best-effort: metrics must not affect MCP routing behaviour
      }
    }
  }
}