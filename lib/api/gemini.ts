import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DashboardData, IndicatorData, AdvancedAnalyticsExplanation } from '../types/indicators';
import { GeminiModelName, DEFAULT_GEMINI_MODEL } from '../constants/gemini-models';
import { createQuotaError } from '../types/errors';

const execFileAsync = promisify(execFile);
const GEMINI_CLI_COMMAND = process.env.GEMINI_CLI_PATH || 'gemini';
const GEMINI_CLI_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const QUOTA_ERROR_PATTERNS = ['quota', 'rate limit', '429', 'resource exhausted', 'too many requests'];
const GEMINI_CLI_DEPRECATED_ALLOWED_TOOLS_WARNING_PATTERN =
  /Warning:\s+--allowed-tools cli argument and tools\.allowed in settings\.json are deprecated[^]*?policy-engine\/?/g;
const GEMINI_CLI_CREDENTIALS_LOG_PATTERN = /Loaded cached credentials\./g;

function readBoundedIntegerEnv(
  key: string,
  defaultValue: number,
  minValue: number,
  maxValue: number
): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < minValue || parsed > maxValue) {
    return defaultValue;
  }

  return parsed;
}

const GEMINI_CLI_TIMEOUT_MS = readBoundedIntegerEnv('GEMINI_CLI_TIMEOUT_MS', 180000, 5000, 300000);
const GEMINI_CLI_MAX_CONCURRENCY = readBoundedIntegerEnv('GEMINI_CLI_MAX_CONCURRENCY', 1, 1, 10);
const GEMINI_CLI_MAX_QUEUE_DEPTH = readBoundedIntegerEnv('GEMINI_CLI_MAX_QUEUE_DEPTH', 50, 1, 1000);
const GEMINI_CLI_MAX_RETRY_ATTEMPTS = readBoundedIntegerEnv('GEMINI_CLI_MAX_RETRY_ATTEMPTS', 3, 1, 6);
const GEMINI_CLI_RETRY_BASE_DELAY_MS = readBoundedIntegerEnv('GEMINI_CLI_RETRY_BASE_DELAY_MS', 1200, 100, 30000);
const GEMINI_CLI_RETRY_MAX_DELAY_MS = readBoundedIntegerEnv('GEMINI_CLI_RETRY_MAX_DELAY_MS', 10000, 500, 120000);
const GEMINI_CLI_MIN_REQUEST_INTERVAL_MS = readBoundedIntegerEnv('GEMINI_CLI_MIN_REQUEST_INTERVAL_MS', 1200, 0, 60000);
const GEMINI_CLI_ALLOWED_TOOLS = (process.env.GEMINI_CLI_ALLOWED_TOOLS || '').trim();
let activeCliRequests = 0;
const cliRequestQueue: Array<() => void> = [];
let nextCliRequestAtMs = 0;

export class GeminiQueueFullError extends Error {
  constructor() {
    super('AI request queue is full. Please retry shortly.');
    this.name = 'GeminiQueueFullError';
  }
}

export interface MarketPrediction {
  sentiment: 'bullish' | 'bearish' | 'neutral';
  reasoning: string;
  risks: string[];
  timestamp: string;
  isFallback?: boolean;
  fallbackMessage?: string;
}

// =============================================================================
// Helper Functions (리팩토링된 공통 유틸리티)
// =============================================================================

/**
 * 기간별 변화율 포맷팅 (일별/월별 데이터 통합)
 * @param indicator - 지표 데이터
 * @param isMonthly - 월별 데이터 여부 (true: 1M/2M/3M, false: 1D/7D/30D)
 */
