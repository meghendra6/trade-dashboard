import { DashboardData, IndicatorData, HistoricalDataPoint } from '../types/indicators';

const MAX_HISTORY_POINTS = 500;
const MAX_TEXT_LENGTH = 200;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const EXPECTED_INDICATOR_KEYS = [
  'us10yYield',
  'us2yYield',
  'yieldCurveSpread',
  'dxy',
  'highYieldSpread',
  'm2MoneySupply',
  'cpi',
  'payems',
  'sp500',
  'nasdaq',
  'russell2000',
  'crudeOil',
  'gold',
  'moveIndex',
  'copperGoldRatio',
  'pmi',
  'putCallRatio',
  'bitcoin',
  'usdKrw',
  'kospi',
  'ewy',
  'kosdaq',
  'kr3yBond',
  'kr10yBond',
  'koreaSemiconductorExportsProxy',
  'koreaTradeBalance',
] as const;

type IndicatorKey = typeof EXPECTED_INDICATOR_KEYS[number];

const INDICATOR_META: Record<IndicatorKey, Pick<IndicatorData, 'name' | 'symbol' | 'unit'>> = {
  us10yYield: { name: 'US 10Y Yield', symbol: 'US10Y', unit: '%' },
  us2yYield: { name: 'US 2Y Yield', symbol: 'US2Y', unit: '%' },
  yieldCurveSpread: { name: '10Y-2Y Yield Curve Spread', symbol: 'T10Y2Y', unit: 'pp' },
  dxy: { name: 'US Dollar Index', symbol: 'DXY' },
  highYieldSpread: { name: 'High Yield Spread', symbol: 'HYS', unit: 'bps' },
  m2MoneySupply: { name: 'M2 Money Supply', symbol: 'M2', unit: 'Billion $' },
  cpi: { name: 'Consumer Price Index (CPI)', symbol: 'CPI', unit: 'Index' },
  payems: { name: 'Total Nonfarm Employment', symbol: 'PAYEMS', unit: 'M' },
  sp500: { name: 'S&P 500 Index', symbol: 'SPX' },
  nasdaq: { name: 'Nasdaq Composite', symbol: 'IXIC' },
  russell2000: { name: 'Russell 2000 Index', symbol: 'RUT' },
  crudeOil: { name: 'Crude Oil (WTI)', symbol: 'OIL', unit: '$/barrel' },
  gold: { name: 'Gold (COMEX Futures)', symbol: 'GOLD', unit: '$/oz' },
  moveIndex: { name: 'MOVE Index (Rate Volatility)', symbol: 'MOVE' },
  copperGoldRatio: { name: 'Copper/Gold Ratio', symbol: 'Cu/Au', unit: 'x10000' },
  pmi: { name: 'Manufacturing Confidence (OECD)', symbol: 'MFG' },
  putCallRatio: { name: 'VIX (Market Fear Index)', symbol: 'VIX' },
  bitcoin: { name: 'Bitcoin (BTC/USD)', symbol: 'BTC', unit: '$' },
  usdKrw: { name: 'USD/KRW Exchange Rate', symbol: 'USDKRW', unit: 'KRW/USD' },
  kospi: { name: 'KOSPI Composite Index', symbol: 'KOSPI' },
  ewy: { name: 'iShares MSCI Korea ETF', symbol: 'EWY', unit: '$' },
  kosdaq: { name: 'KOSDAQ Composite Index', symbol: 'KOSDAQ' },
  kr3yBond: { name: 'KR 3Y Treasury Proxy (KTB ETF)', symbol: 'KR3Y', unit: 'KRW' },
  kr10yBond: { name: 'KR 10Y Treasury Proxy (KTB ETF)', symbol: 'KR10Y', unit: 'KRW' },
  koreaSemiconductorExportsProxy: { name: 'Korea Semiconductor Exports Proxy (KODEX)', symbol: 'KRSEMI', unit: 'KRW' },
  koreaTradeBalance: { name: 'Korea Trade Balance (Commodities)', symbol: 'KRTB', unit: 'T KRW' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  if (CONTROL_CHAR_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function sanitizeHistory(history: unknown): HistoricalDataPoint[] | undefined {
  if (history === undefined) return undefined;
  if (!Array.isArray(history) || history.length > MAX_HISTORY_POINTS) return undefined;

  const sanitized: HistoricalDataPoint[] = [];
  for (const point of history) {
    if (!isRecord(point)) continue;
    const date = sanitizeText(point.date, 32);
    const value = point.value;
    if (!date || !ISO_DATE_PATTERN.test(date) || !isFiniteNumber(value)) continue;
    sanitized.push({ date, value });
  }

  return sanitized;
}

function sanitizeOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return isFiniteNumber(value) ? value : undefined;
}

function sanitizeIsoDateTime(value: unknown): string | null {
  const text = sanitizeText(value, 64);
  if (!text) return null;
  return Number.isNaN(Date.parse(text)) ? null : text;
}

function sanitizeIndicatorData(key: IndicatorKey, value: unknown): IndicatorData | null {
  if (!isRecord(value)) return null;

  const meta = INDICATOR_META[key];
  const name = meta.name.slice(0, MAX_TEXT_LENGTH);
  const symbol = meta.symbol;
  const lastUpdated = sanitizeIsoDateTime(value.lastUpdated);
  const unit = meta.unit;

  if (!lastUpdated) return null;
  if (!isFiniteNumber(value.value)) return null;
  if (!isFiniteNumber(value.change)) return null;
  if (!isFiniteNumber(value.changePercent)) return null;

  return {
    name,
    symbol,
    value: value.value,
    change: value.change,
    changePercent: value.changePercent,
    change7d: sanitizeOptionalNumber(value.change7d),
    changePercent7d: sanitizeOptionalNumber(value.changePercent7d),
    change30d: sanitizeOptionalNumber(value.change30d),
    changePercent30d: sanitizeOptionalNumber(value.changePercent30d),
    lastUpdated,
    unit,
    history: sanitizeHistory(value.history),
  };
}

export function sanitizeIndicators(input: unknown): DashboardData['indicators'] | null {
  if (!isRecord(input)) return null;

  const sanitized = {} as DashboardData['indicators'];
  for (const key of EXPECTED_INDICATOR_KEYS) {
    const indicator = sanitizeIndicatorData(key, input[key]);
    if (!indicator) {
      return null;
    }
    sanitized[key as IndicatorKey] = indicator;
  }

  return sanitized;
}

export function sanitizeDashboardData(input: unknown): DashboardData | null {
  if (!isRecord(input)) return null;

  const indicators = sanitizeIndicators(input.indicators);
  if (!indicators) return null;

  const timestamp = sanitizeIsoDateTime(input.timestamp);
  if (!timestamp) return null;

  return { indicators, timestamp };
}
