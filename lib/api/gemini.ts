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
const GEMINI_CLI_TOOL_EXEC_ERROR_LINE_PATTERN = /^Error executing tool [^\n]*\n?/gm;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g;

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
  regime?: string;
  dominantDriver?: string;
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
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(GEMINI_CLI_DEPRECATED_ALLOWED_TOOLS_WARNING_PATTERN, '')
    .replace(GEMINI_CLI_CREDENTIALS_LOG_PATTERN, '')
    .replace(GEMINI_CLI_TOOL_EXEC_ERROR_LINE_PATTERN, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

function decodeCommonEscapes(raw: string): string {
  return raw
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function decodeLooseEscapedJsonString(raw: string): string | null {
  if (!raw) return null;

  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    const fallback = decodeCommonEscapes(raw);
    return fallback === raw ? null : fallback;
  }
}

function extractJsonStringField(raw: string, fieldName: string): string | null {
  const pattern = new RegExp(`"${fieldName}"\\s*:`, 'i');
  const match = pattern.exec(raw);
  if (!match) return null;

  let cursor = match.index + match[0].length;
  while (cursor < raw.length && /\s/.test(raw[cursor])) {
    cursor++;
  }

  if (raw[cursor] !== '"') {
    return null;
  }

  cursor += 1;
  let escaped = false;
  let buffer = '';

  while (cursor < raw.length) {
    const char = raw[cursor];
    if (escaped) {
      buffer += char;
      escaped = false;
      cursor += 1;
      continue;
    }

    if (char === '\\') {
      buffer += char;
      escaped = true;
      cursor += 1;
      continue;
    }

    if (char === '"') {
      const decoded = decodeLooseEscapedJsonString(buffer);
      return decoded ?? buffer;
    }

    buffer += char;
    cursor += 1;
  }

  // Best-effort handling for truncated outputs (missing closing quote)
  const partial = buffer.trim();
  if (!partial) return null;
  const decoded = decodeLooseEscapedJsonString(buffer);
  return decoded ?? buffer;
}

function extractLikelyResponsePayload(raw: string): string | null {
  const cleaned = stripKnownCliNoise(raw);
  const candidates = ['response', 'text', 'content'];

  for (const field of candidates) {
    const extracted = extractJsonStringField(cleaned, field);
    if (extracted && extracted.trim().length > 0) {
      return extracted;
    }
  }

  return null;
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

function stripCodeFences(text: string): string {
  return text
    .replace(/```json\s*/gi, '')
    .replace(/```javascript\s*/gi, '')
    .replace(/```ts\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

function normalizeJsonCandidate(candidate: string): string {
  return candidate
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

function parseGeminiCliJson(text: string): GeminiCliJsonOutput | null {
  const noiseStripped = stripKnownCliNoise(text);
  const trimmed = stripCodeFences(noiseStripped).trim();
  if (!trimmed) return null;

  const codeFenceBlocks = Array.from(noiseStripped.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))
    .map((match) => match[1]?.trim())
    .filter((block): block is string => Boolean(block));

  const candidates = [
    trimmed,
    ...codeFenceBlocks,
    ...extractJsonObjects(trimmed).reverse(),
  ];
  const visited = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate || visited.has(candidate)) continue;
    visited.add(candidate);
    try {
      return JSON.parse(candidate) as GeminiCliJsonOutput;
    } catch {
      const normalized = normalizeJsonCandidate(candidate);
      if (!normalized || visited.has(normalized)) continue;
      visited.add(normalized);
      try {
        return JSON.parse(normalized) as GeminiCliJsonOutput;
      } catch {
        // continue
      }
    }
  }

  return null;
}

function tryParseJsonFromResponse<T>(text: string): T | null {
  if (!text) {
    return null;
  }

  const noiseStripped = stripKnownCliNoise(text);
  const cleaned = stripCodeFences(noiseStripped);
  const codeFenceBlocks = Array.from(noiseStripped.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))
    .map((match) => match[1]?.trim())
    .filter((block): block is string => Boolean(block));
  const candidates = [
    cleaned.trim(),
    ...codeFenceBlocks,
    ...extractJsonObjects(cleaned).reverse(),
  ];
  const visited = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate || visited.has(candidate)) continue;
    visited.add(candidate);

    try {
      return JSON.parse(candidate) as T;
    } catch {
      const normalized = normalizeJsonCandidate(candidate);
      if (!normalized || visited.has(normalized)) {
        continue;
      }
      visited.add(normalized);

      try {
        return JSON.parse(normalized) as T;
      } catch {
        // continue
      }
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

  const extractedPayload = extractLikelyResponsePayload(cleanedStdout);
  if (extractedPayload) {
    return extractedPayload;
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

  const parsed = tryParseJsonFromResponse<T>(text);
  if (parsed !== null) {
    // Handle gemini-cli wrapper object:
    // { session_id, response: "<json-string>", stats }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const wrapper = parsed as Record<string, unknown>;
      const wrapperResponse = wrapper.response;
      if (typeof wrapperResponse === 'string') {
        const nestedParsed = tryParseJsonFromResponse<T>(wrapperResponse);
        if (nestedParsed !== null) {
          return nestedParsed;
        }
      } else if (wrapperResponse && typeof wrapperResponse === 'object') {
        return wrapperResponse as T;
      }
    }

    return parsed;
  }

  const extractedPayload = extractLikelyResponsePayload(text);
  if (extractedPayload) {
    const nestedParsed = tryParseJsonFromResponse<T>(extractedPayload);
    if (nestedParsed !== null) {
      return nestedParsed;
    }
  }

  throw new Error('Invalid response format from gemini-cli');
}

function normalizeSymbolKey(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function buildBatchCommentTemplate(symbols: string[]): string {
  return `{\n${symbols.map((symbol) => `  "${symbol}": ""`).join(',\n')}\n}`;
}

function extractCommentText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    const joined = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0)
      .join(' ');
    return joined.length > 0 ? joined : null;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const candidateFields = ['comment', 'analysis', 'text', 'content', 'summary', 'reasoning', 'value'];
    for (const field of candidateFields) {
      const nested = extractCommentText(record[field]);
      if (nested) return nested;
    }
  }

  return null;
}

function normalizeRecoveredComment(text: string): string {
  return text
    .trim()
    .replace(/^"/, '')
    .replace(/",?\s*$/, '')
    .trim();
}

function normalizeBatchCommentObject(
  raw: Record<string, unknown>,
  symbolLookup: Map<string, string>
): Record<string, string> {
  const normalized: Record<string, string> = {};
  const candidates: Record<string, unknown>[] = [raw];
  const nestedFields = ['comments', 'result', 'data', 'items'];

  for (const field of nestedFields) {
    const nested = raw[field];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      candidates.push(nested as Record<string, unknown>);
    }
  }

  for (const candidate of candidates) {
    for (const [rawKey, rawValue] of Object.entries(candidate)) {
      const mappedKey = symbolLookup.get(normalizeSymbolKey(rawKey));
      if (!mappedKey) continue;

      const comment = extractCommentText(rawValue);
      if (!comment) continue;

      normalized[mappedKey] = comment;
    }
  }

  return normalized;
}

function parseBatchCommentsFromPlainText(
  text: string,
  symbolLookup: Map<string, string>
): Record<string, string> {
  const parseLines = (input: string): Record<string, string> => {
    const lines = stripKnownCliNoise(input).replace(/\r/g, '').split('\n');
    const buffers: Record<string, string[]> = {};
    let currentSymbol: string | null = null;
    const symbolLinePattern =
      /^\s*(?:\d+\s*[.)-]\s*)?(?:[-*•]\s*)?(?:"?([A-Za-z0-9_./-]{2,30})"?)\s*[:：\-]\s*(.*)$/;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const symbolMatch = trimmed.match(symbolLinePattern);
      if (symbolMatch) {
        const rawSymbol = symbolMatch[1];
        const mappedSymbol = symbolLookup.get(normalizeSymbolKey(rawSymbol));
        if (mappedSymbol) {
          currentSymbol = mappedSymbol;
          buffers[mappedSymbol] = buffers[mappedSymbol] || [];
          if (symbolMatch[2]?.trim()) {
            buffers[mappedSymbol].push(normalizeRecoveredComment(symbolMatch[2]));
          }
          continue;
        }
      }

      if (currentSymbol && !/^[\[\]{}(),]+$/.test(trimmed)) {
        buffers[currentSymbol] = buffers[currentSymbol] || [];
        buffers[currentSymbol].push(normalizeRecoveredComment(trimmed));
      }
    }

    const normalized: Record<string, string> = {};
    for (const [symbol, parts] of Object.entries(buffers)) {
      const comment = normalizeRecoveredComment(parts.join(' '));
      if (comment.length > 0) {
        normalized[symbol] = comment;
      }
    }

    return normalized;
  };

  const direct = parseLines(text);
  if (Object.keys(direct).length > 0) {
    return direct;
  }

  const unescaped = decodeCommonEscapes(text);
  if (unescaped !== text) {
    const parsedUnescaped = parseLines(unescaped);
    if (Object.keys(parsedUnescaped).length > 0) {
      return parsedUnescaped;
    }
  }

  const decodedJsonString = decodeLooseEscapedJsonString(text);
  if (decodedJsonString && decodedJsonString !== text) {
    const parsedDecoded = parseLines(decodedJsonString);
    if (Object.keys(parsedDecoded).length > 0) {
      return parsedDecoded;
    }
  }

  return {};
}

function parseBatchCommentsResponse(
  text: string,
  requestedSymbols: string[]
): Record<string, string> {
  const symbolLookup = new Map(requestedSymbols.map((symbol) => [normalizeSymbolKey(symbol), symbol]));

  const parseFromPayload = (payload: string): Record<string, string> => {
    const parsedJson = tryParseJsonFromResponse<unknown>(payload);
    if (parsedJson && typeof parsedJson === 'object') {
      if (!Array.isArray(parsedJson)) {
        const record = parsedJson as Record<string, unknown>;
        const normalized = normalizeBatchCommentObject(record, symbolLookup);
        if (Object.keys(normalized).length > 0) {
          return normalized;
        }

        // If this is a wrapper response, recursively parse nested response payload
        for (const wrapperField of ['response', 'text', 'content']) {
          const nested = record[wrapperField];
          if (typeof nested === 'string') {
            const nestedParsed = parseFromPayload(nested);
            if (Object.keys(nestedParsed).length > 0) {
              return nestedParsed;
            }
          } else if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            const nestedNormalized = normalizeBatchCommentObject(
              nested as Record<string, unknown>,
              symbolLookup
            );
            if (Object.keys(nestedNormalized).length > 0) {
              return nestedNormalized;
            }
          }
        }
      } else {
        const merged: Record<string, string> = {};
        for (const item of parsedJson) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const normalized = normalizeBatchCommentObject(item as Record<string, unknown>, symbolLookup);
          Object.assign(merged, normalized);
        }
        if (Object.keys(merged).length > 0) {
          return merged;
        }
      }
    }

    return parseBatchCommentsFromPlainText(payload, symbolLookup);
  };

  const directParsed = parseFromPayload(text);
  if (Object.keys(directParsed).length > 0) {
    return directParsed;
  }

  const extractedPayload = extractLikelyResponsePayload(text);
  if (extractedPayload) {
    const nestedParsed = parseFromPayload(extractedPayload);
    if (Object.keys(nestedParsed).length > 0) {
      return nestedParsed;
    }
  }

  return {};
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
  const allIndicators: IndicatorData[] = [
    us10yYield,
    us2yYield,
    yieldCurveSpread,
    dxy,
    highYieldSpread,
    moveIndex,
    putCallRatio,
    m2MoneySupply,
    cpi,
    payems,
    pmi,
    sp500,
    nasdaq,
    russell2000,
    bitcoin,
    crudeOil,
    gold,
    copperGoldRatio,
    usdKrw,
    kospi,
    ewy,
    kosdaq,
    kr3yBond,
    kr10yBond,
    koreaSemiconductorExportsProxy,
    koreaTradeBalance,
  ];

  const derivedSignals = allIndicators.map((indicator) => {
    const short = indicator.changePercent;
    const mid = indicator.changePercent7d ?? short;
    const long = indicator.changePercent30d ?? mid;
    const trendScore = short * 0.2 + mid * 0.3 + long * 0.5;
    const volatility = calculateHistoryVolatility(indicator.history);
    return {
      symbol: indicator.symbol,
      short,
      mid,
      long,
      trendScore,
      volatility,
    };
  });

  const topTrendSignals = [...derivedSignals]
    .sort((a, b) => Math.abs(b.trendScore) - Math.abs(a.trendScore))
    .slice(0, 6)
    .map((item) => `${item.symbol}:${item.trendScore >= 0 ? '+' : ''}${item.trendScore.toFixed(2)}`)
    .join(', ');

  const topVolatilitySignals = [...derivedSignals]
    .sort((a, b) => (b.volatility ?? -1) - (a.volatility ?? -1))
    .slice(0, 6)
    .map((item) => `${item.symbol}:${item.volatility !== null ? item.volatility.toFixed(2) : 'n/a'}%`)
    .join(', ');

  const dominantDriverCandidates = [...derivedSignals]
    .map((item) => ({
      symbol: item.symbol,
      impactScore: Math.abs(item.trendScore) + (item.volatility ?? 0) * 0.7,
    }))
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, 5)
    .map((item) => `${item.symbol}:${item.impactScore.toFixed(2)}`)
    .join(', ');

  const riskOnSignals = [
    sp500.changePercent > 0,
    nasdaq.changePercent > 0,
    russell2000.changePercent > 0,
    kospi.changePercent > 0,
    kosdaq.changePercent > 0,
    ewy.changePercent > 0,
    koreaSemiconductorExportsProxy.changePercent > 0,
    bitcoin.changePercent > 0,
    putCallRatio.changePercent < 0,
    highYieldSpread.changePercent < 0,
  ].filter(Boolean).length;

  const riskOffSignals = [
    dxy.changePercent > 0,
    moveIndex.changePercent > 0,
    putCallRatio.changePercent > 0,
    highYieldSpread.changePercent > 0,
    usdKrw.changePercent > 0,
    yieldCurveSpread.changePercent < 0,
    sp500.changePercent < 0,
    nasdaq.changePercent < 0,
    kospi.changePercent < 0,
    kosdaq.changePercent < 0,
  ].filter(Boolean).length;

  const inflationPressureSignals = [
    cpi.changePercent > 0,
    m2MoneySupply.changePercent > 0,
    crudeOil.changePercent > 0,
    gold.changePercent > 0,
    us10yYield.changePercent > 0,
    us2yYield.changePercent > 0,
    dxy.changePercent > 0,
    pmi.changePercent > 0,
  ].filter(Boolean).length;

  const prompt = `Role: You are a Senior Cross-Asset Macro Strategist focused on US-Korea spillover.
Goal: deliver institutional-grade but readable Korean analysis for active investors.

Data timestamp (source data): ${dashboardData.timestamp}
Prompt generated at (KST): ${analysisDateKst}

Primary dataset (26 indicators, treat this as ground truth):
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

Derived diagnostics:
- Signal scoreboard (short-horizon): risk_on=${riskOnSignals}, risk_off=${riskOffSignals}, inflation_pressure=${inflationPressureSignals}
- Stress channels: T10Y2Y(${formatSignedPercent(yieldCurveSpread.changePercent)}), HYS(${formatSignedPercent(highYieldSpread.changePercent)}), MOVE(${formatSignedPercent(moveIndex.changePercent)}), VIX(${formatSignedPercent(putCallRatio.changePercent)})
- Korea spillover channels: USDKRW(${formatSignedPercent(usdKrw.changePercent)}), KOSPI(${formatSignedPercent(kospi.changePercent)}), KOSDAQ(${formatSignedPercent(kosdaq.changePercent)}), KRSEMI(${formatSignedPercent(koreaSemiconductorExportsProxy.changePercent)}), KRTB(${formatSignedPercent(koreaTradeBalance.changePercent)})
- Top |trend score|: ${topTrendSignals}
- Top volatility: ${topVolatilitySignals}
- Dominant driver candidates (impact score): ${dominantDriverCandidates}

Selected advanced signals (trend/volatility/range/recent series):
${[
  `US10Y: ${formatAdvancedSignal(us10yYield)}`,
  `US2Y: ${formatAdvancedSignal(us2yYield)}`,
  `T10Y2Y: ${formatAdvancedSignal(yieldCurveSpread)}`,
  `DXY: ${formatAdvancedSignal(dxy)}`,
  `HYS: ${formatAdvancedSignal(highYieldSpread)}`,
  `MOVE: ${formatAdvancedSignal(moveIndex)}`,
  `VIX: ${formatAdvancedSignal(putCallRatio)}`,
  `SPX: ${formatAdvancedSignal(sp500)}`,
  `KOSPI: ${formatAdvancedSignal(kospi)}`,
  `KOSDAQ: ${formatAdvancedSignal(kosdaq)}`,
  `USDKRW: ${formatAdvancedSignal(usdKrw)}`,
  `KRSEMI: ${formatAdvancedSignal(koreaSemiconductorExportsProxy)}`,
].join('\n')}

Reasoning protocol (strict, easy Korean):
1) First pick one "dominant driver" from data and explain why it matters most now.
2) Then classify regime with one of these Korean labels: [위험선호, 위험회피, 반등시도, 박스권].
3) Build one causal chain: 미국(금리/달러/변동성) -> 글로벌 위험자산 -> 한국(환율/주식/반도체).
4) Validate trend durability using 1D/7D/30D (or 1M/2M/3M): 정렬(alignment) vs 괴리(divergence).
5) Include one concrete pivot scenario using real metric levels from given data in this format: "만약 [지표]가 [수치]를 [상향/하향] 이탈하면, [시장 영향] 가능성이 커집니다."
6) If evidence is weak/conflicting, write exactly: "확인 가능한 추가 이벤트는 제한적입니다."
7) Avoid heavy jargon; use practical Korean words first. If English term is unavoidable, add short Korean explanation.
8) Never fabricate exact quotes, dates, targets, or institution views.
9) Explain for beginners: use plain Korean that a new retail investor can understand quickly.
10) If you use 전문용어(예: 밸류에이션, 디버전스, 컨빅션), immediately add 쉬운 뜻 in parentheses.

