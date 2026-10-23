import { monitorEventLoopDelay } from 'node:perf_hooks';
import type * as core from 'express-serve-static-core';

/**
 * Event loop lag guard — returns 503 Service Unavailable when the
 * Node.js event loop is overloaded.
 *
 * Uses the built-in `perf_hooks.monitorEventLoopDelay()` API instead of
 * native C++ addon (toobusy-js) to avoid node-gyp build dependency.
 *
 * Default threshold: 70ms (p99 percentile).
 */

const DEFAULT_THRESHOLD_MS = 70;
const MONITOR_RESOLUTION_MS = 20;

let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;

function getHistogram(): ReturnType<typeof monitorEventLoopDelay> {
  if (!histogram) {
    histogram = monitorEventLoopDelay({ resolution: MONITOR_RESOLUTION_MS });
    histogram.enable();
  }
  return histogram;
}

export function createEventLoopGuard(
  thresholdMs: number = DEFAULT_THRESHOLD_MS,
): (req: core.Request, res: core.Response, next: core.NextFunction) => void {
  const h = getHistogram();

  return (_req: core.Request, res: core.Response, next: core.NextFunction): void => {
    // p99 in nanoseconds → milliseconds
    const lagMs = h.percentile(99) / 1e6;

    if (lagMs > thresholdMs) {
      res.status(503).json({
        status: 503,
        error: 'Service Unavailable',
        message: 'Server is too busy, please retry later',
        retryAfterSeconds: 5,
      });
      return;
    }

    next();
  };
}

/** Expose current lag for health checks / metrics. */
export function getEventLoopLagMs(): number {
  const h = getHistogram();
  return h.percentile(99) / 1e6;
}
