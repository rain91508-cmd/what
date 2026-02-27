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
  WaveformInfo,
  WaveformSignal,
} from '../types';

interface KdbFileInfo {
  name: string;
  file_size: number;
  is_valid: boolean;
}

interface KdbListResponse {
  kdbs: KdbFileInfo[];
  summary: {
    total: number;
    valid: number;
    invalid: number;
  };
}

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

  isConnected(): boolean {
    return this.connected;
  }

  // Generic API request
  private async request<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<ApiResponse<T>> {
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

  async downloadKdb(
    kdbName: string,
    onProgress?: (downloaded: number, total: number) => void
  ): Promise<ArrayBuffer | null> {
    // First, get file info
    const info = await this.getKdbInfo(kdbName);
    if (info.status !== 'success' || !info.data) {
      console.error('[ApiService] Failed to get KDB info:', info);
      return null;
    }

    const totalSize = info.data.kdb_info.file_size;
    const chunkSize = 64 * 1024; // 64KB chunks
    const chunks: ArrayBuffer[] = [];
    let downloaded = 0;

    // Download in chunks
    for (let offset = 0; offset < totalSize; offset += chunkSize) {
      const end = Math.min(offset + chunkSize - 1, totalSize - 1);
      const result = await this.binaryRequest(`/api/kdb/${kdbName}/file`, { start: offset, end });

      if (!result) {
        console.error('[ApiService] Failed to download chunk at offset:', offset);
        return null;
      }

      chunks.push(result.data);
      downloaded += result.data.byteLength;
      onProgress?.(downloaded, totalSize);
    }

    // Combine chunks
    const combined = new Uint8Array(downloaded);
    let position = 0;
    for (const chunk of chunks) {
      combined.set(new Uint8Array(chunk), position);
      position += chunk.byteLength;
    }

    return combined.buffer;
  }

  // Waveform APIs
  async getWaveformList(): Promise<ApiResponse<WaveformInfo[]>> {
    return this.request('/api/wave/list');
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
