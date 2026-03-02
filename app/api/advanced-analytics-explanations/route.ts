import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  generateAdvancedAnalyticsExplanation,
  getGeminiCliLoad,
  getGeminiCliLimits,
  GeminiQueueFullError,
} from '@/lib/api/gemini';
import { geminiCache } from '@/lib/cache/gemini-cache-redis';
import { DashboardData } from '@/lib/types/indicators';
import {
  GeminiModelName,
  DEFAULT_GEMINI_MODEL,
  VALID_MODEL_NAMES,
} from '@/lib/constants/gemini-models';
import { sanitizeDashboardData } from '@/lib/utils/dashboard-validation';
import { checkRateLimit } from '@/lib/utils/rate-limit';
import { isQuotaError } from '@/lib/types/errors';

export const dynamic = 'force-dynamic';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_PER_CLIENT = 10;
const RATE_LIMIT_MAX_GLOBAL = 100;
const MAX_REQUEST_BYTES = 120 * 1024;

class PayloadTooLargeError extends Error {
  constructor() {
    super('payload_too_large');
    this.name = 'PayloadTooLargeError';
  }
}

function createErrorResponse(
  errorCode: string,
  message: string,
  status: number,
  extra: Record<string, unknown> = {}
) {
  return NextResponse.json(
    {
      error: errorCode,
      errorCode,
      message,
      ...extra,
    },
    { status }
  );
}

async function readRequestBodyWithLimit(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) {
    return '';
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      throw new PayloadTooLargeError();
    }

    chunks.push(value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
}

export async function POST(request: Request) {
  const contentLength = Number.parseInt(request.headers.get('content-length') || '0', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return createErrorResponse(
      'payload_too_large',
      `Request body too large (max ${MAX_REQUEST_BYTES} bytes)`,
      413
    );
  }

  const rateLimitDecision = await checkRateLimit('api:advanced-analytics-explanations', request, {
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxPerClient: RATE_LIMIT_MAX_PER_CLIENT,
    maxGlobal: RATE_LIMIT_MAX_GLOBAL,
  });
  if (rateLimitDecision.limited) {
    const isMisconfigured = rateLimitDecision.reason === 'misconfigured';
    const status = isMisconfigured ? 503 : 429;
    return NextResponse.json(
      {
        error: isMisconfigured ? 'server_misconfigured' : 'rate_limited',
        errorCode: isMisconfigured ? 'server_misconfigured' : 'rate_limited',
        message: isMisconfigured
          ? '서버 레이트리밋 설정이 올바르지 않습니다. 관리자에게 문의해주세요.'
          : rateLimitDecision.reason === 'global'
          ? '현재 요청이 집중되어 있습니다. 잠시 후 다시 시도해주세요.'
          : '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
      },
      { status, headers: { 'Retry-After': String(rateLimitDecision.retryAfterSeconds) } }
    );
  }

  let dashboardData: DashboardData;
  let modelName: GeminiModelName = DEFAULT_GEMINI_MODEL;
  let forceRefresh = false;

  try {
    const rawBody = await readRequestBodyWithLimit(request, MAX_REQUEST_BYTES);
    if (!rawBody.trim()) {
      return createErrorResponse('invalid_request', 'Invalid request body', 400);
    }

    const parsedBody = JSON.parse(rawBody) as unknown;
    const body = parsedBody as {
      dashboardData?: DashboardData;
      modelName?: GeminiModelName;
      forceRefresh?: boolean;
    };

    const dashboardDataInput = body.dashboardData || parsedBody;
    const sanitizedDashboardData = sanitizeDashboardData(dashboardDataInput);
    if (!sanitizedDashboardData) {
      return createErrorResponse('invalid_request', 'Invalid dashboardData payload', 400);
    }

    dashboardData = sanitizedDashboardData;
    modelName = body.modelName || DEFAULT_GEMINI_MODEL;
    forceRefresh = body.forceRefresh === true;

    if (!VALID_MODEL_NAMES.includes(modelName)) {
      return createErrorResponse('invalid_model', 'Invalid model name', 400);
    }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return createErrorResponse(
        'payload_too_large',
        `Request body too large (max ${MAX_REQUEST_BYTES} bytes)`,
        413
      );
    }

    return createErrorResponse('invalid_request', 'Invalid request body', 400);
  }

  try {
    if (!forceRefresh) {
      const cached = await geminiCache.getAdvancedAnalyticsExplanation(dashboardData, modelName);
      if (cached) {
        return NextResponse.json(cached);
      }
    }

    const { queuedRequests } = getGeminiCliLoad();
    const { maxQueueDepth } = getGeminiCliLimits();
    if (queuedRequests >= maxQueueDepth) {
      return NextResponse.json(
        {
          error: 'server_busy',
          errorCode: 'server_busy',
          message: '현재 AI 분석 요청이 많습니다. 잠시 후 다시 시도해주세요.',
        },
        { status: 503, headers: { 'Retry-After': '10' } }
      );
    }

    const explanation = await generateAdvancedAnalyticsExplanation(dashboardData, modelName);
    await geminiCache.setAdvancedAnalyticsExplanation(dashboardData, explanation, modelName);

    return NextResponse.json(explanation);
  } catch (error) {
    if (error instanceof GeminiQueueFullError) {
      return NextResponse.json(
        {
          error: 'server_busy',
          errorCode: 'server_busy',
          message: '현재 AI 분석 요청이 많습니다. 잠시 후 다시 시도해주세요.',
        },
        { status: 503, headers: { 'Retry-After': '10' } }
      );
    }

    const errorId = randomUUID();
    console.error(`[API advanced-analytics-explanations][${errorId}] Error:`, error);
    const quotaExceeded = isQuotaError(error);

    const message = quotaExceeded
      ? 'API 사용 한도가 초과되었습니다. 잠시 후 다시 시도해주세요.'
      : '고급 분석 생성에 실패했습니다. 잠시 후 다시 시도해주세요.';

    return NextResponse.json(
      {
        error: quotaExceeded ? 'quota_exceeded' : 'advanced_analytics_failed',
        errorCode: quotaExceeded ? 'quota_exceeded' : 'advanced_analytics_failed',
        message,
        isQuotaError: quotaExceeded,
        errorId,
      },
      { status: quotaExceeded ? 429 : 500 }
    );
  }
}
