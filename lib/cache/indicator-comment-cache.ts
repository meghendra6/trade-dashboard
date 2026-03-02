import { Redis } from '@upstash/redis';
import { IndicatorData } from '../types/indicators';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
});

const COMMENT_PREFIX = 'indicator:comment:';
const FALLBACK_PREFIX = 'indicator:comment:fallback:';
const FALLBACK_INDEX_PREFIX = 'indicator:comment:fallback:index:';

interface CachedComment {
  comment: string;
  timestamp: number;
  symbol: string;
  value: number;
}

/**
 * Cache for individual indicator AI comments
 *
 * Strategy: Very aggressive rounding to maximize cache hit rate (50-70% target)
 * - BTC: $5,000 units ($96,500 → $95,000)
 * - US10Y/US2Y/T10Y2Y/HYS/MOVE: 0.5 units
 * - DXY/VIX: 5.0 units (103.47 → 105)
 * - OIL: $5 units ($56.6 → $55)
 * - Cu/Au: 0.5 units (13.32 → 13.5)
 * - M2: $500B units
 * - MFG: 0.5 units
 * - SPX/IXIC/RUT/KOSPI: 25 units
 * - KOSDAQ: 10 units
 * - KR3Y/KR10Y/KRSEMI: 1 unit
 * - USDKRW: 10 KRW
 * - EWY/GOLD: $1 units
 * - KRTB: 0.1 trillion KRW
 *
 * Cache key: Only uses indicator value (no date, no change percentages)
 * - AI comments describe general trends, not exact values
 * - Value-based caching sufficient for meaningful insights
 *
 * TTL: 25 hours (90,000 seconds)
 * - Aligns with daily indicator update cycle
 * - Covers weekends (Friday data available through Saturday)
 */
class IndicatorCommentCache {
  private readonly TTL = 90000; // 25 hours in seconds
  private readonly MAX_FALLBACK_ENTRIES = 5;

  /**
   * Round indicator value based on symbol for cache key (5x more aggressive)
   */
  private roundValue(symbol: string, value: number): number {
    switch (symbol) {
      case 'BTC':
        return Math.round(value / 5000) * 5000; // $5,000 units ($96,500 → $95,000)
      case 'US10Y':
      case 'US2Y':
      case 'T10Y2Y':
      case 'HYS':
      case 'MOVE':
        return Math.round(value * 2) / 2; // 0.5% units (4.52% → 4.5%)
      case 'DXY':
      case 'VIX':
        return Math.round(value / 5) * 5; // 5.0 units (103.47 → 105)
      case 'SPX':
      case 'IXIC':
      case 'RUT':
      case 'KOSPI':
        return Math.round(value / 25) * 25;
      case 'KOSDAQ':
        return Math.round(value / 10) * 10;
      case 'M2':
        return Math.round(value / 500) * 500; // $500B units
      case 'OIL':
        return Math.round(value / 5) * 5; // $5 units ($56.6 → $55)
      case 'USDKRW':
        return Math.round(value / 10) * 10;
      case 'KR3Y':
      case 'KR10Y':
      case 'KRSEMI':
        return Math.round(value);
      case 'KRTB':
        return Math.round(value * 10) / 10;
      case 'Cu/Au':
        return Math.round(value * 2) / 2; // 0.5 units (13.32 → 13.5)
      case 'MFG':
        return Math.round(value * 2) / 2; // 0.5 units
      case 'EWY':
      case 'GOLD':
        return Math.round(value);
      case 'CPI':
        return Math.round(value * 10) / 10; // 0.1 units (308.417 → 308.4)
      case 'PAYEMS':
        return Math.round(value * 100) / 100; // 0.01M units (159.526 → 159.53)
      default:
        return Math.round(value); // Default: integer units
    }
  }

  /**
   * Generate cache key from indicator data (value-only strategy)
   */
  private getCacheKey(symbol: string, data: IndicatorData): string {
    const roundedValue = this.roundValue(symbol, data.value);
    return `${COMMENT_PREFIX}${symbol}:${roundedValue}`;
  }