Output requirements (must follow exactly):
- Return ONLY valid JSON. No markdown, no code block, no extra text.
- JSON schema:
{
  "regime": "위험선호 | 위험회피 | 반등시도 | 박스권",
  "sentiment": "bullish" | "bearish" | "neutral",
  "dominantDriver": "현재 시장의 핵심 동인 한 문장",
  "reasoning": "Korean EXACTLY 6 sentences, each <= 22 words, comma at most once per sentence. Each sentence must start with a tag in this exact order: [요약] [수급] [미국] [한국] [전망] [신뢰도].",
  "risks": ["짧은 한국어 문장: [트리거] -> [포트폴리오 영향]", "..."]
}
- "risks" must contain exactly 3 concrete items.
- Each risk item should be one short sentence in easy Korean.
- Ensure sentiment is logically consistent with reasoning and risks.`;

  try {
    const text = await runGeminiCliPrompt(prompt, modelName);
    const prediction = parseJsonFromResponse<{
      regime?: unknown;
      dominantDriver?: unknown;
      sentiment: string;
      reasoning: string;
      risks?: string[];
    }>(text);

    return {
      regime: sanitizeAiText(prediction.regime, '').trim() || undefined,
      dominantDriver: sanitizeAiText(prediction.dominantDriver, '').trim() || undefined,
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

  const formatSigned = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

  const getContextualPosition = (data: IndicatorData): string => {
    if (!data.history || data.history.length < 5) {
      return '과거 비교 데이터 제한';
    }

    const values = data.history
      .map((point) => point.value)
      .filter((value) => Number.isFinite(value));
    if (values.length < 5) {
      return '과거 비교 데이터 제한';
    }

    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avgDeviation = average !== 0 ? ((data.value - average) / Math.abs(average)) * 100 : 0;
    const rangePosition = max > min ? ((data.value - min) / (max - min)) * 100 : 50;

    return `평균대비 ${formatSigned(avgDeviation)}, 과거 범위 위치 ${rangePosition.toFixed(0)}%`;
  };

  // Build indicator descriptions for prompt
  const indicatorDescriptions = indicators.map(({ symbol, data }) => {
    const isMonthly = symbol === 'MFG' || symbol === 'M2' || symbol === 'CPI' || symbol === 'PAYEMS' || symbol === 'KRTB';
    const periodContext = formatPeriodChanges(data, isMonthly);
    const contextualPosition = getContextualPosition(data);
    return `${symbol} (${data.name}): ${data.value.toFixed(2)}${data.unit || ''} [${periodContext}] | [${contextualPosition}]`;
  }).join('\n');

  const requestedSymbols = indicators.map(({ symbol }) => symbol);
  const symbolList = requestedSymbols.join(', ');
  const jsonTemplate = buildBatchCommentTemplate(requestedSymbols);

  const prompt = `Role: You are a buy-side macro analyst writing concise Korean dashboard briefs for practical decision-making.
