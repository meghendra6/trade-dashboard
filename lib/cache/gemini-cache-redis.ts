import { Redis } from '@upstash/redis';
import { createHash } from 'node:crypto';
import { DashboardData } from '../types/indicators';
import { MarketPrediction } from '../api/gemini';
import { AdvancedAnalyticsExplanation } from '../types/indicators';
import { DEFAULT_GEMINI_MODEL } from '../constants/gemini-models';

interface CachedPrediction {
  prediction: MarketPrediction;
  timestamp: number;
  dataHash: string;
}

interface CachedAdvancedAnalyticsExplanation {
  explanation: AdvancedAnalyticsExplanation;
  timestamp: number;
  modelName: string;
  dataHash: string;
}

interface ParsedHash {
  model: string;
  us10y: number;
  us2y: number;
  t10y2y: number;
  dxy: number;
  spread: number;
  m2: number;
  spx: number;
  rut: number;
  oil: number;
  move: number;
  ratio: number;
  pmi: number;
  vix: number;
  btc: number;
  usdkrw: number;
  kospi: number;
  kosdaq: number;
  kr3y: number;
  kr10y: number;
  krsemi: number;
  krtb: number;
  [key: string]: string | number; // Allow dynamic indexing
}

const CACHE_PREFIX = 'gemini:prediction:';
const PREDICTION_INDEX_KEY = 'gemini:prediction:index';
const FALLBACK_PREFIX = 'gemini:fallback:';
const FALLBACK_INDEX_KEY = 'gemini:fallback:index';
const TTL_SECONDS = 24 * 60 * 60; // 24 hours
const MAX_FALLBACK_ENTRIES = 50;
const ADVANCED_EXPLANATION_PREFIX = 'gemini:advanced:explanation:';
const ADVANCED_EXPLANATION_INDEX_KEY = 'gemini:advanced:explanation:index';
const ADVANCED_EXPLANATION_FALLBACK_PREFIX = 'gemini:advanced:fallback:';
const ADVANCED_EXPLANATION_FALLBACK_INDEX_KEY = 'gemini:advanced:fallback:index';
const ADVANCED_EXPLANATION_TTL_SECONDS = 6 * 60 * 60; // 6 hours
const MAX_ADVANCED_EXPLANATION_ENTRIES = 30;
const SIMILARITY_KEYS = [
  'us10y',
  'us2y',
  't10y2y',
  'dxy',
  'spread',
  'm2',
  'spx',
  'rut',
  'oil',
  'move',
  'ratio',
  'pmi',
  'vix',
  'btc',
  'usdkrw',
  'kospi',
  'kosdaq',
  'kr3y',
  'kr10y',
  'krsemi',
  'krtb',
] as const;

const MIN_THRESHOLDS: Record<(typeof SIMILARITY_KEYS)[number], number> = {
  us10y: 0.16,
  us2y: 0.16,
  t10y2y: 0.25,
  dxy: 1.0,
  spread: 0.2,
  m2: 100,
  spx: 40,
  rut: 25,
  oil: 1.5,
  move: 1.0,
  ratio: 0.05,
  pmi: 0.15,
  vix: 0.9,
  btc: 1000,
  usdkrw: 5,
  kospi: 20,
  kosdaq: 10,
  kr3y: 1,
  kr10y: 1,
  krsemi: 1,
  krtb: 0.1,
};

/**
 * Upstash Redis-based Gemini cache
 * - Persistent across serverless instances
 * - Automatic TTL management
 * - Global replication for low latency
 */
class GeminiCacheRedis {
  private redis: Redis;

  constructor() {
    this.redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }

  /**
   * Get cached prediction by data hash
   */
  async getPrediction(
    dashboardData: DashboardData,
    modelName: string
  ): Promise<MarketPrediction | null> {
    const hash = this.hashData(dashboardData, modelName);
    const key = `${CACHE_PREFIX}${hash}`;

    try {
      const cached = await this.redis.get<CachedPrediction>(key);

      if (!cached) {
        console.log('[GeminiCacheRedis] Cache miss:', hash);
        return null;
      }

      const age = Math.round((Date.now() - cached.timestamp) / 1000);
      console.log(`[GeminiCacheRedis] Cache hit: ${hash} (age: ${age}s)`);
      return cached.prediction;
    } catch (error) {
      console.error('[GeminiCacheRedis] Error getting prediction:', error);
      return null;
    }
  }

