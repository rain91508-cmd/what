/**
 * Waveform Drawing - 通用波形绘制函数
 * 
 * 这个模块提供与 Canvas 类型无关的波形绘制函数，
 * 可以同时用于主线程 (HTMLCanvasElement) 和 Worker (OffscreenCanvas)。
 */

import type { RenderSegment, ValueInfo } from '../waveformProviderInterface';

// 类型定义 - 使用 ValueInfo 作为基础类型
export interface FormattedValue extends ValueInfo {
  // 扩展 ValueInfo 以支持 type/valueType/value_type 三种格式
  type?: string;  // WASM返回的格式
  value_type?: string;
  display_str?: string;
  has_xz?: boolean;
  min_value?: string;
  max_value?: string;
  is_min_max?: boolean;
}

export interface DrawContext {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  rowHeight: number;
}

export interface TimeRangeOnly {
  timeStart: number;
  timeEnd: number;
}

export interface TimeConfig {
  DisplayUnitPerLoD0Unit: number;
}

/**
 * 获取信号电平（用于单bit信号）
 * Returns: 0 for low, 1 for high, -1 for X/Z/unknown
 */
export function getSignalLevel(value: FormattedValue): number {
  // 使用 type/valueType/value_type 三种格式
  const type = value.type || value.valueType || value.value_type;
  switch (type) {
    case 'zero': return 0;
    case 'one': return 1;
    default: return -1;
  }
}

/**
 * 检测连续的 min/max segment 组
 */
