// ============================================
// Data Provider Types
// ============================================
// DataProvider 负责所有数据相关的工作：
// - 从服务器/缓存获取原始数据
// - 数值格式化（进制转换）
// - X/Z 检测
// - 坐标转换（时间 → 像素）
// - 视口过滤
//
// UI 层只提供可见信号列表（包括展开后的多bit信号）

import type { Viewport } from './index';

/**
 * 信号信息（由 UI 提供）
 */
export interface SignalInfo {
  /** 信号全名（唯一标识） */
  name: string;
  
  /** UI 分配的行号（决定 Y 坐标） */
  row: number;
  
  /** 显示名称（可选，用于标签） */
  displayName?: string;
  
  /** 位宽（可选，用于正确渲染多bit信号） */
  width?: number;
}

/**
 * 格式化后的值（供渲染使用）
 */
export interface FormattedValue {
  /** 值类型 */
  type: 'zero' | 'one' | 'all_x' | 'all_z' | 'numeric' | 'mixed' | 'min_max';
  
  /** 显示字符串（已格式化）- 注意：WASM 返回的是 display_str */
  displayStr?: string;
  display_str?: string;
  
  /** 位宽 */
  width: number;
  
  /** 是否有 X/Z */
  hasXZ: boolean;
  
  // LoD 1+ min/max support
  /** Min value for bucket (LoD 1+) */
  minValue?: string;
  min_value?: string;
  /** Max value for bucket (LoD 1+) */
  maxValue?: string;
  max_value?: string;
  /** True if this is a min/max bucket segment */
  isMinMax?: boolean;
  is_min_max?: boolean;
}

/**
 * Segment（包含像素坐标，可直接渲染）
 */
export interface RenderSegment {
  /** 起始像素位置 */
  x0: number;
  
  /** 结束像素位置 */
  x1: number;
  
  /** Y 像素位置（中心线） */
  y: number;
  
  /** 值（已格式化） */
  value: FormattedValue;
  
  /** 信号名称 */
  signalName: string;
  
  /** 显示名称（用于标签） */
  displayName?: string;
}

/**
 * 显示格式
 */
export type DisplayFormat = 'bin' | 'oct' | 'dec' | 'hex' | 'auto';

/**
 * DataProvider 接口
 */
export interface DataProvider {
  /**
   * 初始化：设置可见信号列表和视口
   * @param signals UI 提供的可见信号列表（已按显示顺序排列，包含row）
   * @param viewport 当前视口
   * @param format 显示格式
   * @param canvasWidth 画布宽度
   * @param rowHeight 每行高度
   * @param rulerHeight 标尺高度
   */
  initialize(
    signals: SignalInfo[],
    viewport: Viewport,
    format: DisplayFormat,
    canvasWidth: number,
    rowHeight: number,
    rulerHeight: number
  ): void;
  
  /**
   * 更新可见信号列表（当展开/折叠/过滤时调用）
   */
  setSignals(signals: SignalInfo[]): void;
  
  /**
   * 更新视口
   */
  setViewport(viewport: Viewport): void;
  
  /**
   * 更新显示格式
   */
  setFormat(format: DisplayFormat): void;
  
  /**
   * 更新画布尺寸
   */
  setCanvasDimensions(width: number, rowHeight: number, rulerHeight: number): void;
  
  /**
   * 获取当前视口内所有信号的 Segments（已格式化、已转换坐标）
   */
  getSegments(): RenderSegment[];
  
  /**
   * 获取指定时间的信号值（用于鼠标悬停显示）
   */
  getValueAt(signalName: string, time: number): FormattedValue | null;
  
  /**
   * 获取一组信号在某个时间点的显示值
   * 用于更新信号列表的值一栏（包括多bit展开后的信号）
   * @param time 时间点
   * @returns Map<信号名, 显示值字符串>
   */
  getValuesAtTime(time: number): Map<string, string>;

  /**
   * 查找信号在指定时间前后的 transition 时间
   * @param signalName 信号名
   * @param time 当前时间
   * @returns { prev: 前一个transition时间, next: 后一个transition时间 }
   */
  findTransitionsAround(signalName: string, time: number): { prev: number | null; next: number | null };

  /**
   * 获取信号位宽
   */
  getSignalWidth(signalName: string): number;

  /**
   * 获取当前可见信号名称列表
   */
  getSignalNames(): string[];
}