  /**
   * Store prediction in cache with TTL
   */
  async setPrediction(
    dashboardData: DashboardData,
    prediction: MarketPrediction,
    modelName: string
  ): Promise<void> {
    const hash = this.hashData(dashboardData, modelName);
    const key = `${CACHE_PREFIX}${hash}`;
    const fallbackKey = `${FALLBACK_PREFIX}${Date.now()}`;

    const cached: CachedPrediction = {
      prediction,
      timestamp: Date.now(),
      dataHash: hash,
    };

    try {
      // Store with hash key (for exact match)
      await this.redis.set(key, cached, { ex: TTL_SECONDS });
      await this.redis.lpush(PREDICTION_INDEX_KEY, key);
      await this.redis.ltrim(PREDICTION_INDEX_KEY, 0, MAX_FALLBACK_ENTRIES - 1);
      await this.redis.expire(PREDICTION_INDEX_KEY, TTL_SECONDS);

      // Also store with timestamp key (for fallback retrieval)
      await this.redis.set(fallbackKey, cached, { ex: TTL_SECONDS });
      await this.redis.lpush(FALLBACK_INDEX_KEY, fallbackKey);
      await this.redis.ltrim(FALLBACK_INDEX_KEY, 0, MAX_FALLBACK_ENTRIES - 1);
      await this.redis.expire(FALLBACK_INDEX_KEY, TTL_SECONDS);

      console.log(`[GeminiCacheRedis] Cached prediction: ${hash}`);
    } catch (error) {
      console.error('[GeminiCacheRedis] Error setting prediction:', error);
    }
  }

  async getAdvancedAnalyticsExplanation(
    dashboardData: DashboardData,
    modelName: string
  ): Promise<AdvancedAnalyticsExplanation | null> {
    const hash = this.hashAdvancedExplanationData(dashboardData, modelName);
    const key = `${ADVANCED_EXPLANATION_PREFIX}${hash}`;

    try {
      const cached = await this.redis.get<CachedAdvancedAnalyticsExplanation>(key);
      if (!cached) {
        console.log('[GeminiCacheRedis] Advanced analytics explanation cache miss:', hash);
        return null;
      }

      const age = Math.round((Date.now() - cached.timestamp) / 1000);
      console.log(`[GeminiCacheRedis] Advanced analytics explanation cache hit: ${hash} (age: ${age}s)`);
      return cached.explanation;
    } catch (error) {
      console.error('[GeminiCacheRedis] Error getting advanced analytics explanation:', error);
      return null;
    }
  }

  async setAdvancedAnalyticsExplanation(
    dashboardData: DashboardData,
    explanation: AdvancedAnalyticsExplanation,
    modelName: string
  ): Promise<void> {
    const hash = this.hashAdvancedExplanationData(dashboardData, modelName);
    const key = `${ADVANCED_EXPLANATION_PREFIX}${hash}`;
    const fallbackKey = `${ADVANCED_EXPLANATION_FALLBACK_PREFIX}${Date.now()}`;

    const cached: CachedAdvancedAnalyticsExplanation = {
      explanation,
      timestamp: Date.now(),
      modelName,
      dataHash: hash,
    };

    try {
      await this.redis.set(key, cached, { ex: ADVANCED_EXPLANATION_TTL_SECONDS });
      await this.redis.lpush(ADVANCED_EXPLANATION_INDEX_KEY, key);
      await this.redis.ltrim(ADVANCED_EXPLANATION_INDEX_KEY, 0, MAX_ADVANCED_EXPLANATION_ENTRIES - 1);
      await this.redis.expire(ADVANCED_EXPLANATION_INDEX_KEY, ADVANCED_EXPLANATION_TTL_SECONDS);

      await this.redis.set(fallbackKey, cached, { ex: ADVANCED_EXPLANATION_TTL_SECONDS });
      await this.redis.lpush(ADVANCED_EXPLANATION_FALLBACK_INDEX_KEY, fallbackKey);
      await this.redis.ltrim(
        ADVANCED_EXPLANATION_FALLBACK_INDEX_KEY,
        0,
        MAX_ADVANCED_EXPLANATION_ENTRIES - 1
      );
      await this.redis.expire(
        ADVANCED_EXPLANATION_FALLBACK_INDEX_KEY,
        ADVANCED_EXPLANATION_TTL_SECONDS
      );

      console.log(`[GeminiCacheRedis] Cached advanced analytics explanation: ${hash}`);
    } catch (error) {
      console.error('[GeminiCacheRedis] Error setting advanced analytics explanation:', error);
    }
  }