export function detectMinMaxGroups(
  segments: Array<{ x0: number; x1: number; value: FormattedValue }>
): Map<number, { isContinuous: boolean; groupSize: number; groupIndex: number }> {
  const result = new Map<number, { isContinuous: boolean; groupSize: number; groupIndex: number }>();

  // 找到所有 is_min_max=true 的 segment（包括单bit和多bit）
  const minMaxSegments: { index: number; x0: number; x1: number }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isMinMax = seg.value.isMinMax || seg.value.is_min_max;
    const valueType = seg.value.type || seg.value.valueType || seg.value.value_type;
    // 支持单bit和多bit信号的min_max类型
    if (valueType === 'min_max' && isMinMax) {
      minMaxSegments.push({ index: i, x0: seg.x0, x1: seg.x1 });
    }
  }

  if (minMaxSegments.length === 0) {
    return result;
  }

  // 按时间排序
  minMaxSegments.sort((a, b) => a.x0 - b.x0);

  // 按时间连续性分组
  let currentGroup: typeof minMaxSegments = [minMaxSegments[0]];

  for (let i = 1; i < minMaxSegments.length; i++) {
    const curr = minMaxSegments[i];
    const prev = minMaxSegments[i - 1];

    const epsilon = 0.001;
    if (Math.abs(curr.x0 - prev.x1) < epsilon) {
      currentGroup.push(curr);
    } else {
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

  // 保存最后一组
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
 * 查找大的 min/max 组（groupSize > 2）
 */
export function findLargeMinMaxGroups(
  segments: Array<{ x0: number; x1: number; y: number; value: FormattedValue }>,
  minMaxGroups: Map<number, { isContinuous: boolean; groupSize: number; groupIndex: number }>
): Array<{ startIndex: number; endIndex: number; x0: number; x1: number; y: number; groupSize: number }> {
  const result: Array<{ startIndex: number; endIndex: number; x0: number; x1: number; y: number; groupSize: number }> = [];

  let currentGroup: typeof result[0] | null = null;

  for (let i = 0; i < segments.length; i++) {
    const groupInfo = minMaxGroups.get(i);
    if (groupInfo && groupInfo.groupSize > 2) {
      const seg = segments[i];
      if (!currentGroup) {
        currentGroup = {
          startIndex: i,
          endIndex: i,
          x0: seg.x0,
          x1: seg.x1,
          y: seg.y,
          groupSize: groupInfo.groupSize
        };
      } else if (currentGroup.groupSize === groupInfo.groupSize) {
        currentGroup.endIndex = i;
        currentGroup.x1 = seg.x1;
      } else {
        result.push(currentGroup);
        currentGroup = {
          startIndex: i,
          endIndex: i,
          x0: seg.x0,
          x1: seg.x1,
          y: seg.y,
          groupSize: groupInfo.groupSize
        };
      }
    } else if (currentGroup) {
      result.push(currentGroup);
      currentGroup = null;
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }

  return result;
}

/**
 * 绘制跳变边沿（垂直线）
 */
export function drawTransitionEdge(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  prevLevel: number,
  currLevel: number,
  rowHeight: number
): void {
  if (prevLevel < 0 || currLevel < 0) return;

  const waveHeight = rowHeight * 0.35;
  const yLow = y + waveHeight;
  const yHigh = y - waveHeight;

  const y0 = prevLevel === 0 ? yLow : yHigh;
  const y1 = currLevel === 0 ? yLow : yHigh;

  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, y1);
  ctx.stroke();
}

/**
 * 绘制 X 波形（红色交叉线）
 */
export function drawXWaveform(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x0: number,
  x1: number,
  y: number,
  rowHeight: number
): void {
  const waveHeight = rowHeight * 0.35;
  const yLow = y + waveHeight;
  const yHigh = y - waveHeight;

  ctx.strokeStyle = '#ff0000';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.moveTo(x0, yHigh);
  ctx.lineTo(x1, yLow);
  ctx.moveTo(x0, yLow);
  ctx.lineTo(x1, yHigh);
  ctx.stroke();
}

/**
 * 绘制 Z 波形（蓝色虚线）
 */
export function drawZWaveform(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x0: number,
  x1: number,
  y: number
): void {
  ctx.strokeStyle = '#0066ff';
  ctx.lineWidth = 2;
  ctx.setLineDash([2, 2]);

  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * 绘制单bit波形
 */
export function drawSingleBitWaveform(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x0: number,
  x1: number,
  y: number,
  value: FormattedValue,
  rowHeight: number
): void {
  const waveHeight = rowHeight * 0.35;
  const yLow = y + waveHeight;
  const yHigh = y - waveHeight;
  const yMid = y;

  ctx.lineWidth = 2;
  ctx.setLineDash([]);

  // 获取值类型（支持 type/valueType/value_type 三种格式）
  const valueType = value.type || value.valueType || value.value_type;

  // 处理 min_max 类型（LoD > 0, min=max 情况）
  if (valueType === 'min_max') {
    const minVal = value.minValue || value.min_value;
    if (minVal === '0' || minVal === '00' || minVal === '00000000') {
      ctx.strokeStyle = '#000000';
      ctx.beginPath();
      ctx.moveTo(x0, yLow);
      ctx.lineTo(x1, yLow);
      ctx.stroke();
    } else if (minVal === '1' || minVal === '01' || minVal === '00000001') {
      ctx.strokeStyle = '#00aa00';
      ctx.beginPath();
      ctx.moveTo(x0, yHigh);
      ctx.lineTo(x1, yHigh);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#888888';
      ctx.beginPath();
      ctx.moveTo(x0, yMid);
      ctx.lineTo(x1, yMid);
      ctx.stroke();
    }
    return;
  }

  switch (valueType) {
    case 'zero':
      ctx.strokeStyle = '#000000';
      ctx.beginPath();
      ctx.moveTo(x0, yLow);
      ctx.lineTo(x1, yLow);
      ctx.stroke();
      break;

    case 'one':
      ctx.strokeStyle = '#00aa00';
      ctx.beginPath();
      ctx.moveTo(x0, yHigh);
      ctx.lineTo(x1, yHigh);
      ctx.stroke();
      break;

    case 'all_x':
      drawXWaveform(ctx, x0, x1, y, rowHeight);
      break;

    case 'all_z':
      drawZWaveform(ctx, x0, x1, yMid);
      break;

    case 'mixed':
    case 'numeric':
    default:
      ctx.strokeStyle = '#00aa00';
      ctx.beginPath();
      ctx.moveTo(x0, yHigh);
      ctx.lineTo(x1, yHigh);
      ctx.stroke();
      break;
  }
}

/**
 * 截断标签以适应空间
 */
export function truncateLabel(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  label: string | undefined,
  maxWidth: number
): string {
  if (!label) return '';

  const textWidth = ctx.measureText(label).width;
  if (textWidth <= maxWidth) {
    return label;
  }

  const ellipsis = '...';
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  const availableWidth = maxWidth - ellipsisWidth;

  if (availableWidth <= 0) {
    return ellipsis;
  }

  const avgCharWidth = textWidth / label.length;
  const charsToShow = Math.floor(availableWidth / avgCharWidth / 2);

  if (charsToShow <= 0) {
    return ellipsis;
  }

  return label.slice(0, charsToShow) + ellipsis + label.slice(-charsToShow);
}

/**
 * 绘制多bit波形
 */
export function drawMultiBitWaveform(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x0: number,
  x1: number,
  y: number,
  value: FormattedValue,
  rowHeight: number
): void {
  const width = x1 - x0;
  const rectHeight = rowHeight * 0.75;
  const rectY = y - rectHeight / 2;

  // 获取值类型
  const valueType = value.type || value.valueType || value.value_type;

  let strokeColor: string;
  let fillColor: string;
  let textColor: string;

  switch (valueType) {
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
  ctx.fillStyle = fillColor;
  ctx.fillRect(x0, rectY, width, rectHeight);

  // 绘制矩形边框
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, rectY, width, rectHeight);

  // 绘制数值标签
  const displayStr = value.displayStr || value.display_str;
  if (width > 20 && displayStr) {
    ctx.fillStyle = textColor;
    ctx.font = '14px Consolas, Monaco, monospace';

    const label = truncateLabel(ctx, displayStr, width - 8);
    const textWidth = ctx.measureText(label).width;
    const textX = x0 + (width - textWidth) / 2;
    const textY = y + 5;

    ctx.fillText(label, textX, textY);
  }

  // 绘制跳变边沿
  if (width > 2) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1, rectY);
    ctx.lineTo(x1, rectY + rectHeight);
    ctx.stroke();
  }
}

/**
 * 绘制 min/max 波形
 */
export function drawMinMaxWaveform(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x0: number,
  x1: number,
  y: number,
  value: FormattedValue,
  rowHeight: number,
  groupInfo?: { isContinuous: boolean; groupSize: number; groupIndex: number }
): void {
  const waveHeight = rowHeight * 0.35;
  const width = x1 - x0;

  if (value.width === 1) {
    if (!groupInfo || !groupInfo.isContinuous) {
      // 非连续：画一条实体竖线
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.moveTo(x0, y - waveHeight);
      ctx.lineTo(x0, y + waveHeight);
      ctx.stroke();
    } else if (groupInfo.groupSize <= 2) {
      // 连续区间 <= 2 pixels：画两条实体竖线
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.moveTo(x0, y - waveHeight);
      ctx.lineTo(x0, y + waveHeight);
      ctx.stroke();

      if (groupInfo.groupIndex === 0) {
        ctx.beginPath();
        ctx.moveTo(x1, y - waveHeight);
        ctx.lineTo(x1, y + waveHeight);
        ctx.stroke();
      }
    } else {
      // 连续区间 > 2 pixels：画深灰色方框
      const rectHeight = rowHeight * 0.75;
      const rectY = y - rectHeight / 2;

      ctx.fillStyle = '#666666';
      ctx.fillRect(x0, rectY, width, rectHeight);

      ctx.strokeStyle = '#444444';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, rectY, width, rectHeight);

      if (width > 50) {
        ctx.fillStyle = '#ffffff';
        ctx.font = '11px Consolas, Monaco, sans-serif';
        const label = 'toggling';
        const textWidth = ctx.measureText(label).width;
        if (textWidth < width - 10) {
          const textX = x0 + (width - textWidth) / 2;
          const textY = y + 4;
          ctx.fillText(label, textX, textY);
        }
      }
    }
  } else {
    // 多bit：绘制网格状背景
    const rectHeight = rowHeight * 0.75;
    const rectY = y - rectHeight / 2;

    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(x0, rectY, width, rectHeight);

    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);

    const gridSpacing = rectHeight / 4;
    for (let i = 1; i < 4; i++) {
      const gridY = rectY + i * gridSpacing;
      ctx.beginPath();
      ctx.moveTo(x0, gridY);
      ctx.lineTo(x1, gridY);
      ctx.stroke();
    }

    const vGridSpacing = Math.max(10, width / 5);
    for (let x = x0 + vGridSpacing; x < x1; x += vGridSpacing) {
      ctx.beginPath();
      ctx.moveTo(x, rectY);
      ctx.lineTo(x, rectY + rectHeight);
      ctx.stroke();
    }

    ctx.setLineDash([]);

    ctx.strokeStyle = '#999999';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, rectY, width, rectHeight);

    // 绘制 min/max 标签
    const minVal = value.minValue || value.min_value;
    const maxVal = value.maxValue || value.max_value;
    if (width > 40 && minVal && maxVal) {
      ctx.fillStyle = '#666666';
      ctx.font = '11px Consolas, Monaco, monospace';
      const label = `${minVal}..${maxVal}`;
      const textWidth = ctx.measureText(label).width;
      const textX = x0 + (width - textWidth) / 2;
      const textY = y + 4;
      ctx.fillText(label, textX, textY);
    }
  }
}