function formatPeriodChanges(
  indicator: { changePercent: number; changePercent7d?: number; changePercent30d?: number },
  isMonthly: boolean = false
): string {
  const labels = isMonthly
    ? ['1M', '2M', '3M']
    : ['1D', '7D', '30D'];

  const formatChange = (value: number) =>
    `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

  const changes = [`${labels[0]}: ${formatChange(indicator.changePercent)}`];

  if (indicator.changePercent7d !== undefined) {
    changes.push(`${labels[1]}: ${formatChange(indicator.changePercent7d)}`);
  }
  if (indicator.changePercent30d !== undefined) {
    changes.push(`${labels[2]}: ${formatChange(indicator.changePercent30d)}`);
  }

  return changes.join(', ');
}

function calculateHistoryVolatility(history: IndicatorData['history']): number | null {
  if (!history || history.length < 3) {
    return null;
  }

  const returns: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].value;
    const curr = history[i].value;
    if (prev !== 0) {
      returns.push(((curr - prev) / Math.abs(prev)) * 100);
    }
  }

  if (returns.length < 2) {
    return null;
  }

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

function getTrendDescriptor(indicator: IndicatorData): string {
  const short = indicator.changePercent;
  const mid = indicator.changePercent7d ?? short;
  const long = indicator.changePercent30d ?? mid;

  if (short > 0 && mid > 0 && long > 0) return 'consistent_uptrend';
  if (short < 0 && mid < 0 && long < 0) return 'consistent_downtrend';
  if (short > 0 && long < 0) return 'short_term_rebound';
  if (short < 0 && long > 0) return 'short_term_pullback';
  return 'mixed_trend';
}

function formatRecentHistory(indicator: IndicatorData, points = 5): string {
  if (!indicator.history || indicator.history.length === 0) {
    return 'n/a';
  }

  return indicator.history
    .slice(-points)
    .map((point) => {
      const date = new Date(point.date).toISOString().slice(0, 10);
      return `${date}:${point.value.toFixed(2)}`;
    })
    .join(', ');
}

function formatAdvancedSignal(indicator: IndicatorData): string {
  const volatility = calculateHistoryVolatility(indicator.history);
  const trend = getTrendDescriptor(indicator);
  const range = indicator.history && indicator.history.length > 0
    ? Math.max(...indicator.history.map((point) => point.value)) - Math.min(...indicator.history.map((point) => point.value))
    : null;

  return [
    `trend=${trend}`,
    `volatility=${volatility !== null ? `${volatility.toFixed(2)}%` : 'n/a'}`,
    `range=${range !== null ? range.toFixed(2) : 'n/a'}`,
    `recent_series=[${formatRecentHistory(indicator)}]`,
  ].join(', ');
}

interface GeminiCliError {
  type?: string;
  message?: string;
  code?: string | number;
}

interface GeminiCliJsonOutput {
  response?: string;
  error?: GeminiCliError;
}

interface ExecFileFailure extends Error {
  code?: string | number;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  signal?: string | null;
  killed?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toText(chunk: string | Buffer | undefined): string {
  if (!chunk) return '';
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
}

function stripKnownCliNoise(raw: string): string {
  if (!raw) return raw;

  return raw
    .replace(GEMINI_CLI_DEPRECATED_ALLOWED_TOOLS_WARNING_PATTERN, '')
    .replace(GEMINI_CLI_CREDENTIALS_LOG_PATTERN, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

function isQuotaLikeMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return QUOTA_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function extractJsonObjects(text: string): string[] {
  const blocks: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      isEscaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      if (depth === 0) {
        start = i;
      }
      depth++;
      continue;
    }

    if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return blocks;
}

function parseGeminiCliJson(text: string): GeminiCliJsonOutput | null {
  const trimmed = stripKnownCliNoise(text).trim();
  if (!trimmed) return null;

  const candidates = [trimmed, ...extractJsonObjects(trimmed).reverse()];
  const visited = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate || visited.has(candidate)) continue;
    visited.add(candidate);
    try {
      return JSON.parse(candidate) as GeminiCliJsonOutput;
    } catch {
      // continue
    }
  }

  return null;
}

function sanitizeCliMessage(raw: string): string {
  const firstLine = stripKnownCliNoise(raw)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('at '));

  if (!firstLine || firstLine === '[object Object]') {
    return 'gemini-cli 호출 중 오류가 발생했습니다.';
  }

  return firstLine.length > 280 ? `${firstLine.slice(0, 280)}...` : firstLine;
}

function extractReadableMessage(input: unknown): string | null {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed || trimmed === '[object Object]') {
      return null;
    }
    return trimmed;
  }

  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
    return String(input);
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const nested = extractReadableMessage(item);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const candidateKeys = ['message', 'error', 'detail', 'details', 'reason', 'stderr', 'stdout', 'text'];
    for (const key of candidateKeys) {
      const nested = extractReadableMessage(record[key]);
      if (nested) {
        return nested;
      }
    }

    try {
      const serialized = JSON.stringify(input);
      if (serialized && serialized !== '{}' && serialized !== '[object Object]') {
        return serialized;
      }
    } catch {
      // Ignore serialization failures
    }
  }

  return null;
}

function normalizeUnknownErrorMessage(
  input: unknown,
  fallback = 'gemini-cli 호출에 실패했습니다.'
): string {
  const extracted = extractReadableMessage(input);
  if (!extracted) {
    return fallback;
  }
  return sanitizeCliMessage(extracted);
}

function parseGeminiCliResponse(stdout: string): string {
  const cleanedStdout = stripKnownCliNoise(stdout);
  const parsed = parseGeminiCliJson(cleanedStdout);

  if (parsed?.error) {
    throw new Error(normalizeUnknownErrorMessage(parsed.error.message || parsed.error));
  }

  if (typeof parsed?.response === 'string' && parsed.response.trim()) {
    return parsed.response;
  }

  if (parsed?.response !== undefined) {
    const parsedResponse = extractReadableMessage(parsed.response);
    if (parsedResponse) {
      return parsedResponse;
    }
  }

  const fallback = cleanedStdout.trim();
  if (!fallback) {
    throw new Error('No text output from gemini-cli');
  }
  return fallback;
}

function buildGeminiCliError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(normalizeUnknownErrorMessage(error));
  }

  const cliError = error as ExecFileFailure;
  const stdout = stripKnownCliNoise(toText(cliError.stdout));
  const stderr = stripKnownCliNoise(toText(cliError.stderr));
  const parsedStdout = parseGeminiCliJson(stdout);
  const parsedStderr = parseGeminiCliJson(stderr);

  const cliMessage = extractReadableMessage(parsedStdout?.error?.message) ||
    extractReadableMessage(parsedStderr?.error?.message) ||
    extractReadableMessage(parsedStdout?.response) ||
    extractReadableMessage(parsedStderr?.response);

  if (cliError.code === 'ENOENT') {
    return new Error('gemini-cli 실행 파일을 찾을 수 없습니다. GEMINI_CLI_PATH 또는 PATH를 확인해주세요.');
  }

  if (cliError.killed || cliError.signal === 'SIGTERM') {
    return new Error(`gemini-cli 실행 시간이 ${Math.round(GEMINI_CLI_TIMEOUT_MS / 1000)}초를 초과했습니다.`);
  }

  if (cliMessage && cliMessage.trim()) {
    return new Error(sanitizeCliMessage(cliMessage));
  }

  const combinedOutput = `${stdout}\n${stderr}`;
  if (isQuotaLikeMessage(combinedOutput)) {
    return new Error('API quota exceeded (429)');
  }

  if (stderr.trim()) {
    return new Error(sanitizeCliMessage(stderr));
  }

  if (stdout.trim()) {
    return new Error(sanitizeCliMessage(stdout));
  }

  if (cliError.message?.trim()) {
    const normalized = sanitizeCliMessage(cliError.message);
    if (normalized !== 'gemini-cli 호출 중 오류가 발생했습니다.') {
      return new Error(normalized);
    }
  }

  return new Error('gemini-cli 호출에 실패했습니다.');
}

function shouldRetryGeminiCliError(error: Error): boolean {
  const normalized = error.message.toLowerCase();
  return (
    isQuotaLikeMessage(normalized) ||
    normalized.includes('temporar') ||
    normalized.includes('service unavailable') ||
    normalized.includes('internal error') ||
    normalized.includes('invalid response format') ||
    normalized.includes('no text output from gemini-cli') ||
    normalized.includes('econnreset') ||
    normalized.includes('etimedout') ||
    normalized.includes('socket hang up')
  );
}

function calculateRetryDelayMs(attempt: number): number {
  const exponential = Math.min(
    GEMINI_CLI_RETRY_MAX_DELAY_MS,
    GEMINI_CLI_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  );
  const jitterCap = Math.max(100, Math.floor(exponential * 0.2));
  const jitter = Math.floor(Math.random() * jitterCap);
  return Math.min(GEMINI_CLI_RETRY_MAX_DELAY_MS, exponential + jitter);
}

async function acquireCliSlot(): Promise<void> {
  if (activeCliRequests < GEMINI_CLI_MAX_CONCURRENCY) {
    activeCliRequests++;
    return;
  }

  if (cliRequestQueue.length >= GEMINI_CLI_MAX_QUEUE_DEPTH) {
    throw new GeminiQueueFullError();
  }

  await new Promise<void>((resolve) => {
    cliRequestQueue.push(resolve);
  });

  activeCliRequests++;
}

function releaseCliSlot(): void {
  activeCliRequests = Math.max(0, activeCliRequests - 1);
  const next = cliRequestQueue.shift();
  if (next) {
    next();
  }
}

async function enforceCliRequestInterval(): Promise<void> {
  if (GEMINI_CLI_MIN_REQUEST_INTERVAL_MS <= 0) return;

  const now = Date.now();
  const scheduledAt = Math.max(nextCliRequestAtMs, now);
  nextCliRequestAtMs = scheduledAt + GEMINI_CLI_MIN_REQUEST_INTERVAL_MS;

  const waitMs = scheduledAt - now;
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

function buildGeminiCliArgs(prompt: string, modelName: GeminiModelName): string[] {
  const args = ['-m', modelName, '-p', prompt, '--output-format', 'json'];
  if (GEMINI_CLI_ALLOWED_TOOLS) {
    args.push('--allowed-tools', GEMINI_CLI_ALLOWED_TOOLS);
  }
  return args;
}

async function runGeminiCliPrompt(prompt: string, modelName: GeminiModelName): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= GEMINI_CLI_MAX_RETRY_ATTEMPTS; attempt++) {
    let slotAcquired = false;
    let retryDelayMs = 0;

    try {
      await acquireCliSlot();
      slotAcquired = true;
      await enforceCliRequestInterval();

      const { stdout } = await execFileAsync(
        GEMINI_CLI_COMMAND,
        buildGeminiCliArgs(prompt, modelName),
        {
          encoding: 'utf8',
          timeout: GEMINI_CLI_TIMEOUT_MS,
          maxBuffer: GEMINI_CLI_MAX_BUFFER_BYTES,
        }
      );

      return parseGeminiCliResponse(toText(stdout));
    } catch (error) {
      if (error instanceof GeminiQueueFullError) {
        throw error;
      }

      const normalizedError = buildGeminiCliError(error);
      lastError = normalizedError;

      const shouldRetry =
        attempt < GEMINI_CLI_MAX_RETRY_ATTEMPTS && shouldRetryGeminiCliError(normalizedError);
      if (!shouldRetry) {
        throw normalizedError;
      }

      retryDelayMs = calculateRetryDelayMs(attempt);
      console.warn(
        `[gemini-cli] Attempt ${attempt}/${GEMINI_CLI_MAX_RETRY_ATTEMPTS} failed: ${normalizedError.message}. Retrying in ${retryDelayMs}ms`
      );
    } finally {
      if (slotAcquired) {
        releaseCliSlot();
      }
    }

    if (retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }

  throw lastError || new Error('gemini-cli 호출에 실패했습니다.');
}

export function getGeminiCliLoad(): { activeRequests: number; queuedRequests: number } {
  return {
    activeRequests: activeCliRequests,
    queuedRequests: cliRequestQueue.length,
  };
}

export function getGeminiCliLimits(): { maxQueueDepth: number; maxConcurrency: number } {
  return {
    maxQueueDepth: GEMINI_CLI_MAX_QUEUE_DEPTH,
    maxConcurrency: GEMINI_CLI_MAX_CONCURRENCY,
  };
}

/**
 * 응답 텍스트에서 JSON 추출 및 파싱
 * @throws Error if no text or invalid JSON format
 */
function parseJsonFromResponse<T>(text: string): T {
  if (!text) {
    throw new Error('No text output from gemini-cli');
  }

  const candidates = [text.trim(), ...extractJsonObjects(text).reverse()];
  const visited = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate || visited.has(candidate)) continue;
    visited.add(candidate);

    try {
      return JSON.parse(candidate) as T;
    } catch {
      // continue
    }
  }

  throw new Error('Invalid response format from gemini-cli');
}

/**
 * Quota/Rate limit 에러 여부 확인
 */
function isQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return isQuotaLikeMessage(error.message);
}

/**
 * Quota 에러 처리 - quota 에러면 throw, 아니면 원본 에러 throw
 */
function handleApiError(error: unknown, quotaMessage: string): never {
  if (isQuotaError(error)) {
    throw createQuotaError(quotaMessage);
  }
  throw error;
}

// =============================================================================
// Main Functions
// =============================================================================

export async function generateMarketPrediction(
  dashboardData: DashboardData,
  modelName: GeminiModelName = DEFAULT_GEMINI_MODEL
): Promise<MarketPrediction> {
  const {
    us10yYield,
    us2yYield,
    yieldCurveSpread,
    dxy,
    highYieldSpread,
    m2MoneySupply,
    cpi,
    payems,
    sp500,
    nasdaq,
    russell2000,
    crudeOil,
    gold,
    moveIndex,
    copperGoldRatio,
    pmi,
    putCallRatio,
    bitcoin,
    usdKrw,
    kospi,
    ewy,
    kosdaq,
    kr3yBond,
    kr10yBond,
    koreaSemiconductorExportsProxy,
    koreaTradeBalance,
  } = dashboardData.indicators;

  // Generate time context for analysis prompt
  const now = new Date();
  const analysisDateKst = now.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Seoul',
  });
  const advancedSignals = [
    `US10Y: ${formatAdvancedSignal(us10yYield)}`,
    `US2Y: ${formatAdvancedSignal(us2yYield)}`,
    `T10Y2Y: ${formatAdvancedSignal(yieldCurveSpread)}`,
    `DXY: ${formatAdvancedSignal(dxy)}`,
    `HYS: ${formatAdvancedSignal(highYieldSpread)}`,
    `M2: ${formatAdvancedSignal(m2MoneySupply)}`,
    `CPI: ${formatAdvancedSignal(cpi)}`,
    `PAYEMS: ${formatAdvancedSignal(payems)}`,
    `SPX: ${formatAdvancedSignal(sp500)}`,
    `IXIC: ${formatAdvancedSignal(nasdaq)}`,
    `RUT: ${formatAdvancedSignal(russell2000)}`,
    `OIL: ${formatAdvancedSignal(crudeOil)}`,
    `GOLD: ${formatAdvancedSignal(gold)}`,
    `MOVE: ${formatAdvancedSignal(moveIndex)}`,
    `Cu/Au: ${formatAdvancedSignal(copperGoldRatio)}`,
    `BTC: ${formatAdvancedSignal(bitcoin)}`,
    `USDKRW: ${formatAdvancedSignal(usdKrw)}`,
    `KOSPI: ${formatAdvancedSignal(kospi)}`,
    `EWY: ${formatAdvancedSignal(ewy)}`,
    `KOSDAQ: ${formatAdvancedSignal(kosdaq)}`,
    `KR3Y: ${formatAdvancedSignal(kr3yBond)}`,
    `KR10Y: ${formatAdvancedSignal(kr10yBond)}`,
    `KRSEMI: ${formatAdvancedSignal(koreaSemiconductorExportsProxy)}`,
    `KRTB: ${formatAdvancedSignal(koreaTradeBalance)}`,
    `MFG: ${formatAdvancedSignal(pmi)}`,
    `VIX: ${formatAdvancedSignal(putCallRatio)}`,
  ].join('\n');

  const prompt = `Role: You are a senior multi-asset macro strategist writing for Korean investors.

Data timestamp (source data): ${dashboardData.timestamp}
Prompt generated at (KST): ${analysisDateKst}

Primary dataset (26 indicators, prioritize these values over narrative):
[US Rates / Credit]
- US10Y: ${us10yYield.value.toFixed(2)}% (${formatPeriodChanges(us10yYield)})
- US2Y: ${us2yYield.value.toFixed(2)}% (${formatPeriodChanges(us2yYield)})
- T10Y2Y: ${yieldCurveSpread.value.toFixed(2)}pp (${formatPeriodChanges(yieldCurveSpread)})
- DXY: ${dxy.value.toFixed(2)} (${formatPeriodChanges(dxy)})
- HYS: ${highYieldSpread.value.toFixed(2)}bps (${formatPeriodChanges(highYieldSpread)})
- MOVE: ${moveIndex.value.toFixed(2)} (${formatPeriodChanges(moveIndex)})
- VIX: ${putCallRatio.value.toFixed(2)} (${formatPeriodChanges(putCallRatio)})

[US Macro (Monthly)]
- M2: $${m2MoneySupply.value.toFixed(2)}B (${formatPeriodChanges(m2MoneySupply, true)})
- CPI: ${cpi.value.toFixed(2)} (${formatPeriodChanges(cpi, true)})
- PAYEMS: ${payems.value.toFixed(2)}M (${formatPeriodChanges(payems, true)})
- MFG: ${pmi.value.toFixed(2)} (${formatPeriodChanges(pmi, true)})

[US Equities / Global Risk]
- SPX: ${sp500.value.toFixed(2)} (${formatPeriodChanges(sp500)})
- IXIC: ${nasdaq.value.toFixed(2)} (${formatPeriodChanges(nasdaq)})
- RUT: ${russell2000.value.toFixed(2)} (${formatPeriodChanges(russell2000)})
- BTC: $${bitcoin.value.toFixed(2)} (${formatPeriodChanges(bitcoin)})

[Commodities]
- OIL: $${crudeOil.value.toFixed(2)} (${formatPeriodChanges(crudeOil)})
- GOLD: $${gold.value.toFixed(2)} (${formatPeriodChanges(gold)})
- Cu/Au: ${copperGoldRatio.value.toFixed(2)}x10000 (${formatPeriodChanges(copperGoldRatio)})

[Korea / Asia Spillover]
- USDKRW: ${usdKrw.value.toFixed(2)} (${formatPeriodChanges(usdKrw)})
- KOSPI: ${kospi.value.toFixed(2)} (${formatPeriodChanges(kospi)})
- EWY: ${ewy.value.toFixed(2)} (${formatPeriodChanges(ewy)})
- KOSDAQ: ${kosdaq.value.toFixed(2)} (${formatPeriodChanges(kosdaq)})
- KR3Y: ${kr3yBond.value.toFixed(2)} (${formatPeriodChanges(kr3yBond)})
- KR10Y: ${kr10yBond.value.toFixed(2)} (${formatPeriodChanges(kr10yBond)})
- KRSEMI: ${koreaSemiconductorExportsProxy.value.toFixed(2)} (${formatPeriodChanges(koreaSemiconductorExportsProxy)})
- KRTB: ${koreaTradeBalance.value.toFixed(2)} (${formatPeriodChanges(koreaTradeBalance, true)})

Advanced quantitative signals (trend/volatility/recent series):
${advancedSignals}

Strict reasoning protocol:
1) Start with indicator evidence only. Create an internal scoreboard:
   - risk_on_or_growth signals = n
   - risk_off_or_slowdown signals = n
   - inflation_or_tightening pressure signals = n