Today: ${dateStr}

Task:
- For each indicator, write one Korean comment with EXACTLY 3 sentences.
- Prioritize contextual position, cross-asset transmission, and actionable threshold.

Indicators:
${indicatorDescriptions}

Per-indicator sentence template (strict):
1) Status & Driver: explain where current value sits versus its recent history and why it moved.
2) Asset Transmission: name the most sensitive asset group (주식/채권/환율/원자재/한국) and likely direction.
3) Critical Threshold: provide one concrete pivot level from given data and explain "if A then B" in plain Korean.

Evidence policy:
- Priority: official policy/data releases > market-implied pricing changes > technical/positioning factors.
- If no verified single catalyst exists, write exactly: "확인 가능한 단일 이벤트보다 포지셔닝/기술적 요인의 영향이 우세합니다."
- Never start with a mere restatement of current value or % change.
- Avoid vague phrases without anchor (e.g., 심리 악화, 불확실성 확대).
- Do not fabricate exact numbers, dates, quotes, or institutions.
- Keep language concise, professional, and easy to read for Korean users.

JSON output contract (strict):
- Return ONLY a JSON object and nothing else.
- Include ALL requested symbols exactly once as top-level keys.
- Each value must be Korean plain text (no markdown).
- If evidence is limited, still provide 3-sentence comment using the fallback sentence above.
- Use this exact key structure (fill values only):
${jsonTemplate}

