import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  generateMarketPrediction,
  getGeminiCliLoad,
  getGeminiCliLimits,
  GeminiQueueFullError,
} from '@/lib/api/gemini';
import { geminiCache } from '@/lib/cache/gemini-cache-redis';
import { DashboardData } from '@/lib/types/indicators';
import {
  GeminiModelName,
  DEFAULT_GEMINI_MODEL,
  VALID_MODEL_NAMES
} from '@/lib/constants/gemini-models';
import { isQuotaError } from '@/lib/types/errors';
import { sanitizeDashboardData } from '@/lib/utils/dashboard-validation';
import { checkRateLimit } from '@/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_PER_CLIENT = 10;
const RATE_LIMIT_MAX_GLOBAL = 120;
const MAX_REQUEST_BYTES = 100 * 1024;

class PayloadTooLargeError extends Error {
  constructor() {
    super('payload_too_large');
    this.name = 'PayloadTooLargeError';
  }
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
    return NextResponse.json(
      {
        error: 'payload_too_large',
        message: `Request body too large (max ${MAX_REQUEST_BYTES} bytes)`,
      },
      { status: 413 }
    );
  }

  const rateLimitDecision = await checkRateLimit('api:ai-prediction', request, {
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxPerClient: RATE_LIMIT_MAX_PER_CLIENT,
    maxGlobal: RATE_LIMIT_MAX_GLOBAL,
  });
  if (rateLimitDecision.limited) {
    return NextResponse.json(
      {
        error: 'rate_limited',
        message: rateLimitDecision.reason === 'global'
          ? '현재 요청이 집중되어 있습니다. 잠시 후 다시 시도해주세요.'
          : '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
      },
      { status: 429, headers: { 'Retry-After': String(rateLimitDecision.retryAfterSeconds) } }
    );
  }

  const { queuedRequests } = getGeminiCliLoad();
  const { maxQueueDepth } = getGeminiCliLimits();
  if (queuedRequests >= maxQueueDepth) {
    return NextResponse.json(
      {
        error: 'server_busy',
        message: '현재 AI 분석 요청이 많습니다. 잠시 후 다시 시도해주세요.',
      },
      { status: 503, headers: { 'Retry-After': '10' } }
    );
  }

  // Get dashboard data and model from request body (sent by client)
  let dashboardData: DashboardData;
  let modelName: GeminiModelName = DEFAULT_GEMINI_MODEL;

  try {
    const rawBody = await readRequestBodyWithLimit(request, MAX_REQUEST_BYTES);
    if (!rawBody.trim()) {
      throw new Error('Empty request body');
    }

    const parsedBody = JSON.parse(rawBody) as unknown;
    const body = parsedBody as { dashboardData?: DashboardData; modelName?: GeminiModelName };
    const dashboardDataInput = body.dashboardData || parsedBody;
    const sanitizedDashboardData = sanitizeDashboardData(dashboardDataInput);
    if (!sanitizedDashboardData) {
      return NextResponse.json(
        { error: 'invalid_request', message: 'Invalid dashboardData payload' },
        { status: 400 }
      );
    }

    dashboardData = sanitizedDashboardData;
    modelName = body.modelName || DEFAULT_GEMINI_MODEL;

    // Validate model name
    if (!VALID_MODEL_NAMES.includes(modelName)) {
      return NextResponse.json(
        { error: 'invalid_model', message: 'Invalid model name' },
        { status: 400 }
      );
    }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json(
        {
          error: 'payload_too_large',
          message: `Request body too large (max ${MAX_REQUEST_BYTES} bytes)`,
        },
        { status: 413 }
      );
    }

    console.error('Error parsing request body:', error);
    return NextResponse.json(
      {
        error: 'invalid_request',
        message: 'Invalid request body',
      },
      { status: 400 }
    );
  }

  try {
    // Check cache first
    const cachedPrediction = await geminiCache.getPrediction(dashboardData, modelName);
    if (cachedPrediction) {
      console.log(`[API] Returning cached Gemini prediction (model: ${modelName})`);
      return NextResponse.json(cachedPrediction);
    }

    // Cache miss - generate new prediction
    console.log(`[API] Cache miss - generating new Gemini prediction (model: ${modelName})`);
    const prediction = await generateMarketPrediction(dashboardData, modelName);

    // Store in cache
    await geminiCache.setPrediction(dashboardData, prediction, modelName);

    return NextResponse.json(prediction);
  } catch (error) {
    if (error instanceof GeminiQueueFullError) {
      return NextResponse.json(
        {
          error: 'server_busy',
          message: '현재 AI 분석 요청이 많습니다. 잠시 후 다시 시도해주세요.',
        },
        { status: 503, headers: { 'Retry-After': '10' } }
      );
    }

    const errorId = randomUUID();
    console.error(`[API ai-prediction][${errorId}] Error generating AI prediction:`, error);

    // Check if it's a quota/rate limit error
    const isQuota = isQuotaError(error);

    // If quota error, try to use similarity-based fallback cache
    if (isQuota) {
      const fallbackPrediction = await geminiCache.getBestMatchingPrediction(
        dashboardData,
        modelName
      );
      if (fallbackPrediction) {
        console.log(`[API] Using similarity-based fallback prediction due to quota error (model: ${modelName})`);
        return NextResponse.json({
          ...fallbackPrediction,
          isFallback: true,
          fallbackMessage: 'API 사용 한도가 초과되었습니다. 금일 분석 내역에서 가장 유사한 시장 상황의 분석을 표시합니다.',
        });
      }
      console.log(`[API] No fallback available for model ${modelName}, returning quota error`);
    }

    const clientMessage = isQuota
      ? 'API 사용 한도가 초과되었습니다. 잠시 후 다시 시도해주세요.'
      : 'AI 분석 생성에 실패했습니다. 잠시 후 다시 시도해주세요.';

    return NextResponse.json(
      {
        error: isQuota ? 'quota_exceeded' : 'prediction_failed',
        message: clientMessage,
        isQuotaError: isQuota,
        errorId,
      },
      { status: isQuota ? 429 : 500 }
    );
  }
}
