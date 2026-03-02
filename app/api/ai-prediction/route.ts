import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  generateMarketPrediction,
  MarketPrediction,
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

function buildRuleBasedPrediction(dashboardData: DashboardData): MarketPrediction {
  const indicators = dashboardData.indicators;
  const riskSignals: string[] = [];
  const bullishSignals: string[] = [];

  if (indicators.yieldCurveSpread.value < 0) riskSignals.push('장단기 금리 역전');
  if (indicators.putCallRatio.value >= 24) riskSignals.push('변동성 지수(VIX) 고점 구간');
  if (indicators.moveIndex.value >= 110) riskSignals.push('채권 변동성(MOVE) 확대');
  if (indicators.highYieldSpread.value >= 4) riskSignals.push('하이일드 스프레드 확대');
  if (indicators.usdKrw.changePercent > 1) riskSignals.push('원/달러 급등');
  if (indicators.sp500.changePercent < 0) riskSignals.push('S&P500 단기 약세');
  if (indicators.nasdaq.changePercent < 0) riskSignals.push('나스닥 단기 약세');

  if (indicators.sp500.changePercent > 0) bullishSignals.push('S&P500 반등');
  if (indicators.nasdaq.changePercent > 0) bullishSignals.push('나스닥 반등');
  if (indicators.russell2000.changePercent > 0) bullishSignals.push('러셀2000 반등');
  if (indicators.payems.changePercent > 0) bullishSignals.push('고용 지표 개선');
  if (indicators.pmi.changePercent > 0) bullishSignals.push('제조업 심리 개선');
  if (indicators.kospi.changePercent > 0 || indicators.kosdaq.changePercent > 0) {
    bullishSignals.push('한국 주식시장 위험선호 회복');
  }

  const score = bullishSignals.length - riskSignals.length;
  const sentiment: MarketPrediction['sentiment'] =
    score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'neutral';

  const risks = riskSignals.slice(0, 4);
  if (risks.length === 0) {
    risks.push('핵심 이벤트 전후 변동성 확대 가능성');
  }

  return {
    sentiment,
    reasoning:
      `AI 응답 생성이 지연되어 규칙 기반 분석으로 대체했습니다. ` +
      `현재는 위험 신호 ${riskSignals.length}개, 개선 신호 ${bullishSignals.length}개가 관측되며 ` +
      `${sentiment === 'bullish' ? '완만한 위험선호 회복' : sentiment === 'bearish' ? '방어적 대응 우위' : '방향성 혼조'} 국면으로 해석됩니다.`,
    risks,
    timestamp: new Date().toISOString(),
    isFallback: true,
    fallbackMessage: 'AI 분석이 일시적으로 불안정하여 규칙 기반 대체 분석을 표시합니다.',
  };
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

    const { queuedRequests } = getGeminiCliLoad();
    const { maxQueueDepth } = getGeminiCliLimits();
    if (queuedRequests >= maxQueueDepth) {
      const busyFallback = buildRuleBasedPrediction(dashboardData);
      busyFallback.fallbackMessage = '현재 AI 분석 요청이 많아 규칙 기반 대체 분석을 표시합니다.';
      return NextResponse.json(busyFallback);
    }

    // Cache miss - generate new prediction
    console.log(`[API] Cache miss - generating new Gemini prediction (model: ${modelName})`);
    const prediction = await generateMarketPrediction(dashboardData, modelName);

    // Store in cache
    await geminiCache.setPrediction(dashboardData, prediction, modelName);

    return NextResponse.json(prediction);
  } catch (error) {
    if (error instanceof GeminiQueueFullError) {
      const busyFallback = buildRuleBasedPrediction(dashboardData);
      busyFallback.fallbackMessage = '현재 AI 분석 요청이 많아 규칙 기반 대체 분석을 표시합니다.';
      return NextResponse.json(busyFallback);
    }

    const errorId = randomUUID();
    console.error(`[API ai-prediction][${errorId}] Error generating AI prediction:`, error);

    // Check if it's a quota/rate limit error
    const isQuota = isQuotaError(error);

    const fallbackPrediction = await geminiCache.getBestMatchingPrediction(
      dashboardData,
      modelName
    );
    if (fallbackPrediction) {
      console.log(`[API] Using similarity-based fallback prediction (model: ${modelName})`);
      return NextResponse.json({
        ...fallbackPrediction,
        isFallback: true,
        fallbackMessage: isQuota
          ? 'API 사용 한도가 초과되었습니다. 금일 분석 내역에서 가장 유사한 시장 상황의 분석을 표시합니다.'
          : 'AI 분석 생성이 일시적으로 실패해 가장 유사한 과거 분석을 표시합니다.',
      });
    }

    const ruleBasedPrediction = buildRuleBasedPrediction(dashboardData);
    ruleBasedPrediction.fallbackMessage = isQuota
      ? 'API 사용 한도가 초과되어 규칙 기반 대체 분석을 표시합니다.'
      : 'AI 분석 생성에 실패해 규칙 기반 대체 분석을 표시합니다.';
    console.log(`[API] Returning rule-based fallback prediction (errorId: ${errorId})`);
    return NextResponse.json(ruleBasedPrediction);
  }
}
