import type { MasErrorCategory } from '../../mas/services/mas-error-types';
import type { DurableSloDiagnostics } from '../../mas/MasExecutionError';

/**
 * MAS Durable Execution typed event payloads.
 *
 * Layer: Domain (contracts)
 *
 * Эти типы описывают payload MAS‑событий вокруг выполнения задач и шагов,
 * используемых поверх EventStore/Outbox.
 * JSON‑схемы и runtime‑контракты синхронизируются с
 * 05-PLUGIN_SYSTEM/14-typed-events-registry.md.
 */

export type MasTaskExecutionEventType =
  | 'mas.task_execution.created'
  | 'mas.task_execution.started'
  | 'mas.execution_step.planned'
  | 'mas.execution_step.started'
  | 'mas.execution_step.completed'
  | 'mas.execution_step.failed'
  | 'mas.task_execution.completed'
  | 'mas.task_execution.failed'
  | 'mas.task_execution.cancelled'
  | 'mas.task_execution.resumed'
  | 'mas.task_execution.dead_lettered';

/**
 * Базовый контракт идентификации Durable Execution событий.
 * Совместим с RCTX‑MAS инвариантами (correlation_id / mas_session_id).
 */
export interface MasDurableEventBasePayload extends Record<string, unknown> {
  /** MAS‑сессия, в рамках которой выполняется задача */
  mas_session_id: string;
  /** Опциональный MAS trace id для сценария */
  mas_trace_id?: string;
  /** Логический идентификатор сценария (MasRequest.scenario) */
  scenario?: string;
  /** Бизнесовый use‑case (MasRequest.useCase) */
  use_case?: string;
  /** Tenant / user идентичность, если доступна */
  tenant_id?: string;
  user_id?: string;
  /** Correlation id e2e цепочки (RequestContext.correlationId) */
  correlation_id: string;
  /**
   * Источник correlation id в терминах RCTX‑оси.
   * Для Durable Execution ожидается 'mas_context'.
   */
  correlation_source?:
    | 'mas_context'
    | 'memory_context'
    | 'policy_context'
    | 'request_context'
    | 'plugin_context'
    | 'fallback_dev'
    | 'fallback_prod';
  /** Временная метка события (ISO‑8601) */
  timestamp: string;
}

/**
 * Краткое описание ошибки исполнения шага/задачи.
 * Структура совместима с MasExecutionError, но использует строки для времени.
 */
export interface MasExecutionErrorDetails {
  masErrorCategory?: MasErrorCategory;
  /**
   * Optional durable execution policy diagnostics (R2 policy layer).
   *
   * These fields mirror effective MAS runtime policy parameters that were
   * applied for the given task/step at the moment of failure.
   */
  policy_profile?: string;
  effective_task_timeout_ms?: number;
  effective_step_timeout_ms?: number;
  effective_max_step_retries?: number;
  /**
   * Optional structured durable SLO diagnostics (R3-C2-C3).
   *
   * This nested object provides a camelCase view over the same effective
   * durable policy parameters that are also exposed as flattened
   * *_ms / *_retries fields for backwards compatibility.
   */
  durableSlo?: DurableSloDiagnostics;
  // Допускаем произвольные дополнительные поля для расширения диагностики.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface MasExecutionErrorPayload {
  code: string;
  message: string;
  details?: MasExecutionErrorDetails;
  first_occurred_at: string;
  last_occurred_at: string;
}

/**
 * Базовый контракт для событий по конкретной MAS‑задаче и её execution‑агрегату.
 */
export interface MasTaskExecutionEventBasePayload
  extends MasDurableEventBasePayload {
  /** Логический идентификатор задачи внутри MAS‑плана */
  task_id: string;
  /** Идентификатор Durable Execution агрегата */
  task_execution_id: string;
}

/**
 * mas.task_execution.created
 * Фиксирует создание нового Durable Execution агрегата.
 */
export interface MasTaskExecutionCreatedEventPayload
  extends MasTaskExecutionEventBasePayload {
  status:
    | 'Pending'
    | 'Running'
    | 'Completed'
    | 'Failed'
    | 'Cancelled'
    | 'DeadLettered';
  attempts: number;
  timeouts?: {
    task_timeout_ms?: number;
    step_timeout_ms?: number;
  };
  /** Произвольные служебные метаданные */
  meta?: Record<string, unknown>;
}

/**
 * mas.task_execution.started
 * Задача переведена в Running, начинается выполнение первого шага.
 */
export interface MasTaskExecutionStartedEventPayload
  extends MasTaskExecutionEventBasePayload {
  previous_status?:
    | 'Pending'
    | 'Running'
    | 'Completed'
    | 'Failed'
    | 'Cancelled'
    | 'DeadLettered';
  status: 'Running';
  attempts: number;
}

