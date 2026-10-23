/**
 * Concurrency Limiter Utility
 * 
 * Provides bounded concurrent execution to prevent memory exhaustion
 * from unbounded Promise.all() with large arrays (P0-007 fix).
 * 
 * @example
 * ```typescript
 * import { withConcurrencyLimit, DEFAULT_CONCURRENCY } from './concurrency-limiter';
 * 
 * // Limit concurrent handlers to 10
 * await withConcurrencyLimit(handlers, 10, (handler) => handler(event));
 * ```
 */

/** Default concurrency limit for event handlers */
export const DEFAULT_CONCURRENCY = 10;

/** Maximum concurrency limit to prevent excessive resource usage */
export const MAX_CONCURRENCY = 100;

/** Minimum concurrency limit */
export const MIN_CONCURRENCY = 1;

/**
 * Validates and normalizes concurrency limit within bounds
 */
export function normalizeConcurrencyLimit(limit: number): number {
  return Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, limit));
}

/**
 * Execute array of items with bounded concurrency
 * 
 * @param items - Array of items to process
 * @param concurrency - Maximum concurrent operations (default: 10)
 * @param fn - Function to execute for each item
 * @returns Promise resolving to array of results
 */
export async function withConcurrencyLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const limit = normalizeConcurrencyLimit(concurrency);
  
  if (items.length === 0) {
    return [];
  }
  
  // If concurrency >= items, just use Promise.all
  if (limit >= items.length) {
    return Promise.all(items.map((item) => fn(item)));
  }
  
  // Process in batches to limit concurrency
  const results: R[] = new Array(items.length);
  let index = 0;
  
  // Process initial batch
  const initialBatchSize = Math.min(limit, items.length);
  const initialPromises: Promise<void>[] = [];
  
  for (let i = 0; i < initialBatchSize; i++) {
    const currentIndex = index++;
    initialPromises.push(
      fn(items[currentIndex]).then((result) => {
        results[currentIndex] = result;
      })
    );
  }
  
  // Wait for each completion and start next item
  await Promise.all(
    initialPromises.map((promise) =>
      promise.then(async () => {
        while (index < items.length) {
          const currentIndex = index++;
          const result = await fn(items[currentIndex]);
          results[currentIndex] = result;
        }
      })
    )
  );
  
  return results;
}

/**
 * Create a reusable concurrency limiter with fixed limit
 * 
 * @param concurrency - Maximum concurrent operations
 * @returns Object with execute method
 */
export function createConcurrencyLimiter(concurrency: number = DEFAULT_CONCURRENCY) {
  const limit = normalizeConcurrencyLimit(concurrency);
  let running = 0;
  const queue: Array<{
    fn: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];
  
  async function processNext(): Promise<void> {
    if (queue.length === 0 || running >= limit) {
      return;
    }
    
    const next = queue.shift()!;
    
    running++;
    try {
      const result = await next.fn();
      next.resolve(result);
    } catch (error) {
      next.reject(error);
    } finally {
      running--;
      // Process next item from queue
      void processNext();
    }
  }
  
  return {
    /**
     * Execute function with concurrency limit
     */
    execute<R>(fn: () => Promise<R>): Promise<R> {
      return new Promise((resolve, reject) => {
        queue.push({
          fn: fn,
          resolve: resolve as (value: unknown) => void,
          reject: reject as (error: unknown) => void,
        });
        void processNext();
      });
    },
    
    /**
     * Execute array of functions with concurrency limit
     */
    executeAll<R>(fns: Array<() => Promise<R>>): Promise<R[]> {
      return withConcurrencyLimit(fns, limit, (fn) => fn());
    },
    
    /**
     * Get current active count
     */
    get activeCount(): number {
      return running;
    },
    
    /**
     * Get pending count
     */
    get pendingCount(): number {
      return queue.length;
    },
    
    /**
     * Clear pending tasks
     */
    clearQueue: (): void => {
      // Reject all pending tasks
      while (queue.length > 0) {
        const item = queue.shift()!;
        item.reject(new Error('Queue cleared'));
      }
    },
  };
}

/**
 * Process event handlers with bounded concurrency
 * Specialized helper for event bus patterns
 * 
 * @param handlers - Array of handler functions
 * @param event - Event to pass to handlers
 * @param concurrency - Maximum concurrent handlers (default: 10)
 * @returns Promise resolving when all handlers complete
 */
export async function processEventHandlers<TEvent>(
  handlers: Array<(event: TEvent) => Promise<void> | void>,
  event: TEvent,
  concurrency: number = DEFAULT_CONCURRENCY
): Promise<void> {
  const limit = normalizeConcurrencyLimit(concurrency);
  
  if (handlers.length === 0) {
    return;
  }
  
  // If concurrency >= handlers, just use Promise.all
  if (limit >= handlers.length) {
    await Promise.all(handlers.map(async (handler) => handler(event)));
    return;
  }
  
  // Process with limited concurrency
  let index = 0;
  const errors: Error[] = [];
  
  async function runNext(): Promise<void> {
    while (index < handlers.length) {
      const currentIndex = index++;
      try {
        await handlers[currentIndex](event);
      } catch (error) {
        errors.push(error as Error);
      }
    }
  }
  
  // Start initial batch of workers
  const workers = Array(Math.min(limit, handlers.length))
    .fill(null)
    .map(() => runNext());
  
  await Promise.all(workers);
  
  // Throw first error if any occurred
  if (errors.length > 0) {
    throw errors[0];
  }
}
