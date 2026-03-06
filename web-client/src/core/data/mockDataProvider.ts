// ============================================
// Mock Data Provider
// ============================================
// 使用 mock 数据实现 DataProvider 接口
// 支持多bit信号和 X/Z 值

import type {
  DataProvider,
  SignalInfo,
  FormattedValue,
  RenderSegment,
  DisplayFormat,
} from '../../types/dataProvider';
import type { TimeRangeOnly } from '../../utils/viewport';

/**
 * Mock 信号数据
 */
interface MockSignalData {
  width: number;
  transitions: Array<{
    time: number;
    value: string;  // 原始值字符串，如 "0xFF", "0b1010", "X", "Z"
  }>;
}

/**
 * Mock Data Provider 实现
 */
export class MockDataProvider implements DataProvider {
  private signals: SignalInfo[] = [];
  private viewport: TimeRangeOnly = { timeStart: 0, timeEnd: 100 };
  private format: DisplayFormat = 'hex';
  private canvasWidth = 800;
  private rowHeight = 24;  // Must match CSS .waveform-signal-item height
  private rulerHeight = 20;

  // 存储 mock 数据
  private mockData: Map<string, MockSignalData> = new Map();

  /**
   * 初始化
   */
  initialize(
    signals: SignalInfo[],
    viewport: TimeRangeOnly,
    format: DisplayFormat,
    canvasWidth: number,
    rowHeight: number,
    rulerHeight: number
  ): void {
    this.signals = signals;
    this.viewport = viewport;
    this.format = format;
    this.canvasWidth = canvasWidth;
    this.rowHeight = rowHeight;
    this.rulerHeight = rulerHeight;

    // 为每个信号生成 mock 数据（如果不存在）
    for (const signal of signals) {
      if (!this.mockData.has(signal.name)) {
        // 使用 UI 提供的 width，如果没有则根据信号名推断
        const width = signal.width ?? this.inferWidthFromName(signal.name);
        this.mockData.set(signal.name, this.generateMockData(signal.name, width));
      }
    }
  }

  /**
   * 更新可见信号列表
   */
  setSignals(signals: SignalInfo[]): void {
    this.signals = signals;

    // 为新增的信号生成 mock 数据
    for (const signal of signals) {
      if (!this.mockData.has(signal.name)) {
        // 使用 UI 提供的 width，如果没有则根据信号名推断
        const width = signal.width ?? this.inferWidthFromName(signal.name);
        this.mockData.set(signal.name, this.generateMockData(signal.name, width));
      }
    }
  }

  /**
   * 更新视口
   */
  setViewport(viewport: TimeRangeOnly): void {
    this.viewport = viewport;
  }

  /**
   * 更新显示格式
   */
  setFormat(format: DisplayFormat): void {
    this.format = format;
  }

  /**
   * 更新画布尺寸
   */
  setCanvasDimensions(width: number, rowHeight: number, rulerHeight: number): void {
    this.canvasWidth = width;
    this.rowHeight = rowHeight;
    this.rulerHeight = rulerHeight;
  }

  /**
   * 获取 Segments（已格式化、已转换坐标）
   * UI 提供 signals（含 row），DataProvider 计算 y 坐标
   */
  getSegments(): RenderSegment[] {
    const segments: RenderSegment[] = [];
    const timeRange = this.viewport.timeEnd - this.viewport.timeStart;

    for (const signal of this.signals) {
      const signalData = this.mockData.get(signal.name);
      if (!signalData) continue;

      // 根据 UI 提供的 row 计算 Y 坐标
      // 信号列表的 row 0 对应波形区域 ruler 下方的第一行
      const y = this.rulerHeight + signal.row * this.rowHeight + this.rowHeight / 2;

      // 使用 UI 提供的 width，如果没有则使用 signalData 推断的 width
      const width = signal.width ?? signalData.width;

      // 获取视口范围内的 transitions
      const visibleTransitions = this.getVisibleTransitions(signalData);

      if (visibleTransitions.length === 0) {
        // 没有跳变，整个视口内值不变
        const value = this.getValueAtTime(signalData, this.viewport.timeStart);
        const x0 = 0;
        const x1 = this.canvasWidth;

        segments.push({
          x0,
          x1,
          y,
          value: this.formatValue(value, width),
          signalName: signal.name,
          displayName: signal.displayName,
        });
      } else {
        // 有跳变，为每段创建 segment
        let lastTime = this.viewport.timeStart;
        let lastValue = this.getValueAtTime(signalData, this.viewport.timeStart);

        for (const transition of visibleTransitions) {
          const x0 = ((lastTime - this.viewport.timeStart) / timeRange) * this.canvasWidth;
          const x1 = ((transition.time - this.viewport.timeStart) / timeRange) * this.canvasWidth;

          segments.push({
            x0,
            x1,
            y,
            value: this.formatValue(lastValue, width),
            signalName: signal.name,
            displayName: signal.displayName,
          });

          lastTime = transition.time;
          lastValue = transition.value;
        }

        // 最后一段
        const x0 = ((lastTime - this.viewport.timeStart) / timeRange) * this.canvasWidth;
        const x1 = this.canvasWidth;

        segments.push({
          x0,
          x1,
          y,
          value: this.formatValue(lastValue, width),
          signalName: signal.name,
          displayName: signal.displayName,
        });
      }
    }

    return segments;
  }

