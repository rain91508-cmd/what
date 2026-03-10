/**
 * Waveform Provider Adapter
 * 
 * 这个适配器将新的 WaveformProviderInterface 适配为旧的 WaveformDataProvider 接口，
 * 使得现有的 WaveformWindow 组件可以无缝使用新的 Provider，无需修改大量代码。
 * 
 * 这是一个临时解决方案，最终应该将 WaveformWindow 迁移到使用新的接口。
 */

import type { WaveformProviderInterface, WasmSignalInfo as NewWasmSignalInfo, RenderSegment, ValueInfo } from '../core/waveformProviderInterface';

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
 * 适配器类 - 将新接口适配为旧接口
 * 
 * 旧的 WaveformDataProvider 使用 snake_case 方法名，
 * 新的 WaveformProviderInterface 使用 camelCase 方法名。
 */
export class WaveformProviderAdapter {
  private provider: WaveformProviderInterface;

  constructor(provider: WaveformProviderInterface) {
    this.provider = provider;
  }

  // ==================== 属性映射 ====================

  get viewport_time_start(): number {
    return this.provider.viewportTimeStart;
  }

  get viewport_time_end(): number {
    return this.provider.viewportTimeEnd;
  }

  get canvas_width(): number {
    return this.provider.canvasWidth;
  }

  get canvas_height(): number {
    return this.provider.canvasHeight;
  }

  get signal_prefix(): string {
    // 从 provider 中获取，如果支持的话
    return '';
  }

  set signal_prefix(_value: string) {
    // 暂不支持
  }

  get space_before_bracket(): boolean {
    return false;
  }

  set space_before_bracket(_value: boolean) {
    // 暂不支持
  }

  get display_format(): string {
    return 'hex';
  }

  set display_format(value: string) {
    // 使用新的方法
    this.provider.setDisplayFormat(value as 'hex' | 'bin' | 'oct' | 'dec');
  }

  // ==================== 方法映射 ====================

  set_viewport(timeStart: number, timeEnd: number): void {
    this.provider.setViewport(timeStart, timeEnd);
  }

  set_canvas_dimensions(width: number, height: number, rowHeight: number): void {
    this.provider.setCanvasDimensions({ width, height, rowHeight });
  }

  set_draw_list(signals: OldWasmSignalInfo[]): void {
    // 转换 snake_case 到 camelCase
    const newSignals: NewWasmSignalInfo[] = signals.map(sig => ({
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
    this.provider.setSignalList(newSignals);
  }

  async fetch_and_get_segments(signalNames: string[]): Promise<RenderSegment[]> {
    return this.provider.fetchAndGetSegments(signalNames);
  }

  async get_signal_value_at_time(signalName: string, time: number): Promise<ValueInfo | null> {
    return this.provider.getSignalValueAtTime(signalName, time);
  }

  async find_transitions_around(signalName: string, time: number): Promise<(number | null)[]> {
    const result = await this.provider.findTransitionsAround(signalName, time);
    if (!result) {
      return [null, null];
    }
    // 处理两种可能的返回格式：对象 { prev, next } 或数组 [prev, next]
    if (Array.isArray(result)) {
      return result as (number | null)[];
    }
    // 对象格式
    return [result.prev ?? null, result.next ?? null];
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

  // ==================== 额外方法 ====================

  /**
   * 获取底层的 Provider 实例
   */
  getProvider(): WaveformProviderInterface {
    return this.provider;
  }
}

/**
 * 创建适配器的工厂函数
 */
export function createAdapter(provider: WaveformProviderInterface): WaveformProviderAdapter {
  return new WaveformProviderAdapter(provider);
}
