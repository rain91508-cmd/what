/**
 * WASM Waveform Provider - Direct Mode
 * 
 * 直接 WASM 模式的包装器实现。
 * 包装现有的 WaveformDataProvider，实现 WaveformProviderInterface 接口。
 */

import {
  WaveformProviderInterface,
  ProviderConfig,
  ViewportConfig,
  CanvasConfig,
  WasmSignalInfo,
  RenderSegment,
  ValueInfo,
  WaveformProviderError,
  SignalInfo,
  SignalSegment,
} from '../core/waveformProviderInterface';
import { WaveformDataProvider } from '../../wasm-pkg/hwda_wasm.js';
import { initWasm, createProvider, getSignalManager } from './waveformProvider';
import { getSignalIdManager } from '../core/cache/signalIdManager';

/**
 * 直接 WASM 模式波形提供者
 * 
 * 包装现有的 WaveformDataProvider，实现标准接口。
 * 所有操作在主线程同步执行。
 */
export class WasmWaveformProvider implements WaveformProviderInterface {
  private wasmProvider: WaveformDataProvider | null = null;
  private viewport: ViewportConfig = { startTime: 0, endTime: 1000, width: 800, height: 600 };
  private canvas: CanvasConfig = { width: 800, height: 600, rowHeight: 24 };
  private _isOpfsEnabled = false;
  private _isMemoryCacheEnabled = true;

  /**
   * 初始化提供者
   */
  async initialize(config: ProviderConfig): Promise<void> {
    try {
      // 初始化 WASM 模块
      await initWasm();

      // 创建 WASM provider
      this.wasmProvider = await createProvider(
        config.serverUrl,
        config.waveformName,
        config.signalPrefix,
        config.spaceBeforeBracket,
        config.timeStamp,
        config.enableOpfs ?? false
      );

      this._isOpfsEnabled = config.enableOpfs ?? false;
      this._isMemoryCacheEnabled = config.enableMemoryCache ?? true;

      // 设置内存缓存
      if (this.wasmProvider) {
        this.wasmProvider.set_memory_cache_enabled(this._isMemoryCacheEnabled);
      }

      console.log('[WasmWaveformProvider] Initialized successfully');
    } catch (error) {
      console.error('[WasmWaveformProvider] Initialization failed:', error);
      throw new WaveformProviderError('Failed to initialize WASM provider', error);
    }
  }

  /**
   * 销毁提供者，释放资源
   */
  async dispose(): Promise<void> {
    try {
      // 清理 WASM provider
      if (this.wasmProvider) {
        this.wasmProvider.clear_cache();
        this.wasmProvider = null;
      }

      // 清理 SignalIdManager
      const signalManager = getSignalManager();
      if (signalManager) {
        await signalManager.clear();
      }

      console.log('[WasmWaveformProvider] Disposed successfully');
    } catch (error) {
      console.error('[WasmWaveformProvider] Dispose failed:', error);
      throw new WaveformProviderError('Failed to dispose WASM provider', error);
    }
  }

  // ==================== 配置设置 ====================

  /**
   * 设置视口范围
   */
  setViewport(timeStart: number, timeEnd: number): void {
    if (!this.wasmProvider) {
      throw new WaveformProviderError('Provider not initialized');
    }

    this.viewport = { ...this.viewport, startTime: timeStart, endTime: timeEnd };
    this.wasmProvider.set_viewport(timeStart, timeEnd);
  }

  /**
   * 设置画布尺寸
   */
  setCanvasDimensions(config: CanvasConfig): void {
    if (!this.wasmProvider) {
      throw new WaveformProviderError('Provider not initialized');
    }

    this.canvas = { ...config };
    this.wasmProvider.set_canvas_dimensions(config.width, config.height, config.rowHeight);
  }

  /**
   * 设置信号列表
   */
  setSignalList(signals: WasmSignalInfo[]): void {
    if (!this.wasmProvider) {
      throw new WaveformProviderError('Provider not initialized');
    }

    // 转换信号格式
    const wasmSignals = signals.map((sig) => ({
      global_id: sig.globalId,
      name: sig.name,
      row: sig.row,
      width: sig.width,
      draw_sig_id: sig.drawSigId,
      bit_extract: sig.bitExtract
        ? {
            parent_name: sig.bitExtract.parentName,
            msb: sig.bitExtract.msb,
            lsb: sig.bitExtract.lsb,
          }
        : undefined,
    }));

    this.wasmProvider.set_draw_list(wasmSignals);
  }