  /**
   * Parse hash string back to numeric values
   */
  private parseHash(hash: string): ParsedHash | null {
    let parsed: Record<string, string | number | undefined>;
    try {
      parsed = JSON.parse(hash) as Record<string, string | number | undefined>;
    } catch {
      return null;
    }

    const parsedHash: ParsedHash = {
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_GEMINI_MODEL,
      us10y: Number(parsed.us10y),
      us2y: Number(parsed.us2y),
      t10y2y: Number(parsed.t10y2y),
      dxy: Number(parsed.dxy),
      spread: Number(parsed.spread),
      m2: Number(parsed.m2),
      spx: Number(parsed.spx),
      rut: Number(parsed.rut),
      oil: Number(parsed.oil),
      move: Number(parsed.move),
      ratio: Number(parsed.ratio),
      pmi: Number(parsed.pmi),
      vix: Number(parsed.vix),
      btc: Number(parsed.btc),
      usdkrw: Number(parsed.usdkrw),
      kospi: Number(parsed.kospi),
      kosdaq: Number(parsed.kosdaq),
      kr3y: Number(parsed.kr3y),
      kr10y: Number(parsed.kr10y),
      krsemi: Number(parsed.krsemi),
      krtb: Number(parsed.krtb),
    };

    for (const key of SIMILARITY_KEYS) {
      if (!Number.isFinite(parsedHash[key] as number)) {
        return null;
      }
    }

    return parsedHash;
  }

  /**
   * Calculate dynamic ranges (min-max) for each indicator across all cached predictions
   * Used for adaptive similarity calculation based on actual 24h cache data distribution
   */
  private calculateDynamicRanges(
    allCachedPredictions: CachedPrediction[]
  ): Record<string, number> {
    // Parse all cached hashes to numeric values
    const allValues = allCachedPredictions
      .map((prediction) => this.parseHash(prediction.dataHash))
      .filter((value): value is ParsedHash => value !== null);

    const ranges: Record<string, number> = {};
    if (allValues.length === 0) {
      for (const key of SIMILARITY_KEYS) {
        ranges[key] = 0;
      }
      return ranges;
    }

    // Calculate min-max range for each indicator
    for (const key of SIMILARITY_KEYS) {
      const values = allValues.map(v => v[key] as number);
      const min = Math.min(...values);
      const max = Math.max(...values);
      ranges[key] = max - min;
    }

    return ranges;
  }

  /**
   * Calculate similarity score using Hybrid Min-Max approach
   * Combines dynamic ranges (from actual cache data) with minimum thresholds
   * Returns 0-1 score (1 = identical, 0 = very different)
   *
   * @param currentData - Current dashboard data to compare
   * @param cachedHash - Hash of cached prediction to compare against
   * @param dynamicRanges - Min-max ranges calculated from all cached predictions
   * @param modelName - Model name to use for hashing current data
   */
  private calculateSimilarityHybrid(
    currentData: DashboardData,
    cachedHash: string,
    dynamicRanges: Record<string, number>,
    modelName: string
  ): number {
    const current = this.parseHash(this.hashData(currentData, modelName));
    const cached = this.parseHash(cachedHash);
    if (!current || !cached) {
      return 0;
    }

    let sumSquaredDiffs = 0;
    for (const key of SIMILARITY_KEYS) {
      // Effective range: max(dynamic range, minimum threshold)
      // Uses dynamic range when cache data varies, falls back to threshold for stability
      const effectiveRange = Math.max(
        dynamicRanges[key] || 0,
        MIN_THRESHOLDS[key]
      );

      const diff = Math.abs((current[key] as number) - (cached[key] as number)) / effectiveRange;
      sumSquaredDiffs += diff * diff;
    }

    // Average distance across all dimensions
    const distance = Math.sqrt(sumSquaredDiffs / SIMILARITY_KEYS.length);

    // Convert distance to similarity score (0-1, where 1 is most similar)
    // Using exponential decay: e^(-distance)
    return Math.exp(-distance);
  }

