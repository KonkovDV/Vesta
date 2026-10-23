/**
 * StructuredLogger - реализация ILogger с JSON-логами.
 * Layer: Infrastructure
 *
 * Особенности:
 * - Выводит одну JSON-строку на запись.
 * - Уровни: debug, info, warn, error.
 * - Поддерживает redaction чувствительных полей (пароли, ключи, токены).
 * - Ошибки логируются с message и stack.
 */

import type { ILogger } from '../../core/decorators/ILogger';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type JsonObject = { [key: string]: unknown };

export type ErrorCaptureKind = 'logger' | 'uncaughtException' | 'unhandledRejection' | 'external';

type SerializedError = {
  name: string;
  message: string;
  stack?: string;
} & JsonObject;

interface StructuredLogRecord extends JsonObject {
  ts: string;
  level: LogLevel;
  msg: string;
  logger?: string;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface CapturedErrorLogRecord extends StructuredLogRecord {
  captureKind?: ErrorCaptureKind;
}

type ErrorCaptureSink = (record: CapturedErrorLogRecord) => void | Promise<void>;

export class StructuredLogger implements ILogger {
  private readonly contextName?: string;

  /**
   * Optional accessor for correlationId from ambient request context.
   * Set via setCorrelationIdAccessor() during bootstrap to avoid
   * importing Application-layer RequestContext directly.
   */
  private static correlationIdAccessor?: () => string | undefined;
  private static errorCaptureSink?: ErrorCaptureSink;

  static setCorrelationIdAccessor(accessor: () => string | undefined): void {
    StructuredLogger.correlationIdAccessor = accessor;
  }

  static setErrorCaptureSink(sink?: ErrorCaptureSink): void {
    StructuredLogger.errorCaptureSink = sink;
  }

  static captureExternalError(input: {
    message: string;
    logger?: string;
    error?: Error | JsonObject;
    meta?: JsonObject;
    captureKind?: ErrorCaptureKind;
  }): void {
    const transientLogger = new StructuredLogger(input.logger);
    const error = input.error instanceof Error
      ? input.error
      : transientLogger.tryBuildErrorFromLikeObject(input.error);
    const record = transientLogger.buildRecord('error', input.message, error, input.meta) as CapturedErrorLogRecord;
    record.captureKind = input.captureKind ?? 'external';
    StructuredLogger.dispatchErrorCapture(record);
  }

  constructor(contextName?: string) {
    this.contextName = contextName;
  }

  debug(message: string, meta?: JsonObject): void {
    this.write('debug', message, undefined, meta);
  }

  info(message: string, meta?: JsonObject): void {
    this.write('info', message, undefined, meta);
  }

  log(message: string, meta?: JsonObject): void {
    this.write('info', message, undefined, meta);
  }

  warn(message: string, meta?: JsonObject): void {
    this.write('warn', message, undefined, meta);
  }

  error(
    message: string,
    errorOrMeta?: Error | JsonObject,
    maybeMeta?: JsonObject,
  ): void {
    if (errorOrMeta instanceof Error) {
      this.write('error', message, errorOrMeta, maybeMeta);
      return;
    }
    this.write('error', message, undefined, errorOrMeta);
  }

  private write(
    level: LogLevel,
    message: string,
    error: Error | undefined,
    meta: JsonObject | undefined,
  ): void {
    const record = this.buildRecord(level, message, error, meta);
    const json = JSON.stringify(record);
    const line = `${json}\n`;
    if (level === 'error') {
      process.stderr.write(line);
      StructuredLogger.dispatchErrorCapture({ ...(record as CapturedErrorLogRecord), captureKind: 'logger' });
    } else {
      process.stdout.write(line);
    }
  }

  private static dispatchErrorCapture(record: CapturedErrorLogRecord): void {
    const sink = StructuredLogger.errorCaptureSink;
    if (!sink) {
      return;
    }

    try {
      void Promise.resolve(sink(record)).catch(() => undefined);
    } catch {
      // Keep logging side-effect free even if persistence fails.
    }
  }

