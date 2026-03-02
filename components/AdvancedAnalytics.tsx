'use client';

import { useEffect, useState } from 'react';
import {
  DashboardData,
  IndicatorData,
  HistoricalDataPoint,
  AdvancedAnalyticsExplanation,
} from '@/lib/types/indicators';
import { DEFAULT_GEMINI_MODEL } from '@/lib/constants/gemini-models';
import {
  ADVANCED_ANALYTICS_CHART_TOOLTIP_KO,
  getIndicatorTooltipKo,
} from '@/lib/constants/chart-tooltips-ko';
import { parseApiErrorMessage } from '@/lib/utils/api-error-message';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface AdvancedAnalyticsProps {
  dashboardData: DashboardData;
}

interface IndicatorEntry {
  key: string;
  indicator: IndicatorData;
}

const MONTHLY_SYMBOLS = new Set(['MFG', 'M2', 'CPI', 'PAYEMS', 'KRTB']);

function toFixedOrDash(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return value.toFixed(digits);
}

function getHistoryStats(history: HistoricalDataPoint[] | undefined): {
  min: number | null;
  max: number | null;
  avg: number | null;
  volatility: number | null;
} {
  if (!history || history.length === 0) {
    return { min: null, max: null, avg: null, volatility: null };
  }

  const values = history.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;

  if (values.length < 3) {
    return { min, max, avg, volatility: null };
  }

  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    if (prev !== 0) {
      returns.push(((curr - prev) / Math.abs(prev)) * 100);
    }
  }

  if (returns.length < 2) {
    return { min, max, avg, volatility: null };
  }

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  const volatility = Math.sqrt(variance);

  return { min, max, avg, volatility };
}

function getTrendScore(indicator: IndicatorData): number {
  const short = indicator.changePercent;
  const mid = indicator.changePercent7d ?? indicator.changePercent;
  const long = indicator.changePercent30d ?? indicator.changePercent7d ?? indicator.changePercent;
  return short * 0.2 + mid * 0.3 + long * 0.5;
}

function buildChartSeries(indicator: IndicatorData): Array<{ date: string; value: number; ma: number | null }> {
  const history = indicator.history || [];
  if (history.length === 0) return [];

  const window = MONTHLY_SYMBOLS.has(indicator.symbol) ? 3 : 5;

  return history.map((point, index) => {
    const start = Math.max(0, index - window + 1);
    const subset = history.slice(start, index + 1).map((item) => item.value);
    const ma = subset.reduce((sum, value) => sum + value, 0) / subset.length;
    const date = new Date(point.date);
    const label = `${date.getMonth() + 1}/${date.getDate()}`;
    return { date: label, value: point.value, ma };
  });
}

function formatTooltipValue(value: number | string | ReadonlyArray<number | string> | undefined): string {
  if (value === undefined) return '-';
  const source = Array.isArray(value) ? value[0] : value;
  const numeric = Number(source);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : String(source);
}

function advancedAnalyticsErrorFallback(status: number): string {
  if (status === 429) {
    return 'API 사용 한도가 초과되었습니다. 잠시 후 다시 시도해주세요.';
  }
  if (status === 503) {
    return '현재 AI 분석 요청이 많습니다. 잠시 후 다시 시도해주세요.';
  }
  return '고급 분석을 불러오지 못했습니다.';
}

