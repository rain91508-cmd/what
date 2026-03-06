// ============================================
// Viewport Management
// ============================================
// Centralized viewport operations to ensure timeStart/timeEnd are always integers
// All code must use these functions to modify viewport, direct modification is prohibited

import type { Viewport } from '../types';

// Simple time range interface (subset of Viewport)
export interface TimeRangeOnly {
  timeStart: number;
  timeEnd: number;
}

/**
 * Validate and sanitize time range values
 * Ensures timeStart and timeEnd are integers (u64 compatible)
 * Clamps values to waveform range if provided
 * 
 * @param timeStart - Start time (will be floored to integer)
 * @param timeEnd - End time (will be floored to integer)
 * @param waveformRange - Optional waveform total range for clamping (if not provided, uses options.maxTime)
 * @param options - Optional constraints
 * @returns Sanitized time range and whether changes were made
 */
export function sanitizeTimeRange(
  timeStart: number,
  timeEnd: number,
  waveformRange?: { start: number; end: number },
  options?: {
    minRange?: number;     // Minimum time range
    allowNegative?: boolean; // Allow negative start time (default: false)
  }
): { timeStart: number; timeEnd: number; changed: boolean } {
  let changed = false;
  
  // Determine effective range limits
  const rangeStart = waveformRange?.start ?? 0;
  const rangeEnd = waveformRange?.end ?? Number.MAX_SAFE_INTEGER;
  
  // Step 1: Ensure integers by truncating decimals
  let start = Math.floor(timeStart);
  let end = Math.floor(timeEnd);
  
  if (start !== timeStart || end !== timeEnd) {
    changed = true;
  }
  
  // Step 2: Clamp to waveform range
  if (start < rangeStart) {
    console.warn(`[Viewport] Start time ${start} below range ${rangeStart}, clamping`);
    start = rangeStart;
    changed = true;
  }
  if (end > rangeEnd) {
    console.warn(`[Viewport] End time ${end} exceeds range ${rangeEnd}, clamping`);
    end = rangeEnd;
    changed = true;
  }
  
  // Step 3: Ensure start < end
  if (start >= end) {
    console.warn(`[Viewport] Invalid time range: ${start} >= ${end}, adjusting`);
    end = start + 1;
    // Re-check range end constraint
    if (end > rangeEnd) {
      end = rangeEnd;
      start = Math.max(rangeStart, end - 1);
    }
    changed = true;
  }
  
  // Step 4: Handle negative start time (only if not allowing negative and rangeStart >= 0)
  if (!options?.allowNegative && start < 0 && rangeStart >= 0) {
    console.warn(`[Viewport] Negative start time: ${start}, clamping to 0`);
    start = 0;
    if (end <= start) {
      end = start + 1;
    }
    changed = true;
  }
  
  // Step 5: Apply minimum range constraint
  if (options?.minRange !== undefined) {
    const range = end - start;
    if (range < options.minRange) {
      end = start + options.minRange;
      // Re-check range end constraint
      if (end > rangeEnd) {
        end = rangeEnd;
        start = Math.max(rangeStart, end - options.minRange);
      }
      changed = true;
    }
  }
  
  return { timeStart: start, timeEnd: end, changed };
}

/**
 * Create a new Viewport with sanitized time range
 * This is the ONLY allowed way to create a Viewport with time values
 * 
 * @param timeStart - Start time
 * @param timeEnd - End time
 * @param waveformRange - Optional waveform total range for clamping
 * @param signalStart - Start signal index
 * @param signalEnd - End signal index
 * @param pixelsPerTime - Pixels per time unit
 * @param pixelsPerSignal - Pixels per signal
 */
export function createViewport(
  timeStart: number,
  timeEnd: number,
  waveformRange?: { start: number; end: number },
  signalStart: number = 0,
  signalEnd: number = 10,
  pixelsPerTime: number = 0,
  pixelsPerSignal: number = 0
): Viewport {
  const { timeStart: start, timeEnd: end } = sanitizeTimeRange(timeStart, timeEnd, waveformRange);

  return {
    timeStart: start,
    timeEnd: end,
    signalStart: Math.floor(signalStart),
    signalEnd: Math.floor(signalEnd),
    pixelsPerTime,
    pixelsPerSignal,
  };
}

/**
 * Set time range on an existing viewport
 * This is the ONLY allowed way to modify timeStart/timeEnd
 * 
 * @param viewport - Current viewport
 * @param timeStart - New start time
 * @param timeEnd - New end time
 * @param waveformRange - Optional waveform total range for clamping
 */
export function setViewTimeRange(
  viewport: Viewport,
  timeStart: number,
  timeEnd: number,
  waveformRange?: { start: number; end: number }
): Viewport {
  const { timeStart: start, timeEnd: end } = sanitizeTimeRange(timeStart, timeEnd, waveformRange);

  return {
    ...viewport,
    timeStart: start,
    timeEnd: end,
  };
}

/**
 * Update viewport with partial changes (preserving existing time values)
 * Use this for signal range or pixel changes only
 */
