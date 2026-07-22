// ============================================
// Canvas 2D Waveform Renderer (Pure Rendering)
// ============================================
// 
// 纯渲染层，只负责绘制，不做任何计算：
// - 接收已包含像素坐标的 RenderSegment
// - 根据 value.type 和 width 选择样式
// - 单bit：带跳变边沿的方波
// - 多bit：矩形块 + 中间数值

import type { RenderSegment } from '../../types/dataProvider';
import type { TimeRangeOnly } from '../../utils/viewport';
import type { TimeConfig } from '../../components/TabPanel';
// Use the shared FormattedValue type from waveformDrawing which supports
// the triple fallback (type || valueType || value_type). This avoids type
// mismatches when delegating drawing calls.
import type { FormattedValue as DrawingFormattedValue } from './waveformDrawing';
// Delegate all drawing logic to the shared waveformDrawing module to eliminate
// code duplication and behavioral divergence (§4.1). The private draw methods
// below are thin wrappers that pass this.ctx and this.rowHeight through.
import {
  getSignalLevel as sharedGetSignalLevel,
  drawSingleBitWaveform as sharedDrawSingleBit,
  drawMultiBitWaveform as sharedDrawMultiBit,
  drawXWaveform as sharedDrawX,
  drawZWaveform as sharedDrawZ,
  drawMinMaxWaveform as sharedDrawMinMax,
  drawTimeRuler as sharedDrawTimeRuler,
  detectMinMaxGroups as sharedDetectMinMaxGroups,
  findLargeMinMaxGroups as sharedFindLargeMinMaxGroups,
  drawMinMaxGroupBox as sharedDrawMinMaxGroupBox,
  truncateLabel,
} from './waveformDrawing';

class WaveformRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rowHeight = 25;  // 行高，用于计算波形高度（24px + 1px border）

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    if (!this.ctx) {
      throw new Error('Failed to get Canvas 2D context');
    }

    console.log('[WaveformRenderer] Initialized successfully');
  }

  isInitialized(): boolean {
    return this.canvas !== null && this.ctx !== null;
  }

  /**
   * 渲染波形
   * @param segments 已包含像素坐标的 segments
   * @param viewport 用于绘制标尺
   * @param canvasWidth 画布宽度
   * @param canvasHeight 画布高度
   * @param rulerHeight 标尺高度
   * @param timeConfig 时间配置，用于标尺显示单位转换
   */
  render(
    segments: RenderSegment[],
    viewport: TimeRangeOnly,
    canvasWidth: number,
    canvasHeight: number,
    rulerHeight: number = 20,
    timeConfig?: TimeConfig
  ): void {
    if (!this.ctx || !this.canvas) {
      throw new Error('Renderer not initialized');
    }

    // Clear canvas
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Draw time ruler at top
    this.drawTimeRuler(canvasWidth, rulerHeight, viewport, timeConfig);

    // Draw segments (直接使用 x0, x1, y)
    // Group segments by y coordinate (row) to handle transitions correctly
    // This ensures that signals with the same name but different rows are drawn separately
    const segmentsByRow = new Map<number, RenderSegment[]>();
    for (const seg of segments) {
      const rowKey = Math.round(seg.y * 100) / 100; // Round to avoid floating point issues
      if (!segmentsByRow.has(rowKey)) {
        segmentsByRow.set(rowKey, []);
      }
      segmentsByRow.get(rowKey)!.push(seg);
    }

    // Draw segments for each row, sorted by x0
    for (const [_rowKey, rowSegments] of segmentsByRow) {
      // Sort by x0
      rowSegments.sort((a, b) => a.x0 - b.x0);

      // Detect continuous min/max segments for single-bit signals
      const minMaxGroups = this.detectMinMaxGroups(rowSegments);

      // Find large min/max groups (groupSize > 2) and draw them as single boxes
      const largeGroups = this.findLargeMinMaxGroups(rowSegments, minMaxGroups);

      // Build an index map: segment index → large group, for O(1) lookup
      const largeGroupIndex = new Map<number, (typeof largeGroups)[number]>();
      for (const g of largeGroups) {
        for (let idx = g.startIndex; idx <= g.endIndex; idx++) {
          largeGroupIndex.set(idx, g);
        }
      }

      let prevValue: DrawingFormattedValue | null = null;
      let i = 0;
      while (i < rowSegments.length) {
        const seg = rowSegments[i];

        // Check if this segment is part of a large min/max group (O(1) via index map)
        const largeGroup = largeGroupIndex.get(i);
        if (largeGroup) {
          // Draw the entire group as a single box
          this.drawMinMaxGroupBox(largeGroup.x0, largeGroup.x1, largeGroup.y, largeGroup.groupSize);
          // Skip all segments in this group
          i = largeGroup.endIndex + 1;
          prevValue = seg.value as DrawingFormattedValue;
          continue;
        }

        // Draw transition edge if there's a previous segment with different value
        if (prevValue && seg.value.width === 1 && prevValue.width === 1) {
          const prevLevel = this.getSignalLevel(prevValue);
          const currLevel = this.getSignalLevel(seg.value as DrawingFormattedValue);
          if (prevLevel !== currLevel) {
            this.drawTransitionEdge(seg.x0, seg.y, prevLevel, currLevel);
          }
        }

        // Check if this segment is part of a min/max group
        const groupInfo = minMaxGroups.get(i);
        if (groupInfo && seg.value.width === 1) {
          // For small groups (groupSize <= 2), draw individual segments
          this.drawMinMaxWaveform(seg.x0, seg.x1, seg.y, seg.value as DrawingFormattedValue, groupInfo);
        } else {
          this.drawSegment(seg);
        }
        prevValue = seg.value as DrawingFormattedValue;
        i++;
      }
    }
  }

  /**
   * Get signal level for single-bit signals — delegates to shared module.
   * Uses triple fallback (type || valueType || value_type) from waveformDrawing.
   * Returns: 0 for low, 1 for high, -1 for X/Z/unknown.
   */
  private getSignalLevel(value: DrawingFormattedValue): number {
    return sharedGetSignalLevel(value);
  }

  /**
   * Find large min/max groups — delegates to shared module.
   */
  private findLargeMinMaxGroups(
    segments: RenderSegment[],
    minMaxGroups: Map<number, { isContinuous: boolean; groupSize: number; groupIndex: number }>
  ) {
    return sharedFindLargeMinMaxGroups(segments as any, minMaxGroups);
  }

  /**
   * Draw a large min/max group as a single box — delegates to shared module.
   */
  private drawMinMaxGroupBox(x0: number, x1: number, y: number, _groupSize: number): void {
    if (!this.ctx) return;
    sharedDrawMinMaxGroupBox(this.ctx, x0, x1, y, _groupSize, this.rowHeight);
  }

  /**
   * Detect continuous min/max segment groups — delegates to shared module.
   */
  private detectMinMaxGroups(segments: RenderSegment[]) {
    // Cast to the format expected by the shared module (which uses a compatible
    // segment interface with the DrawingFormattedValue value type).
    return sharedDetectMinMaxGroups(segments as any);
  }

  /**
   * Draw transition edge (vertical line) for single-bit signals
   */
  private drawTransitionEdge(x: number, y: number, prevLevel: number, currLevel: number): void {
    if (!this.ctx) return;
    if (prevLevel < 0 || currLevel < 0) return;

    const waveHeight = this.rowHeight * 0.35;
    const yLow = y + waveHeight;
    const yHigh = y - waveHeight;

    const y0 = prevLevel === 0 ? yLow : yHigh;
    const y1 = currLevel === 0 ? yLow : yHigh;

    this.ctx.strokeStyle = '#000000';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(x, y0);
    this.ctx.lineTo(x, y1);
    this.ctx.stroke();
  }

  /**
   * 绘制单个 segment — delegates to shared drawing functions.
   */
  private drawSegment(seg: RenderSegment): void {
    if (!this.ctx) return;
    const { x0, x1, y, value } = seg;
    const ctx = this.ctx;
    const dv = value as DrawingFormattedValue;
    const valueType = dv.type || dv.valueType || dv.value_type;
    const isMinMax = dv.isMinMax || dv.is_min_max;
    if (valueType === 'min_max' && isMinMax) {
      sharedDrawMinMax(ctx, x0, x1, y, dv, this.rowHeight);
    } else if (dv.width === 1) {
      sharedDrawSingleBit(ctx, x0, x1, y, dv, this.rowHeight);
    } else {
      sharedDrawMultiBit(ctx, x0, x1, y, dv, this.rowHeight);
    }
  }

  /**
   * 绘制单bit波形 — delegates to shared module.
   */
  private drawSingleBitWaveform(x0: number, x1: number, y: number, value: DrawingFormattedValue): void {
    if (!this.ctx) return;
    sharedDrawSingleBit(this.ctx, x0, x1, y, value, this.rowHeight);
  }

  private drawMultiBitWaveform(x0: number, x1: number, y: number, value: DrawingFormattedValue): void {
    if (!this.ctx) return;
    sharedDrawMultiBit(this.ctx, x0, x1, y, value, this.rowHeight);
  }

  private drawXWaveform(x0: number, x1: number, y: number, waveHeight: number): void {
    if (!this.ctx) return;
    sharedDrawX(this.ctx, x0, x1, y, waveHeight);
  }

  private drawZWaveform(x0: number, x1: number, y: number): void {
    if (!this.ctx) return;
    sharedDrawZ(this.ctx, x0, x1, y);
  }

  private drawMinMaxWaveform(
    x0: number, x1: number, y: number, value: DrawingFormattedValue,
    groupInfo?: { isContinuous: boolean; groupSize: number; groupIndex: number }
  ): void {
    if (!this.ctx) return;
    sharedDrawMinMax(this.ctx, x0, x1, y, value, this.rowHeight, groupInfo);
  }

  /**
   * 截断标签以适应空间 — delegates to shared module.
   */
  private truncateLabel(label: string | undefined, maxWidth: number): string {
    if (!this.ctx) return label || '';
    return truncateLabel(this.ctx, label, maxWidth);
  }

  /**
   * 绘制时间标尺 — delegates to shared module.
   */
  private drawTimeRuler(width: number, height: number, viewport: TimeRangeOnly, timeConfig?: TimeConfig): void {
    if (!this.ctx) return;
    sharedDrawTimeRuler(this.ctx, width, height, viewport, timeConfig);
  }

  // Calculate a "nice" step value (1, 2, 5, 10, 20, 50, 100...)
  private calculateNiceStep(rawStep: number): number {
    if (rawStep <= 0) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const normalizedStep = rawStep / magnitude;
    if (normalizedStep < 1.5) return 1 * magnitude;
    if (normalizedStep < 3.5) return 2 * magnitude;
    if (normalizedStep < 7.5) return 5 * magnitude;
    return 10 * magnitude;
  }

  resize(width: number, height: number): void {
    if (this.canvas) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  dispose(): void {
    this.canvas = null;
    this.ctx = null;
  }
}

// Singleton instance
export const waveformRenderer = new WaveformRenderer();
export { WaveformRenderer };