2) Compare short/mid/long horizons (1D/7D/30D or 1M/2M/3M) and classify regime:
   acceleration / deceleration / mean_reversion / divergence.
3) Evaluate stress channels explicitly: T10Y2Y, HYS, MOVE, VIX.
4) Evaluate Korea spillover explicitly: USDKRW, KOSPI/KOSDAQ, KR3Y/KR10Y, KRSEMI, KRTB.
5) Web search is secondary confirmation only:
   - Prefer official releases and major institutions from last 7 days.
   - If confirmation is weak or conflicting, write: "확인 가능한 추가 이벤트는 제한적입니다."
6) Never fabricate exact quotes, dates, targets, or institution views.

Output requirements (must follow exactly):
- Return ONLY valid JSON. No markdown, no code block, no extra text.
- JSON schema:
{
  "sentiment": "bullish" | "bearish" | "neutral",
  "reasoning": "Korean 7-9 sentences. Must include: (a) indicator scoreboard counts, (b) 1-3개월 관점, (c) 한국 시장 전이 평가, (d) 신뢰도(높음/중간/낮음)와 근거.",
  "risks": ["Korean risk item with trigger and impact", "..."]
}
- "risks" must contain 3-5 concrete items.
- Ensure sentiment is logically consistent with reasoning and risks.`;

  try {
    const text = await runGeminiCliPrompt(prompt, modelName);
    const prediction = parseJsonFromResponse<{ sentiment: string; reasoning: string; risks?: string[] }>(text);

    return {
      sentiment: prediction.sentiment as 'bullish' | 'bearish' | 'neutral',
      reasoning: prediction.reasoning,
      risks: prediction.risks || [],
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error generating market prediction:', error);
    handleApiError(error, 'API 사용 한도가 초과되었습니다. 잠시 후 다시 시도해주세요.');
  }
}

/**
 * Generate AI comments for multiple indicators in a single API call (3 sentences each)
 *
 * Batch processing:
 * - Takes array of indicators with cache misses
 * - Sends all indicators in one prompt
 * - Returns JSON object with comments per symbol
 *
 * Explains for each indicator:
 * 1. Why the indicator moved (reason for change)
 * 2. Expected impact of this change
 */
export async function generateBatchComments(
  indicators: Array<{ symbol: string; data: IndicatorData }>,
  modelName: GeminiModelName = DEFAULT_GEMINI_MODEL
): Promise<Record<string, string>> {
  // Generate current date string for context
  const today = new Date();
  const dateStr = today.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // Build indicator descriptions for prompt
  const indicatorDescriptions = indicators.map(({ symbol, data }) => {
    const isMonthly = symbol === 'MFG' || symbol === 'M2' || symbol === 'CPI' || symbol === 'PAYEMS' || symbol === 'KRTB';
    const periodContext = formatPeriodChanges(data, isMonthly);
    return `${symbol} (${data.name}): ${data.value.toFixed(2)}${data.unit || ''} [${periodContext}]`;
  }).join('\n');

  const symbolList = indicators.map(({ symbol }) => symbol).join(', ');

  const prompt = `Role: You are a buy-side macro analyst writing high-signal Korean dashboard briefs.
