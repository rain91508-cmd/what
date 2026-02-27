// ============================================
// wSignal Module - Waveform Viewer
// ============================================
//
// Responsibilities (per spec.md):
// - Signal management (add/remove/reorder signals)
// - Signal groups and bus operations
// - Waveform rendering with WebGL/regl
// - Cursor and marker functionality
// - Zoom and pan operations
// - Value searching
// - Window management (split views)

import type {
  Signal,
  SignalGroup,
  BusConfig,
  CursorState,
  MarkerState,
  Viewport,
  ZoomState,
  TimeRange,
  LoDLevelType,
  WaveformSignal,
} from '../../types';
import { LoDLevel } from '../../types';

// Displayed signal in waveform
export interface DisplayedSignal {
  id: string;
  signal: Signal | WaveformSignal;
  row: number;
  visible: boolean;
  color: string;
  height: number;
  format: ValueFormat;
  group?: string;
}

export enum ValueFormat {
  BINARY = 'binary',
  OCTAL = 'octal',
  DECIMAL = 'decimal',
  HEXADECIMAL = 'hexadecimal',
  ASCII = 'ascii',
}

// Search configuration
export interface SearchConfig {
  signalId: string;
  type: SearchType;
  startTime: number;
  endTime: number;
  value?: string;
  fromValue?: string;
  toValue?: string;
}

export enum SearchType {
  ANY_CHANGE = 'any_change',
  RISING_EDGE = 'rising_edge',
  FALLING_EDGE = 'falling_edge',
  BUS_VALUE = 'bus_value',
  VALUE_TRANSITION = 'value_transition',
}

// Search result
export interface SearchResult {
  time: number;
  value: string;
  signalId: string;
}

// Window split configuration
export interface WindowSplit {
  enabled: boolean;
  ratio: number; // 0.0 - 1.0
  independentScroll: boolean;
}

// Time compression
export interface TimeCompression {
  enabled: boolean;
  ranges: TimeRange[];
}

// wSignal Module Interface
export interface wSignalModule {
  // Signal management
  addSignal(signal: Signal | WaveformSignal): void;
  removeSignal(signalId: string): void;
  reorderSignals(signalIds: string[]): void;
  getDisplayedSignals(): DisplayedSignal[];
  setSignalVisibility(signalId: string, visible: boolean): void;
  setSignalFormat(signalId: string, format: ValueFormat): void;
  setSignalColor(signalId: string, color: string): void;
  setSignalHeight(signalId: string, height: number): void;

  // Signal groups
  createGroup(name: string, signalIds: string[]): SignalGroup;
  renameGroup(groupId: string, newName: string): void;
  deleteGroup(groupId: string): void;
  toggleGroupExpand(groupId: string): void;
  moveSignalToGroup(signalId: string, groupId: string): void;

  // Bus operations
  createBus(config: BusConfig): DisplayedSignal;
  expandBus(busId: string): void;
  collapseBus(busId: string): void;
  setBusAlias(busId: string, value: string, alias: string): void;

  // Viewport
  getViewport(): Viewport;
  setViewport(viewport: Viewport): void;
  panTime(delta: number): void;
  panSignals(delta: number): void;

  // Zoom
  zoomIn(center?: number): void;
  zoomOut(center?: number): void;
  zoomToRange(range: TimeRange): void;
  zoomToFit(): void;
  zoomToSignal(signalId: string): void;
  getZoomState(): ZoomState;

  // Cursor
  setCursorPosition(time: number): void;
  getCursorPosition(): number;
  showCursor(): void;
  hideCursor(): void;
  toggleCursor(): void;

  // Markers
  addMarker(time: number, label?: string): MarkerState;
  removeMarker(time: number): void;
  getMarkers(): MarkerState[];
  clearMarkers(): void;

  // Search
  search(config: SearchConfig): SearchResult[];
  findNext(config: SearchConfig): SearchResult | null;
  findPrevious(config: SearchConfig): SearchResult | null;

  // Window management
  splitWindow(ratio?: number): void;
  unsplitWindow(): void;
  setWindowRatio(ratio: number): void;

  // Time compression
  compressTimeRange(range: TimeRange): void;
  removeTimeCompression(range: TimeRange): void;
  clearTimeCompression(): void;

  // Save/restore
  saveSignalConfiguration(): string;
  loadSignalConfiguration(config: string): void;
}

// wSignal Module Implementation
class wSignalModuleImpl implements wSignalModule {
  private signals: Map<string, DisplayedSignal> = new Map();
  private groups: Map<string, SignalGroup> = new Map();
  private cursor: CursorState = { position: 0, visible: true };
  private markers: Map<number, MarkerState> = new Map();
  private viewport: Viewport = {
    timeStart: 0,
    timeEnd: 1000,
    signalStart: 0,
    signalEnd: 10,
    pixelsPerTime: 1,
    pixelsPerSignal: 24,
  };
  private zoomState: ZoomState = {
    timeRange: { start: 0, end: 1000 },
    lodLevel: LoDLevel.L0 as LoDLevelType,
    scale: 1,
  };
  private windowSplit: WindowSplit = {
    enabled: false,
    ratio: 0.5,
    independentScroll: true,
  };
  private timeCompression: TimeCompression = {
    enabled: false,
    ranges: [],
  };