  /**
   * 设置显示格式
   */
  setDisplayFormat(format: 'hex' | 'bin' | 'oct' | 'dec'): void {
    if (!this.wasmProvider) {
      throw new WaveformProviderError('Provider not initialized');
    }

    this.wasmProvider.display_format = format;
  }

  // ==================== 数据获取 ====================

  /**
   * 获取指定时间点的信号值
   */
  async getSignalValueAtTime(signalName: string, time: number): Promise<ValueInfo | null> {
    if (!this.wasmProvider) {
      throw new WaveformProviderError('Provider not initialized');
    }

    try {
      const value = this.wasmProvider.get_signal_value_at_time(signalName, time);
      return value as ValueInfo | null;
    } catch (error) {
      console.warn('[WasmWaveformProvider] getSignalValueAtTime failed:', error);
      return null;
    }
  }

  /**
   * 查找指定时间点前后的跳变
   */
  async findTransitionsAround(
    signalName: string,
    time: number
  ): Promise<{ prev: number | null; next: number | null }> {
    if (!this.wasmProvider) {
      throw new WaveformProviderError('Provider not initialized');
    }

    try {
      const result = this.wasmProvider.find_transitions_around(signalName, time);
      return result as { prev: number | null; next: number | null };
    } catch (error) {
      console.warn('[WasmWaveformProvider] findTransitionsAround failed:', error);
      return { prev: null, next: null };
    }
  }

  // ==================== 渲染 ====================

  /**
   * 获取渲染段（用于主线程渲染模式）
   */
  async fetchAndGetSegments(signalNames: string[]): Promise<RenderSegment[]> {
    if (!this.wasmProvider) {
      throw new WaveformProviderError('Provider not initialized');
    }

    try {
      const segmentsJs = await this.wasmProvider.fetch_and_get_segments(signalNames);

      // 验证返回数据
      if (!segmentsJs || !Array.isArray(segmentsJs)) {
        throw new Error('Invalid segments data from WASM');
      }

      return segmentsJs as RenderSegment[];
    } catch (error) {
      console.error('[WasmWaveformProvider] fetchAndGetSegments failed:', error);
      throw new WaveformProviderError('Failed to fetch segments', error);
    }
  }

  /**
   * 渲染波形到 Canvas（用于 Worker 渲染模式）
   * 
   * 注意：在直接模式下，这个方法将使用 fetchAndGetSegments 获取数据
   * 然后在主线程渲染到 Canvas。
   */
  async renderWaveform(
    signalNames: string[],
    viewport: ViewportConfig,
    canvas: HTMLCanvasElement
  ): Promise<ImageBitmap> {
    if (!this.wasmProvider) {
      throw new WaveformProviderError('Provider not initialized');
    }

    // 设置视口
    this.setViewport(viewport.startTime, viewport.endTime);
    this.setCanvasDimensions({ 
      width: viewport.width, 
      height: viewport.height, 
      rowHeight: 24 
    });

    // 获取渲染段
    const segments = await this.fetchAndGetSegments(signalNames);

    // 在主线程渲染
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new WaveformProviderError('Failed to get canvas context');
    }

    // 清空画布
    ctx.clearRect(0, 0, viewport.width, viewport.height);

    // 简单的渲染逻辑（实际应该使用更复杂的渲染器）
    for (const segment of segments) {
      ctx.fillStyle = segment.value.hasXZ ? '#ff6b6b' : '#4dabf7';
      ctx.fillRect(segment.x0, segment.y, segment.x1 - segment.x0, 20);
    }

