/**
 * CorrelationIdProvider - единый источник генерации и валидации correlationId
 * Layer: Core
 *
 * Стандарт Variant A:
 * - В коде используем camelCase: correlationId
 * - На границах и в БД: snake_case поля и заголовки: correlation_id, x-correlation-id
 *
 * Возможности:
 * - Генерация безопасного correlationId
 * - Валидация/нормализация входящих значений
 * - Извлечение из набора HTTP‑заголовков
 */
import { IdGenerator } from '../utils/IdGenerator';

export namespace CorrelationIdProvider {
  const MIN_LEN = 5;
  const MAX_LEN = 255;
  const RE_ALLOWED = /^[a-zA-Z0-9._-]+$/;

  /** Порядок предпочтения заголовков для корреляции */
  const HEADER_PREFERENCE = [
    'x-correlation-id',
    'x-correlationid',
    'correlation-id',
    'x-request-id',
    'x-trace-id',
    'trace-id',
    'span-id',
  ] as const;

  export type HeaderBag = Record<string, unknown>;

  /**
   * Проверка допустимости строки
   */
  export function isValid(id: unknown): id is string {
    if (typeof id !== 'string') return false;
    const trimmed = id.trim();
    if (trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) return false;
    return RE_ALLOWED.test(trimmed);
  }

  /**
   * Бросает ошибку при невалидном correlationId
   */
  export function validateOrThrow(id: unknown, field: string = 'correlationId'): string {
    if (!isValid(id)) {
      throw new Error(`Invalid ${field} format`);
    }
    return (id).trim();
  }

  /**
   * Генерация безопасного correlationId вида: corr_{ts}_{rand}
   */
  export function generate(prefix: string = 'corr'): string {
    const ts = Date.now();
    const rand = IdGenerator.generateRandomString(9);
    return `${prefix}_${ts}_${rand}`;
  }

  /**
   * Нормализация входящего значения: вернуть валидный id или сгенерировать новый
   */
  export function normalize(id?: unknown, options?: { generateIfInvalid?: boolean; prefix?: string }): string {
    const genIfInvalid = options?.generateIfInvalid !== false;
    if (isValid(id)) return (id).trim();
    if (genIfInvalid) return generate(options?.prefix);
    throw new Error('Invalid correlationId');
  }

  /**
   * Ключ snake_case для JSON/БД
   */
  export function snakeKey(): 'correlation_id' {
    return 'correlation_id';
  }

  /**
   * Каноничное имя заголовка на проводе
   */
  export function headerName(): 'x-correlation-id' {
    return 'x-correlation-id';
  }

  /**
   * Вернуть объект метаданных с correlation_id
   */
  export function toJSONMeta(correlationId: string): Record<string, string> {
    return { [snakeKey()]: validateOrThrow(correlationId) };
  }

  /**
   * Извлечь значение заголовка без учета регистра
   */
  function getHeader(headers: HeaderBag | undefined | null, name: string): unknown {
    // istanbul ignore next -- defensive: callers already null-check before calling
    if (!headers || typeof headers !== 'object') return undefined;
    const headersRecord = headers as Record<string, string | string[] | undefined>;
    const direct = headersRecord[name];
    if (typeof direct !== 'undefined') return direct;

    // Поиск без учета регистра
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  }

  /**
   * Найти первое подходящее значение корреляции в заголовках (без нормализации)
   */
  export function pickFromHeaders(headers?: HeaderBag | null): string | undefined {
    if (!headers) return undefined;
    for (const key of HEADER_PREFERENCE) {
      const val = getHeader(headers, key);
      if (typeof val === 'string' && isValid(val)) {
        return val.trim();
      }
    }
    return undefined;
  }

  /**
   * Получить нормализованный correlationId из заголовков
   * Возвращает найденный валидный id или генерирует новый
   */
  export function getPreferred(headers?: HeaderBag | null, options?: { prefix?: string }): string {
    const picked = pickFromHeaders(headers);
    return normalize(picked, { generateIfInvalid: true, prefix: options?.prefix });
  }
}

export default CorrelationIdProvider;