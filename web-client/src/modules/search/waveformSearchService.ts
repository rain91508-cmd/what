// ============================================
// Waveform Search Service - Pattern search in waveform
// ============================================

import { apiService } from '../../services/api';

export type WaveformSearchType = 'value' | 'edge' | 'transition';
export type EdgeType = 'rising' | 'falling' | 'any';
export type WaveformSearchDirection = 'forward' | 'backward';

export interface WaveformSearchResult {
  time: number;
  value: string;
}

export interface WaveformSearchParams {
  signalName: string;
  searchType: WaveformSearchType;
  valuePattern?: string;      // For value mode
  edgeType?: EdgeType;        // For edge mode
  fromValue?: string;         // For transition mode
  toValue?: string;           // For transition mode
  radix: string;
}

export interface WaveformSearchCache {
  params: WaveformSearchParams;
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
    params: WaveformSearchParams,
    startTime: number,
    direction: WaveformSearchDirection,
    maxResults: number = 100
  ): Promise<WaveformSearchResult[]> {
    // Check if we can use cached results
    if (this.canUseCache(params, startTime)) {
      console.log('[WaveformSearchService] Using cached results');
      return this.findFromCache(startTime, direction);
    }

    // Build pattern based on search type
    const pattern = this.buildPattern(params);

    // Build request body
    const requestBody: Record<string, unknown> = {
      start_time: startTime,
      direction: direction,
      pattern: pattern,
      max_results: maxResults,
    };

    // Add time_range if available (optional optimization)
    // This helps limit the search range on the server side
    // requestBody.time_range = {
    //   start: 0,
    //   end: waveformEndTime,
    // };

    // Encode signal name using Base64 (required by API)
    // Format: b64:base64encodedstring
    const encodedSignalName = 'b64:' + btoa(params.signalName);

    // Call API
    const response = await apiService.post(
      `/api/wave/${encodeURIComponent(waveformName)}/signals/${encodedSignalName}/pattern-search`,
      requestBody
    );

    if (response.error) {
      throw new Error(response.error);
    }

    const matches: WaveformSearchResult[] = response.data?.matches || [];

    // Update cache
    if (matches.length > 0) {
      const times = matches.map(m => m.time);
      this.cache = {
        params,
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
  private buildPattern(params: WaveformSearchParams): object {
    switch (params.searchType) {
      case 'value':
        return {
          type: 'value',
          value: params.valuePattern || '',
          radix: params.radix,
        };
      
      case 'edge':
        return {
          type: 'edge',
          edge_type: params.edgeType || 'any',
        };
      
      case 'transition':
        return {
          type: 'transition',
          from_value: params.fromValue || '',
          to_value: params.toValue || '',
          radix: params.radix,
        };
      
      default:
        return {
          type: 'value',
          value: params.valuePattern || '',
          radix: params.radix,
        };
    }
  }

  /**
   * Check if cached results can be used
   */
  private canUseCache(
    params: WaveformSearchParams,
    startTime: number
  ): boolean {
    if (!this.cache) return false;

    const cached = this.cache.params;

    // Check if search parameters match
    if (
      cached.signalName !== params.signalName ||
      cached.searchType !== params.searchType ||
      cached.radix !== params.radix
    ) {
      return false;
    }

    // Check type-specific parameters
    if (params.searchType === 'value' && cached.valuePattern !== params.valuePattern) {
      return false;
    }
    if (params.searchType === 'edge' && cached.edgeType !== params.edgeType) {
      return false;
    }
    if (params.searchType === 'transition' && 
        (cached.fromValue !== params.fromValue || cached.toValue !== params.toValue)) {
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