  private buildRecord(
    level: LogLevel,
    message: string,
    error: Error | undefined,
    meta: JsonObject | undefined,
  ): StructuredLogRecord {
    const base: StructuredLogRecord = {
      ts: new Date().toISOString(),
      level,
      msg: message,
    };

    if (this.contextName && this.contextName.length > 0) {
      base.logger = this.contextName;
    }

    // Auto-include correlationId from ambient request context
    if (StructuredLogger.correlationIdAccessor) {
      try {
        const corrId = StructuredLogger.correlationIdAccessor();
        if (corrId) {
          base.correlationId = corrId;
        }
      } catch {
        // Outside request context — no correlationId
      }
    }

    const metaSafe = meta ? this.redactAndClone(meta, []) : undefined;

    let errorValue: Error | undefined = error;
    const metaWithoutError: JsonObject = {};

    if (metaSafe && typeof metaSafe === 'object' && !Array.isArray(metaSafe)) {
      const entries = Object.entries(metaSafe);
      for (const [key, value] of entries) {
        if (!errorValue && key === 'error' && value instanceof Error) {
          errorValue = value;
        } else if (!errorValue && key === 'error') {
          const maybe = this.tryBuildErrorFromLikeObject(value);
          if (maybe) {
            errorValue = maybe;
          } else {
            metaWithoutError[key] = value;
          }
        } else {
          metaWithoutError[key] = value;
        }
      }
    }

    if (errorValue) {
      base.error = {
        name: errorValue.name,
        message: errorValue.message,
        stack: errorValue.stack,
      };
    }

    const reserved: { [key: string]: boolean } = {
      ts: true,
      level: true,
      msg: true,
      logger: true,
      error: true,
    };

    const metaEntries = Object.entries(metaWithoutError);
    for (const [key, value] of metaEntries) {
      if (!reserved[key]) {
        base[key] = value;
      }
    }

    return base;
  }

  private tryBuildErrorFromLikeObject(value: unknown): Error | undefined {
    if (!this.isJsonObject(value)) {
      return undefined;
    }

    const messageValue = value.message;
    const message = typeof messageValue === 'string' ? messageValue : undefined;
    if (!message) {
      return undefined;
    }

    const error = new Error(message);
    const nameValue = value.name;
    if (typeof nameValue === 'string' && nameValue.length > 0) {
      error.name = nameValue;
    }

    const stackValue = value.stack;
    if (typeof stackValue === 'string' && stackValue.length > 0) {
      error.stack = stackValue;
    }
    return error;
  }

  private serializeError(error: Error): SerializedError {
    const serialized: SerializedError = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    const ownKeys = Object.getOwnPropertyNames(error);
    for (const key of ownKeys) {
      if (key === 'name' || key === 'message' || key === 'stack') {
        continue;
      }
      try {
        serialized[key] = (error as unknown as JsonObject)[key];
      } catch {
        // Avoid breaking logging if error has throwing getters.
      }
    }

    return serialized;
  }

  private redactAndClone(
    value: unknown,
    path: string[],
    seen?: WeakSet<object>,
  ): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    const valueType = typeof value;

    if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
      if (this.isSensitiveKey(path)) {
        return '[redacted]';
      }
      return value;
    }

    if (Array.isArray(value)) {
      const currentSeen = seen ?? new WeakSet<object>();
      if (currentSeen.has(value)) {
        return '[circular]';
      }
      currentSeen.add(value);

      const nextPath = path;
      return value.map((item, index) =>
        this.redactAndClone(item, nextPath.concat(String(index)), currentSeen),
      );
    }

    if (valueType === 'object') {
      if (value instanceof Error) {
        const currentSeen = seen ?? new WeakSet<object>();
        if (currentSeen.has(value)) {
          return '[circular]';
        }
        currentSeen.add(value);

        const serialized = this.serializeError(value);
        return this.redactAndClone(serialized, path, currentSeen);
      }

      if (!this.isJsonObject(value)) {
        return String(value);
      }
      const currentSeen = seen ?? new WeakSet<object>();
      if (currentSeen.has(value)) {
        return '[circular]';
      }
      currentSeen.add(value);

      const result: JsonObject = {};
      const entries = Object.entries(value);
      for (const [key, nested] of entries) {
        const nextPath = path.concat(key);
        result[key] = this.redactAndClone(nested, nextPath, currentSeen);
      }
      return result;
    }

    if (this.isSensitiveKey(path)) {
      return '[redacted]';
    }

    return String(value);
  }

  private isSensitiveKey(path: string[]): boolean {
    if (path.length === 0) {
      return false;
    }
    const key = path[path.length - 1].toLowerCase();

    if (key.includes('password')) {
      return true;
    }
    if (key.includes('secret')) {
      return true;
    }
    if (key.endsWith('token') || key.includes('token_') || key.includes('token-')) {
      return true;
    }
    if (key.includes('apikey') || key.includes('api_key') || key.includes('api-key')) {
      return true;
    }
    if (key === 'authorization' || key === 'cookie' || key === 'set-cookie') {
      return true;
    }
    if (key === 'x-api-key' || key === 'x_api_key') {
      return true;
    }
    return false;
  }

  private isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null;
  }
}
