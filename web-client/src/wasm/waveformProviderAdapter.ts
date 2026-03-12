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

    return this.provider.fetchAndGetSegments(
      signalNames,
      this.viewport,
      newSignals
    );
  }

  async get_signal_value_at_time(signalName: string, time: number): Promise<ValueInfo | null> {
    // 转换信号列表格式
    const newSignals = this.convertSignals(this.currentSignals);

    return this.provider.getSignalValueAtTime(
      signalName,
      time,
      newSignals
    );
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

  // Prefix settings for signal name conversion
  private _signalPrefix: string = '';
  private _serverPrefix: string = '';
  private _spaceBeforeBracket: boolean = false;

  get signal_prefix(): string {
    return this._signalPrefix;
  }

  set signal_prefix(value: string) {
    this._signalPrefix = value;
  }

  get server_prefix(): string {
    return this._serverPrefix;
  }

  set server_prefix(value: string) {
    this._serverPrefix = value;
  }

  get space_before_bracket(): boolean {
    return this._spaceBeforeBracket;
  }

  set space_before_bracket(value: boolean) {
    this._spaceBeforeBracket = value;
  }

  // ==================== Prefix 设置方法 ====================

  setSignalPrefix(prefix: string): void {
    this._signalPrefix = prefix;
    console.log('[WaveformProviderAdapter] setSignalPrefix:', prefix);
  }

  setServerPrefix(prefix: string): void {
    this._serverPrefix = prefix;
    console.log('[WaveformProviderAdapter] setServerPrefix:', prefix);
  }

  setSpaceBeforeBracket(enabled: boolean): void {
    this._spaceBeforeBracket = enabled;
    console.log('[WaveformProviderAdapter] setSpaceBeforeBracket:', enabled);
  }

  async render_waveform(options?: {
    signals?: OldWasmSignalInfo[],
    viewport?: ViewportConfig,
    canvasConfig?: CanvasConfig,
    displayFormat?: DisplayFormat,
    timeConfig?: TimeConfig,
  }): Promise<void> {
    // 检查 Canvas 是否已注册
    if (!this.canvasRegistered) {
      console.log('[WaveformProviderAdapter] Canvas not registered, skipping render');
      return;
    }
    
    // 使用提供的参数或默认参数
    const currentSignals = options?.signals || this.currentSignals;
    const viewport = options?.viewport || this.viewport;
    const canvasConfig = options?.canvasConfig || this.canvasConfig;
    const displayFormat = options?.displayFormat || this._displayFormat;
    const timeConfig = options?.timeConfig || this.timeConfig;
    
    // 转换信号列表格式
    const newSignals = this.convertSignals(currentSignals);
    
    // 使用逻辑尺寸（CSS像素）传递给WASM
    // WASM计算segments时使用逻辑尺寸
    // Worker中使用ctx.scale(dpr, dpr)来缩放绘制
    console.log('[WaveformProviderAdapter] render_waveform called with:', { 
      canvasId: this.canvasId, 
      currentSignals: currentSignals, 
      newSignals, 
      viewport, 
      canvasConfig, 
      dpr: this.devicePixelRatio,
      displayFormat, 
      timeConfig,
      signalPrefix: this._signalPrefix,
      serverPrefix: this._serverPrefix,
      spaceBeforeBracket: this._spaceBeforeBracket,
    });

    await this.provider.renderWaveform({
      canvasId: this.canvasId,
      signals: newSignals,
      viewport,
      canvasConfig,
      displayFormat,
      timeConfig,
      devicePixelRatio: this.devicePixelRatio,
      signalPrefix: this._signalPrefix,
      serverPrefix: this._serverPrefix,
      spaceBeforeBracket: this._spaceBeforeBracket,
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