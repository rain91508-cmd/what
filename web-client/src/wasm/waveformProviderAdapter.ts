/**
 * Waveform Provider Adapter
 *
 * 这个适配器将新的共享 Provider 接口适配为旧的接口，
 * 使得现有的 WaveformWindow 组件可以无缝使用新的共享 Provider，
 * 无需修改大量代码。
 *
 * 架构：共享 Provider + 参数化 Render
 * - 内部使用共享 Provider
 * - 管理自己的 Canvas（每个 Tab 一个）
 * - 保存状态，在调用时转换为参数传递
 */

import type {
  WaveformProviderInterface,
  WasmSignalInfo as NewWasmSignalInfo,
  RenderSegment,
  ValueInfo,
  ViewportConfig,
  CanvasConfig,
  TimeConfig,
  GetSignalValuesAtTransitionsParams,
  RawSignalValuesResult,
} from '../core/waveformProviderInterface';

/**
 * 旧的 WasmSignalInfo 接口（snake_case）
 */
interface OldWasmSignalInfo {
  global_id: number;
  name: string;
  row: number;
  width: number;
  draw_sig_id: number;
  bit_extract?: {
    parent_name: string;
    msb: number;
    lsb: number;
  };
  display_format?: DisplayFormat;
}

/**
 * 显示格式
 */
type DisplayFormat = 'hex' | 'bin' | 'oct' | 'dec';

/**
 * 适配器类 - 将新的共享 Provider 接口适配为旧接口
 *
 * 每个 Tab 有自己的 Adapter 实例，保存 Tab 相关的状态：
 * - signals: 当前信号列表
 * - viewport: 当前视口
 * - canvasId: Canvas ID
 * - canvasConfig: Canvas 配置
 * - displayFormat: 显示格式
 * - timeConfig: 时间配置
 */
export class WaveformProviderAdapter {
  private provider: WaveformProviderInterface;
  private canvasId: string;

  // Tab 相关状态（保存在 Adapter 中，不在 Provider 中）
  private currentSignals: OldWasmSignalInfo[] = [];
  private viewport: ViewportConfig = { startTime: 0, endTime: 1000, width: 800, height: 600 };
  private canvasConfig: CanvasConfig = { width: 800, height: 600, rowHeight: 24 };
  private _displayFormat: DisplayFormat = 'hex';
  private timeConfig: TimeConfig = { displayUnit: 'ps', lod0Unit: 1, displayUnitPerLoD0Unit: 1 };
  private devicePixelRatio: number = 1;
  private canvasRegistered: boolean = false;

  constructor(provider: WaveformProviderInterface, canvasId: string) {
    this.provider = provider;
    this.canvasId = canvasId;
  }

  // ==================== 属性映射 ====================

  get viewport_time_start(): number {
    return this.viewport.startTime;
  }

  get viewport_time_end(): number {
    return this.viewport.endTime;
  }

  get canvas_width(): number {
    return this.canvasConfig.width;
  }

  get canvas_height(): number {
    return this.canvasConfig.height;
  }

  get display_format(): DisplayFormat {
    return this._displayFormat;
  }

  set display_format(value: DisplayFormat) {
    this._displayFormat = value;
  }

  // ==================== Canvas 管理 ====================

  /**
   * 注册 Canvas（Tab 创建时调用）
   */
  async registerCanvas(canvas: OffscreenCanvas, dpr: number = 1): Promise<void> {
    this.devicePixelRatio = dpr;
    await this.provider.registerCanvas(this.canvasId, canvas, dpr);
    this.canvasRegistered = true;
  }

  /**
   * 注销 Canvas（Tab 关闭时调用）
   */
  async unregisterCanvas(): Promise<void> {
    await this.provider.unregisterCanvas(this.canvasId);
    this.canvasRegistered = false;
  }

  /**
   * 标记 Canvas 已注册（用于 StrictMode 下 canvas 已在 Worker 中的场景）
   */
  markCanvasRegistered(): void {
    this.canvasRegistered = true;
  }

  // ==================== 方法映射 ====================

  set_viewport(timeStart: number, timeEnd: number): void {
    this.viewport = { ...this.viewport, startTime: timeStart, endTime: timeEnd };
  }

  set_canvas_dimensions(width: number, height: number, rowHeight: number): void {
    this.canvasConfig = { width, height, rowHeight };
  }

  set_draw_list(signals: OldWasmSignalInfo[]): void {
    this.currentSignals = signals;
  }

  async fetch_and_get_segments(signalNames: string[]): Promise<RenderSegment[]> {
    // 转换信号列表格式
    const newSignals = this.convertSignals(this.currentSignals);

    // 注意：不再传递全局 displayFormat，因为每个信号的 display_format 已经在 newSignals 中设置
    return this.provider.fetchAndGetSegments(
      signalNames,
      this.viewport,
      newSignals,
      undefined
    );
  }

  async get_signal_value_at_time(
    signalName: string, 
    time: number, 
    displayFormat?: 'hex' | 'bin' | 'oct' | 'dec'
  ): Promise<ValueInfo | null> {
    // 转换信号列表格式
    const newSignals = this.convertSignals(this.currentSignals);

    // 传递 displayFormat 参数，优先使用传入的格式
    return this.provider.getSignalValueAtTime(
      signalName,
      time,
      newSignals,
      displayFormat
    );
  }

  async getSignalDataStats(signalName: string): Promise<{ transitions: number; buckets: number; tiles: number } | null> {
    return this.provider.getSignalDataStats(signalName);
  }

