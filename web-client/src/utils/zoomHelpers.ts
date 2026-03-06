/**
 * Zoom 相关的工具函数
 * 提供统一的 zoom in/out 逻辑，供 toolbar 按钮和鼠标拖动使用
 */

import { sanitizeTimeRange, type TimeRangeOnly } from './viewport';

/**
 * Zoom In: 以 cursor 为中心放大视图
 * @param viewport 当前视口（TimeRangeOnly 兼容 Tab.viewport）
 * @param cursorPosition cursor 位置（可选，默认为视口中心）
 * @param waveformRange 波形总范围（可选，用于边界限制）
 * @returns 新的 time range，如果无法放大则返回 null
 */
export function zoomIn(
  viewport: TimeRangeOnly,
  cursorPosition?: number | null,
  waveformRange?: { start: number; end: number }
): TimeRangeOnly | null {
  const { timeStart, timeEnd } = viewport;
  const cursorPos = cursorPosition ?? ((timeStart + timeEnd) / 2);

  // 边界保护：检查是否还能继续放大
  const canZoomStart = Math.abs(cursorPos - timeStart) > 1;
  const canZoomEnd = Math.abs(cursorPos - timeEnd) > 1;

  if (!canZoomStart && !canZoomEnd) {
    return null; // 已经到达最大缩放
  }

  // 以 cursor 为中心放大，两侧向 cursor 靠拢
  const rawStart = canZoomStart ? (cursorPos + timeStart) / 2 : timeStart;
  const rawEnd = canZoomEnd ? (cursorPos + timeEnd) / 2 : timeEnd;

  // Validate and sanitize time range
  const sanitized = sanitizeTimeRange(rawStart, rawEnd, waveformRange);

  return {
    timeStart: sanitized.timeStart,
    timeEnd: sanitized.timeEnd,
  };
}

/**
 * Zoom Out: 以 cursor 为中心缩小视图
 * @param viewport 当前视口（TimeRangeOnly 兼容 Tab.viewport）
 * @param cursorPosition cursor 位置（可选，默认为视口中心）
 * @param waveformRange 波形总范围（可选，用于边界限制）
 * @returns 新的 time range，如果无法缩小则返回 null
 */
export function zoomOut(
  viewport: TimeRangeOnly,
  cursorPosition?: number | null,
  waveformRange?: { start: number; end: number }
): TimeRangeOnly | null {
  const { timeStart, timeEnd } = viewport;
  const cursorPos = cursorPosition ?? ((timeStart + timeEnd) / 2);

  // 获取实际的范围限制
  const rangeStart = waveformRange?.start ?? 0;
  const rangeEnd = waveformRange?.end ?? Number.MAX_SAFE_INTEGER;

  // 计算新的边界：以 cursor 为中心，两侧远离 cursor
  const distStart = cursorPos - timeStart;
  const distEnd = timeEnd - cursorPos;
  let newStart = cursorPos - (distStart * 2);
  let newEnd = cursorPos + (distEnd * 2);

  // 限制在实际波形范围内
  const clampedStart = Math.max(rangeStart, newStart);
  const clampedEnd = Math.min(rangeEnd, newEnd);

  // 边界保护：检查是否还能继续缩小
  const canZoomOutStart = newStart < timeStart && clampedStart !== timeStart;
  const canZoomOutEnd = newEnd > timeEnd && clampedEnd !== timeEnd;

  if (!canZoomOutStart && !canZoomOutEnd) {
    return null; // 已经到达最小缩放
  }

  const finalStart = canZoomOutStart ? clampedStart : timeStart;
  const finalEnd = canZoomOutEnd ? clampedEnd : timeEnd;

  // Validate and sanitize time range
  const sanitized = sanitizeTimeRange(finalStart, finalEnd, waveformRange);

  return {
    timeStart: sanitized.timeStart,
    timeEnd: sanitized.timeEnd,
  };
}

/**
 * 检查是否可以 Zoom In
 */
export function canZoomIn(viewport: TimeRangeOnly, cursorPosition?: number | null): boolean {
  const { timeStart, timeEnd } = viewport;
  const cursorPos = cursorPosition ?? ((timeStart + timeEnd) / 2);
  return Math.abs(cursorPos - timeStart) > 1 || Math.abs(cursorPos - timeEnd) > 1;
}

/**
 * 检查是否可以 Zoom Out
 */
export function canZoomOut(
  viewport: TimeRangeOnly,
  cursorPosition?: number | null,
  waveformRange?: { start: number; end: number }
): boolean {
  const { timeStart, timeEnd } = viewport;
  const cursorPos = cursorPosition ?? ((timeStart + timeEnd) / 2);

  // 获取实际的范围限制
  const rangeStart = waveformRange?.start ?? 0;
  const rangeEnd = waveformRange?.end ?? Number.MAX_SAFE_INTEGER;

  const distStart = cursorPos - timeStart;
  const distEnd = timeEnd - cursorPos;
  const newStart = cursorPos - (distStart * 2);
  const newEnd = cursorPos + (distEnd * 2);

  const clampedStart = Math.max(rangeStart, newStart);
  const clampedEnd = Math.min(rangeEnd, newEnd);

  return (newStart < timeStart && clampedStart !== timeStart) ||
         (newEnd > timeEnd && clampedEnd !== timeEnd);
}
