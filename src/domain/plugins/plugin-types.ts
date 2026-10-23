import type {
  PluginManifestId,
  PluginManifestSnapshot,
} from './manifest/plugin-manifest-store.interface';
import type { IRequestContext } from '../../core/context/request-context';
import type { IMicroPhoenixPlugin } from './microphoenix-plugin.port';
import { z } from 'zod';

export type PluginType =
  | 'phoenix-plugin'
  | 'external-http'
  | 'sam-tool'
  | 'internal';

export interface PluginRoute {
  name: string;
  version?: string;
}

export interface PluginEntrypointRef {
  ref: string;
  options?: Record<string, unknown>;
}

export interface PluginDescriptor {
  id: PluginManifestId;
  type: PluginType;
  displayName: string;
  entrypoint: PluginEntrypointRef;
  manifest?: PluginManifestSnapshot;
  tags?: string[];
}

export interface IPluginManifest {
  name: string;
  version: string;
  dependencies?: string[];
}

export const PluginManifestSchema = z.object({
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  dependencies: z
    .array(z.string().min(1).max(128))
    .max(64)
    .optional(),
});

/**
 * Plugin interface extending MicroPhoenix core lifecycle
 *
 * Combines lifecycle hooks (onLoad/onUnload from IMicroPhoenixPlugin)
 * with execution capability for tool/action plugins.
 *
 * Backward Compatibility:
 * - Existing plugins implementing execute() continue to work
 * - Lifecycle hooks are optional for gradual migration
 */
export interface IPlugin<TInput = unknown, TOutput = unknown>
  extends IMicroPhoenixPlugin {
  /**
   * Execute plugin with input and context
   * Core functionality for tool/action plugins
   *
   * @param input - Plugin input data
   * @param context - Execution context with request correlation
   * @returns Plugin output (sync or async)
   */
  execute(input: TInput, context: PluginExecutionContext): Promise<TOutput> | TOutput;
}

/**
 * Execution-scoped view of RequestContext for plugin/tool runtime.
 *
 * RCTX-PLUGINS invariants for HTTP → /api/plugins/execute → UPR:
 * - correlationId:
 *   - приходит из RequestContext.getCorrelationId() (см. RequestContextMiddleware)
 *   - всегда валиден по RequestContextUtils.isValidCorrelationId() либо равен 'unknown' в девиантных сценариях
 * - tenantId / sessionId / userId:
 *   - являются snapshot-значениями из RequestContext.getContext() и/или Auth-слоя
 *   - не переопределяются внутри плагинного runtime.
 * - mas* поля, если заданы, прокидываются из MAS/RequestContext-связки без локальной генерации.
 */
export interface PluginExecutionContext {
  /** Полный RequestContext, привязанный к этому исполнению (AsyncLocal или клон). */
  requestContext: IRequestContext;
  /**
   * Correlation ID плагинного вызова.
   * Используется как первичный источник для tool.* / sandbox.* / plugin.audit.* событий.
   */
  correlationId: string;
  /** Логический идентификатор пользователя/актора (actor). */
  userId?: string;
  /** Идентификатор сессии HTTP/MAS, если применимо. */
  sessionId?: string;
  /** Идентификатор арендатора для multi-tenant сценариев, если применимо. */
  tenantId?: string;
  /** Идентификатор MAS-сессии, если плагин выполняется в MAS-контексте. */
  masSessionId?: string;
  /** Идентификатор MAS-трейса для связывания MAS и плагинных трасс. */
  masTraceId?: string;
}

/**
 * Interface for publishing tool events.
 * Extracted to plugin-types.ts to break circular dependency (TASK-023).
 */
export interface IToolEventsPublisher {
  publishToolCalled(input: {
    toolName: string;
    args: unknown;
    context: PluginExecutionContext;
  }): Promise<void>;

  publishToolResult(input: {
    toolName: string;
    success: boolean;
    durationMs?: number;
    result?: unknown;
    error?: unknown;
    context: PluginExecutionContext;
  }): Promise<void>;
}