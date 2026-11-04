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
 * A method is repeated only when its owner marks it idempotent. An aspect cannot
 * know whether a write (a payment, a tool body, a message) already reached the
 * other side before the error, and a repeat would perform it twice. A name does not
 * tell either: the audit found 32 methods named like reads that write (V-03).
 *
 * Two ways to mark, both checked here:
 * - the class lists the method: `static readonly idempotentMethods = ['listTags']`;
 * - the registration says so: `aspectOptions.methodMetadata.<method>.metadata.idempotent = true`
 *   for one method, or `aspectOptions.metadata.idempotent = true` for a service that only reads.
 */
export function isMarkedIdempotent(context: AroundAdviceContext): boolean {
  if (context.joinPoint?.metadata?.idempotent === true) return true;
  const owner = (context.target as { constructor?: { idempotentMethods?: unknown } } | undefined)?.constructor;
  const marked = owner?.idempotentMethods;
  return Array.isArray(marked) && marked.includes(context.methodName);
}

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

/** Default rule: a transient failure of a method marked idempotent. Nothing else is repeated. */
export function defaultRetryable(error: unknown, context: AroundAdviceContext): boolean {
  return isMarkedIdempotent(context) && isTransientError(error);
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