/**
 * 绘制单个 segment
 */
export function drawSegment(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  seg: { x0: number; x1: number; y: number; value: FormattedValue },
  rowHeight: number,
  minMaxGroups?: Map<number, { isContinuous: boolean; groupSize: number; groupIndex: number }>,
  segmentIndex?: number
): void {
  const { x0, x1, y, value } = seg;
  // _width 保留供后续使用
  void (x1 - x0);

  const valueType = value.type || value.valueType || value.value_type;
  const isMinMax = value.isMinMax || value.is_min_max;
  if (valueType === 'min_max' && isMinMax) {
    const groupInfo = segmentIndex !== undefined ? minMaxGroups?.get(segmentIndex) : undefined;
    drawMinMaxWaveform(ctx, x0, x1, y, value, rowHeight, groupInfo);
  } else if (value.width === 1) {
    drawSingleBitWaveform(ctx, x0, x1, y, value, rowHeight);
  } else {
    drawMultiBitWaveform(ctx, x0, x1, y, value, rowHeight);
  }
}

/**
 * 绘制大的 min/max 组方框
 */
export function drawMinMaxGroupBox(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x0: number,
  x1: number,
  y: number,
  _groupSize: number,
  rowHeight: number
): void {
  const width = x1 - x0;
  const rectHeight = rowHeight * 0.75;
  const rectY = y - rectHeight / 2;

  ctx.fillStyle = '#666666';
  ctx.fillRect(x0, rectY, width, rectHeight);

  ctx.strokeStyle = '#444444';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, rectY, width, rectHeight);

  if (width > 50) {
    ctx.fillStyle = '#ffffff';
    ctx.font = '11px Consolas, Monaco, sans-serif';
    const label = 'toggling';
    const textWidth = ctx.measureText(label).width;
    if (textWidth < width - 10) {
      const textX = x0 + (width - textWidth) / 2;
      const textY = y + 4;
      ctx.fillText(label, textX, textY);
    }
  }
}