  /**
   * Generate fallback key with timestamp
   */
  private getFallbackKey(symbol: string): string {
    return `${FALLBACK_PREFIX}${symbol}:${Date.now()}`;
  }

  private getFallbackIndexKey(symbol: string): string {
    return `${FALLBACK_INDEX_PREFIX}${symbol}`;
  }

  /**
   * Get cached AI comment for indicator
   */
  async getComment(symbol: string, data: IndicatorData): Promise<string | null> {
    try {
      const key = this.getCacheKey(symbol, data);
      const cached = await redis.get<string>(key);

      if (cached) {
        console.log(`[IndicatorCommentCache] Cache hit: ${key}`);
      }

      return cached;
    } catch (error) {
      console.error('[IndicatorCommentCache] Error getting cache:', error);
      return null;
    }
  }

  /**
   * Set cached AI comment for indicator (with fallback storage)
   */
  async setComment(symbol: string, data: IndicatorData, comment: string): Promise<void> {
    try {
      const key = this.getCacheKey(symbol, data);
      const fallbackKey = this.getFallbackKey(symbol);

      const cached: CachedComment = {
        comment,
        timestamp: Date.now(),
        symbol,
        value: data.value,
      };

      // Store with value-based key (for exact match)
      await redis.setex(key, this.TTL, comment);

      // Also store with timestamp key (for fallback retrieval)
      await redis.set(fallbackKey, cached, { ex: this.TTL });
      const fallbackIndexKey = this.getFallbackIndexKey(symbol);
      await redis.lpush(fallbackIndexKey, fallbackKey);
      await redis.ltrim(fallbackIndexKey, 0, this.MAX_FALLBACK_ENTRIES - 1);
      await redis.expire(fallbackIndexKey, this.TTL);

      console.log(`[IndicatorCommentCache] Cached: ${key}`);
    } catch (error) {
      console.error('[IndicatorCommentCache] Error setting cache:', error);
    }
  }

  /**
   * Get latest cached comment for a symbol (fallback mechanism)
   */
  async getLatestComment(symbol: string): Promise<string | null> {
    try {
      const fallbackIndexKey = this.getFallbackIndexKey(symbol);
      let keys = await redis.lrange<string>(fallbackIndexKey, 0, this.MAX_FALLBACK_ENTRIES - 1);

      if (keys.length === 0) {
        const legacyKeys = await redis.keys(`${FALLBACK_PREFIX}${symbol}:*`);
        if (legacyKeys.length > 0) {
          const sortedLegacyKeys = legacyKeys.sort((a, b) => {
            const tsA = Number.parseInt(a.split(':').pop() || '0', 10);
            const tsB = Number.parseInt(b.split(':').pop() || '0', 10);
            return tsB - tsA;
          });
          keys = sortedLegacyKeys.slice(0, this.MAX_FALLBACK_ENTRIES);

          await redis.del(fallbackIndexKey);
          for (let i = keys.length - 1; i >= 0; i--) {
            await redis.lpush(fallbackIndexKey, keys[i]);
          }
          await redis.expire(fallbackIndexKey, this.TTL);
        }
      }

      if (keys.length === 0) {
        console.log(`[IndicatorCommentCache] No fallback available for ${symbol}`);
        return null;
      }

      for (const fallbackKey of keys) {
        const cached = await redis.get<CachedComment>(fallbackKey);
        if (!cached) {
          continue;
        }

        const age = Math.round((Date.now() - cached.timestamp) / 1000);
        console.log(
          `[IndicatorCommentCache] Fallback found for ${symbol}: value=${cached.value.toFixed(2)}, age=${age}s`
        );
        return cached.comment;
      }

      return null;
    } catch (error) {
      console.error(`[IndicatorCommentCache] Error getting fallback for ${symbol}:`, error);
      return null;
    }
  }
}

export const indicatorCommentCache = new IndicatorCommentCache();
