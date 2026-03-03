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
import { lod0ToFsWithStr } from '../components/TabPanel';

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

  configure(config: ServerConfig): void {
    const protocol = config.useHttps ? 'https' : 'http';
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

  // Generic API request
  private async request<T>(
    endpoint: string,
    options?: RequestInit
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
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      });

      if (!response.ok) {
        const error: ApiError = {
          code: `HTTP_${response.status}`,
          message: response.statusText,
        };
        return { status: 'error', data: null, error };
      }

      const data = await response.json();
      return { status: 'success', data: data.data, error: null };
    } catch (error) {
      const apiError: ApiError = {
        code: 'NETWORK_ERROR',
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

      const response = await fetch(`${this.baseUrl}${endpoint}`, { headers });

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
    return this.request(`/api/kdb/${kdbName}`);
  }

  // Note: downloadKdb removed - use kdbDownloadManager with Web Worker instead
  // for streaming download + zstd decompression + batch storage

  // Waveform APIs
  async getWaveformList(): Promise<ApiResponse<WaveListResponse>> {
    return this.request('/api/wave/list');
  }

  // Check if KDB has changed by comparing checksum
  async checkKdbChanged(kdbName: string, localChecksum?: string): Promise<{ changed: boolean; serverInfo?: ServerKdbFileInfo }> {
    const response = await this.request<KdbListResponse>('/api/kdb');
    if (response.status !== 'success' || !response.data) {
      return { changed: false };
    }

    const serverKdb = response.data.kdbs.find(k => k.name === kdbName);
    if (!serverKdb) {
      return { changed: false };
    }

    // If no local checksum, consider it as changed (needs download)
    if (!localChecksum) {
      return { changed: true, serverInfo: serverKdb };
    }

    // Compare checksums
    const changed = serverKdb.checksum !== localChecksum;
    return { changed, serverInfo: serverKdb };
  }

  // Check if Waveform has changed by comparing checksum
  async checkWaveformChanged(waveName: string, localChecksum?: string): Promise<{ changed: boolean; serverInfo?: ServerWaveFileInfo }> {
    const response = await this.request<WaveListResponse>('/api/wave/list');
    if (response.status !== 'success' || !response.data) {
      return { changed: false };
    }

    const serverWave = response.data.waves.find(w => w.name === waveName);
    if (!serverWave) {
      return { changed: false };
    }

    // If no local checksum, consider it as changed (needs download)
    if (!localChecksum) {
      return { changed: true, serverInfo: serverWave };
    }

    // Compare checksums
    const changed = serverWave.checksum !== localChecksum;
    return { changed, serverInfo: serverWave };
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

    return this.request(`/api/wave/${waveformName}/signals?${params}`);
  }

  async getWaveformSignalInfo(
    waveformName: string,
    signalName: string
  ): Promise<ApiResponse<{
    timeRange: { start: number; end: number; unit: string };
    transitionCount: number;
    lodLevels: number[];
  }>> {
    return this.request(`/api/wave/${waveformName}/info/${signalName}`);
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

    const endpoint = `/api/wave/${waveformName}/signals/${signalName}/data?${params}`;
    const result = await this.binaryRequest(endpoint, range);
    return result?.data || null;
  }

  /**
   * Download waveform chunk with LoD0Unit time range
   * Automatically converts LoD0Unit to fs using waveform's time unit
   * @param waveformName - Waveform name
   * @param signalName - Signal name
   * @param lod - Level of detail
   * @param lod0TimeRange - Time range in LoD0Units { start, end }
   * @param waveformTimeUnit - WaveformInfo.timeUnit (0=fs, 1=ps, 2=ns, 3=us, 4=ms, 5=s)
   * @param waveformTimeUnitStr - WaveformInfo.timeUnitStr (如 "1ps", "3ns")
   * @param range - Optional byte range for partial download
   * @param compress - Compression type
   */
  async downloadWaveformChunkLod0(
    waveformName: string,
    signalName: string,
    lod: number,
    lod0TimeRange: { start: number; end: number },
    waveformTimeUnit: number,
    waveformTimeUnitStr?: string,
    range?: { start: number; end: number },
    compress?: 'none' | 'zstd' | 'lz4'
  ): Promise<ArrayBuffer | null> {
    // Convert LoD0Unit to fs using timeUnitStr if available
    // Server API now uses fs as base unit
    const fsTimeRange = {
      start: lod0ToFsWithStr(lod0TimeRange.start, waveformTimeUnit, waveformTimeUnitStr),
      end: lod0ToFsWithStr(lod0TimeRange.end, waveformTimeUnit, waveformTimeUnitStr),
    };

    return this.downloadWaveformChunk(
      waveformName,
      signalName,
      lod,
      fsTimeRange,
      range,
      compress
    );
  }

  // Connection test
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      this.connected = response.ok;
      return this.connected;
    } catch {
      this.connected = false;
      return false;
    }
  }
}

// Singleton instance
export const apiService = new ApiService();
