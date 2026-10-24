import type { ILogger } from '../decorators/ILogger';
import type { Aspect, AdviceContext, AroundAdviceContext } from './Aspect';

export interface LoggingAspectOptions {
  includeArgs?: boolean;
  includeResult?: boolean;
  includeMetadata?: boolean;
  includeDuration?: boolean;
  level?: 'log' | 'info' | 'debug';
  errorLevel?: 'error' | 'warn';
  slowCallThresholdMs?: number;
}

const SENSITIVE_KEY_PATTERN = /^(authorization|x-api-key|api[_-]?key|token|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|secret|client[_-]?secret|private[_-]?key|cookie|set-cookie)$/i;
const SENSITIVE_METHOD_PATTERN = /authenticate|login|verifyToken|validateKey|issueKey|rotateKey|^sign(?:[A-Z]|$)|Sign/;
const TOKEN_LIKE_VALUE_PATTERN = /^(Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|[A-Fa-f0-9]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key.trim());
}

function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return TOKEN_LIKE_VALUE_PATTERN.test(value.trim()) ? '[REDACTED]' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (depth > 6 || typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? '[REDACTED]' : redactValue(entry, depth + 1, seen);
  }
  return out;
}

function isClientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { status?: unknown; statusCode?: unknown };
  const status = typeof record.status === 'number' ? record.status : record.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
}

export class LoggingAspect implements Aspect {
  private readonly logger: ILogger;
  private readonly options: Required<LoggingAspectOptions>;

  constructor(logger: ILogger, options: LoggingAspectOptions = {}) {
    this.logger = logger;
    this.options = {
      includeArgs: options.includeArgs ?? true,
      includeResult: options.includeResult ?? false,
      includeMetadata: options.includeMetadata ?? false,
      includeDuration: options.includeDuration ?? true,
      // Every matched method call writes start and success. At info level that was
      // several kilobytes of log per request; it is a debugging aid.
      level: options.level ?? 'debug',
      errorLevel: options.errorLevel ?? 'error',
      slowCallThresholdMs: options.slowCallThresholdMs ?? 500,
    };
  }

  async around(context: AroundAdviceContext): Promise<unknown> {
    const start = Date.now();
    const basePayload = this.buildBasePayload(context, undefined);

    this.write(this.options.level, `[AOP][${context.joinPoint.className}.${context.methodName}] start`, {
      ...basePayload,
      args: this.options.includeArgs ? this.prepareArgs(context.args, context.methodName) : undefined,
    });

    try {
      const result = await context.proceed();
      const duration = Date.now() - start;

      const payload = this.buildBasePayload(context, duration);
      if (this.options.includeResult) {
        payload.result = this.safeSerialize(result);
      }
      if (this.options.includeDuration) {
        payload.durationMs = duration;
        payload.slowCall =
          this.options.slowCallThresholdMs > 0 &&
          duration >= this.options.slowCallThresholdMs;
      }

      this.write(
        this.options.level,
        `[AOP][${context.joinPoint.className}.${context.methodName}] success`,
        payload,
      );

      return result;
    } catch (error) {
      const duration = Date.now() - start;
      const payload = this.buildBasePayload(context, duration);
      payload.error = this.formatError(error);
      payload.durationMs = duration;

      // A 4xx (a missing key, a validation error) is the caller's mistake, not a
      // fault: at error level it fed the runtime error-lesson capture on every 401.
      this.write(
        isClientError(error) ? 'warn' : this.options.errorLevel,
        `[AOP][${context.joinPoint.className}.${context.methodName}] failed`,
        payload,
      );
      throw error;
    }
  }

  private buildBasePayload(context: AdviceContext, duration?: number) {
    const payload: Record<string, unknown> = {
      className: context.joinPoint.className,
      methodName: context.methodName,
    };

    if (this.options.includeDuration && typeof duration === 'number') {
      payload.durationMs = duration;
    }

    if (this.options.includeMetadata && context.metadata) {
      const metadataWithNested = context.metadata as { metadata?: Record<string, unknown> };
      const nestedMetadata = metadataWithNested?.metadata;
      if (nestedMetadata) {
        payload.metadata = nestedMetadata;
      }
    }

    return payload;
  }

  private prepareArgs(args: unknown[], methodName?: string): unknown {
    const methodIsSensitive = Boolean(methodName && SENSITIVE_METHOD_PATTERN.test(methodName));
    return args.map((arg) => {
      if (methodIsSensitive && typeof arg === 'string' && arg.trim().length > 0) {
        return '[REDACTED]';
      }
      return this.safeSerialize(arg);
    });
  }

  private safeSerialize(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === 'string') {
      return TOKEN_LIKE_VALUE_PATTERN.test(value.trim()) ? '[REDACTED]' : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'function') {
      return value.name ? `[Function ${value.name}]` : '[Function]';
    }
    if (value instanceof Error) {
      return this.formatError(value);
    }
    if (typeof value === 'object') {
      try {
        const json = JSON.stringify(value);
        return redactValue(JSON.parse(json));
      } catch {
        return '[Circular]';
      }
    }
    return String(value);
  }

  private formatError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        // A client error has no fault to locate; its stack is noise in every 4xx line.
        ...(isClientError(error) ? {} : { stack: error.stack }),
      };
    }
    return {
      message: String(error),
    };
  }

  private write(level: string, message: string, meta?: Record<string, unknown>) {
    const loggerWithMethods = this.logger as {
      log?: (message: string, meta?: Record<string, unknown>) => void;
      info?: (message: string, meta?: Record<string, unknown>) => void;
      debug?: (message: string, meta?: Record<string, unknown>) => void;
      error?: (message: string, meta?: Record<string, unknown>) => void;
      warn?: (message: string, meta?: Record<string, unknown>) => void;
    };
    
    const loggerMethod = loggerWithMethods[level as keyof typeof loggerWithMethods];
    if (typeof loggerMethod === 'function') {
      loggerMethod.call(this.logger, message, meta);
      return;
    }

    this.logger.log?.(message, meta);
  }
}