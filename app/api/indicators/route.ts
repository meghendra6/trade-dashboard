import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getAllIndicators } from '@/lib/api/indicators';
import { DashboardData } from '@/lib/types/indicators';
import { checkRateLimit } from '@/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_PER_CLIENT = 30;
const RATE_LIMIT_MAX_GLOBAL = 180;
const FRESH_CACHE_TTL_MS = 30 * 1000;
const STALE_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

let cachedDashboardData: DashboardData | null = null;
let cachedAtMs = 0;
let inFlightFetch: Promise<DashboardData> | null = null;

async function getCachedDashboardData(): Promise<DashboardData> {
  const now = Date.now();
  if (cachedDashboardData && now - cachedAtMs <= FRESH_CACHE_TTL_MS) {
    return cachedDashboardData;
  }

  if (!inFlightFetch) {
    inFlightFetch = (async () => {
      const indicators = await getAllIndicators();
      const nextData: DashboardData = {
        indicators,
        timestamp: new Date().toISOString(),
      };
      cachedDashboardData = nextData;
      cachedAtMs = Date.now();
      return nextData;
    })().finally(() => {
      inFlightFetch = null;
    });
  }

  return inFlightFetch;
}

export async function GET(request: Request) {
  const rateLimitDecision = await checkRateLimit('api:indicators', request, {
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxPerClient: RATE_LIMIT_MAX_PER_CLIENT,
    maxGlobal: RATE_LIMIT_MAX_GLOBAL,
  });
  if (rateLimitDecision.limited) {
    const isMisconfigured = rateLimitDecision.reason === 'misconfigured';
    return NextResponse.json(
      {
        error: isMisconfigured ? 'server_misconfigured' : 'rate_limited',
        message: isMisconfigured
          ? '서버 레이트리밋 설정이 올바르지 않습니다. 관리자에게 문의해주세요.'
          : rateLimitDecision.reason === 'global'
          ? '현재 요청이 집중되어 있습니다. 잠시 후 다시 시도해주세요.'
          : '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
      },
      { status: isMisconfigured ? 503 : 429, headers: { 'Retry-After': String(rateLimitDecision.retryAfterSeconds) } }
    );
  }

  try {
    const data = await getCachedDashboardData();
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, max-age=15, stale-while-revalidate=30',
      },
    });
  } catch (error) {
    const errorId = randomUUID();
    console.error(`[API indicators][${errorId}] Error fetching indicators:`, error);

    const now = Date.now();
    if (cachedDashboardData && now - cachedAtMs <= STALE_CACHE_MAX_AGE_MS) {
      return NextResponse.json(cachedDashboardData, {
        headers: {
          'Cache-Control': 'no-store',
          'X-Data-Stale': '1',
        },
      });
    }

    return NextResponse.json(
      {
        error: 'Failed to fetch market indicators',
        message: '지표 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.',
        errorId,
      },
      { status: 500 }
    );
  }
}
