// In-memory sliding window rate limiter — copied from functions/src/rateLimiter.ts

const windowMap = new Map<string, number[]>();

setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, times] of windowMap.entries()) {
    const pruned = times.filter(t => t > cutoff);
    if (pruned.length === 0) windowMap.delete(key);
    else windowMap.set(key, pruned);
  }
}, 5 * 60 * 1000);

export class RateLimitError extends Error {
  status = 429;
  constructor(message = 'Rate limit exceeded. Please slow down.') {
    super(message);
    this.name = 'RateLimitError';
  }
}

export function checkRateLimit(key: string, maxPerMinute: number): void {
  const now = Date.now();
  const windowStart = now - 60_000;
  const existing = windowMap.get(key) ?? [];
  const recent = existing.filter(t => t > windowStart);
  if (recent.length >= maxPerMinute) {
    throw new RateLimitError();
  }
  recent.push(now);
  windowMap.set(key, recent);
}
