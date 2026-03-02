export interface HistoricalDataPoint {
  date: string;
  value: number;
}

export interface IndicatorData {
  name: string;
  symbol: string;
  value: number;

  // 1-day change
  change: number;
  changePercent: number;

  // 7-day change
  change7d?: number;
  changePercent7d?: number;

  // 30-day change
  change30d?: number;
  changePercent30d?: number;

  lastUpdated: string;
  unit?: string;
  history?: HistoricalDataPoint[];
}

// AI comments stored separately from indicator data
export type IndicatorComments = Record<string, string | undefined>;

// API response type for /api/indicator-comments
export interface IndicatorCommentsResponse {
  comments: IndicatorComments;
}

export interface DashboardData {
  indicators: {
    // Core indicators
    us10yYield: IndicatorData;
    us2yYield: IndicatorData;
    yieldCurveSpread: IndicatorData;
    dxy: IndicatorData;
    highYieldSpread: IndicatorData;

    // New indicators (Phase 7)
    m2MoneySupply: IndicatorData;
    crudeOil: IndicatorData;
    copperGoldRatio: IndicatorData;

    // Market sentiment indicators
    pmi: IndicatorData;
    putCallRatio: IndicatorData;

    // Digital asset indicator (Phase 8)
    bitcoin: IndicatorData;

    // Equity market indicators (Phase 12)
    sp500: IndicatorData;
    nasdaq: IndicatorData;
    russell2000: IndicatorData;
    gold: IndicatorData;

    // Inflation & Employment indicators (Phase 11)
    cpi: IndicatorData;     // Consumer Price Index
    payems: IndicatorData;  // Total Nonfarm Employment (PAYEMS)

    // Risk-sensitive indicators (Phase 13)
    moveIndex: IndicatorData;

    // Korea-related indicators (Phase 13)
    usdKrw: IndicatorData;
    kospi: IndicatorData;
    ewy: IndicatorData;

    // Korea-specialized indicators (Phase 14)
    kosdaq: IndicatorData;
    kr3yBond: IndicatorData;
    kr10yBond: IndicatorData;
    koreaSemiconductorExportsProxy: IndicatorData;
    koreaTradeBalance: IndicatorData;
  };
  timestamp: string;
}

export interface FREDResponse {
  observations: Array<{
    date: string;
    value: string;
  }>;
}

export interface YahooFinanceQuote {
  chart: {
    result: Array<{
      meta: {
        regularMarketPrice: number;
        chartPreviousClose: number;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: (number | null)[];
        }>;
      };
    }>;
  };
}

export interface CoinGeckoSimplePrice {
  bitcoin: {
    usd: number;
    usd_24h_change: number;
    last_updated_at: number;
  };
}

export interface CoinGeckoMarketChart {
  prices: [number, number][]; // [timestamp, price]
}

// Re-export GeminiModelName from central constants file
export type { GeminiModelName } from '../constants/gemini-models';
