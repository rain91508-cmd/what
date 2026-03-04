// ============================================
// Canvas 2D Waveform Renderer (Pure Rendering)
// ============================================
// 
// 纯渲染层，只负责绘制，不做任何计算：
// - 接收已包含像素坐标的 RenderSegment
// - 根据 value.type 和 width 选择样式
// - 单bit：带跳变边沿的方波
// - 多bit：矩形块 + 中间数值

import type { RenderSegment, FormattedValue } from '../../types/dataProvider';
import type { Viewport } from '../../types';

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
   */
  render(
    segments: RenderSegment[],
    viewport: Viewport,
    canvasWidth: number,
    canvasHeight: number,
    rulerHeight: number = 20
  ): void {
    if (!this.ctx || !this.canvas) {
      throw new Error('Renderer not initialized');
    }

    // Clear canvas
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Draw time ruler at top
    this.drawTimeRuler(canvasWidth, rulerHeight, viewport);

    // Draw segments (直接使用 x0, x1, y)
    for (const seg of segments) {
      this.drawSegment(seg);
    }
  }

  /**
   * 绘制单个 segment
   */
  private drawSegment(seg: RenderSegment): void {
    const { x0, x1, y, value } = seg;
    const width = x1 - x0;

    // 根据位宽选择绘制方式
    if (value.width === 1) {
      // 单bit：带跳变边沿的方波
      this.drawSingleBitWaveform(x0, x1, y, value, width);
    } else {
      // 多bit：矩形块 + 中间数值
      this.drawMultiBitWaveform(x0, x1, y, value, width);
    }
  }

  /**
   * 绘制单bit波形：带跳变边沿的方波
   * 
   * 样式：
   * - 0：低电平（下方）
   * - 1：高电平（上方）
   * - X：红色交叉线
   * - Z：蓝色虚线（中间）
   */
  private drawSingleBitWaveform(
    x0: number,
    x1: number,
    y: number,
    value: FormattedValue,
    width: number
  ): void {
    if (!this.ctx) return;

    const waveHeight = this.rowHeight * 0.35;  // 波形高度
    const yLow = y + waveHeight;   // 低电平Y
    const yHigh = y - waveHeight;  // 高电平Y
    const yMid = y;                // 中间Y（用于Z）

    this.ctx.lineWidth = 2;
    this.ctx.setLineDash([]);

    switch (value.type) {
      case 'zero':
        // 低电平：在下方绘制水平线
        this.ctx.strokeStyle = '#000000';
        this.ctx.beginPath();
        this.ctx.moveTo(x0, yLow);
        this.ctx.lineTo(x1, yLow);
        this.ctx.stroke();
        break;

      case 'one':
        // 高电平：在上方绘制水平线
        this.ctx.strokeStyle = '#00aa00';
        this.ctx.beginPath();
        this.ctx.moveTo(x0, yHigh);
        this.ctx.lineTo(x1, yHigh);
        this.ctx.stroke();
        break;

      case 'all_x':
        // X：红色交叉线
        this.drawXWaveform(x0, x1, y, waveHeight);
        break;

      case 'all_z':
        // Z：蓝色虚线（中间）
        this.drawZWaveform(x0, x1, yMid);
        break;

      case 'mixed':
      case 'numeric':
      default:
        // 数值：根据值选择高低（简化处理，实际应该根据前一个值决定跳变）
        this.ctx.strokeStyle = '#00aa00';
        this.ctx.beginPath();
        this.ctx.moveTo(x0, yHigh);
        this.ctx.lineTo(x1, yHigh);
        this.ctx.stroke();
        break;
    }

    // 绘制跳变边沿（垂直线）- 在 segment 结束时
    if (width > 2) {
      this.ctx.strokeStyle = '#000000';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(x1, yHigh);
      this.ctx.lineTo(x1, yLow);
      this.ctx.stroke();
    }
  }

  /**
   * 绘制多bit波形：矩形块 + 中间数值
   * 
   * 类似 wavedrom 的样式：
   * ┌─────────────┐
   * │   0xFF      │  ← 数值显示在矩形中间
   * └─────────────┘
   */
  private drawMultiBitWaveform(
    x0: number,
    x1: number,
    y: number,
    value: FormattedValue,
    width: number
  ): void {
    if (!this.ctx) return;

    const rectHeight = this.rowHeight * 0.75;  // 矩形高度（增大占比）
    const rectY = y - rectHeight / 2;          // 矩形顶部Y

    // 根据类型选择颜色
    let strokeColor: string;
    let fillColor: string;
    let textColor: string;

    switch (value.type) {
      case 'all_x':
        strokeColor = '#ff0000';
        fillColor = '#ffeeee';
        textColor = '#ff0000';
        break;
      case 'all_z':
        strokeColor = '#0066ff';
        fillColor = '#eeeeff';
        textColor = '#0066ff';
        break;
      case 'mixed':
        strokeColor = '#ff8800';
        fillColor = '#fff8ee';
        textColor = '#ff8800';
        break;
      default:
        strokeColor = '#00aa00';
        fillColor = '#eeffee';
        textColor = '#000000';
        break;
    }

    // 绘制矩形背景
    this.ctx.fillStyle = fillColor;
    this.ctx.fillRect(x0, rectY, width, rectHeight);

    // 绘制矩形边框
    this.ctx.strokeStyle = strokeColor;
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(x0, rectY, width, rectHeight);

    // 绘制数值标签（居中）- 使用更大字体（不加粗）
    if (width > 20) {
      this.ctx.fillStyle = textColor;
      this.ctx.font = '13px Consolas, Monaco, monospace';

      // 截断标签以适应空间
      const label = this.truncateLabel(value.displayStr, width - 8);
      const textWidth = this.ctx.measureText(label).width;
      const textX = x0 + (width - textWidth) / 2;
      const textY = y + 4;  // 垂直居中

      this.ctx.fillText(label, textX, textY);
    }

    // 绘制跳变边沿（垂直线）- 在 segment 结束时
    if (width > 2) {
      this.ctx.strokeStyle = strokeColor;
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(x1, rectY);
      this.ctx.lineTo(x1, rectY + rectHeight);
      this.ctx.stroke();
    }
  }

  /**
   * 绘制 X 波形：红色交叉线
   */
  private drawXWaveform(x0: number, x1: number, y: number, waveHeight: number): void {
    if (!this.ctx) return;

    const yLow = y + waveHeight;
    const yHigh = y - waveHeight;

    this.ctx.strokeStyle = '#ff0000';
    this.ctx.lineWidth = 2;
    this.ctx.setLineDash([]);

    // 绘制 X 形状（两条对角线）
    this.ctx.beginPath();
    // 第一条对角线 \
    this.ctx.moveTo(x0, yHigh);
    this.ctx.lineTo(x1, yLow);
    // 第二条对角线 /
    this.ctx.moveTo(x0, yLow);
    this.ctx.lineTo(x1, yHigh);
    this.ctx.stroke();

    // 绘制 X 标签
    const width = x1 - x0;
    if (width > 15) {
      this.ctx.fillStyle = '#ff0000';
      this.ctx.font = 'bold 10px Arial';
      const textWidth = this.ctx.measureText('X').width;
      const textX = x0 + (width - textWidth) / 2;
      this.ctx.fillText('X', textX, y - waveHeight - 4);
    }
  }

  /**
   * 绘制 Z 波形：蓝色虚线（中间）
   */
  private drawZWaveform(x0: number, x1: number, y: number): void {
    if (!this.ctx) return;

    this.ctx.strokeStyle = '#0066ff';
    this.ctx.lineWidth = 2;
    this.ctx.setLineDash([2, 2]);

    this.ctx.beginPath();
    this.ctx.moveTo(x0, y);
    this.ctx.lineTo(x1, y);
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    // 绘制 Z 标签
    const width = x1 - x0;
    if (width > 15) {
      this.ctx.fillStyle = '#0066ff';
      this.ctx.font = 'bold 10px Arial';
      const textWidth = this.ctx.measureText('Z').width;
      const textX = x0 + (width - textWidth) / 2;
      this.ctx.fillText('Z', textX, y - 6);
    }
  }

  /**
   * 截断标签以适应空间
   */
  private truncateLabel(label: string, maxWidth: number): string {
    if (!this.ctx) return label;

    const textWidth = this.ctx.measureText(label).width;
    if (textWidth <= maxWidth) {
      return label;
    }

    // 截断：前N...后N
    const ellipsis = '...';
    const ellipsisWidth = this.ctx.measureText(ellipsis).width;
    const availableWidth = maxWidth - ellipsisWidth;

    if (availableWidth <= 0) {
      return ellipsis;
    }

    // 估算每个字符宽度
    const avgCharWidth = textWidth / label.length;
    const charsToShow = Math.floor(availableWidth / avgCharWidth / 2);

    if (charsToShow <= 0) {
      return ellipsis;
    }

    return label.slice(0, charsToShow) + ellipsis + label.slice(-charsToShow);
  }

  /**
   * 绘制时间标尺
   */
  private drawTimeRuler(width: number, height: number, viewport: Viewport): void {
    if (!this.ctx) return;

    // Draw ruler background
    this.ctx.fillStyle = '#f5f5f5';
    this.ctx.fillRect(0, 0, width, height);

    // Draw bottom border
    this.ctx.strokeStyle = '#c0c0c0';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, height - 1);
    this.ctx.lineTo(width, height - 1);
    this.ctx.stroke();

    const lod0Range = viewport.timeEnd - viewport.timeStart;

    // Calculate major step (for labels) - target ~100 pixels between labels
    const targetLabelCount = Math.max(2, Math.floor(width / 100));
    const majorStep = this.calculateNiceStep(lod0Range / targetLabelCount);

    // Minor step is 1/10 of major step
    const minorStep = majorStep / 10;

    // Calculate first and last major ticks
    const firstMajorTick = Math.ceil(viewport.timeStart / majorStep) * majorStep;
    const lastMajorTick = Math.floor(viewport.timeEnd / majorStep) * majorStep;

    // Draw minor ticks (no labels) - same color as major ticks
    this.ctx.strokeStyle = '#666';
    this.ctx.lineWidth = 1;

    const firstMinorTick = Math.ceil(viewport.timeStart / minorStep) * minorStep;
    const lastMinorTick = Math.floor(viewport.timeEnd / minorStep) * minorStep;

    for (let tick = firstMinorTick; tick <= lastMinorTick; tick += minorStep) {
      // Skip if this is a major tick
      if (Math.abs(tick % majorStep) < minorStep / 2) continue;

      const x = ((tick - viewport.timeStart) / lod0Range) * width;

      // Determine tick height: middle tick (5th) is longer (8px)
      const minorIndex = Math.round((tick % majorStep) / minorStep);
      const tickHeight = minorIndex === 5 ? 8 : 4;

      this.ctx.beginPath();
      this.ctx.moveTo(x, height - tickHeight);
      this.ctx.lineTo(x, height - 1);
      this.ctx.stroke();
    }

    // Draw major ticks (with labels)
    this.ctx.fillStyle = '#333';
    this.ctx.font = '11px Consolas, Monaco, monospace';
    this.ctx.strokeStyle = '#666';
    this.ctx.lineWidth = 1;

    for (let tick = firstMajorTick; tick <= lastMajorTick; tick += majorStep) {
      const x = ((tick - viewport.timeStart) / lod0Range) * width;

      // Draw major tick line
      this.ctx.beginPath();
      this.ctx.moveTo(x, height - 10);
      this.ctx.lineTo(x, height - 1);
      this.ctx.stroke();

      // Draw time label
      this.ctx.fillText(Math.round(tick).toString(), x + 2, height - 12);
    }
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