  /**
   * 获取指定时间的信号值
   */
  getValueAt(signalName: string, time: number): FormattedValue | null {
    const signalData = this.mockData.get(signalName);
    if (!signalData) return null;

    const value = this.getValueAtTime(signalData, time);
    return this.formatValue(value, signalData.width);
  }

  /**
   * 获取一组信号在某个时间点的显示值
   * 只获取当前可见的信号（this.signals 中定义的）
   */
  getValuesAtTime(time: number): Map<string, string> {
    const values = new Map<string, string>();

    for (const signal of this.signals) {
      const signalData = this.mockData.get(signal.name);
      if (!signalData) {
        values.set(signal.name, 'X');
        continue;
      }

      // 使用 UI 提供的 width，如果没有则使用 signalData 推断的 width
      const width = signal.width ?? signalData.width;

      const rawValue = this.getValueAtTime(signalData, time);
      const formattedValue = this.formatValue(rawValue, width);
      values.set(signal.name, formattedValue.displayStr ?? '');
    }

    return values;
  }

  /**
   * 获取信号位宽
   */
  getSignalWidth(signalName: string): number {
    const signalData = this.mockData.get(signalName);
    return signalData?.width ?? 1;
  }

  /**
   * 获取当前可见信号名称列表
   */
  getSignalNames(): string[] {
    return this.signals.map(s => s.name);
  }

  /**
   * 查找信号在指定时间前后的 transition 时间
   */
  findTransitionsAround(signalName: string, time: number): { prev: number | null; next: number | null } {
    const signalData = this.mockData.get(signalName);
    if (!signalData) return { prev: null, next: null };

    let prev: number | null = null;
    let next: number | null = null;

    for (const transition of signalData.transitions) {
      if (transition.time <= time) {
        prev = transition.time;
      } else if (next === null) {
        next = transition.time;
        break;
      }
    }

    return { prev, next };
  }

  /**
   * 生成 mock 数据
   * @param signalName 信号名
   * @param width 位宽（由 UI 提供或推断）
   */
  private generateMockData(_signalName: string, width: number): MockSignalData {
    // 生成随机跳变
    const transitions: Array<{ time: number; value: string }> = [];
    const step = 100;

    for (let t = 0; t < 10000; t += step) {
      const rand = Math.random();
      let value: string;

      if (rand < 0.05) {
        value = 'X';
      } else if (rand < 0.1) {
        value = 'Z';
      } else {
        // 生成随机数值
        const maxVal = Math.pow(2, Math.min(width, 32));
        const num = Math.floor(Math.random() * maxVal);

        if (width === 1) {
          value = num % 2 === 0 ? '0' : '1';
        } else {
          // 偶尔生成带 X 的值
          if (Math.random() < 0.1 && width > 4) {
            const hex = num.toString(16).toUpperCase();
            const xPos = Math.floor(Math.random() * hex.length);
            value = '0x' + hex.slice(0, xPos) + 'X' + hex.slice(xPos + 1);
          } else {
            value = '0x' + num.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0');
          }
        }
      }

      transitions.push({ time: t, value });
    }

    return { width, transitions };
  }