export function updateViewport(
  viewport: Viewport,
  updates: Partial<Omit<Viewport, 'timeStart' | 'timeEnd'>>
): Viewport {
  return {
    ...viewport,
    ...updates,
    // Ensure time values are never modified through this function
    timeStart: viewport.timeStart,
    timeEnd: viewport.timeEnd,
  };
}

/**
 * Get time range from viewport
 * Returns integers guaranteed
 */
export function getTimeRange(viewport: TimeRangeOnly): { timeStart: number; timeEnd: number } {
  return {
    timeStart: Math.floor(viewport.timeStart),
    timeEnd: Math.floor(viewport.timeEnd),
  };
}

/**
 * Calculate time from x coordinate (pixel to time)
 * Returns integer time value
 */
export function pixelToTime(
  x: number,
  viewport: Viewport,
  canvasWidth: number
): number {
  const { timeStart, timeEnd } = getTimeRange(viewport);
  const timeRange = timeEnd - timeStart;
  const ratio = x / canvasWidth;
  return Math.floor(timeStart + ratio * timeRange);
}

/**
 * Calculate x coordinate from time (time to pixel)
 * Returns float x coordinate (pixels can be fractional)
 */
export function timeToPixel(
  time: number,
  viewport: Viewport,
  canvasWidth: number
): number {
  const { timeStart, timeEnd } = getTimeRange(viewport);
  const timeRange = timeEnd - timeStart;
  if (timeRange === 0) return 0;
  return ((time - timeStart) / timeRange) * canvasWidth;
}

// ============================================
// Zoom Operations (all return sanitized viewport)
// ============================================

/**
 * Zoom in around cursor position
 * Returns TimeRangeOnly (timeStart/timeEnd only) for compatibility with Tab viewport
 */
export function zoomIn(
  viewport: TimeRangeOnly,
  cursorPosition?: number | null,
  _zoomFactor: number = 0.8
): TimeRangeOnly | null {
  const { timeStart, timeEnd } = getTimeRange(viewport);
  
  const cursorPos = cursorPosition ?? Math.floor((timeStart + timeEnd) / 2);
  
  // Boundary protection
  const canZoomStart = Math.abs(cursorPos - timeStart) > 1;
  const canZoomEnd = Math.abs(cursorPos - timeEnd) > 1;
  
  if (!canZoomStart && !canZoomEnd) {
    return null;
  }
  
  const newStart = canZoomStart 
    ? Math.floor((cursorPos + timeStart) / 2) 
    : timeStart;
  const newEnd = canZoomEnd 
    ? Math.floor((cursorPos + timeEnd) / 2) 
    : timeEnd;
  
  return { timeStart: newStart, timeEnd: newEnd };
}

/**
 * Zoom out around cursor position
 * Returns TimeRangeOnly (timeStart/timeEnd only) for compatibility with Tab viewport
 */
export function zoomOut(
  viewport: TimeRangeOnly,
  cursorPosition?: number | null,
  _zoomFactor: number = 1.25
): TimeRangeOnly | null {
  const { timeStart, timeEnd } = getTimeRange(viewport);
  
  const cursorPos = cursorPosition ?? Math.floor((timeStart + timeEnd) / 2);
  
  const distStart = cursorPos - timeStart;
  const distEnd = timeEnd - cursorPos;
  
  const newStart = Math.floor(cursorPos - distStart * _zoomFactor);
  const newEnd = Math.floor(cursorPos + distEnd * _zoomFactor);
  
  return { timeStart: newStart, timeEnd: newEnd };
}

/**
 * Pan viewport by delta (in time units)
 */
export function panViewport(viewport: Viewport, deltaTime: number): Viewport {
  const { timeStart, timeEnd } = getTimeRange(viewport);
  
  const newStart = Math.floor(timeStart + deltaTime);
  const newEnd = Math.floor(timeEnd + deltaTime);
  
  return setViewTimeRange(viewport, newStart, newEnd);
}

/**
 * Zoom to specific time range
 */
export function zoomToRange(
  viewport: Viewport,
  start: number,
  end: number
): Viewport {
  return setViewTimeRange(viewport, start, end);
}

/**
 * Reset viewport to full range
 */
export function resetViewport(
  viewport: Viewport,
  fullRange: { start: number; end: number }
): Viewport {
  return setViewTimeRange(viewport, fullRange.start, fullRange.end);
}

// ============================================
// Validation
// ============================================

/**
 * Check if viewport time values are valid integers
 */
export function isValidViewport(viewport: Viewport): boolean {
  const isInteger = (n: number) => Number.isInteger(n);
  return (
    isInteger(viewport.timeStart) &&
    isInteger(viewport.timeEnd) &&
    viewport.timeStart < viewport.timeEnd
  );
}

/**
 * Assert viewport is valid (throws if not)
 */
export function assertValidViewport(viewport: Viewport): void {
  if (!isValidViewport(viewport)) {
    throw new Error(
      `Invalid viewport: timeStart=${viewport.timeStart}, timeEnd=${viewport.timeEnd}. ` +
      `Both must be integers with timeStart < timeEnd.`
    );
  }
}