function ExpandedIndicatorChart({ entry }: { entry: IndicatorEntry }) {
  const { indicator } = entry;
  const series = buildChartSeries(indicator);
  const stats = getHistoryStats(indicator.history);
  const trendScore = getTrendScore(indicator);
  const longLabel = MONTHLY_SYMBOLS.has(indicator.symbol) ? '3M' : '30D';

  if (series.length === 0) {
    return null;
  }

  return (
    <div className="glass-card rounded-xl p-5">
      <div className="flex items-start justify-between mb-3">
        <div title={getIndicatorTooltipKo(indicator.symbol, indicator.name)}>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 cursor-help">
            {indicator.name}
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{indicator.symbol}</p>
        </div>
        <div className="text-right">
          <p className="text-base font-bold text-zinc-900 dark:text-zinc-100">
            {indicator.value.toFixed(2)}
            {indicator.unit ? (
              <span className="ml-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                {indicator.unit}
              </span>
            ) : null}
          </p>
          <p
            className={`text-xs font-semibold ${
              trendScore >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
            }`}
          >
            추세 점수 {trendScore >= 0 ? '+' : ''}
            {trendScore.toFixed(2)}
          </p>
        </div>
      </div>

      <div className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
            <YAxis hide domain={['auto', 'auto']} />
            <Tooltip
              formatter={(value) => formatTooltipValue(value)}
              labelFormatter={(label) => `날짜 ${label}`}
            />
            <Line type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2} dot={false} name="실제값" />
            <Line type="monotone" dataKey="ma" stroke="#f97316" strokeWidth={1.7} dot={false} name="이동평균" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
        <div className="rounded bg-zinc-100/70 dark:bg-zinc-900/50 px-2 py-1.5">
          최소: <span className="font-semibold">{toFixedOrDash(stats.min)}</span>
        </div>
        <div className="rounded bg-zinc-100/70 dark:bg-zinc-900/50 px-2 py-1.5">
          최대: <span className="font-semibold">{toFixedOrDash(stats.max)}</span>
        </div>
        <div className="rounded bg-zinc-100/70 dark:bg-zinc-900/50 px-2 py-1.5">
          평균: <span className="font-semibold">{toFixedOrDash(stats.avg)}</span>
        </div>
        <div className="rounded bg-zinc-100/70 dark:bg-zinc-900/50 px-2 py-1.5">
          변동성: <span className="font-semibold">{toFixedOrDash(stats.volatility)}%</span>
        </div>
      </div>

      <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        {longLabel} 변화율:{' '}
        {indicator.changePercent30d !== undefined
          ? `${indicator.changePercent30d >= 0 ? '+' : ''}${indicator.changePercent30d.toFixed(2)}%`
          : '-'}
        {' · '}
        데이터 포인트: {indicator.history?.length || 0}
      </div>
    </div>
  );
}