  /**
   * Calculate recency score based on timestamp
   * Returns 0-1 score (1 = just now, 0 = 24 hours old)
   */
  private calculateRecencyScore(timestamp: number): number {
    const ageHours = (Date.now() - timestamp) / (1000 * 60 * 60);
    const maxAgeHours = 24; // TTL duration

    // Linear decay: 0 hours = 1.0, 24 hours = 0.0
    return Math.max(0, 1 - (ageHours / maxAgeHours));
  }

  private async getIndexedFallbackKeys(): Promise<string[]> {
    const indexedKeys = await this.redis.lrange<string>(FALLBACK_INDEX_KEY, 0, MAX_FALLBACK_ENTRIES - 1);
    const filteredIndexedKeys = indexedKeys.filter((key) => key.startsWith(FALLBACK_PREFIX));
    if (filteredIndexedKeys.length > 0) {
      return filteredIndexedKeys;
    }

    const legacyKeys = await this.redis.keys(`${FALLBACK_PREFIX}*`);
    if (legacyKeys.length === 0) {
      return [];
    }

    const sortedLegacyKeys = legacyKeys.sort((a, b) => {
      const tsA = Number.parseInt(a.replace(FALLBACK_PREFIX, ''), 10);
      const tsB = Number.parseInt(b.replace(FALLBACK_PREFIX, ''), 10);
      return tsB - tsA;
    });
    const limitedLegacyKeys = sortedLegacyKeys.slice(0, MAX_FALLBACK_ENTRIES);

    await this.redis.del(FALLBACK_INDEX_KEY);
    for (let i = limitedLegacyKeys.length - 1; i >= 0; i--) {
      await this.redis.lpush(FALLBACK_INDEX_KEY, limitedLegacyKeys[i]);
    }
    await this.redis.expire(FALLBACK_INDEX_KEY, TTL_SECONDS);

    return limitedLegacyKeys;
  }

  private async getIndexedAdvancedFallbackKeys(): Promise<string[]> {
    const indexedKeys = await this.redis.lrange<string>(
      ADVANCED_EXPLANATION_FALLBACK_INDEX_KEY,
      0,
      MAX_ADVANCED_EXPLANATION_ENTRIES - 1
    );
    const filteredIndexedKeys = indexedKeys.filter((key) =>
      key.startsWith(ADVANCED_EXPLANATION_FALLBACK_PREFIX)
    );
    if (filteredIndexedKeys.length > 0) {
      return filteredIndexedKeys;
    }

    const legacyKeys = await this.redis.keys(`${ADVANCED_EXPLANATION_FALLBACK_PREFIX}*`);
    if (legacyKeys.length === 0) {
      return [];
    }

    const sortedLegacyKeys = legacyKeys.sort((a, b) => {
      const tsA = Number.parseInt(a.replace(ADVANCED_EXPLANATION_FALLBACK_PREFIX, ''), 10);
      const tsB = Number.parseInt(b.replace(ADVANCED_EXPLANATION_FALLBACK_PREFIX, ''), 10);
      return tsB - tsA;
    });
    const limitedLegacyKeys = sortedLegacyKeys.slice(0, MAX_ADVANCED_EXPLANATION_ENTRIES);

    await this.redis.del(ADVANCED_EXPLANATION_FALLBACK_INDEX_KEY);
    for (let i = limitedLegacyKeys.length - 1; i >= 0; i--) {
      await this.redis.lpush(ADVANCED_EXPLANATION_FALLBACK_INDEX_KEY, limitedLegacyKeys[i]);
    }
    await this.redis.expire(
      ADVANCED_EXPLANATION_FALLBACK_INDEX_KEY,
      ADVANCED_EXPLANATION_TTL_SECONDS
    );

    return limitedLegacyKeys;
  }

