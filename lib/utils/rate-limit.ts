import { Redis } from '@upstash/redis';
import { createHash } from 'node:crypto';

interface RateLimitOptions {
  windowMs: number;
  maxPerClient: number;
  maxGlobal: number;
  maxTrackedKeys?: number;
}

interface RateLimitDecision {
  limited: boolean;
  retryAfterSeconds: number;
  reason: 'client' | 'global' | 'misconfigured';
}

interface SlidingWindowState {
  timestamps: number[];
}

const DEFAULT_MAX_TRACKED_KEYS = 5000;
const BASE_TRUSTED_IP_HEADERS = [
  'x-vercel-forwarded-for',
  'cf-connecting-ip',
  'x-forwarded-for',
] as const;
const SAFE_IP_PATTERN = /^[A-Fa-f0-9:.]{3,64}$/;
const SAFE_HEADER_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
const TRUST_PROXY_HEADERS = process.env.RATE_LIMIT_TRUST_PROXY_HEADERS === '1';
const STRICT_PROXY_MODE = process.env.RATE_LIMIT_STRICT_PROXY_MODE === '1';
const X_FORWARDED_FOR_HOP = (process.env.RATE_LIMIT_XFF_HOP || 'first').toLowerCase();
const TRUSTED_PROXY_SIGNATURE = process.env.RATE_LIMIT_PROXY_SIGNATURE || '';
const TRUSTED_PROXY_SIGNATURE_HEADER = (process.env.RATE_LIMIT_PROXY_SIGNATURE_HEADER || 'x-ingress-signature')
  .trim()
  .toLowerCase();

const TRUSTED_IP_HEADER_CANDIDATES = [
  ...BASE_TRUSTED_IP_HEADERS,
  ...((process.env.RATE_LIMIT_EXTRA_TRUSTED_IP_HEADERS || '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter((header) => SAFE_HEADER_NAME_PATTERN.test(header))),
];

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
  if (!TRUST_PROXY_HEADERS) {
    return '';
  }
  if (TRUSTED_PROXY_SIGNATURE) {
    const providedSignature = request.headers.get(TRUSTED_PROXY_SIGNATURE_HEADER) || '';
    if (providedSignature !== TRUSTED_PROXY_SIGNATURE) {
      return '';
    }
  }

  for (const header of TRUSTED_IP_HEADER_CANDIDATES) {
    const raw = request.headers.get(header);
    if (!raw) continue;
    const candidate = header === 'x-forwarded-for'
      ? (() => {
          const hops = raw.split(',').map((hop) => hop.trim()).filter(Boolean);
          if (hops.length === 0) return raw;
          if (X_FORWARDED_FOR_HOP === 'last') return hops[hops.length - 1];
          return hops[0];
        })()
      : raw;
    const normalized = normalizeIp(candidate);
    if (normalized) return normalized;
  }

  return '';
}

function toSeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

function getLowTrustClientFingerprint(request: Request): string {
  const userAgent = (request.headers.get('user-agent') || '').slice(0, 256);
  const acceptLanguage = (request.headers.get('accept-language') || '').slice(0, 128);
  const accept = (request.headers.get('accept') || '').slice(0, 128);
  const source = `${userAgent}|${acceptLanguage}|${accept}`;

  if (!source.replace(/\|/g, '').trim()) {
    return 'anonymous-low-trust';
  }

  const digest = createHash('sha256').update(source).digest('hex');
  return `fp:${digest.slice(0, 24)}`;
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

  if (STRICT_PROXY_MODE && !TRUST_PROXY_HEADERS) {
    console.error('[rate-limit] STRICT mode requires RATE_LIMIT_TRUST_PROXY_HEADERS=1.');
    return {
      limited: true,
      retryAfterSeconds: windowSeconds,
      reason: 'misconfigured',
    };
  }

  const trustedClientIp = getTrustedClientIp(request);
  if (STRICT_PROXY_MODE && !trustedClientIp) {
    return {
      limited: true,
      retryAfterSeconds: windowSeconds,
      reason: 'misconfigured',
    };
  }

  const clientId = trustedClientIp || getLowTrustClientFingerprint(request);
  const perClientLimit = trustedClientIp ? options.maxPerClient : Math.max(1, Math.floor(options.maxPerClient / 3));

  if (redis) {
    try {
      const clientResult = await checkBucketWithRedis(
        `ratelimit:${scope}:client:${clientId}`,
        perClientLimit,
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
        reason: 'global',
      };
    } catch (error) {
      console.error('[rate-limit] Redis limiter failed, falling back to in-memory limiter:', error);
    }
  }

  const maxTrackedKeys = options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  const limiter = getLimiter(maxTrackedKeys);
  const nowMs = Date.now();

  const clientKey = `${scope}:client:${clientId}`;
  const clientResult = limiter.check(clientKey, perClientLimit, options.windowMs, nowMs);
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
    reason: 'global',
  };
}
