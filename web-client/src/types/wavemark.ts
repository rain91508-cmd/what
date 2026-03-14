// ============================================
// Wavemark Types - Waveform Marker Feature
// ============================================

// 预定义的颜色选项
export const WAVEMARK_COLORS = [
  '#ff6600', // Orange (default)
  '#ff0000', // Red
  '#00ff00', // Green
  '#0000ff', // Blue
  '#ffff00', // Yellow
  '#ff00ff', // Magenta
  '#00ffff', // Cyan
  '#800080', // Purple
  '#008000', // Dark Green
  '#ffa500', // Orange (bright)
  '#ff1493', // Deep Pink
  '#00ced1', // Dark Turquoise
] as const;

export type WavemarkColor = typeof WAVEMARK_COLORS[number];

/**
 * Wavemark记录 - 保存特定时间点的波形状态
 */
export interface Wavemark {
  id: string;                    // 唯一标识
  name: string;                  // marker名称
  time: number;                  // 时间点（LoD0Unit）
  createdAt: number;             // 创建时间戳
  color: WavemarkColor;          // marker颜色
  // 信号列表状态
  expandedGroups: string[];      // 展开的group ID列表
}

/**
 * Wavemark创建参数
 */
export interface CreateWavemarkParams {
  name: string;
  time: number;
  expandedGroups: string[];
  color?: WavemarkColor;
}