/**
 * 绘制时间标尺
 */
export function drawTimeRuler(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: TimeRangeOnly,
  timeConfig?: TimeConfig
): void {
  // 绘制标尺背景
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(0, 0, width, height);

  // 绘制底部边框
  ctx.strokeStyle = '#c0c0c0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height - 1);
  ctx.lineTo(width, height - 1);
  ctx.stroke();

  const lod0Range = viewport.timeEnd - viewport.timeStart;

  // 计算主刻度步长
  const targetLabelCount = Math.max(2, Math.floor(width / 100));
  const majorStep = calculateNiceStep(lod0Range / targetLabelCount);
  const minorStep = majorStep / 10;

  const firstMajorTick = Math.ceil(viewport.timeStart / majorStep) * majorStep;
  const lastMajorTick = Math.floor(viewport.timeEnd / majorStep) * majorStep;

  // 绘制次刻度
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1;

  const firstMinorTick = Math.ceil(viewport.timeStart / minorStep) * minorStep;
  const lastMinorTick = Math.floor(viewport.timeEnd / minorStep) * minorStep;

  for (let tick = firstMinorTick; tick <= lastMinorTick; tick += minorStep) {
    if (Math.abs(tick % majorStep) < minorStep / 2) continue;

    const x = ((tick - viewport.timeStart) / lod0Range) * width;
    const minorIndex = Math.round((tick % majorStep) / minorStep);
    const tickHeight = minorIndex === 5 ? 8 : 4;

    ctx.beginPath();
    ctx.moveTo(x, height - tickHeight);
    ctx.lineTo(x, height - 1);
    ctx.stroke();
  }

  // 绘制主刻度
  ctx.fillStyle = '#333';
  ctx.font = '11px Consolas, Monaco, monospace';
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1;

  let lastLabelText: string | null = null;
  let isFirstTick = true;

  for (let tick = firstMajorTick; tick <= lastMajorTick; tick += majorStep) {
    const x = ((tick - viewport.timeStart) / lod0Range) * width;

    ctx.beginPath();
    ctx.moveTo(x, height - 10);
    ctx.lineTo(x, height - 1);
    ctx.stroke();

    // 转换显示单位
    let displayValue: number;
    let unitLabel = '';
    if (timeConfig && timeConfig.DisplayUnitPerLoD0Unit > 0) {
      displayValue = tick / timeConfig.DisplayUnitPerLoD0Unit;
      if (displayValue >= 1_000_000) {
        displayValue = displayValue / 1_000;
        unitLabel = 'K';
      }
    } else {
      displayValue = tick;
    }

    // 格式化标签 - 每3位加逗号
    const intValue = Math.floor(displayValue);
    const formattedNumber = intValue.toLocaleString('en-US');
    let labelText: string;
    if (unitLabel) {
      labelText = formattedNumber + unitLabel;
    } else {
      labelText = formattedNumber;
    }

    if (!isFirstTick && labelText === lastLabelText) {
      continue;
    }

    ctx.fillText(labelText, x + 2, height - 12);
    lastLabelText = labelText;
    isFirstTick = false;
  }
}