  /**
   * Get best matching prediction based on similarity to current data
   * Uses Hybrid Min-Max approach: dynamic ranges + minimum thresholds
   * Weighted scoring: 90% similarity, 10% recency
   */
  async getBestMatchingPrediction(
    currentData: DashboardData,
    modelName: string
  ): Promise<MarketPrediction | null> {
    try {
      const keys = await this.getIndexedFallbackKeys();

      if (keys.length === 0) {
        console.log('[GeminiCacheRedis] No fallback predictions available');
        return null;
      }

      // Fetch all cached predictions with their keys (maintain pairing)
      const keyPredictionPairs = await Promise.all(
        keys.map(async (key) => {
          const cached = await this.redis.get<CachedPrediction>(key);
          return { key, cached };
        })
      );

      // Filter out null predictions and filter by model
      const validPairs = keyPredictionPairs.filter(
        (pair): pair is { key: string; cached: CachedPrediction } => {
          if (pair.cached === null) return false;
          const parsedHash = this.parseHash(pair.cached.dataHash);
          if (!parsedHash) return false;
          const cachedModel = parsedHash.model;
          return cachedModel === modelName;
        }
      );

      if (validPairs.length === 0) return null;

      // Extract predictions for dynamic range calculation
      const validCachedPredictions = validPairs.map(p => p.cached);

      // Calculate dynamic ranges once for all comparisons
      const dynamicRanges = this.calculateDynamicRanges(validCachedPredictions);

      // Calculate scores for all cached predictions
      const scoredPredictions = validPairs.map(({ key, cached }) => {
        const similarityScore = this.calculateSimilarityHybrid(
          currentData,
          cached.dataHash,
          dynamicRanges,
          modelName
        );
        const recencyScore = this.calculateRecencyScore(cached.timestamp);

        // Weighted combination: 90% similarity, 10% recency
        const finalScore = similarityScore * 0.9 + recencyScore * 0.1;

        return {
          key,
          cached,
          similarityScore,
          recencyScore,
          finalScore,
        };
      });

      // Find best match
      const best = scoredPredictions.reduce((prev, curr) =>
        curr.finalScore > prev.finalScore ? curr : prev
      );

      const age = Math.round((Date.now() - best.cached.timestamp) / 1000);
      console.log(
        `[GeminiCacheRedis] Best match found (Hybrid Min-Max):`,
        `key=${best.key},`,
        `similarity=${best.similarityScore.toFixed(3)},`,
        `recency=${best.recencyScore.toFixed(3)},`,
        `final=${best.finalScore.toFixed(3)},`,
        `age=${age}s,`,
        `dynamic_ranges: us10y=${dynamicRanges.us10y.toFixed(3)}, dxy=${dynamicRanges.dxy.toFixed(1)}, btc=${dynamicRanges.btc.toFixed(0)}`
      );

      return best.cached.prediction;
    } catch (error) {
      console.error('[GeminiCacheRedis] Error getting best match:', error);
      return null;
    }
  }

  /**
   * @deprecated Use getBestMatchingPrediction instead
   * Get latest valid prediction for fallback (timestamp-based only)
   */
  async getLatestValidPrediction(): Promise<MarketPrediction | null> {
    try {
      const keys = await this.getIndexedFallbackKeys();

      if (keys.length === 0) {
        console.log('[GeminiCacheRedis] No fallback predictions available');
        return null;
      }

      for (const key of keys) {
        const cached = await this.redis.get<CachedPrediction>(key);
        if (!cached) {
          continue;
        }

        const age = Math.round((Date.now() - cached.timestamp) / 1000);
        console.log(`[GeminiCacheRedis] Fallback found: ${cached.dataHash} (age: ${age}s)`);
        return cached.prediction;
      }

      return null;
    } catch (error) {
      console.error('[GeminiCacheRedis] Error getting fallback:', error);
      return null;
    }
  }

  /**
   * Hash dashboard data for cache key
   */
  private hashAdvancedExplanationData(data: DashboardData, modelName: string): string {
    const normalizedIndicators = Object.keys(data.indicators)
      .sort()
      .map((key) => {
        const indicator = data.indicators[key as keyof DashboardData['indicators']];
        const historySignature = (indicator.history || [])
          .map((point) => `${point.date}:${point.value.toFixed(4)}`)
          .join('|');

        return {
          key,
          value: Number(indicator.value.toFixed(4)),
          changePercent: Number(indicator.changePercent.toFixed(4)),
          changePercent7d:
            indicator.changePercent7d !== undefined
              ? Number(indicator.changePercent7d.toFixed(4))
              : null,
          changePercent30d:
            indicator.changePercent30d !== undefined
              ? Number(indicator.changePercent30d.toFixed(4))
              : null,
          lastUpdated: indicator.lastUpdated,
          historySignature,
        };
      });

    const raw = JSON.stringify({
      model: modelName,
      timestamp: data.timestamp,
      indicators: normalizedIndicators,
    });

    return createHash('sha256').update(raw).digest('hex');
  }