export default function AdvancedAnalytics({ dashboardData }: AdvancedAnalyticsProps) {
  const [explanation, setExplanation] = useState<AdvancedAnalyticsExplanation | null>(null);
  const [explanationLoading, setExplanationLoading] = useState(false);
  const [explanationError, setExplanationError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchExplanation = async () => {
      try {
        setExplanationLoading(true);
        setExplanationError(null);

        const response = await fetch('/api/advanced-analytics-explanations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            dashboardData,
            modelName: DEFAULT_GEMINI_MODEL,
          }),
        });

        if (!response.ok) {
          const message = await parseApiErrorMessage(response, advancedAnalyticsErrorFallback);
          throw new Error(message);
        }

        const data = (await response.json()) as AdvancedAnalyticsExplanation;
        if (!cancelled) {
          setExplanation(data);
        }
      } catch (error) {
        if (!cancelled) {
          setExplanationError(
            error instanceof Error ? error.message : '고급 분석을 생성하는 중 오류가 발생했습니다.'
          );
        }
      } finally {
        if (!cancelled) {
          setExplanationLoading(false);
        }
      }
    };

    fetchExplanation();

    return () => {
      cancelled = true;
    };
  }, [dashboardData]);

  const entries: IndicatorEntry[] = Object.entries(dashboardData.indicators).map(([key, indicator]) => ({
    key,
    indicator,
  }));

  const periodComparisonData = entries.map(({ indicator }) => ({
    symbol: indicator.symbol,
    short: indicator.changePercent,
    mid: indicator.changePercent7d ?? null,
    long: indicator.changePercent30d ?? null,
  }));

  const volatilityData = entries.map(({ indicator }) => {
    const stats = getHistoryStats(indicator.history);
    return {
      symbol: indicator.symbol,
      volatility: stats.volatility ?? 0,
      trend: getTrendScore(indicator),
    };
  });

  return (
    <section className="mb-8">
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Advanced Analytics</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          기간별 변화율, 변동성, 추세 강도를 확장 그래프로 제공하고 AI 해설을 함께 표시합니다.
        </p>
      </div>

      <div className="glass-card rounded-xl p-5 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xl">🧠</span>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Advanced Analytics AI 해설
          </h3>
        </div>

        {explanationLoading ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">AI가 고급 차트 의미를 분석 중입니다...</p>
        ) : explanationError ? (
          <p className="text-sm text-red-600 dark:text-red-400">{explanationError}</p>
        ) : explanation ? (
          <div className="space-y-3">
            {explanation.isFallback && explanation.fallbackMessage ? (
              <p className="text-xs text-yellow-700 dark:text-yellow-300 bg-yellow-50/80 dark:bg-yellow-900/20 border border-yellow-200/60 dark:border-yellow-800/60 rounded-lg px-3 py-2">
                {explanation.fallbackMessage}
              </p>
            ) : null}
            <p className="text-sm text-zinc-700 dark:text-zinc-200 leading-relaxed">{explanation.summary}</p>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <div className="rounded-lg bg-zinc-100/70 dark:bg-zinc-900/50 px-3 py-2">
                <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-300 mb-1">
                  기간별 변화율 해석
                </p>
                <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
                  {explanation.periodComparison}
                </p>
              </div>
              <div className="rounded-lg bg-zinc-100/70 dark:bg-zinc-900/50 px-3 py-2">
                <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-300 mb-1">
                  변동성·추세점수 해석
                </p>
                <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
                  {explanation.volatilityTrend}
                </p>
              </div>
            </div>
            {explanation.topSignals.length > 0 ? (
              <ul className="space-y-1">
                {explanation.topSignals.map((signal, index) => (
                  <li key={`${signal}-${index}`} className="text-xs text-zinc-700 dark:text-zinc-200">
                    • {signal}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
              모델: {DEFAULT_GEMINI_MODEL} · 생성 시각:{' '}
              {new Date(explanation.generatedAt).toLocaleString()}
            </p>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
        <div className="glass-card rounded-xl p-5">
          <h3
            className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3 cursor-help"
            title={ADVANCED_ANALYTICS_CHART_TOOLTIP_KO.periodComparison}
          >
            기간별 변화율 비교
          </h3>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={periodComparisonData} margin={{ top: 8, right: 8, left: 0, bottom: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                <XAxis dataKey="symbol" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={56} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value) => `${formatTooltipValue(value)}%`} />
                <Legend />
                <Bar dataKey="short" name="단기(1D / 1M)" fill="#2563eb" radius={[3, 3, 0, 0]} />
                <Bar dataKey="mid" name="중기(7D / 2M)" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
                <Bar dataKey="long" name="장기(30D / 3M)" fill="#22c55e" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="glass-card rounded-xl p-5">
          <h3
            className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3 cursor-help"
            title={ADVANCED_ANALYTICS_CHART_TOOLTIP_KO.volatilityTrend}
          >
            변동성 & 추세 점수
          </h3>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={volatilityData} margin={{ top: 8, right: 8, left: 0, bottom: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                <XAxis dataKey="symbol" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={56} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value) => formatTooltipValue(value)} />
                <Legend />
                <Bar dataKey="volatility" name="변동성 (%)" fill="#f97316" radius={[3, 3, 0, 0]} />
                <Bar dataKey="trend" name="추세 점수" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {entries.map((entry) => (
          <ExpandedIndicatorChart key={entry.key} entry={entry} />
        ))}
      </div>
    </section>
  );
}
