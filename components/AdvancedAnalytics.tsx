'use client';

import { DashboardData, IndicatorData, HistoricalDataPoint } from '@/lib/types/indicators';
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
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{indicator.name}</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{indicator.symbol}</p>
        </div>
        <div className="text-right">
          <p className="text-base font-bold text-zinc-900 dark:text-zinc-100">
            {indicator.value.toFixed(2)}
            {indicator.unit ? <span className="ml-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">{indicator.unit}</span> : null}
          </p>
          <p className={`text-xs font-semibold ${trendScore >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            Trend score {trendScore >= 0 ? '+' : ''}
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
              labelFormatter={(label) => `Date ${label}`}
            />
            <Line type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2} dot={false} name="Value" />
            <Line type="monotone" dataKey="ma" stroke="#f97316" strokeWidth={1.7} dot={false} name="Moving Avg" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
        <div className="rounded bg-zinc-100/70 dark:bg-zinc-900/50 px-2 py-1.5">
          Min: <span className="font-semibold">{toFixedOrDash(stats.min)}</span>
        </div>
        <div className="rounded bg-zinc-100/70 dark:bg-zinc-900/50 px-2 py-1.5">
          Max: <span className="font-semibold">{toFixedOrDash(stats.max)}</span>
        </div>
        <div className="rounded bg-zinc-100/70 dark:bg-zinc-900/50 px-2 py-1.5">
          Avg: <span className="font-semibold">{toFixedOrDash(stats.avg)}</span>
        </div>
        <div className="rounded bg-zinc-100/70 dark:bg-zinc-900/50 px-2 py-1.5">
          Volatility: <span className="font-semibold">{toFixedOrDash(stats.volatility)}%</span>
        </div>
      </div>

      <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        {longLabel} change: {indicator.changePercent30d !== undefined
          ? `${indicator.changePercent30d >= 0 ? '+' : ''}${indicator.changePercent30d.toFixed(2)}%`
          : '-'}
        {' · '}
        Data points: {indicator.history?.length || 0}
      </div>
    </div>
  );
}

export default function AdvancedAnalytics({ dashboardData }: AdvancedAnalyticsProps) {
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
          더 정확한 판단을 위해 기간별 변화율, 변동성, 추세 강도를 확장 그래프로 제공합니다.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
        <div className="glass-card rounded-xl p-5">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Period Change Comparison</h3>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={periodComparisonData} margin={{ top: 8, right: 8, left: 0, bottom: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                <XAxis dataKey="symbol" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={56} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value) => `${formatTooltipValue(value)}%`} />
                <Legend />
                <Bar dataKey="short" name="1D / 1M" fill="#2563eb" radius={[3, 3, 0, 0]} />
                <Bar dataKey="mid" name="7D / 2M" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
                <Bar dataKey="long" name="30D / 3M" fill="#22c55e" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="glass-card rounded-xl p-5">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Volatility & Trend Score</h3>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={volatilityData} margin={{ top: 8, right: 8, left: 0, bottom: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                <XAxis dataKey="symbol" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={56} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value) => formatTooltipValue(value)} />
                <Legend />
                <Bar dataKey="volatility" name="Volatility (%)" fill="#f97316" radius={[3, 3, 0, 0]} />
                <Bar dataKey="trend" name="Trend Score" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
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
