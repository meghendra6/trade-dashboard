import { Redis } from '@upstash/redis';

interface RateLimitOptions {
  windowMs: number;
  maxPerClient: number;
  maxGlobal: number;
  maxTrackedKeys?: number;
}

interface RateLimitDecision {
  limited: boolean;
  retryAfterSeconds: number;
  reason: 'client' | 'global';
}

interface SlidingWindowState {
  timestamps: number[];
}

const DEFAULT_MAX_TRACKED_KEYS = 5000;
const TRUSTED_IP_HEADER_CANDIDATES = [
  'x-vercel-forwarded-for',
  'cf-connecting-ip',
  'x-forwarded-for',
] as const;
const SAFE_IP_PATTERN = /^[A-Fa-f0-9:.]{3,64}$/;

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

class SlidingWindowRateLimiter {
  private readonly states = new Map<string, SlidingWindowState>();
  private readonly maxTrackedKeys: number;

  constructor(maxTrackedKeys: number) {
    this.maxTrackedKeys = maxTrackedKeys;
  }

  private evictOldestIfNeeded(): void {
    while (this.states.size > this.maxTrackedKeys) {
      const oldestKey = this.states.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.states.delete(oldestKey);
    }
  }

  private getState(key: string): SlidingWindowState {
    const existing = this.states.get(key);
    if (existing) {
      this.states.delete(key);
      this.states.set(key, existing);
      return existing;
    }

    const created: SlidingWindowState = { timestamps: [] };
    this.states.set(key, created);
    this.evictOldestIfNeeded();
    return created;
  }

  check(key: string, limit: number, windowMs: number, nowMs: number): { allowed: boolean; retryAfterMs: number } {
    const state = this.getState(key);
    const threshold = nowMs - windowMs;

    while (state.timestamps.length > 0 && state.timestamps[0] <= threshold) {
      state.timestamps.shift();
    }

    if (state.timestamps.length >= limit) {
      const oldest = state.timestamps[0] ?? nowMs;
      const retryAfterMs = Math.max(0, oldest + windowMs - nowMs);
      return { allowed: false, retryAfterMs };
    }

    state.timestamps.push(nowMs);
    return { allowed: true, retryAfterMs: 0 };
  }
}

const limiterRegistry = new Map<number, SlidingWindowRateLimiter>();

function getLimiter(maxTrackedKeys: number): SlidingWindowRateLimiter {
  const existing = limiterRegistry.get(maxTrackedKeys);
  if (existing) return existing;

  const created = new SlidingWindowRateLimiter(maxTrackedKeys);
  limiterRegistry.set(maxTrackedKeys, created);
  return created;
}

function normalizeIp(rawValue: string | null | undefined): string | null {
  if (!rawValue) return null;
  const first = rawValue.split(',')[0]?.trim();
  if (!first) return null;
  const normalized = first.slice(0, 64);
  return SAFE_IP_PATTERN.test(normalized) ? normalized : null;
}

function getTrustedClientIp(request: Request): string {
  for (const header of TRUSTED_IP_HEADER_CANDIDATES) {
    const raw = request.headers.get(header);
    if (!raw) continue;
    const normalized = normalizeIp(raw);
    if (normalized) return normalized;
  }

  return 'unknown';
}

function toSeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

async function checkBucketWithRedis(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  if (!redis) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }

  if (count > limit) {
    const ttl = await redis.ttl(key);
    return {
      allowed: false,
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

export async function checkRateLimit(
  scope: string,
  request: Request,
  options: RateLimitOptions
): Promise<RateLimitDecision> {
  const windowSeconds = toSeconds(options.windowMs);
  const clientIp = getTrustedClientIp(request);

  if (redis) {
    try {
      const clientResult = await checkBucketWithRedis(
        `ratelimit:${scope}:client:${clientIp}`,
        options.maxPerClient,
        windowSeconds
      );
      if (!clientResult.allowed) {
        return {
          limited: true,
          retryAfterSeconds: clientResult.retryAfterSeconds,
          reason: 'client',
        };
      }

      const globalResult = await checkBucketWithRedis(
        `ratelimit:${scope}:global`,
        options.maxGlobal,
        windowSeconds
      );
      if (!globalResult.allowed) {
        return {
          limited: true,
          retryAfterSeconds: globalResult.retryAfterSeconds,
          reason: 'global',
        };
      }

      return {
        limited: false,
        retryAfterSeconds: 0,
        reason: 'client',
      };
    } catch (error) {
      console.error('[rate-limit] Redis limiter failed, falling back to in-memory limiter:', error);
    }
  }

  const maxTrackedKeys = options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  const limiter = getLimiter(maxTrackedKeys);
  const nowMs = Date.now();

  const clientKey = `${scope}:client:${clientIp}`;
  const clientResult = limiter.check(clientKey, options.maxPerClient, options.windowMs, nowMs);
  if (!clientResult.allowed) {
    return {
      limited: true,
      retryAfterSeconds: toSeconds(clientResult.retryAfterMs),
      reason: 'client',
    };
  }

  const globalResult = limiter.check(
    `${scope}:global`,
    options.maxGlobal,
    options.windowMs,
    nowMs
  );
  if (!globalResult.allowed) {
    return {
      limited: true,
      retryAfterSeconds: toSeconds(globalResult.retryAfterMs),
      reason: 'global',
    };
  }

  return {
    limited: false,
    retryAfterSeconds: 0,
    reason: 'client',
  };
}