Required keys: [${symbolList}]`;

  try {
    const text = await runGeminiCliPrompt(prompt, modelName);
    const comments = parseBatchCommentsResponse(text, requestedSymbols);
    if (Object.keys(comments).length === 0) {
      const preview = stripKnownCliNoise(text).slice(0, 400).replace(/\s+/g, ' ');
      console.warn(`[generateBatchComments] Unparseable response preview: ${preview}`);
      throw new Error('Invalid response format from gemini-cli');
    }

    // Validate that all requested symbols have comments
    for (const symbol of requestedSymbols) {
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

  const prompt = `Role: You are a Financial Data Scientist explaining quantitative charts to sophisticated Korean investors.

Input timestamp: ${dashboardData.timestamp}

All indicators (short=1D/1M, mid=7D/2M, long=30D/3M):
${indicatorSummary}

Top absolute trend scores:
${strongestSignals.map((item) => `${item.symbol}:${item.trendScore.toFixed(2)}`).join(', ')}

Top volatility indicators:
${highestVolatility
    .map((item) => `${item.symbol}:${item.volatility !== null ? item.volatility.toFixed(2) : 'n/a'}%`)
    .join(', ')}

Interpretation framework (Data Science + Macro):
1) Signal vs Noise: if trend score is high but volatility is too high, classify as "노이즈 경고" rather than strong signal.
2) Leading vs Lagging: treat PMI/MOVE/DXY/HYS/KRSEMI as relatively leading, CPI/PAYEMS/M2 as relatively lagging, and explain timing gap.
3) Momentum persistence: use short/mid/long changes to judge whether momentum is strengthening, fading, or diverging.
4) Period Change Comparison: explain time-horizon alignment vs divergence in easy Korean.
5) Volatility & Trend Score: state which signals are high-conviction and which require caution.
6) Cross-asset reading: connect US rates/FX/volatility changes to Korea-sensitive assets when relevant.
7) Output in professional but plain Korean. No markdown.

Return ONLY valid JSON:
{
  "summary": "2-3문장. 전체 시장 국면과 핵심 투자 시사점",
  "periodComparison": "2-3문장. 기간 정렬/괴리 해석",
  "volatilityTrend": "2-3문장. 위험조정 추세 해석 및 포지셔닝 힌트",
  "topSignals": [
    "핵심 신호 1 (지표명 + 의미)",
    "핵심 신호 2 (지표명 + 의미)",
    "핵심 신호 3 (지표명 + 의미)",
    "핵심 신호 4 (지표명 + 의미)"
  ]
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
