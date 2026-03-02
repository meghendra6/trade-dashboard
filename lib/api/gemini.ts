import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DashboardData, IndicatorData, AdvancedAnalyticsExplanation } from '../types/indicators';
import { GeminiModelName, DEFAULT_GEMINI_MODEL } from '../constants/gemini-models';
import { createQuotaError } from '../types/errors';

const execFileAsync = promisify(execFile);
const GEMINI_CLI_COMMAND = process.env.GEMINI_CLI_PATH || 'gemini';
const GEMINI_CLI_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const QUOTA_ERROR_PATTERNS = ['quota', 'rate limit', '429', 'resource exhausted', 'too many requests'];

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

const GEMINI_CLI_TIMEOUT_MS = readBoundedIntegerEnv('GEMINI_CLI_TIMEOUT_MS', 360000, 5000, 300000);
const GEMINI_CLI_MAX_CONCURRENCY = readBoundedIntegerEnv('GEMINI_CLI_MAX_CONCURRENCY', 2, 1, 10);
const GEMINI_CLI_MAX_QUEUE_DEPTH = readBoundedIntegerEnv('GEMINI_CLI_MAX_QUEUE_DEPTH', 50, 1, 1000);
const GEMINI_CLI_ALLOWED_TOOLS = (process.env.GEMINI_CLI_ALLOWED_TOOLS || 'google_web_search').trim();
let activeCliRequests = 0;
const cliRequestQueue: Array<() => void> = [];

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