  /**
   * 从信号名推断位宽
   * 支持格式：
   * - signal[7:0] → 8bit
   * - signal[3] → 1bit (单个bit)
   * - signal → 根据名称推断或默认1bit
   */
  private inferWidthFromName(name: string): number {
    // 匹配单个bit访问：signal[3]
    const bitMatch = name.match(/\[(\d+)\]$/);
    if (bitMatch) {
      return 1;  // 单个bit
    }

    // 匹配总线范围：signal[7:0] 或 signal[7]
    const busMatch = name.match(/\[(\d+)(?::0)?\]/);
    if (busMatch) {
      return parseInt(busMatch[1], 10) + 1;
    }

    // 默认位宽（根据信号名特征）
    const baseName = name.replace(/\[.*\]$/, '');  // 移除bit后缀
    if (baseName.toLowerCase().includes('bus') || baseName.toLowerCase().includes('data')) {
      return 8;
    }
    if (baseName.toLowerCase().includes('addr')) {
      return 16;
    }

    return 1;
  }

  /**
   * 获取视口范围内的 transitions
   */
  private getVisibleTransitions(signalData: MockSignalData): Array<{ time: number; value: string }> {
    return signalData.transitions.filter(
      t => t.time >= this.viewport.timeStart && t.time <= this.viewport.timeEnd
    );
  }

  /**
   * 获取指定时间的值
   */
  private getValueAtTime(signalData: MockSignalData, time: number): string {
    // 找到最后一个 <= time 的 transition
    let lastValue = signalData.transitions[0]?.value ?? '0';

    for (const t of signalData.transitions) {
      if (t.time <= time) {
        lastValue = t.value;
      } else {
        break;
      }
    }

    return lastValue;
  }

  /**
   * 格式化值
   */
  private formatValue(rawValue: string, width: number): FormattedValue {
    const upperValue = rawValue.toUpperCase();

    // 检测 X/Z
    const hasX = upperValue.includes('X');
    const hasZ = upperValue.includes('Z');

    // 确定类型
    let type: FormattedValue['type'];
    if (hasX && !hasZ && /^X+$/.test(upperValue.replace(/0X/g, '').replace(/X0/g, ''))) {
      type = 'all_x';
    } else if (hasZ && !hasX && /^Z+$/.test(upperValue.replace(/0Z/g, '').replace(/Z0/g, ''))) {
      type = 'all_z';
    } else if (hasX || hasZ) {
      type = 'mixed';
    } else if (rawValue === '0' || rawValue === '0x0' || rawValue === '0b0') {
      type = 'zero';
    } else if (rawValue === '1' || rawValue === '0x1' || rawValue === '0b1') {
      type = 'one';
    } else {
      type = 'numeric';
    }

    // 如果原始值是单bit但width>1，扩展为多bit格式
    let adjustedRawValue = rawValue;
    if (width > 1 && (rawValue === '0' || rawValue === '1')) {
      adjustedRawValue = '0x' + parseInt(rawValue, 10).toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0');
    }

    // 格式化显示字符串
    let displayStr = this.convertFormat(adjustedRawValue, width);

    return {
      type,
      displayStr,
      width,
      hasXZ: hasX || hasZ,
    };
  }

  /**
   * 转换格式
   */
  private convertFormat(rawValue: string, width: number): string {
    // 如果包含 X/Z，保持原样
    if (/[XZ]/i.test(rawValue)) {
      return rawValue;
    }

    // 解析数值
    let num: number;
    if (rawValue.startsWith('0x') || rawValue.startsWith('0X')) {
      num = parseInt(rawValue.slice(2), 16);
    } else if (rawValue.startsWith('0b') || rawValue.startsWith('0B')) {
      num = parseInt(rawValue.slice(2), 2);
    } else if (rawValue.startsWith('0o') || rawValue.startsWith('0O')) {
      num = parseInt(rawValue.slice(2), 8);
    } else {
      num = parseInt(rawValue, 10);
    }

    if (isNaN(num)) {
      return rawValue;
    }

    // 根据格式转换
    switch (this.format) {
      case 'bin':
        return '0b' + num.toString(2).padStart(width, '0');
      case 'oct':
        return '0o' + num.toString(8);
      case 'dec':
        return num.toString(10);
      case 'hex':
      case 'auto':
      default:
        if (width === 1) {
          return num.toString();
        }
        return '0x' + num.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0');
    }
  }
}

// 导出单例
export const mockDataProvider = new MockDataProvider();