Today: ${dateStr}

Task:
- For each indicator below, write one detailed Korean comment with EXACTLY 3 sentences.
- Goal: maximize accuracy, specificity, and practical decision value.

Indicators:
${indicatorDescriptions}

Per-indicator sentence template (strict):
1) Driver sentence: explain WHY the move happened using concrete evidence (policy/data/event/positioning).
2) Transmission sentence: explain WHICH assets/sectors/regions are affected and in what direction.
3) Monitoring sentence: state one 1-2주 핵심 체크포인트 and what it implies if confirmed.

Evidence policy:
- Priority: official policy/data releases > market-implied pricing changes > technical/positioning factors.
- If no verified single catalyst exists, write exactly: "확인 가능한 단일 이벤트보다 포지셔닝/기술적 요인의 영향이 우세합니다."
- Never start with a simple restatement of current value or % change.
- Avoid vague phrases without anchor (e.g., 심리 악화, 불확실성 확대).
- Do not fabricate exact numbers, dates, quotes, or institutions.

JSON output contract (strict):
- Return ONLY a JSON object and nothing else.
- Include ALL requested symbols exactly once as top-level keys.
- Each value must be Korean plain text (no markdown).
- If evidence is limited, still provide 3-sentence comment using the fallback sentence above.

Required keys: [${symbolList}]`;

  try {
    const text = await runGeminiCliPrompt(prompt, modelName);
    const comments = parseJsonFromResponse<Record<string, string>>(text);

    // Validate that all requested symbols have comments
    for (const { symbol } of indicators) {
      if (!comments[symbol]) {
        console.warn(`[generateBatchComments] Missing comment for ${symbol}`);
      }
    }

    return comments;
  } catch (error) {
    console.error('[generateBatchComments] Error:', error);
    handleApiError(error, 'API 사용 한도가 초과되었습니다.');
  }
}

function formatSignedPercent(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) {
    return 'n/a';
  }
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function sanitizeAiText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export async function generateAdvancedAnalyticsExplanation(
  dashboardData: DashboardData,
  modelName: GeminiModelName = DEFAULT_GEMINI_MODEL
): Promise<AdvancedAnalyticsExplanation> {
  const indicators = Object.values(dashboardData.indicators).map((indicator) => {
    const short = indicator.changePercent;
    const mid = indicator.changePercent7d ?? short;
    const long = indicator.changePercent30d ?? mid;
    const trendScore = short * 0.2 + mid * 0.3 + long * 0.5;
    const volatility = calculateHistoryVolatility(indicator.history);

    return {
      symbol: indicator.symbol,
      name: indicator.name,
      current: indicator.value,
      unit: indicator.unit || '',
      short,
      mid,
      long,
      trendScore,
      volatility,
    };
  });

  const strongestSignals = [...indicators]
    .sort((a, b) => Math.abs(b.trendScore) - Math.abs(a.trendScore))
    .slice(0, 8);
  const highestVolatility = [...indicators]
    .sort((a, b) => (b.volatility ?? -1) - (a.volatility ?? -1))
    .slice(0, 8);

  const indicatorSummary = indicators
    .map((indicator) => {
      const unitText = indicator.unit ? ` ${indicator.unit}` : '';
      return [
        `${indicator.symbol} (${indicator.name})`,
        `현재=${indicator.current.toFixed(2)}${unitText}`.trim(),
        `단기=${formatSignedPercent(indicator.short)}`,
        `중기=${formatSignedPercent(indicator.mid)}`,
        `장기=${formatSignedPercent(indicator.long)}`,
        `추세점수=${indicator.trendScore.toFixed(2)}`,
        `변동성=${indicator.volatility !== null ? `${indicator.volatility.toFixed(2)}%` : 'n/a'}`,
      ].join(' | ');
    })
    .join('\n');

  const prompt = `You are a macro strategist explaining chart analytics to Korean users.

