// ============================================
// API Service - Server Communication
// ============================================
//
// Responsibilities (per spec.md):
// - HTTP/1.1 Range request support
// - Knowledge base download
// - Waveform data fetching
// - Error handling and retry logic

import type {
  ApiResponse,
  ApiError,
  ServerConfig,
  WaveformSignal,
  KdbListResponse,
  WaveListResponse,
  ServerKdbFileInfo,
  ServerWaveFileInfo,
} from '../types';

interface KdbInfoResponse {
  kdb_info: {
    design_name: string;
    version: string;
    signal_count: number;
    module_count: number;
    file_size: number;
    checksum: string;
  };
}

class ApiService {
  private baseUrl: string = '';
  private connected = false;
  // Default timeout: 30s for normal requests, 5s for health check
  private requestTimeout = 30000;

  configure(config: ServerConfig): void {
    // Auto-use HTTPS for port 443, otherwise respect useHttps flag
    const protocol = (config.useHttps || config.port === 443) ? 'https' : 'http';
    this.baseUrl = `${protocol}://${config.host}:${config.port}`;
  }

  clearConfig(): void {
    this.baseUrl = '';
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  hasConfig(): boolean {
    return this.baseUrl !== '';
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Create a fetch request with AbortController timeout.
   * Returns the Response on success, throws on timeout or network error.
   */
  private async fetchWithTimeout(
    url: string,
    timeoutMs: number,
    init?: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  // Generic API request
  private async request<T>(
    endpoint: string,
    options?: RequestInit,
    timeoutMs?: number
  ): Promise<ApiResponse<T>> {
    // Check if configured
    if (!this.baseUrl) {
      const error: ApiError = {
        code: 'NOT_CONFIGURED',
        message: 'Server not configured. Please connect first.',
      };
      return { status: 'error', data: null, error };
    }
    
    try {
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}${endpoint}`,
        timeoutMs ?? this.requestTimeout,
        {
          ...options,
          headers: {
            ...options?.headers,
          },
        }
      );

      if (!response.ok) {
        // Try to get detailed error message from response body
        let errorMessage = response.statusText;
        let errorCode = `HTTP_${response.status}`;
        try {
          const errorData = await response.json();
          // Priority: error.message > message > error (string) > error (object)
          if (errorData && errorData.error) {
            if (errorData.error.message) {
              errorMessage = errorData.error.message;
              if (errorData.error.code) {
                errorCode = errorData.error.code;
              }
            } else if (typeof errorData.error === 'string') {
              errorMessage = errorData.error;
            } else {
              errorMessage = JSON.stringify(errorData.error);
            }
          } else if (errorData && errorData.message) {
            errorMessage = errorData.message;
          }
        } catch {
          // If JSON parsing fails, use statusText
        }
        
        const error: ApiError = {
          code: errorCode,
          message: errorMessage,
        };
        return { status: 'error', data: null, error };
      }

      // Wrap success-path JSON parse in its own try/catch so a non-JSON 200
      // is reported as PARSE_ERROR, not NETWORK_ERROR.
      let data: any;
      try {
        data = await response.json();
      } catch (parseError) {
        const apiError: ApiError = {
          code: 'PARSE_ERROR',
          message: `Server returned non-JSON response for ${response.status}`,
        };
        return { status: 'error', data: null, error: apiError };
      }
      // Support both { data: ... } wrapper and direct response
      const responseData = data.data !== undefined ? data.data : data;
      return { status: 'success', data: responseData, error: null };
    } catch (error) {
      const apiError: ApiError = {
        code: (error instanceof DOMException && error.name === 'AbortError')
          ? 'TIMEOUT' : 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
      return { status: 'error', data: null, error: apiError };
    }
  }

  // Binary request with Range support
  private async binaryRequest(
    endpoint: string,
    range?: { start: number; end: number }
  ): Promise<{ data: ArrayBuffer; totalSize?: number; contentRange?: string } | null> {
    try {
      const headers: HeadersInit = {};
      if (range) {
        headers['Range'] = `bytes=${range.start}-${range.end}`;
      }

      const response = await this.fetchWithTimeout(
        `${this.baseUrl}${endpoint}`,
        this.requestTimeout,
        { headers }
      );

      if (!response.ok && response.status !== 206) {
        return null;
      }

      const data = await response.arrayBuffer();
      const contentRange = response.headers.get('Content-Range') || undefined;
      let totalSize: number | undefined;

      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/);
        if (match) {
          totalSize = parseInt(match[1], 10);
        }
      }

      return { data, totalSize, contentRange };
    } catch (error) {
      console.error('Binary request failed:', error);
      return null;
    }
  }

  // Knowledge Base APIs
  async getKdbList(): Promise<ApiResponse<KdbListResponse>> {
    return this.request('/api/kdb');
  }

  async getKdbInfo(kdbName: string): Promise<ApiResponse<KdbInfoResponse>> {
    return this.request(`/api/kdb/${encodeURIComponent(kdbName)}`);
  }

  // Note: downloadKdb removed - use kdbDownloadManager with Web Worker instead
  // for streaming download + zstd decompression + batch storage

  // Waveform APIs
  async getWaveformList(): Promise<ApiResponse<WaveListResponse>> {
    return this.request('/api/wave/list');
  }

  // Check if KDB has changed by comparing checksum.
  // Returns a tri-state: 'changed', 'unchanged', or 'error'.
  async checkKdbChanged(kdbName: string, localChecksum?: string): Promise<{ status: 'changed' | 'unchanged' | 'error'; serverInfo?: ServerKdbFileInfo }> {
    const response = await this.request<KdbListResponse>('/api/kdb');
    if (response.status !== 'success' || !response.data) {
      return { status: 'error' };
    }

    const serverKdb = response.data.kdbs.find(k => k.name === kdbName);
    if (!serverKdb) {
      return { status: 'error' };
    }

    // If no local checksum, consider it as changed (needs download)
    if (!localChecksum) {
      return { status: 'changed', serverInfo: serverKdb };
    }

    // Compare checksums
    const changed = serverKdb.checksum !== localChecksum;
    return { status: changed ? 'changed' : 'unchanged', serverInfo: serverKdb };
  }

  // Check if Waveform has changed by comparing checksum.
  // Returns a tri-state: 'changed', 'unchanged', or 'error'.
  async checkWaveformChanged(waveName: string, localChecksum?: string): Promise<{ status: 'changed' | 'unchanged' | 'error'; serverInfo?: ServerWaveFileInfo }> {
    const response = await this.request<WaveListResponse>('/api/wave/list');
    if (response.status !== 'success' || !response.data) {
      return { status: 'error' };
    }

    const serverWave = response.data.waves.find(w => w.name === waveName);
    if (!serverWave) {
      return { status: 'error' };
    }

    // If no local checksum, consider it as changed (needs download)
    if (!localChecksum) {
      return { status: 'changed', serverInfo: serverWave };
    }

    // Compare checksums
    const changed = serverWave.checksum !== localChecksum;
    return { status: changed ? 'changed' : 'unchanged', serverInfo: serverWave };
  }

  async getWaveformSignals(
    waveformName: string,
    options?: {
      nameRegex?: string;
      handleFrom?: number;
      handleTo?: number;
      limit?: number;
      offset?: number;
    }
  ): Promise<ApiResponse<{ signals: WaveformSignal[]; count: number }>> {
    const params = new URLSearchParams();
    if (options?.nameRegex) params.set('name_regex', options.nameRegex);
    if (options?.handleFrom !== undefined) params.set('handle_from', options.handleFrom.toString());
    if (options?.handleTo !== undefined) params.set('handle_to', options.handleTo.toString());
    if (options?.limit !== undefined) params.set('limit', options.limit.toString());
    if (options?.offset !== undefined) params.set('offset', options.offset.toString());

    return this.request(`/api/wave/${encodeURIComponent(waveformName)}/signals?${params}`);
  }

  async getWaveformSignalInfo(
    waveformName: string,
    signalName: string
  ): Promise<ApiResponse<{
    timeRange: { start: number; end: number; unit: string };
    transitionCount: number;
    lodLevels: number[];
  }>> {
    return this.request(`/api/wave/${encodeURIComponent(waveformName)}/info/${encodeURIComponent(signalName)}`);
  }

  // Get waveform file metadata
  async getWaveformInfo(waveformName: string): Promise<ApiResponse<{
    wave_info: {
      name: string;
      file_size: number;
      signal_count: number;
      start_time: number;
      end_time: number;
      time_unit: string;
      time_precision: string;
      version: string;
      date: string;
    }
  }>> {
    return this.request(`/api/wave/${encodeURIComponent(waveformName)}/info`);
  }

  async downloadWaveformChunk(
    waveformName: string,
    signalName: string,
    lod: number,
    timeRange: { start: number; end: number },
    range?: { start: number; end: number },
    compress?: 'none' | 'zstd' | 'lz4'
  ): Promise<ArrayBuffer | null> {
    const params = new URLSearchParams();
    params.set('lod', lod.toString());
    params.set('start', timeRange.start.toString());
    params.set('end', timeRange.end.toString());
    if (compress) params.set('compress', compress);

    const endpoint = `/api/wave/${encodeURIComponent(waveformName)}/signals/${encodeURIComponent(signalName)}/data?${params}`;
    const result = await this.binaryRequest(endpoint, range);
    return result?.data || null;
  }

  /**
   * Download waveform chunk with LoD0Unit time range
   * Server API now uses LoD0Unit directly
   * @param waveformName - Waveform name
   * @param signalName - Signal name
   * @param lod - Level of detail
   * @param lod0TimeRange - Time range in LoD0Units { start, end }
   * @param range - Optional byte range for partial download
   * @param compress - Compression type
   */
  async downloadWaveformChunkLod0(
    waveformName: string,
    signalName: string,
    lod: number,
    lod0TimeRange: { start: number; end: number },
    range?: { start: number; end: number },
    compress?: 'none' | 'zstd' | 'lz4'
  ): Promise<ArrayBuffer | null> {
    // Server API now uses LoD0Unit directly, no conversion needed
    return this.downloadWaveformChunk(
      waveformName,
      signalName,
      lod,
      lod0TimeRange,
      range,
      compress
    );
  }

  // Connection test (short timeout: 5s)
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/health`, 5000);
      // Validate content-type to avoid false positives from proxy error pages
      if (!response.ok) {
        this.connected = false;
        return false;
      }
      const ct = response.headers.get('Content-Type') || '';
      if (ct.includes('json') || ct.includes('text')) {
        this.connected = true;
        return true;
      }
      // Non-JSON/text response from health endpoint is suspicious
      console.warn(`[API] /health returned unexpected Content-Type: ${ct}, accepting anyway`);
      this.connected = true;
      return true;
    } catch (error) {
      this.connected = false;
      return false;
    }
  }

  // POST request
  async post<T>(endpoint: string, body: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}

// Singleton instance
export const apiService = new ApiService();