    // 创建 ImageBitmap
    return createImageBitmap(canvas);
  }

  // ==================== 缓存管理 ====================

  /**
   * 清除所有缓存
   */
  async clearCache(): Promise<void> {
    if (!this.wasmProvider) {
      throw new WaveformProviderError('Provider not initialized');
    }

    try {
      this.wasmProvider.clear_cache();

      // 清理 SignalIdManager
      const signalManager = getSignalManager();
      if (signalManager) {
        await signalManager.clear();
      }
    } catch (error) {
      console.error('[WasmWaveformProvider] clearCache failed:', error);
      throw new WaveformProviderError('Failed to clear cache', error);
    }
  }

  /**
   * 设置 OPFS 缓存启用状态
   */
  setOpfsEnabled(enabled: boolean): void {
    this._isOpfsEnabled = enabled;

    if (this.wasmProvider) {
      this.wasmProvider.set_opfs_enabled(enabled);
    }
  }

  /**
   * 设置内存缓存启用状态
   */
  setMemoryCacheEnabled(enabled: boolean): void {
    this._isMemoryCacheEnabled = enabled;

    if (this.wasmProvider) {
      this.wasmProvider.set_memory_cache_enabled(enabled);
    }
  }

  // ==================== 属性 ====================

  get viewportTimeStart(): number {
    return this.viewport.startTime;
  }

  get viewportTimeEnd(): number {
    return this.viewport.endTime;
  }

  get canvasWidth(): number {
    return this.canvas.width;
  }

  get canvasHeight(): number {
    return this.canvas.height;
  }

  get isOpfsEnabled(): boolean {
    if (this.wasmProvider) {
      return this.wasmProvider.opfs_enabled;
    }
    return this._isOpfsEnabled;
  }

  get isMemoryCacheEnabled(): boolean {
    if (this.wasmProvider) {
      return this.wasmProvider.memory_cache_enabled;
    }
    return this._isMemoryCacheEnabled;
  }

  // ==================== 辅助方法 ====================

  /**
   * 获取底层的 WASM provider（用于直接访问 WASM 功能）
   * @internal
   */
  getWasmProvider(): WaveformDataProvider | null {
    return this.wasmProvider;
  }

  /**
   * 构建 WASM 信号列表
   * 分配 draw_sig_id 到每个信号
   */
  async buildWasmSignals(
    uiSignals: Array<{
      global_id: number;
      name: string;
      row: number;
      width?: number;
    }>,
    waveformName: string
  ): Promise<WasmSignalInfo[]> {
    const manager = await getSignalIdManager(waveformName);

    return uiSignals.map((uiSig) => {
      const width = uiSig.width || 1;
      const draw_sig_id = manager.getOrCreateDrawSigId(uiSig.global_id);

      return {
        globalId: uiSig.global_id,
        name: uiSig.name,
        row: uiSig.row,
        width,
        drawSigId: draw_sig_id,
      };
    });
  }

  /**
   * 更新提供者设置
   */
  updateSettings(signalPrefix: string, spaceBeforeBracket: boolean): void {
    if (!this.wasmProvider) {
      console.warn('[WasmWaveformProvider] Cannot update settings: provider not created');
      return;
    }

    this.wasmProvider.signal_prefix = signalPrefix;
    this.wasmProvider.space_before_bracket = spaceBeforeBracket;
  }

  // ==================== 额外方法（用于 Hook）====================

  /**
   * 获取信号列表
   */
  async getSignals(): Promise<SignalInfo[]> {
    if (!this.wasmProvider) {
      throw new WaveformProviderError('Provider not initialized');
    }

    // 从 WASM provider 获取信号列表
    // 注意：这里假设 WASM provider 有 get_signals 方法，如果没有需要调整
    const signals = (this.wasmProvider as any).get_signals?.() || [];
    return signals.map((sig: { name: string; width: number; type?: string }) => ({
      name: sig.name,
      width: sig.width,
      type: sig.type || 'unknown',
    }));
  }

  /**
   * 获取信号段数据
   */
  async getSignalSegments(
    signalName: string,
    startTime: number,
    endTime: number
  ): Promise<SignalSegment[]> {
    if (!this.wasmProvider) {
      throw new WaveformProviderError('Provider not initialized');
    }

    // 临时设置视口范围
    const originalStart = this.viewport.startTime;
    const originalEnd = this.viewport.endTime;
    this.setViewport(startTime, endTime);

    try {
      const segments = await this.fetchAndGetSegments([signalName]);
      return segments.map((seg) => ({
        x0: seg.x0,
        x1: seg.x1,
        y: seg.y,
        value: seg.value,
      }));
    } finally {
      // 恢复原始视口
      this.setViewport(originalStart, originalEnd);
    }
  }
}
