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
import type { TimeRangeOnly } from '../../utils/viewport';
import type { TimeConfig } from '../../components/TabPanel';

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

      let prevValue: FormattedValue | null = null;
      for (let i = 0; i < rowSegments.length; i++) {
        const seg = rowSegments[i];
        // Draw transition edge if there's a previous segment with different value
        if (prevValue && seg.value.width === 1 && prevValue.width === 1) {
          const prevLevel = this.getSignalLevel(prevValue);
          const currLevel = this.getSignalLevel(seg.value);
          if (prevLevel !== currLevel) {
            this.drawTransitionEdge(seg.x0, seg.y, prevLevel, currLevel);
          }
        }

        // Check if this segment is part of a min/max group
        const groupInfo = minMaxGroups.get(i);
        if (groupInfo && seg.value.width === 1) {
          // Debug: log group info
          if (i === 0) {
            console.log(`[Renderer] MinMax group detected: total ${minMaxGroups.size} segments, groupSize=${groupInfo.groupSize}`);
          }
          // Pass group info to drawMinMaxWaveform
          this.drawMinMaxWaveform(seg.x0, seg.x1, seg.y, seg.value, seg.x1 - seg.x0, groupInfo);
        } else {
          this.drawSegment(seg);
        }
        prevValue = seg.value;
      }
    }
  }

  /**
   * Get signal level for single-bit signals
   * Returns: 0 for low, 1 for high, -1 for X/Z/unknown
   */
  private getSignalLevel(value: FormattedValue): number {
    switch (value.type) {
      case 'zero': return 0;
      case 'one': return 1;
      default: return -1;
    }
  }

  /**
   * Detect continuous min/max segment groups for single-bit signals
   * Returns a map from segment index to group info
   * 
   * For LoD > 0, segments are grouped by time continuity:
   * - A group is continuous if segments are adjacent in time (x1 of prev == x0 of next)
   * - Group size determines drawing style (vertical lines vs toggling box)
   */
  private detectMinMaxGroups(segments: RenderSegment[]): Map<number, { isContinuous: boolean; groupSize: number; groupIndex: number }> {
    const result = new Map<number, { isContinuous: boolean; groupSize: number; groupIndex: number }>();
    
    // Find all single-bit segments that are part of min/max data (LoD > 0)
    const minMaxSegments: { index: number; x0: number; x1: number }[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.value.type === 'min_max' && seg.value.width === 1) {
        minMaxSegments.push({ index: i, x0: seg.x0, x1: seg.x1 });
      }
    }
    
    if (minMaxSegments.length === 0) {
      return result;
    }
    
    // Sort by x0 to ensure time order
    minMaxSegments.sort((a, b) => a.x0 - b.x0);
    
    // Group by time continuity (adjacent in time)
    let currentGroup: { index: number; x0: number; x1: number }[] = [minMaxSegments[0]];
    
    for (let i = 1; i < minMaxSegments.length; i++) {
      const curr = minMaxSegments[i];
      const prev = minMaxSegments[i - 1];
      
      // Check if continuous in time (prev.x1 == curr.x0)
      // Use a small epsilon to handle floating point errors
      const epsilon = 0.001;
      if (Math.abs(curr.x0 - prev.x1) < epsilon) {
        currentGroup.push(curr);
      } else {
        // Save current group and start new one
        const groupSize = currentGroup.length;
        for (let j = 0; j < currentGroup.length; j++) {
          result.set(currentGroup[j].index, {
            isContinuous: groupSize > 1,
            groupSize,
            groupIndex: j
          });
        }
        currentGroup = [curr];
      }
    }
    
    // Save last group
    const groupSize = currentGroup.length;
    for (let j = 0; j < currentGroup.length; j++) {
      result.set(currentGroup[j].index, {
        isContinuous: groupSize > 1,
        groupSize,
        groupIndex: j
      });
    }
    
    return result;
  }

  /**
   * Draw transition edge (vertical line) for single-bit signals
   */
  private drawTransitionEdge(x: number, y: number, prevLevel: number, currLevel: number): void {
    if (!this.ctx) return;
    if (prevLevel < 0 || currLevel < 0) return; // Don't draw for X/Z

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
   * 绘制单个 segment
   */
  private drawSegment(seg: RenderSegment): void {
    const { x0, x1, y, value } = seg;
    const width = x1 - x0;

    // 检查是否是 min/max 格式（LoD 1+）- 处理 snake_case 和 camelCase
    const isMinMax = value.isMinMax || value.is_min_max;
    if (value.type === 'min_max' && isMinMax) {
      // min/max 格式：单bit画竖线，多bit画网格
      this.drawMinMaxWaveform(x0, x1, y, value, width);
    } else if (value.width === 1) {
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
    _width: number
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

    // Note: Transition edge is drawn by the next segment's starting position
    // No need to draw vertical line here - segments are contiguous
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
    // 处理 WASM 返回的 snake_case 和 camelCase 两种格式
    const displayStr = value.displayStr || value.display_str;
    if (width > 20 && displayStr) {
      this.ctx.fillStyle = textColor;
      // 增大字体，去掉粗体，与 mock data 保持一致
      this.ctx.font = '14px Consolas, Monaco, monospace';

      // 截断标签以适应空间
      const label = this.truncateLabel(displayStr, width - 8);
      const textWidth = this.ctx.measureText(label).width;
      const textX = x0 + (width - textWidth) / 2;
      const textY = y + 5;  // 垂直居中 (调整以匹配更大的字体)

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
   * 绘制 X 波形：红色交叉线（不显示X字符）
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

    // 不绘制 X 字符标签
  }

  /**
   * 绘制 Z 波形：蓝色虚线（中间，不显示Z字符）
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

    // 不绘制 Z 字符标签
  }

  /**
   * 绘制 min/max 波形（LoD 1+ 格式）
   * 
   * 单bit：绘制垂直线表示值在变化
   * 多bit：绘制网格状背景表示值在变化
   */
  private drawMinMaxWaveform(
    x0: number,
    x1: number,
    y: number,
    value: FormattedValue,
    width: number,
    groupInfo?: { isContinuous: boolean; groupSize: number; groupIndex: number }
  ): void {
    if (!this.ctx) return;

    const waveHeight = this.rowHeight * 0.35;

    if (value.width === 1) {
      // 单bit min/max 绘制规则
      if (!groupInfo || !groupInfo.isContinuous) {
        // 非连续：画一条实体竖线（与正常翻转竖线一样）
        this.ctx.strokeStyle = '#000000';
        this.ctx.lineWidth = 2;
        this.ctx.setLineDash([]); // 实线

        this.ctx.beginPath();
        this.ctx.moveTo(x0, y - waveHeight);
        this.ctx.lineTo(x0, y + waveHeight);
        this.ctx.stroke();
      } else if (groupInfo.groupSize <= 2) {
        // 连续区间 <= 2 pixels：画两条实体竖线
        this.ctx.strokeStyle = '#000000';
        this.ctx.lineWidth = 2;
        this.ctx.setLineDash([]); // 实线

        // 第一条竖线在 x0
        this.ctx.beginPath();
        this.ctx.moveTo(x0, y - waveHeight);
        this.ctx.lineTo(x0, y + waveHeight);
        this.ctx.stroke();

        // 第二条竖线在 x1（如果是组内第一个segment）
        if (groupInfo.groupIndex === 0) {
          this.ctx.beginPath();
          this.ctx.moveTo(x1, y - waveHeight);
          this.ctx.lineTo(x1, y + waveHeight);
          this.ctx.stroke();
        }
      } else {
        // 连续区间 > 2 pixels：画深灰色方框，显示 "toggling"
        const rectHeight = this.rowHeight * 0.75;
        const rectY = y - rectHeight / 2;

        // 深灰色背景
        this.ctx.fillStyle = '#666666';
        this.ctx.fillRect(x0, rectY, width, rectHeight);

        // 绘制边框
        this.ctx.strokeStyle = '#444444';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(x0, rectY, width, rectHeight);

        // 显示 "toggling" 文字（如果空间足够）
        if (width > 50) {
          this.ctx.fillStyle = '#ffffff';
          this.ctx.font = '11px Consolas, Monaco, sans-serif';
          const label = 'toggling';
          const textWidth = this.ctx.measureText(label).width;
          if (textWidth < width - 10) {
            const textX = x0 + (width - textWidth) / 2;
            const textY = y + 4;
            this.ctx.fillText(label, textX, textY);
          }
        }
      }
    } else {
      // 多bit：绘制网格状背景
      const rectHeight = this.rowHeight * 0.75;
      const rectY = y - rectHeight / 2;

      // 绘制灰色背景
      this.ctx.fillStyle = '#f0f0f0';
      this.ctx.fillRect(x0, rectY, width, rectHeight);

      // 绘制网格线
      this.ctx.strokeStyle = '#cccccc';
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([2, 2]);

      // 水平网格线
      const gridSpacing = rectHeight / 4;
      for (let i = 1; i < 4; i++) {
        const gridY = rectY + i * gridSpacing;
        this.ctx.beginPath();
        this.ctx.moveTo(x0, gridY);
        this.ctx.lineTo(x1, gridY);
        this.ctx.stroke();
      }

      // 垂直网格线
      const vGridSpacing = Math.max(10, width / 5);
      for (let x = x0 + vGridSpacing; x < x1; x += vGridSpacing) {
        this.ctx.beginPath();
        this.ctx.moveTo(x, rectY);
        this.ctx.lineTo(x, rectY + rectHeight);
        this.ctx.stroke();
      }

      this.ctx.setLineDash([]);

      // 绘制边框
      this.ctx.strokeStyle = '#999999';
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(x0, rectY, width, rectHeight);

      // 绘制 min/max 标签（处理 snake_case 和 camelCase）
      const minVal = value.minValue || value.min_value;
      const maxVal = value.maxValue || value.max_value;
      if (width > 40 && minVal && maxVal) {
        this.ctx.fillStyle = '#666666';
        this.ctx.font = '11px Consolas, Monaco, monospace';
        const label = `${minVal}..${maxVal}`;
        const textWidth = this.ctx.measureText(label).width;
        const textX = x0 + (width - textWidth) / 2;
        const textY = y + 4;
        this.ctx.fillText(label, textX, textY);
      }
    }
  }

  /**
   * 截断标签以适应空间
   */
  private truncateLabel(label: string | undefined, maxWidth: number): string {
    if (!this.ctx) return label || '';
    
    // 处理空值情况
    if (!label) {
      return '';
    }

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
   * @param timeConfig 时间配置，用于转换显示单位
   */
  private drawTimeRuler(width: number, height: number, viewport: TimeRangeOnly, timeConfig?: TimeConfig): void {
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

    let lastLabelText: string | null = null;
    let isFirstTick = true;

    for (let tick = firstMajorTick; tick <= lastMajorTick; tick += majorStep) {
      const x = ((tick - viewport.timeStart) / lod0Range) * width;

      // Draw major tick line
      this.ctx.beginPath();
      this.ctx.moveTo(x, height - 10);
      this.ctx.lineTo(x, height - 1);
      this.ctx.stroke();

      // Convert tick value to display unit if timeConfig is provided
      let displayValue: number;
      let unitLabel = '';
      if (timeConfig && timeConfig.DisplayUnitPerLoD0Unit > 0) {
        displayValue = tick / timeConfig.DisplayUnitPerLoD0Unit;
        // Format: keep up to 6 digits (3+3), use K suffix when exceeding 3 digits
        // Examples: 999 -> "999", 1,000 -> "1,000", 999,999 -> "999,999", 1,000,000 -> "1,000K"
        if (displayValue >= 1_000_000) {
          displayValue = displayValue / 1_000;
          unitLabel = 'K';
        }
        // else: 0-999,999, keep as-is with comma separator
      } else {
        displayValue = tick;
      }

      // Draw time label: format with comma separators (e.g., 999,999K)
      const intValue = Math.floor(displayValue);
      let labelText: string;
      if (unitLabel) {
        // For values with unit (e.g., 999,999K), format the number part
        if (intValue >= 1_000) {
          const high = Math.floor(intValue / 1_000);
          const low = intValue % 1_000;
          labelText = `${high},${low.toString().padStart(3, '0')}${unitLabel}`;
        } else {
          labelText = intValue.toString() + unitLabel;
        }
      } else {
        // For values without unit (0-999,999)
        if (intValue >= 1_000) {
          const high = Math.floor(intValue / 1_000);
          const low = intValue % 1_000;
          labelText = `${high},${low.toString().padStart(3, '0')}`;
        } else {
          labelText = intValue.toString();
        }
      }

      // Skip if not first tick and label is same as previous
      if (!isFirstTick && labelText === lastLabelText) {
        continue;
      }

      this.ctx.fillText(labelText, x + 2, height - 12);
      lastLabelText = labelText;
      isFirstTick = false;
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
