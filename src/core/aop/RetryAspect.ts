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

export class RetryAspect implements Aspect {
  private readonly options: Required<RetryAspectOptions>;

  constructor(options: RetryAspectOptions = {}) {
    this.options = {
      attempts: Math.max(1, options.attempts ?? 3),
      delayMs: Math.max(0, options.delayMs ?? 100),
      multiplier: Math.max(1, options.multiplier ?? 2),
      maxDelayMs: Math.max(0, options.maxDelayMs ?? 30_000),
      jitter: Math.max(0, options.jitter ?? 0.1),
      retryable:
        options.retryable ??
        ((error: unknown) => {
          if (!error) return false;
          if (error instanceof Error) {
            return true;
          }
          return typeof error === 'object';
        }),
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