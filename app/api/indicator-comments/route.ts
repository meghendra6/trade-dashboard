import { NextResponse } from 'next/server';
import { generateAIComments } from '@/lib/api/indicators';
import {
  getGeminiCliLoad,
  getGeminiCliLimits,
  GeminiQueueFullError,
} from '@/lib/api/gemini';
import { DashboardData, IndicatorCommentsResponse } from '@/lib/types/indicators';
import { sanitizeIndicators } from '@/lib/utils/dashboard-validation';
import { checkRateLimit } from '@/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';
const MAX_REQUEST_BYTES = 100 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_PER_CLIENT = 10;
const RATE_LIMIT_MAX_GLOBAL = 120;

class PayloadTooLargeError extends Error {
  constructor() {
    super('payload_too_large');
    this.name = 'PayloadTooLargeError';
  }
}

async function readRequestBodyWithLimit(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return '';

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

/**
 * POST /api/indicator-comments
 *
 * Generates AI comments for all indicators using batch processing
 *
 * Request body: { indicators: DashboardData['indicators'] }
 * Response: { comments: Record<symbol, string | undefined> }
 */
export async function POST(request: Request) {
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

  const rateLimitDecision = await checkRateLimit('api:indicator-comments', request, {
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

  try {
    const rawBody = await readRequestBodyWithLimit(request, MAX_REQUEST_BYTES);
    if (!rawBody.trim()) {
      return NextResponse.json(
        { error: 'Missing indicators in request body' },
        { status: 400 }
      );
    }

    const body = JSON.parse(rawBody);
    const { indicators } = body as { indicators: DashboardData['indicators'] };

    const sanitizedIndicators = sanitizeIndicators(indicators);
    if (!sanitizedIndicators) {
      return NextResponse.json(
        { error: 'Invalid indicators payload' },
        { status: 400 }
      );
    }

    console.log('[API indicator-comments] Generating batch AI comments...');

    // Generate AI comments and get comments record directly
    const comments = await generateAIComments(sanitizedIndicators);

    console.log('[API indicator-comments] Completed');

    return NextResponse.json<IndicatorCommentsResponse>({ comments });
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

    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json(
        { error: `Request body too large (max ${MAX_REQUEST_BYTES} bytes)` },
        { status: 413 }
      );
    }
    console.error('[API indicator-comments] Error:', error);
    return NextResponse.json(
      { error: 'Failed to generate indicator comments' },
      { status: 500 }
    );
  }
}