  async find_transitions_around(signalName: string, time: number): Promise<(number | null)[]> {
    // 转换信号列表格式
    const newSignals = this.convertSignals(this.currentSignals);

    const result = await this.provider.findTransitionsAround(
      signalName,
      time,
      newSignals
    );

    if (!result) {
      return [null, null];
    }

    // 处理两种可能的返回格式
    if (Array.isArray(result)) {
      return result as (number | null)[];
    }

    return [result.prev ?? null, result.next ?? null];
  }

  /**
   * 获取所有信号在跳变时间点的值
   * @param params 查询参数
   */
  async get_signal_values_at_transitions(
    params: GetSignalValuesAtTransitionsParams
  ): Promise<RawSignalValuesResult> {
    // Convert signals to new format with display format
    const signalsWithFormat = params.signals.map(sig => ({
      globalId: sig.globalId,
      name: sig.name,
      row: sig.row,
      width: sig.width,
      drawSigId: sig.drawSigId,
      bitExtract: sig.bitExtract
        ? {
            parentName: sig.bitExtract.parentName,
            msb: sig.bitExtract.msb,
            lsb: sig.bitExtract.lsb,
          }
        : undefined,
      displayFormat: sig.displayFormat,
    }));

    return this.provider.getSignalValuesAtTransitions({
      signalNames: params.signalNames,
      searchStartTime: params.searchStartTime,
      searchEndTime: params.searchEndTime,
      resultMax: params.resultMax,
      signals: signalsWithFormat,
      // Pass LoD parameter
      lod: params.lod,
      // Pass early exit parameter
      earlyExitOnInsufficientTransitions: params.earlyExitOnInsufficientTransitions,
      // Pass prefix settings for signal name conversion
      signalPrefix: params.signalPrefix,
      serverPrefix: params.serverPrefix,
      spaceBeforeBracket: params.spaceBeforeBracket,
      // Pass time unit conversion factor
      displayUnitPerLoD0Unit: params.displayUnitPerLoD0Unit,
      // Pass cache settings
      enableOpfs: params.enableOpfs,
      enableMemoryCache: params.enableMemoryCache,
    });
  }

  async render_waveform(options?: {
    signals?: OldWasmSignalInfo[],
    viewport?: ViewportConfig,
    canvasConfig?: CanvasConfig,
    displayFormat?: DisplayFormat,
    timeConfig?: TimeConfig,
    signalPrefix?: string,
    serverPrefix?: string,
    spaceBeforeBracket?: boolean,
  }): Promise<void> {
    // 检查 Canvas 是否已注册
    if (!this.canvasRegistered) {
      return;
    }

    // 使用提供的参数或默认参数
    const currentSignals = options?.signals || this.currentSignals;
    const viewport = options?.viewport || this.viewport;
    const canvasConfig = options?.canvasConfig || this.canvasConfig;
    // 注意：不再使用全局 displayFormat，因为每个信号的 display_format 已经在 signals 中设置
    const timeConfig = options?.timeConfig || this.timeConfig;
    // Prefix 参数 - 必须从 options 传入
    const signalPrefix = options?.signalPrefix ?? '';
    const serverPrefix = options?.serverPrefix ?? '';
    const spaceBeforeBracket = options?.spaceBeforeBracket ?? false;

    // 如果提供了 signals 参数，更新 currentSignals 以便 get_signal_value_at_time 使用
    if (options?.signals) {
      this.currentSignals = options.signals;
    }

    // 转换信号列表格式
    const newSignals = this.convertSignals(currentSignals);

    // 使用逻辑尺寸（CSS像素）传递给WASM
    // WASM计算segments时使用逻辑尺寸
    // Worker中使用ctx.scale(dpr, dpr)来缩放绘制
    // Debug: console.log('[WaveformProviderAdapter] render_waveform called with:', {
    //   canvasId: this.canvasId,
    //   currentSignals: currentSignals,
    //   newSignals,
    //   viewport,
    //   canvasConfig,
    //   dpr: this.devicePixelRatio,
    //   timeConfig,
    //   signalPrefix,
    //   serverPrefix,
    //   spaceBeforeBracket,
    // });

    await this.provider.renderWaveform({
      canvasId: this.canvasId,
      signals: newSignals,
      viewport,
      canvasConfig,
      // 使用全局 displayFormat，因为接口要求
      displayFormat: this._displayFormat,
      timeConfig,
      devicePixelRatio: this.devicePixelRatio,
      signalPrefix,
      serverPrefix,
      spaceBeforeBracket,
    });
  }

  set_opfs_enabled(enabled: boolean): void {
    this.provider.setOpfsEnabled(enabled);
  }

  set_memory_cache_enabled(enabled: boolean): void {
    this.provider.setMemoryCacheEnabled(enabled);
  }

  clear_cache(): void {
    this.provider.clearCache();
  }

  // ==================== 辅助方法 ====================

  /**
   * 转换信号列表格式（snake_case -> camelCase）
   */
  private convertSignals(signals: OldWasmSignalInfo[]): NewWasmSignalInfo[] {
    return signals.map(sig => ({
      globalId: sig.global_id,
      name: sig.name,
      row: sig.row,
      width: sig.width,
      drawSigId: sig.draw_sig_id,
      bitExtract: sig.bit_extract ? {
        parentName: sig.bit_extract.parent_name,
        msb: sig.bit_extract.msb,
        lsb: sig.bit_extract.lsb,
      } : undefined,
      displayFormat: sig.display_format,
    }));
  }

  /**
   * 设置时间配置
   */
  set_time_config(config: TimeConfig): void {
    this.timeConfig = config;
  }

  /**
   * 获取 Canvas ID
   */
  getCanvasId(): string {
    return this.canvasId;
  }

  /**
   * 获取底层的 Provider 实例
   */
  getProvider(): WaveformProviderInterface {
    return this.provider;
  }
}