  private hashData(data: DashboardData, modelName: string): string {
    const rounded = {
      model: modelName,
      us10y: data.indicators.us10yYield.value.toFixed(2),
      us2y: data.indicators.us2yYield.value.toFixed(2),
      t10y2y: data.indicators.yieldCurveSpread.value.toFixed(2),
      dxy: data.indicators.dxy.value.toFixed(1),
      spread: data.indicators.highYieldSpread.value.toFixed(1),
      m2: data.indicators.m2MoneySupply.value.toFixed(0),
      spx: data.indicators.sp500.value.toFixed(0),
      rut: data.indicators.russell2000.value.toFixed(0),
      oil: data.indicators.crudeOil.value.toFixed(1),
      move: data.indicators.moveIndex.value.toFixed(1),
      ratio: data.indicators.copperGoldRatio.value.toFixed(2),
      pmi: data.indicators.pmi.value.toFixed(1),
      vix: data.indicators.putCallRatio.value.toFixed(1),
      btc: (Math.round(data.indicators.bitcoin.value / 500) * 500).toFixed(0),
      usdkrw: data.indicators.usdKrw.value.toFixed(0),
      kospi: data.indicators.kospi.value.toFixed(0),
      kosdaq: data.indicators.kosdaq.value.toFixed(0),
      kr3y: data.indicators.kr3yBond.value.toFixed(0),
      kr10y: data.indicators.kr10yBond.value.toFixed(0),
      krsemi: data.indicators.koreaSemiconductorExportsProxy.value.toFixed(0),
      krtb: data.indicators.koreaTradeBalance.value.toFixed(1),
    };

    return JSON.stringify(rounded);
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    predictionKeys: number;
    fallbackKeys: number;
    advancedExplanationKeys: number;
    advancedFallbackKeys: number;
  }> {
    try {
      const predictionKeys = await this.redis.lrange<string>(PREDICTION_INDEX_KEY, 0, MAX_FALLBACK_ENTRIES - 1);
      const fallbackKeys = await this.getIndexedFallbackKeys();
      const advancedExplanationKeys = await this.redis.lrange<string>(
        ADVANCED_EXPLANATION_INDEX_KEY,
        0,
        MAX_ADVANCED_EXPLANATION_ENTRIES - 1
      );
      const advancedFallbackKeys = await this.getIndexedAdvancedFallbackKeys();

      return {
        predictionKeys: predictionKeys.length,
        fallbackKeys: fallbackKeys.length,
        advancedExplanationKeys: advancedExplanationKeys.length,
        advancedFallbackKeys: advancedFallbackKeys.length,
      };
    } catch (error) {
      console.error('[GeminiCacheRedis] Error getting stats:', error);
      return {
        predictionKeys: 0,
        fallbackKeys: 0,
        advancedExplanationKeys: 0,
        advancedFallbackKeys: 0,
      };
    }
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    try {
      const predictionKeys = await this.redis.lrange<string>(PREDICTION_INDEX_KEY, 0, MAX_FALLBACK_ENTRIES - 1);
      const fallbackKeys = await this.getIndexedFallbackKeys();
      const advancedExplanationKeys = await this.redis.lrange<string>(
        ADVANCED_EXPLANATION_INDEX_KEY,
        0,
        MAX_ADVANCED_EXPLANATION_ENTRIES - 1
      );
      const advancedFallbackKeys = await this.getIndexedAdvancedFallbackKeys();
      const legacyKeys = await this.redis.keys('gemini:*');
      const allKeys = Array.from(
        new Set([
          ...predictionKeys,
          ...fallbackKeys,
          ...advancedExplanationKeys,
          ...advancedFallbackKeys,
          ...legacyKeys,
          PREDICTION_INDEX_KEY,
          FALLBACK_INDEX_KEY,
          ADVANCED_EXPLANATION_INDEX_KEY,
          ADVANCED_EXPLANATION_FALLBACK_INDEX_KEY,
        ])
      );

      if (allKeys.length > 0) {
        await this.redis.del(...allKeys);
        console.log(`[GeminiCacheRedis] Cleared ${allKeys.length} keys`);
      }
    } catch (error) {
      console.error('[GeminiCacheRedis] Error clearing cache:', error);
    }
  }
}

// Singleton instance
export const geminiCache = new GeminiCacheRedis();
