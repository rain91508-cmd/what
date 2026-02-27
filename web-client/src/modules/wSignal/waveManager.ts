// ============================================
// Waveform Manager - Wave List & Data Management
// ============================================
//
// Responsibilities:
// - Fetch waveform list from server
// - Query signal existence in waveform
// - Manage waveform metadata
// - Coordinate with OPFS for waveform data caching

import { apiService } from '../../services/api';
import type { WaveformInfo, WaveformSignal } from '../../types';

// Note: Using inline type from API response
// interface WaveformSignalsResponse {
//   waveform_name: string;
//   signal_count: number;
//   signals: WaveformSignal[];
// }

class WaveManager {
  private waveforms: Map<string, WaveformInfo> = new Map();
  private currentWaveform: string | null = null;

  /**
   * Fetch waveform list from server
   */
  async fetchWaveformList(): Promise<WaveformInfo[]> {
    try {
      const response = await apiService.getWaveformList();
      if (response.status === 'success' && response.data && (response.data as any).waves) {
        const waves = (response.data as any).waves as WaveformInfo[];
        // Update local cache
        this.waveforms.clear();
        for (const wave of waves) {
          this.waveforms.set(wave.name, wave);
        }
        console.log('[WaveManager] Loaded', waves.length, 'waveforms');
        return waves;
      }
      return [];
    } catch (error) {
      console.error('[WaveManager] Failed to fetch waveform list:', error);
      return [];
    }
  }

  /**
   * Get cached waveform list
   */
  getWaveformList(): WaveformInfo[] {
    return Array.from(this.waveforms.values());
  }

  /**
   * Get waveform by name
   */
  getWaveform(name: string): WaveformInfo | null {
    return this.waveforms.get(name) || null;
  }

  /**
   * Set current waveform
   */
  setCurrentWaveform(name: string): boolean {
    if (this.waveforms.has(name)) {
      this.currentWaveform = name;
      return true;
    }
    return false;
  }

  /**
   * Get current waveform name
   */
  getCurrentWaveform(): string | null {
    return this.currentWaveform;
  }

  /**
   * Query signals in waveform with filtering
   */
  async querySignals(
    waveformName: string,
    options?: {
      nameRegex?: string;
      handleFrom?: number;
      handleTo?: number;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ signals: WaveformSignal[]; total: number }> {
    try {
      const response = await apiService.getWaveformSignals(waveformName, options);
      if (response.status === 'success' && response.data) {
        return {
          signals: response.data.signals || [],
          total: (response.data as any).signal_count || (response.data as any).count || 0,
        };
      }
      return { signals: [], total: 0 };
    } catch (error) {
      console.error('[WaveManager] Failed to query signals:', error);
      return { signals: [], total: 0 };
    }
  }

  /**
   * Check if a signal exists in the waveform
   * This is used to verify KDB signals have waveform data
   */
  async checkSignalExists(waveformName: string, signalName: string): Promise<boolean> {
    try {
      const response = await apiService.getWaveformSignalInfo(waveformName, signalName);
      return response.status === 'success';
    } catch {
      return false;
    }
  }

  /**
   * Check if a signal exists in the current waveform
   */
  async checkSignalExistsInCurrent(signalName: string): Promise<boolean> {
    if (!this.currentWaveform) return false;
    return this.checkSignalExists(this.currentWaveform, signalName);
  }

  /**
   * Get signal info from waveform
   */
  async getSignalInfo(
    waveformName: string,
    signalName: string
  ): Promise<{
    timeRange: { start: number; end: number; unit: string };
    transitionCount: number;
    lodLevels: number[];
  } | null> {
    try {
      const response = await apiService.getWaveformSignalInfo(waveformName, signalName);
      if (response.status === 'success' && response.data) {
        return response.data;
      }
      return null;
    } catch (error) {
      console.error('[WaveManager] Failed to get signal info:', error);
      return null;
    }
  }

  /**
   * Download waveform data chunk
   */
  async downloadWaveformChunk(
    waveformName: string,
    signalName: string,
    lod: number,
    timeRange: { start: number; end: number },
    range?: { start: number; end: number }
  ): Promise<ArrayBuffer | null> {
    try {
      return await apiService.downloadWaveformChunk(
        waveformName,
        signalName,
        lod,
        timeRange,
        range
      );
    } catch (error) {
      console.error('[WaveManager] Failed to download waveform chunk:', error);
      return null;
    }
  }

  /**
   * Get available waveforms count
   */
  getWaveformCount(): number {
    return this.waveforms.size;
  }

  /**
   * Check if any waveforms are available
   */
  hasWaveforms(): boolean {
    return this.waveforms.size > 0;
  }

  /**
   * Clear cached waveforms
   */
  clear(): void {
    this.waveforms.clear();
    this.currentWaveform = null;
  }
}

// Singleton instance
export const waveManager = new WaveManager();
