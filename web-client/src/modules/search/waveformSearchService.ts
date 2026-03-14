// ============================================
// Waveform Search Service - Pattern search in waveform
// ============================================

import { apiService } from '../../services/api';

export type WaveformSearchType = 'value' | 'transition';
export type WaveformSearchDirection = 'forward' | 'backward';

export interface WaveformSearchResult {
  time: number;
  value: string;
}

export interface WaveformSearchCache {
  signalName: string;
  searchType: WaveformSearchType;
  patternValue: string;
  radix: string;
  results: WaveformSearchResult[];
  minTime: number;
  maxTime: number;
}

class WaveformSearchService {
  private cache: WaveformSearchCache | null = null;

  /**
   * Perform pattern search on waveform
   */
  async search(
    waveformName: string,
    signalName: string,
    searchType: WaveformSearchType,
    patternValue: string,
    radix: string,
    startTime: number,
    direction: WaveformSearchDirection,
    maxResults: number = 100
  ): Promise<WaveformSearchResult[]> {
    // Check if we can use cached results
    if (this.canUseCache(signalName, searchType, patternValue, radix, startTime)) {
      console.log('[WaveformSearchService] Using cached results');
      return this.findFromCache(startTime, direction);
    }

    // Build pattern based on search type
    const pattern = this.buildPattern(searchType, patternValue, radix);

    // Call API
    const response = await apiService.post(
      `/api/wave/${encodeURIComponent(waveformName)}/signals/${encodeURIComponent(signalName)}/pattern-search`,
      {
        start_time: startTime,
        direction: direction,
        pattern: pattern,
        max_results: maxResults,
      }
    );

    if (response.error) {
      throw new Error(response.error);
    }

    const matches: WaveformSearchResult[] = response.data?.matches || [];

    // Update cache
    if (matches.length > 0) {
      const times = matches.map(m => m.time);
      this.cache = {
        signalName,
        searchType,
        patternValue,
        radix,
        results: matches,
        minTime: Math.min(...times),
        maxTime: Math.max(...times),
      };
    }

    return matches;
  }

  /**
   * Build pattern object for API
   */
  private buildPattern(
    searchType: WaveformSearchType,
    patternValue: string,
    radix: string
  ): object {
    if (searchType === 'value') {
      return {
        type: 'value',
        value: patternValue,
        radix: radix,
      };
    } else {
      // transition
      // Parse "0->1" or "0 1" format
      const parts = patternValue.split(/->|\s+/).filter(p => p.trim());
      if (parts.length >= 2) {
        return {
          type: 'transition',
          from_value: parts[0],
          to_value: parts[1],
          radix: radix,
        };
      }
      // Fallback to value search if parsing fails
      return {
        type: 'value',
        value: patternValue,
        radix: radix,
      };
    }
  }

  /**
   * Check if cached results can be used
   */
  private canUseCache(
    signalName: string,
    searchType: WaveformSearchType,
    patternValue: string,
    radix: string,
    startTime: number
  ): boolean {
    if (!this.cache) return false;

    // Check if search parameters match
    if (
      this.cache.signalName !== signalName ||
      this.cache.searchType !== searchType ||
      this.cache.patternValue !== patternValue ||
      this.cache.radix !== radix
    ) {
      return false;
    }

    // Check if startTime is within cached range
    if (startTime < this.cache.minTime || startTime > this.cache.maxTime) {
      return false;
    }

    return true;
  }

  /**
   * Find results from cache based on startTime and direction
   */
  private findFromCache(
    startTime: number,
    direction: WaveformSearchDirection
  ): WaveformSearchResult[] {
    if (!this.cache) return [];

    if (direction === 'forward') {
      // Find results after startTime
      return this.cache.results.filter(r => r.time > startTime);
    } else {
      // Find results before startTime
      return this.cache.results.filter(r => r.time < startTime).reverse();
    }
  }

  /**
   * Find the closest result to startTime
   */
  findClosestResult(
    results: WaveformSearchResult[],
    startTime: number,
    direction: WaveformSearchDirection
  ): WaveformSearchResult | null {
    if (results.length === 0) return null;

    if (direction === 'forward') {
      // Find first result after startTime
      return results.find(r => r.time > startTime) || null;
    } else {
      // Find first result before startTime (results are already reversed)
      return results.find(r => r.time < startTime) || null;
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache = null;
  }

  /**
   * Get cache info for debugging
   */
  getCacheInfo(): WaveformSearchCache | null {
    return this.cache;
  }
}

// Singleton instance
export const waveformSearchService = new WaveformSearchService();
