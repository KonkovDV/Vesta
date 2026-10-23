
import type { Request, Response, NextFunction } from 'express-serve-static-core';
// import Redis from 'ioredis'; // Use if real Redis is available. For now using Memory Fallback to ensure reliability if user has no Redis.

// Implementation of "Penalty Box" Rate Limiter
// Since we might not have a running Redis instance for this specific detailed task, 
// I will implement an in-memory version that adheres to the "Immune System" interface,
// but follows the exact logic: standard bucket, burst allowance, and penalty box.

interface ClientState {
  tokens: number;
  lastRefill: number;
  violations: number;
  bannedUntil: number;
}

const LIMIT = 100; // Requests per window
const WINDOW_MS = 60 * 1000; // 1 minute
const BURST = 20; // Allow slight burst
const REFILL_RATE = LIMIT / WINDOW_MS; // tokens per ms

const state = new Map<string, ClientState>();

// Clean up old entries periodically
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, store] of state.entries()) {
    if (now - store.lastRefill > WINDOW_MS * 5) { // Inactive for 5 mins
      state.delete(ip);
    }
  }
}, WINDOW_MS * 5);

cleanupTimer.unref();


export function rateLimiterMiddleware(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  
  if (!state.has(ip)) {
    state.set(ip, { tokens: LIMIT, lastRefill: now, violations: 0, bannedUntil: 0 });
  }

  const client = state.get(ip)!;

  // 1. Check Penalty Box
  if (now < client.bannedUntil) {
    const retryAfter = Math.ceil((client.bannedUntil - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    res.status(403).json({ error: 'IP Banned: Too many violations. Cool down.', retryAfter });
    return;
  }

  // 2. Refill Tokens (Token Bucket Algorithm)
  const elapsed = now - client.lastRefill;
  const newTokens = elapsed * REFILL_RATE;
  if (newTokens > 0) {
    client.tokens = Math.min(LIMIT + BURST, client.tokens + newTokens);
    client.lastRefill = now;
  }

  // 3. Consume Token
  if (client.tokens >= 1) {
    client.tokens -= 1;
    next();
  } else {
    // 4. Violation
    client.violations++;
    if (client.violations > 5) { // 5 violations = Penalty Box
      client.bannedUntil = now + (10 * 60 * 1000); // 10 min ban
      client.violations = 0; // Reset violations for next time, but they are banned now
      res.status(403).json({ error: 'Access Denied: Penalty Box Activated' });
    } else {
      res.status(429).json({ error: 'Too Many Requests' });
    }
  }
}