Input timestamp: ${dashboardData.timestamp}

All indicators (short=1D/1M, mid=7D/2M, long=30D/3M):
${indicatorSummary}

Top absolute trend scores:
${strongestSignals.map((item) => `${item.symbol}:${item.trendScore.toFixed(2)}`).join(', ')}

Top volatility indicators:
${highestVolatility
    .map((item) => `${item.symbol}:${item.volatility !== null ? item.volatility.toFixed(2) : 'n/a'}%`)
    .join(', ')}

Instructions:
1) Explain what the "Period Change Comparison" chart means and what current numbers imply.
2) Explain what the "Volatility & Trend Score" chart means and what current numbers imply.
3) Provide concise, concrete insights for decision support.
4) Korean only. No markdown.

Return ONLY valid JSON:
{
  "summary": "2-3문장",
  "periodComparison": "2-3문장",
  "volatilityTrend": "2-3문장",
  "topSignals": ["핵심 신호 1", "핵심 신호 2", "핵심 신호 3", "핵심 신호 4"]
}`;

  try {
    const text = await runGeminiCliPrompt(prompt, modelName);
    const parsed = parseJsonFromResponse<{
      summary?: unknown;
      periodComparison?: unknown;
      volatilityTrend?: unknown;
      topSignals?: unknown;
    }>(text);

    const topSignals = Array.isArray(parsed.topSignals)
      ? parsed.topSignals
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item) => item.length > 0)
          .slice(0, 6)
      : [];

    return {
      summary: sanitizeAiText(parsed.summary, '핵심 지표들의 방향이 혼재되어 있어 단기 변동성 관리가 중요합니다.'),
      periodComparison: sanitizeAiText(
        parsed.periodComparison,
        '기간별 변화율 비교에서는 단기 반등과 장기 추세가 같은 방향인지 먼저 확인해야 합니다.'
      ),
      volatilityTrend: sanitizeAiText(
        parsed.volatilityTrend,
        '변동성 대비 추세점수가 낮아지면 신호 신뢰도가 떨어질 수 있어 보수적 대응이 필요합니다.'
      ),
      topSignals:
        topSignals.length > 0
          ? topSignals
          : ['핵심 신호를 생성하지 못했습니다. 잠시 후 다시 시도해주세요.'],
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[generateAdvancedAnalyticsExplanation] Error:', error);
    handleApiError(error, 'API 사용 한도가 초과되었습니다. 잠시 후 다시 시도해주세요.');
  }
}
