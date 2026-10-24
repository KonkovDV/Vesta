import type { Aspect, AroundAdviceContext } from './Aspect';

export interface RetryAspectOptions {
  attempts?: number;
  delayMs?: number;
  multiplier?: number;
  maxDelayMs?: number;
  jitter?: number;
  retryable?: (error: unknown, context: AroundAdviceContext, attempt: number) => boolean | Promise<boolean>;
  onRetry?: (error: unknown, context: AroundAdviceContext, attempt: number, delayMs: number) => void | Promise<void>;
}

/** Network and PostgreSQL failures where the request may not have reached its target, or can be repeated. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  '40001', '40P01', '57P01', '08000', '08001', '08006', '53300',
]);
const TRANSIENT_STATUS = new Set([408, 425, 429, 502, 503, 504]);

/**
 * Method names that read. Only these are repeated by default: an aspect cannot
 * know whether a write (a payment, a tool body, a message) already reached the
 * other side before the error, and a repeat would perform it twice.
 * check/load/fetch/is are left out on purpose: RateLimitService.checkLimit
 * consumes a token, and several load and fetch methods write a cache row. A name is
 * a hint, not a guarantee; a method that must be repeated should say so
 * (retryable: true on the error, or a custom `retryable` rule).
 */
const READ_ONLY_METHOD = /^(get|find|list|read|search|query|count|exists|has|lookup|describe|stat|ping|health)(?![a-z])/;

export function isTransientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { retryable?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
  if (record.retryable === true) return true;
  if (record.retryable === false) return false;
  if (typeof record.code === 'string' && TRANSIENT_CODES.has(record.code)) return true;
  const status = typeof record.status === 'number' ? record.status : record.statusCode;
  if (typeof status === 'number' && TRANSIENT_STATUS.has(status)) return true;
  return record.cause !== undefined && record.cause !== error ? isTransientError(record.cause) : false;
}

/** Default rule: a transient failure of a read-only method. */
export function defaultRetryable(error: unknown, context: AroundAdviceContext): boolean {
  return READ_ONLY_METHOD.test(context.methodName) && isTransientError(error);
}

export class RetryAspect implements Aspect {
  private readonly options: Required<RetryAspectOptions>;

  constructor(options: RetryAspectOptions = {}) {
    this.options = {
      attempts: Math.max(1, options.attempts ?? 3),
      delayMs: Math.max(0, options.delayMs ?? 100),
      multiplier: Math.max(1, options.multiplier ?? 2),
      maxDelayMs: Math.max(0, options.maxDelayMs ?? 30_000),
      jitter: Math.max(0, options.jitter ?? 0.1),
      retryable: options.retryable ?? defaultRetryable,
      onRetry: options.onRetry ?? (() => undefined),
    };
  }

  async around(context: AroundAdviceContext): Promise<unknown> {
    let attempt = 0;
    let delay = this.options.delayMs;

    while (attempt < this.options.attempts) {
      try {
        return await context.proceed();
      } catch (error) {
        attempt += 1;
        const shouldRetry =
          attempt < this.options.attempts &&
          (await this.options.retryable(error, context, attempt));

        if (!shouldRetry) {
          throw error;
        }

        const scheduleDelay = this.withJitter(delay);
        await Promise.resolve(this.options.onRetry(error, context, attempt, scheduleDelay));
        await this.sleep(scheduleDelay);

        delay = Math.min(delay * this.options.multiplier, this.options.maxDelayMs);
        context.setAttribute('retry:lastError', error);
        context.setAttribute('retry:attempt', attempt);
      }
    }

    /* istanbul ignore next -- unreachable: attempts >= 1 guaranteed by constructor */
    throw new Error('Retry loop exited unexpectedly');
  }

  private withJitter(baseDelay: number): number {
    if (this.options.jitter <= 0) {
      return baseDelay;
    }
    const delta = baseDelay * this.options.jitter;
    const min = baseDelay - delta;
    const max = baseDelay + delta;
    return Math.max(0, min + Math.random() * (max - min));
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}