/**
 * mas.task_execution.completed
 * Durable Execution задачи успешно завершён.
 */
export interface MasTaskExecutionCompletedEventPayload
  extends MasTaskExecutionEventBasePayload {
  previous_status?:
    | 'Pending'
    | 'Running'
    | 'Completed'
    | 'Failed'
    | 'Cancelled'
    | 'DeadLettered';
  status: 'Completed';
  attempts: number;
}

/**
 * mas.task_execution.failed
 * Задача завершилась необратимой ошибкой.
 */
export interface MasTaskExecutionFailedEventPayload
  extends MasTaskExecutionEventBasePayload {
  previous_status?:
    | 'Pending'
    | 'Running'
    | 'Completed'
    | 'Failed'
    | 'Cancelled'
    | 'DeadLettered';
  status: 'Failed';
  attempts: number;
  error: MasExecutionErrorPayload;
  /**
   * Optional machine-readable terminal failure reason
   * (e.g. TASK_TIMEOUT, STEP_DEAD_LETTERED, CB_STUCK_OPEN).
   */
  reason_code?: string;
}

/**
 * mas.task_execution.cancelled
 * Пользователь или система отменили задачу.
 */
export interface MasTaskExecutionCancelledEventPayload
  extends MasTaskExecutionEventBasePayload {
  previous_status?:
    | 'Pending'
    | 'Running'
    | 'Completed'
    | 'Failed'
    | 'Cancelled'
    | 'DeadLettered';
  status: 'Cancelled';
  attempts: number;
  reason?: string;
}

/**
 * mas.task_execution.resumed
 * Задача возобновлена после паузы/ошибки.
 */
export interface MasTaskExecutionResumedEventPayload
  extends MasTaskExecutionEventBasePayload {
  previous_status: 'Failed' | 'Cancelled' | 'DeadLettered';
  status: 'Running';
  attempts: number;
}

/**
 * mas.task_execution.dead_lettered
 * Задача переведена в DeadLettered после исчерпания попыток.
 */
export interface MasTaskExecutionDeadLetteredEventPayload
  extends MasTaskExecutionEventBasePayload {
  previous_status: 'Failed' | 'Cancelled';
  status: 'DeadLettered';
  attempts: number;
  error: MasExecutionErrorPayload;
  /** Машиночитаемый код причины dead‑lettering (например, CIRCUIT_OPEN, MAX_RETRIES_EXCEEDED) */
  reason_code?: string;
}

/**
 * Базовый контракт для событий по конкретному шагу Durable Execution.
 */
export interface MasExecutionStepEventBasePayload
  extends MasTaskExecutionEventBasePayload {
  /** Идентификатор шага */
  step_id: string;
  /** Порядковый индекс шага в задаче */
  step_index: number;
  /** Логический тип шага (LLM, TOOL, SUB_AGENT и т.п.) */
  step_kind:
    | 'LLM_CALL'
    | 'TOOL_CALL'
    | 'SUB_AGENT'
    | 'DECISION'
    | 'AGGREGATION'
    | 'SYSTEM';
}

/**
 * mas.execution_step.planned
 * Новый шаг добавлен в план выполнения.
 */
export interface MasExecutionStepPlannedEventPayload
  extends MasExecutionStepEventBasePayload {
  status: 'Planned';
  max_attempts?: number;
  idempotency_key: string;
  memory_policy?: 'NONE' | 'SHORT_TERM' | 'LONG_TERM' | 'SUMMARY_ONLY';
}

/**
 * mas.execution_step.started
 * Шаг начал выполняться.
 */
export interface MasExecutionStepStartedEventPayload
  extends MasExecutionStepEventBasePayload {
  status: 'InProgress';
  attempts: number;
}

/**
 * mas.execution_step.completed
 * Шаг успешно завершён.
 */
export interface MasExecutionStepCompletedEventPayload
  extends MasExecutionStepEventBasePayload {
  status: 'Completed';
  attempts: number;
  result_ref?: {
    provider: string;
    ref_id: string;
    locator?: string;
    correlation_id?: string;
    metadata?: Record<string, unknown>;
  };
  /** Опциональная ссылка на решение memory/policy, если применимо */
  policy_decision_ref?: string;
}

/**
 * mas.execution_step.failed
 * Шаг завершился ошибкой; возможны дальнейшие ретраи на уровне Durable Execution.
 */
export interface MasExecutionStepFailedEventPayload
  extends MasExecutionStepEventBasePayload {
  status: 'Failed';
  attempts: number;
  error: MasExecutionErrorPayload;
  /** true, если шаг ещё может быть повторно запущен (attempts < max_attempts) */
  can_retry?: boolean;
}
