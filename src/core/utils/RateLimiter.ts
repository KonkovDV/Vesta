/**
 * RateLimiter - простой token-bucket rate limiter.
 * Layer: Core
 *
 * Потокобезопасность:
 * - Рассчитан на использование в single-threaded event loop Node.js.
 * - Для параллельных вызовов acquire() в одном процессе гарантирует
 *   консистентное состояние при условии последовательного исполнения JS.
 */
export interface IRateLimiter {
  acquire(cost?: number): Promise<void>;
}

export class RateLimiter implements IRateLimiter {
  private tokens: number;
  private lastRefillTimestamp: number;
  private readonly maxTokens: number;
  private readonly refillRatePerSecond: number;

  constructor(maxTokens: number, refillRatePerSecond: number) {
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      throw new Error('maxTokens must be a positive finite number');
    }
    if (!Number.isFinite(refillRatePerSecond) || refillRatePerSecond <= 0) {
      throw new Error('refillRatePerSecond must be a positive finite number');
    }

    this.maxTokens = maxTokens;
    this.refillRatePerSecond = refillRatePerSecond;
    this.tokens = maxTokens;
    this.lastRefillTimestamp = Date.now();
  }

  async acquire(cost: number = 1): Promise<void> {
    if (!Number.isFinite(cost) || cost <= 0) {
      return;
    }

    await this.refill();

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return;
    }

    const tokensNeeded = cost - this.tokens;
    const waitTimeMs = (tokensNeeded / this.refillRatePerSecond) * 1000;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, waitTimeMs);
    });

    await this.refill();

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return;
    }

    this.tokens = 0;
  }

  private async refill(): Promise<void> {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillTimestamp;
    if (elapsedMs <= 0) {
      return;
    }

    const elapsedSeconds = elapsedMs / 1000;
    const tokensToAdd = elapsedSeconds * this.refillRatePerSecond;

    const newTokenCount = this.tokens + tokensToAdd;
    this.tokens = newTokenCount > this.maxTokens ? this.maxTokens : newTokenCount;
    this.lastRefillTimestamp = now;
  }
}