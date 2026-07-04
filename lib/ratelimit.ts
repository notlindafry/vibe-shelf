/**
 * Per-IP rate limiting (rule 3).
 *
 * TRADEOFF CALLOUT (rule 9): this limiter is in-memory and best-effort per
 * serverless instance. Limits reset on cold starts and are NOT shared across
 * concurrent instances, so this satisfies "rate limiting" but not "strict global
 * limits." For robust global limits, back this with Upstash Redis
 * (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
 *
 * SECURITY TODO: Upstash-backed global rate limiting is not wired. The env var
 * contract is documented in .env.example; wiring it would replace the in-memory
 * Map below with a Redis fixed-window counter using the same check() signature.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

// One map per limiter key namespace. Keys are `${namespace}:${ip}`.
const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (for Retry-After). */
  retryAfterSeconds: number;
  remaining: number;
}

export interface RateLimitOptions {
  /** Distinct namespace so login and search limits don't share a counter. */
  namespace: string;
  /** Max requests allowed within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Fixed-window counter. Returns whether this request is allowed and how long to
 * wait if not.
 */
export function checkRateLimit(ip: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const key = `${options.namespace}:${ip}`;
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return { allowed: true, retryAfterSeconds: 0, remaining: options.limit - 1 };
  }

  if (existing.count >= options.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      remaining: 0,
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: options.limit - existing.count,
  };
}

/**
 * Best-effort eviction of expired buckets so the map doesn't grow unbounded on a
 * long-lived instance. Cheap; called opportunistically from limiter callers.
 */
export function sweepExpired(): void {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Derive a client IP from request headers. On Vercel, x-forwarded-for is set by
 * the platform; the left-most entry is the client. Falls back to a constant so
 * the limiter still functions (globally) when no IP is available.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}