function toText(chunk: string | Buffer | undefined): string {
  if (!chunk) return '';
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
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
  const trimmed = text.trim();
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
  const firstLine = raw
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
  const parsed = parseGeminiCliJson(stdout);

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

  const fallback = stdout.trim();
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
  const stdout = toText(cliError.stdout);
  const stderr = toText(cliError.stderr);
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

function buildGeminiCliArgs(prompt: string, modelName: GeminiModelName): string[] {
  const args = ['-m', modelName, '-p', prompt, '--output-format', 'json'];
  if (GEMINI_CLI_ALLOWED_TOOLS) {
    args.push('--allowed-tools', GEMINI_CLI_ALLOWED_TOOLS);
  }
  return args;
}

async function runGeminiCliPrompt(prompt: string, modelName: GeminiModelName): Promise<string> {
  let slotAcquired = false;

  try {
    await acquireCliSlot();
    slotAcquired = true;

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
    throw buildGeminiCliError(error);
  } finally {
    if (slotAcquired) {
      releaseCliSlot();
    }
  }
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

  // Generate dynamic date for search queries
  const now = new Date();
  const monthYear = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
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

  const prompt = `You are a professional financial market analyst. Provide a comprehensive market outlook by analyzing the following 26 economic and market indicators.

=== Economic Indicators ===

**Macro Indicators (Daily Data - 1D/7D/30D periods):**
1. US 10-Year Treasury Yield: ${us10yYield.value.toFixed(2)}% (${formatPeriodChanges(us10yYield)})
2. US 2-Year Treasury Yield: ${us2yYield.value.toFixed(2)}% (${formatPeriodChanges(us2yYield)})
3. 10Y-2Y Yield Curve Spread: ${yieldCurveSpread.value.toFixed(2)}pp (${formatPeriodChanges(yieldCurveSpread)})
4. US Dollar Index (DXY): ${dxy.value.toFixed(2)} (${formatPeriodChanges(dxy)})
5. High Yield Spread: ${highYieldSpread.value.toFixed(2)} bps (${formatPeriodChanges(highYieldSpread)})

**Macro Indicators (Monthly Data - 1M/2M/3M periods):**
6. M2 Money Supply: $${m2MoneySupply.value.toFixed(2)}B (${formatPeriodChanges(m2MoneySupply, true)})
7. Consumer Price Index (CPI): ${cpi.value.toFixed(2)} (Index, Base 1982-1984=100) - (${formatPeriodChanges(cpi, true)})
   → 인플레이션 추세 및 연준 통화정책 방향성의 핵심 지표
8. Total Nonfarm Employment: ${payems.value.toFixed(2)}M persons - (1M change: ${payems.change >= 0 ? '+' : ''}${payems.change.toFixed(2)}M / ${payems.changePercent.toFixed(2)}%, 2M: ${payems.change7d && payems.change7d >= 0 ? '+' : ''}${payems.change7d?.toFixed(2)}M / ${payems.changePercent7d?.toFixed(2)}%, 3M: ${payems.change30d && payems.change30d >= 0 ? '+' : ''}${payems.change30d?.toFixed(2)}M / ${payems.changePercent30d?.toFixed(2)}%)
   → 전체 비농업 고용자 수. 1M change는 월간 일자리 증감 (예: +0.05M = 50,000명 증가)
   → 노동시장 건전성 및 경제 성장 모멘텀의 핵심 지표

**US Equity Market Indicators (Daily Data - 1D/7D/30D periods):**
9. S&P 500 Index: ${sp500.value.toFixed(2)} (${formatPeriodChanges(sp500)})
10. Nasdaq Composite: ${nasdaq.value.toFixed(2)} (${formatPeriodChanges(nasdaq)})
11. Russell 2000 Index: ${russell2000.value.toFixed(2)} (${formatPeriodChanges(russell2000)})

**Commodity & Asset Indicators (Daily Data - 1D/7D/30D periods):**
12. Crude Oil (WTI): $${crudeOil.value.toFixed(2)}/barrel (${formatPeriodChanges(crudeOil)})
13. Gold (COMEX): $${gold.value.toFixed(2)}/oz (${formatPeriodChanges(gold)})
14. Copper/Gold Ratio: ${copperGoldRatio.value.toFixed(2)}×10000 (${formatPeriodChanges(copperGoldRatio)})
15. Bitcoin (BTC/USD): $${bitcoin.value.toFixed(2)} (${formatPeriodChanges(bitcoin)})

**Risk-Sensitive Indicators:**
16. VIX - Fear Index (Daily Data - 1D/7D/30D periods): ${putCallRatio.value.toFixed(2)} (${formatPeriodChanges(putCallRatio)})
17. MOVE Index - US Rate Volatility (Daily Data - 1D/7D/30D periods): ${moveIndex.value.toFixed(2)} (${formatPeriodChanges(moveIndex)})

**Korea-Related Indicators (Daily Data - 1D/7D/30D periods):**
18. USD/KRW Exchange Rate: ${usdKrw.value.toFixed(2)} KRW/USD (${formatPeriodChanges(usdKrw)})
19. KOSPI Composite: ${kospi.value.toFixed(2)} (${formatPeriodChanges(kospi)})
20. iShares MSCI Korea ETF (EWY): ${ewy.value.toFixed(2)} (${formatPeriodChanges(ewy)})

**Korea-Specialized Indicators:**
21. KOSDAQ Composite: ${kosdaq.value.toFixed(2)} (${formatPeriodChanges(kosdaq)})
22. KR 3Y Treasury Proxy (KTB ETF): ${kr3yBond.value.toFixed(2)} KRW (${formatPeriodChanges(kr3yBond)})
23. KR 10Y Treasury Proxy (KTB ETF): ${kr10yBond.value.toFixed(2)} KRW (${formatPeriodChanges(kr10yBond)})
24. Korea Semiconductor Exports Proxy (KODEX Semiconductor ETF): ${koreaSemiconductorExportsProxy.value.toFixed(2)} KRW (${formatPeriodChanges(koreaSemiconductorExportsProxy)})
25. Korea Trade Balance (Commodities, Monthly): ${koreaTradeBalance.value.toFixed(2)} Trillion KRW (${formatPeriodChanges(koreaTradeBalance, true)})

**Manufacturing Sentiment (Monthly Data - 1M/2M/3M periods):**
26. Manufacturing Confidence - OECD: ${pmi.value.toFixed(2)} (${formatPeriodChanges(pmi, true)})

=== Advanced Quantitative Signals (IMPORTANT SUPPORTING DATA) ===
Use the additional signals below to increase accuracy, especially for momentum reversals and volatility regimes:
${advancedSignals}

Interpretation requirements for this section:
- Explicitly check if trend is consistent_uptrend / consistent_downtrend / mixed_trend
- Use volatility to assess confidence level (high volatility = lower confidence, higher risk)
- Use recent_series to verify whether latest movement is acceleration or mean reversion

=== Analysis Priority (CRITICAL) ===

Your analysis MUST follow this strict priority order:

**1. PRIMARY (50% weight): Economic Indicators**
   - Base your core analysis on the 26 indicators' multi-period trends (1D/7D/30D or 1M/2M/3M)
   - Indicator movements are the foundation of your market outlook
   - Compare timeframes to identify momentum, trend reversals, and structural changes
   - **CPI와 NFP는 연준 정책 결정의 핵심 변수이므로 특별히 주목**:
     * CPI: 인플레이션 목표(2%) 대비 현황 평가
     * NFP: 고용시장 과열/냉각 여부 판단
   - **T10Y2Y, VIX, MOVE는 경기 둔화/금융 스트레스 조기 신호로 별도 점검**
   - **USDKRW, KOSPI, KOSDAQ, EWY, KR3Y/KR10Y, KRSEMI, KRTB를 통해 한국/아시아 리스크 전이 여부를 함께 평가**
   - KR3Y/KR10Y/KRSEMI are market-traded proxies, so interpret with caution and focus on direction/momentum
   - 지표 간 상관관계 고려 (예: CPI↑ + NFP강세 → 긴축 압력 증가)

**2. SECONDARY (25% weight): Official Announcements**
   - Fed policy statements, FOMC decisions, interest rate announcements
   - Major political/policy decisions (Trump statements, executive orders, trade policies, tariffs)
   - Official economic data releases (CPI, PPI, unemployment, GDP, NFP)
   - Government fiscal/regulatory policy changes
   - Use these to explain WHY indicators are moving

**3. TERTIARY (25% weight): Expert Opinions & Analyst Consensus**

   **REQUIRED: Search and categorize expert opinions into three groups:**

   🟢 **BULLISH/BUY Opinions:**
   - Analysts recommending buying, increasing exposure, overweight positions
   - Forecasts predicting market/index gains with specific price targets
   - Optimistic outlooks from major investment banks

   🔴 **BEARISH/SELL Opinions:**
   - Analysts recommending selling, reducing exposure, underweight positions
   - Forecasts predicting market/index declines with downside targets
   - Cautious/pessimistic outlooks, recession warnings

   ⚪ **NEUTRAL/HOLD Opinions:**
   - Analysts recommending holding current positions
   - Mixed or uncertain outlooks, wait-and-see recommendations

   **Synthesis Method:**
   - Count opinions in each category (e.g., "5 bullish, 2 bearish, 3 neutral")
   - Identify consensus direction and confidence level
   - Weight by source credibility: Major Investment Banks (Goldman Sachs, Morgan Stanley, JPMorgan) > Research Firms (Morningstar) > Independent Analysts
   - Note significant contrarian views from credible sources

=== Google Search Instructions ===

You have access to real-time web search capabilities. Use them strategically:

**REQUIRED SEARCHES - Official Announcements (25% weight):**
- Search for latest Fed announcements, FOMC decisions, or interest rate changes
- Search for recent Trump policy statements, executive orders, or trade policy changes
- Search for official U.S. economic data releases (CPI, PPI, unemployment, GDP) from the last 7 days
- Search for major geopolitical events affecting markets (tariffs, sanctions, conflicts)

**REQUIRED SEARCHES - Expert Opinions (25% weight):**
- Search for "S&P 500 analyst forecast 2026" or "stock market outlook 2026"
- Search for "Wall Street investment bank recommendation"
- Search for "Goldman Sachs market outlook" or "Morgan Stanley forecast"
- Search for "analyst buy sell rating stock market"

**Search Query Examples:**
- "Fed interest rate decision ${monthYear}"
- "Trump tariff announcement this week"
- "US CPI inflation data latest"
- "FOMC statement recent"
- "Wall Street analyst stock market forecast ${monthYear}"
- "Goldman Sachs S&P 500 target 2026"
- "investment bank bullish bearish outlook"

**Search Guidelines:**
1. Search for BOTH official announcements AND expert opinions
2. Focus on events/opinions from the **last 7 days** for maximum relevance
3. For official news: Verify source credibility (Fed.gov, WhiteHouse.gov, BLS.gov, Reuters, Bloomberg)
4. For expert opinions: Prioritize major investment banks and research firms
5. Categorize expert opinions as BULLISH/BEARISH/NEUTRAL

**CRITICAL**: You MUST search for both official announcements AND expert opinions before writing your analysis.

=== News Classification Guide ===

When evaluating news articles, classify them:

**HIGH PRIORITY (Official Announcements - 25% weight):**
- "Fed announces rate cut" → Official policy
- "Trump imposes new tariffs on China" → Political decision
- "U.S. inflation hits 3.2%" → Official data

**MEDIUM PRIORITY (Expert Opinions - 25% weight):**
Categorize each opinion as BULLISH, BEARISH, or NEUTRAL:

🟢 BULLISH examples:
- "Goldman Sachs raises S&P 500 target to 6,500" → Bullish
- "Morgan Stanley recommends overweight equities" → Bullish
- "JPMorgan sees 15% upside in stocks" → Bullish

🔴 BEARISH examples:
- "Bank of America warns of 20% correction" → Bearish
- "Deutsche Bank recommends underweight" → Bearish
- "Analyst predicts recession in Q2" → Bearish

⚪ NEUTRAL examples:
- "Citi maintains market-weight rating" → Neutral
- "UBS sees mixed outlook, recommends hold" → Neutral

**Source Credibility Ranking:**
1. Major Investment Banks: Goldman Sachs, Morgan Stanley, JPMorgan, Bank of America, Citi, UBS
2. Research Firms: Morningstar, S&P Global, Moody's
3. Financial Media Analysts: Bloomberg, Reuters contributors
4. Independent Analysts: Lower weight within the 25%

=== Analysis Requirements ===
1. **Multi-Period Indicator Analysis** (PRIMARY - 50%):
   - For DAILY indicators (US10Y, US2Y, T10Y2Y, DXY, HYS, SPX, IXIC, RUT, OIL, GOLD, Cu/Au, BTC, VIX, MOVE, USDKRW, KOSPI, EWY, KOSDAQ, KR3Y, KR10Y, KRSEMI): Use 1D/7D/30D periods to identify short-term vs long-term trends
   - For MONTHLY indicators (M2, CPI, PAYEMS, KRTB, MFG): Use 1M/2M/3M periods to identify monthly trends
   - Compare different timeframes to assess momentum and trend reversals
   - Analyze cross-indicator relationships (e.g., yields vs dollar, VIX vs equities)

2. **Official News Integration** (SECONDARY - 25%):
   - Reference official announcements to explain indicator movements
   - When citing, mention ACTUAL CONTENT and SOURCE, not index numbers
   - Good example: "연준의 긴축 기조 유지 발언(FOMC 성명서)에 따라 10년물 국채 수익률이 상승..."
   - Bad example: "뉴스1에 따르면...", "(뉴스2)"

3. **Expert Opinion Synthesis** (TERTIARY - 25%):
   - MUST search for and report expert opinions from major investment banks
   - Categorize opinions: Count BULLISH vs BEARISH vs NEUTRAL
   - Report consensus: "월가 주요 IB 중 X개사 매수, Y개사 매도, Z개사 중립 의견"
   - Include specific analyst names and price targets when available
   - Note significant contrarian views from credible sources
   - Good example: "Goldman Sachs는 S&P 500 목표가를 6,500으로 상향하며 매수 의견을 유지한 반면, Morgan Stanley는 단기 조정 가능성을 경고했습니다."

4. **Balanced Reasoning**:
   - Start with indicator analysis (50%)
   - Integrate official announcements (25%)
   - Synthesize expert consensus with opinion distribution (25%)
   - All three factors should be reflected in your reasoning

5. **Market Sentiment**: Determine sentiment ("bullish"/"bearish"/"neutral") based on:
   - Economic indicators (50%)
   - Official announcements (25%)
   - Expert consensus direction (25%)

6. **Specific Risks**: Identify 3-4 concrete risks based on indicator trends, official policy, AND contrarian expert views

Respond ONLY with the following JSON format:
{
  "sentiment": "bullish" | "bearish" | "neutral",
  "reasoning": "5-6 sentences including indicator analysis, official news, AND expert opinion consensus (e.g., 'X bullish, Y bearish, Z neutral')",
  "risks": ["risk 1", "risk 2", "risk 3"]
}

CRITICAL:
- The "reasoning" and "risks" fields MUST be written in Korean language
- You MUST include expert opinion consensus in your reasoning (e.g., "주요 IB 5곳 중 3곳 매수, 1곳 매도, 1곳 중립")
- When citing sources, mention the actual institution/analyst name (e.g., "Goldman Sachs", "Morgan Stanley"), NOT generic terms`;

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
 * Generate AI comments for multiple indicators in a single API call (2-3 sentences each)
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

  const prompt = `You are a financial market analyst. Today is ${dateStr}.

Analyze the following ${indicators.length} economic indicators and provide a brief comment for EACH indicator (2-3 sentences in Korean).

**Indicators:**
${indicatorDescriptions}

**Search Instructions:**
- Use Google Search to find the ACTUAL cause of today's indicator movement
- Search for news from the last 7 days only
- Prioritize: Fed announcements, economic data releases, geopolitical events
- If no specific news found, state "명확한 단일 원인 없이 기술적 조정"

**Analysis Requirements:**
For EACH indicator, provide a 2-3 sentence analysis in Korean following this structure:

**Sentence 1 - Cause & Context (MUST BE SPECIFIC):**
Directly explain the reason for the change using ONLY concrete evidence. DO NOT start with descriptive statements like "지표가 X% 상승/하락했습니다".
- ✅ GOOD: "연준 파월 의장의 1월 7일 매파적 발언으로 금리 인상 기대감이 높아졌습니다."
- ✅ GOOD: "12월 비농업 고용이 30만명으로 예상치 25만명을 상회하며 강한 고용시장을 보였습니다."
- ✅ GOOD: "ECB의 50bp 금리 인상 결정으로 유로존 긴축 정책이 강화되었습니다."
- ✅ GOOD: "중동 지역 유가 공급 차질 우려가 확대되며 에너지 가격 상승 압력이 증가했습니다."
- ❌ BAD: "VIX 지수가 15.12로 전일 대비 4.35% 상승했습니다." (단순 현황 설명)
- ❌ BAD: "시장 불확실성", "투자자 심리 악화", "리스크 회피 심리" (추상적 표현)
- ❌ BAD: "경기 둔화 우려", "인플레이션 압력" (일반적 이유)

**Sentence 2 - Market Impact:**
Explain what this change means for specific markets, sectors, or assets.
- Example: "이로 인해 성장주 중심의 기술주 섹터에 조정 압력이 가해질 전망입니다."
- Example: "원자재 수출국 통화와 에너지 섹터가 수혜를 입을 것으로 예상됩니다."

**CRITICAL RULES:**
- NEVER start with descriptive statements about the indicator's current value or percentage change (e.g., "지표가 X로 Y% 상승했습니다")
- Start IMMEDIATELY with the causal explanation (WHY it changed)
- ALWAYS cite SPECIFIC, CONCRETE events or data (with dates/numbers if possible)
- NEVER use abstract/vague terms like "시장 불안", "투자자 심리", "불확실성 증가"
- NEVER make unsupported claims - only use verifiable facts
- If you cannot find specific evidence, state "명확한 단일 원인 없이 기술적 조정" instead of making up reasons
- Use concrete sector examples (e.g., "반도체", "신흥국 채권", "원자재 수출주")
- Respond ONLY in valid JSON format

**Evidence Priority:**
1. Official policy announcements (Fed, ECB, government statements)
2. Economic data releases (employment, CPI, GDP, etc.)
3. Corporate earnings/guidance
4. Geopolitical events with clear market impact
5. Technical factors (if no fundamental catalyst exists)

**Response Format:**
{
  "US10Y": "Korean comment here...",
  "DXY": "Korean comment here...",
  "HYS": "Korean comment here...",
  ...
}

Generate comments for these symbols: ${symbolList}`;

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