/**
 * 计算合适的步长
 */
export function calculateNiceStep(rawStep: number): number {
  if (rawStep <= 0) return 1;

  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalizedStep = rawStep / magnitude;

  if (normalizedStep < 1.5) return 1 * magnitude;
  if (normalizedStep < 3.5) return 2 * magnitude;
  if (normalizedStep < 7.5) return 5 * magnitude;
  return 10 * magnitude;
}

/**
 * 渲染完整的波形
 */
export function renderWaveform(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  segments: RenderSegment[],
  viewport: TimeRangeOnly,
  canvasWidth: number,
  canvasHeight: number,
  rulerHeight: number = 20,
  timeConfig?: TimeConfig,
  rowHeight: number = 25
): void {
  // 清空画布
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // 绘制时间标尺
  drawTimeRuler(ctx, canvasWidth, rulerHeight, viewport, timeConfig);

  // 按行分组 segments
  const segmentsByRow = new Map<number, RenderSegment[]>();
  for (const seg of segments) {
    const rowKey = Math.round(seg.y * 100) / 100;
    if (!segmentsByRow.has(rowKey)) {
      segmentsByRow.set(rowKey, []);
    }
    segmentsByRow.get(rowKey)!.push(seg);
  }

  // 绘制每行的 segments
  for (const [_rowKey, rowSegments] of segmentsByRow) {
    rowSegments.sort((a, b) => a.x0 - b.x0);

    const minMaxGroups = detectMinMaxGroups(rowSegments);
    const largeGroups = findLargeMinMaxGroups(rowSegments, minMaxGroups);

    let prevValue: FormattedValue | null = null;
    let i = 0;
    while (i < rowSegments.length) {
      const seg = rowSegments[i];
      // 将 seg.value 转换为 FormattedValue
      const formattedValue = seg.value as unknown as FormattedValue;

      // 检查是否属于大的 min/max 组
      const largeGroup = largeGroups.find(g => i >= g.startIndex && i <= g.endIndex);
      if (largeGroup) {
        drawMinMaxGroupBox(ctx, largeGroup.x0, largeGroup.x1, largeGroup.y, largeGroup.groupSize, rowHeight);
        i = largeGroup.endIndex + 1;
        prevValue = formattedValue;
        continue;
      }

      // 绘制跳变边沿
      if (prevValue && seg.value.width === 1 && prevValue.width === 1) {
        const prevLevel = getSignalLevel(prevValue);
        const currLevel = getSignalLevel(formattedValue);
        if (prevLevel !== currLevel) {
          drawTransitionEdge(ctx, seg.x0, seg.y, prevLevel, currLevel, rowHeight);
        }
      }

      // 绘制 segment
      drawSegment(ctx, { ...seg, value: formattedValue }, rowHeight, minMaxGroups, i);
      prevValue = formattedValue;
      i++;
    }
  }
}