  // Signal management
  addSignal(signal: Signal | WaveformSignal): void {
    const id = 'fullPath' in signal ? signal.fullPath : signal.name;
    const displayedSignal: DisplayedSignal = {
      id,
      signal,
      row: this.signals.size,
      visible: true,
      color: '#000000',
      height: 20,
      format: ValueFormat.HEXADECIMAL,
    };
    this.signals.set(id, displayedSignal);
  }

  removeSignal(signalId: string): void {
    this.signals.delete(signalId);
    this.reassignRows();
  }

  reorderSignals(signalIds: string[]): void {
    const newSignals = new Map<string, DisplayedSignal>();
    let row = 0;

    for (const id of signalIds) {
      const signal = this.signals.get(id);
      if (signal) {
        signal.row = row++;
        newSignals.set(id, signal);
      }
    }

    this.signals = newSignals;
  }

  private reassignRows(): void {
    let row = 0;
    for (const signal of this.signals.values()) {
      signal.row = row++;
    }
  }

  getDisplayedSignals(): DisplayedSignal[] {
    return Array.from(this.signals.values()).sort((a, b) => a.row - b.row);
  }

  setSignalVisibility(signalId: string, visible: boolean): void {
    const signal = this.signals.get(signalId);
    if (signal) {
      signal.visible = visible;
    }
  }

  setSignalFormat(signalId: string, format: ValueFormat): void {
    const signal = this.signals.get(signalId);
    if (signal) {
      signal.format = format;
    }
  }

  setSignalColor(signalId: string, color: string): void {
    const signal = this.signals.get(signalId);
    if (signal) {
      signal.color = color;
    }
  }

  setSignalHeight(signalId: string, height: number): void {
    const signal = this.signals.get(signalId);
    if (signal) {
      signal.height = height;
    }
  }

  // Signal groups
  createGroup(name: string, signalIds: string[]): SignalGroup {
    const id = `group_${Date.now()}`;
    const group: SignalGroup = {
      id,
      name,
      signals: signalIds,
      expanded: true,
    };
    this.groups.set(id, group);

    for (const signalId of signalIds) {
      const signal = this.signals.get(signalId);
      if (signal) {
        signal.group = id;
      }
    }

    return group;
  }

  renameGroup(groupId: string, newName: string): void {
    const group = this.groups.get(groupId);
    if (group) {
      group.name = newName;
    }
  }

  deleteGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (group) {
      for (const signalId of group.signals) {
        const signal = this.signals.get(signalId);
        if (signal) {
          signal.group = undefined;
        }
      }
    }
    this.groups.delete(groupId);
  }

  toggleGroupExpand(groupId: string): void {
    const group = this.groups.get(groupId);
    if (group) {
      group.expanded = !group.expanded;
    }
  }

  moveSignalToGroup(signalId: string, groupId: string): void {
    const signal = this.signals.get(signalId);
    const group = this.groups.get(groupId);

    if (signal && group) {
      // Remove from old group
      if (signal.group) {
        const oldGroup = this.groups.get(signal.group);
        if (oldGroup) {
          oldGroup.signals = oldGroup.signals.filter(id => id !== signalId);
        }
      }

      // Add to new group
      signal.group = groupId;
      if (!group.signals.includes(signalId)) {
        group.signals.push(signalId);
      }
    }
  }

  // Bus operations
  createBus(config: BusConfig): DisplayedSignal {
    const id = `bus_${Date.now()}`;
    // Implementation would create a virtual signal representing the bus
    return {
      id,
      signal: {
        handle: -1,
        name: config.name,
        signalType: 'bus',
        width: config.signals.length,
      } as WaveformSignal,
      row: this.signals.size,
      visible: true,
      color: '#000000',
      height: 20,
      format: ValueFormat.HEXADECIMAL,
    };
  }

  expandBus(_busId: string): void {
    // Implementation would show individual bits
  }

  collapseBus(_busId: string): void {
    // Implementation would hide individual bits
  }

  setBusAlias(_busId: string, _value: string, _alias: string): void {
    // Implementation would store alias mapping
  }

  // Viewport
  getViewport(): Viewport {
    return { ...this.viewport };
  }

  setViewport(viewport: Viewport): void {
    this.viewport = { ...viewport };
  }

  panTime(delta: number): void {
    this.viewport.timeStart += delta;
    this.viewport.timeEnd += delta;
  }

  panSignals(delta: number): void {
    this.viewport.signalStart += delta;
    this.viewport.signalEnd += delta;
  }

  // Zoom
  zoomIn(center?: number): void {
    const timeRange = this.viewport.timeEnd - this.viewport.timeStart;
    const zoomFactor = 0.8;
    const newRange = timeRange * zoomFactor;

    if (center === undefined) {
      center = (this.viewport.timeStart + this.viewport.timeEnd) / 2;
    }

    this.viewport.timeStart = center - newRange / 2;
    this.viewport.timeEnd = center + newRange / 2;
    this.updateLoDLevel();
  }

  zoomOut(center?: number): void {
    const timeRange = this.viewport.timeEnd - this.viewport.timeStart;
    const zoomFactor = 1.25;
    const newRange = timeRange * zoomFactor;

    if (center === undefined) {
      center = (this.viewport.timeStart + this.viewport.timeEnd) / 2;
    }

    this.viewport.timeStart = center - newRange / 2;
    this.viewport.timeEnd = center + newRange / 2;
    this.updateLoDLevel();
  }

  zoomToRange(range: TimeRange): void {
    this.viewport.timeStart = range.start;
    this.viewport.timeEnd = range.end;
    this.updateLoDLevel();
  }

  zoomToFit(): void {
    // Implementation would calculate full time range
    this.viewport.timeStart = 0;
    this.viewport.timeEnd = 1000000;
    this.updateLoDLevel();
  }

  zoomToSignal(_signalId: string): void {
    // Implementation would find signal's active time range
  }

  getZoomState(): ZoomState {
    return { ...this.zoomState };
  }

  private updateLoDLevel(): void {
    const timeRange = this.viewport.timeEnd - this.viewport.timeStart;
    // Calculate appropriate LoD level based on time range
    // This is a simplified version
    if (timeRange < 1000) {
      this.zoomState.lodLevel = LoDLevel.L0 as LoDLevelType;
    } else if (timeRange < 10000) {
      this.zoomState.lodLevel = LoDLevel.L2 as LoDLevelType;
    } else if (timeRange < 100000) {
      this.zoomState.lodLevel = LoDLevel.L4 as LoDLevelType;
    } else {
      this.zoomState.lodLevel = LoDLevel.L6 as LoDLevelType;
    }
  }

  // Cursor
  setCursorPosition(time: number): void {
    this.cursor.position = time;
    this.cursor.visible = true;
  }

  getCursorPosition(): number {
    return this.cursor.position;
  }

  showCursor(): void {
    this.cursor.visible = true;
  }

  hideCursor(): void {
    this.cursor.visible = false;
  }

  toggleCursor(): void {
    this.cursor.visible = !this.cursor.visible;
  }

  // Markers
  addMarker(time: number, label?: string): MarkerState {
    const marker: MarkerState = {
      position: time,
      label: label || `M${this.markers.size + 1}`,
      color: '#FF0000',
    };
    this.markers.set(time, marker);
    return marker;
  }

  removeMarker(time: number): void {
    this.markers.delete(time);
  }

  getMarkers(): MarkerState[] {
    return Array.from(this.markers.values()).sort((a, b) => a.position - b.position);
  }

  clearMarkers(): void {
    this.markers.clear();
  }

  // Search
  search(_config: SearchConfig): SearchResult[] {
    // Implementation would search waveform data
    return [];
  }

  findNext(_config: SearchConfig): SearchResult | null {
    // Implementation would find next occurrence
    return null;
  }

  findPrevious(_config: SearchConfig): SearchResult | null {
    // Implementation would find previous occurrence
    return null;
  }

  // Window management
  splitWindow(ratio: number = 0.5): void {
    this.windowSplit.enabled = true;
    this.windowSplit.ratio = ratio;
  }

  unsplitWindow(): void {
    this.windowSplit.enabled = false;
  }

  setWindowRatio(ratio: number): void {
    this.windowSplit.ratio = Math.max(0.1, Math.min(0.9, ratio));
  }

  // Time compression
  compressTimeRange(range: TimeRange): void {
    this.timeCompression.enabled = true;
    this.timeCompression.ranges.push(range);
  }

  removeTimeCompression(range: TimeRange): void {
    this.timeCompression.ranges = this.timeCompression.ranges.filter(
      r => r.start !== range.start || r.end !== range.end
    );
  }

  clearTimeCompression(): void {
    this.timeCompression.enabled = false;
    this.timeCompression.ranges = [];
  }

  // Save/restore
  saveSignalConfiguration(): string {
    const config = {
      signals: Array.from(this.signals.entries()),
      groups: Array.from(this.groups.entries()),
      viewport: this.viewport,
      cursor: this.cursor,
      markers: Array.from(this.markers.entries()),
    };
    return JSON.stringify(config);
  }

  loadSignalConfiguration(config: string): void {
    try {
      const parsed = JSON.parse(config);
      this.signals = new Map(parsed.signals);
      this.groups = new Map(parsed.groups);
      this.viewport = parsed.viewport;
      this.cursor = parsed.cursor;
      this.markers = new Map(parsed.markers);
    } catch (error) {
      console.error('Failed to load signal configuration:', error);
    }
  }
}

// Singleton instance
export const wSignal = new wSignalModuleImpl();
export { wSignalModuleImpl };

// Wave Manager for server communication
export { waveManager } from './waveManager';
