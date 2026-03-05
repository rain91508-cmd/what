/**
 * Zoom 相关的工具函数
 * 提供统一的 zoom in/out 逻辑，供 toolbar 按钮和鼠标拖动使用
 */

import type { Viewport } from '../types';
import { sanitizeTimeRange } from './viewport';

// 最大时间范围（LoD0Units）
export const MAX_LOD0_UNITS = 1000000;

/**
 * Zoom In: 以 cursor 为中心放大视图
 * @param viewport 当前视口
 * @param cursorPosition cursor 位置（可选，默认为视口中心）
 * @returns 新的视口，如果无法放大则返回 null
 */
export function zoomIn(
  viewport: Viewport,
  cursorPosition?: number | null
): Viewport | null {
  const { timeStart, timeEnd } = viewport;
  const cursorPos = cursorPosition ?? Math.floor((timeStart + timeEnd) / 2);

  // 边界保护：检查是否还能继续放大
  const canZoomStart = Math.abs(cursorPos - timeStart) > 1;
  const canZoomEnd = Math.abs(cursorPos - timeEnd) > 1;

  if (!canZoomStart && !canZoomEnd) {
    return null; // 已经到达最大缩放
  }

  // 以 cursor 为中心放大，两侧向 cursor 靠拢
  const rawStart = canZoomStart ? Math.floor((cursorPos + timeStart) / 2) : timeStart;
  const rawEnd = canZoomEnd ? Math.floor((cursorPos + timeEnd) / 2) : timeEnd;

  // Validate and sanitize time range
  const sanitized = sanitizeTimeRange(rawStart, rawEnd);

  return {
    ...viewport,
    timeStart: sanitized.timeStart,
    timeEnd: sanitized.timeEnd,
  };
}

/**
 * Zoom Out: 以 cursor 为中心缩小视图
 * @param viewport 当前视口
 * @param cursorPosition cursor 位置（可选，默认为视口中心）
 * @returns 新的视口，如果无法缩小则返回 null
 */
export function zoomOut(
  viewport: Viewport,
  cursorPosition?: number | null
): Viewport | null {
  const { timeStart, timeEnd } = viewport;
  const cursorPos = cursorPosition ?? Math.floor((timeStart + timeEnd) / 2);

  // 计算新的边界：以 cursor 为中心，两侧远离 cursor
  const distStart = cursorPos - timeStart;
  const distEnd = timeEnd - cursorPos;
  let newStart = cursorPos - (distStart * 2);
  let newEnd = cursorPos + (distEnd * 2);

  // 限制在有效范围内 [0, MAX_LOD0_UNITS]
  const clampedStart = Math.max(0, newStart);
  const clampedEnd = Math.min(MAX_LOD0_UNITS, newEnd);

  // 边界保护：检查是否还能继续缩小
  const canZoomOutStart = newStart < timeStart && clampedStart !== timeStart;
  const canZoomOutEnd = newEnd > timeEnd && clampedEnd !== timeEnd;

  if (!canZoomOutStart && !canZoomOutEnd) {
    return null; // 已经到达最小缩放
  }

  const finalStart = canZoomOutStart ? clampedStart : timeStart;
  const finalEnd = canZoomOutEnd ? clampedEnd : timeEnd;

  // Validate and sanitize time range
  const sanitized = sanitizeTimeRange(finalStart, finalEnd, { maxTime: MAX_LOD0_UNITS });

  return {
    ...viewport,
    timeStart: sanitized.timeStart,
    timeEnd: sanitized.timeEnd,
  };
}

/**
 * 检查是否可以 Zoom In
 */
export function canZoomIn(viewport: Viewport, cursorPosition?: number | null): boolean {
  const { timeStart, timeEnd } = viewport;
  const cursorPos = cursorPosition ?? Math.floor((timeStart + timeEnd) / 2);
  return Math.abs(cursorPos - timeStart) > 1 || Math.abs(cursorPos - timeEnd) > 1;
}

/**
 * 检查是否可以 Zoom Out
 */
export function canZoomOut(viewport: Viewport, cursorPosition?: number | null): boolean {
  const { timeStart, timeEnd } = viewport;
  const cursorPos = cursorPosition ?? Math.floor((timeStart + timeEnd) / 2);

  const distStart = cursorPos - timeStart;
  const distEnd = timeEnd - cursorPos;
  const newStart = cursorPos - (distStart * 2);
  const newEnd = cursorPos + (distEnd * 2);

  const clampedStart = Math.max(0, newStart);
  const clampedEnd = Math.min(MAX_LOD0_UNITS, newEnd);

  return (newStart < timeStart && clampedStart !== timeStart) ||
         (newEnd > timeEnd && clampedEnd !== timeEnd);
}
