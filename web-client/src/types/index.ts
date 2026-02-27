// ============================================
// Hardware Design Analyzer - Core Types
// ============================================

// Re-export KDB types from kdb.ts
export * from './kdb';

// Waveform Types
export interface WaveformInfo {
  name: string;
  file: string;
  timeRange: TimeRange;
  timeUnit: TimeUnit;
  signalCount: number;
}

export interface TimeRange {
  start: number;
  end: number;
}

export enum TimeUnit {
  FS = 0,
  PS = 1,
  NS = 2,
  US = 3,
  MS = 4,
  S = 5,
}

export interface WaveformSignal {
  handle: number;
  name: string;
  signalType: string;
  width: number;
}

export interface WaveformChunk {
  chunkId: number;
  level: number;
  timeStart: number;
  timeEnd: number;
  data: ArrayBuffer;
}

export interface Transition {
  time: number;
  value: string;
}

export interface SignalBlock {
  handle: number;
  transitions: Transition[];
}

// LoD (Level of Detail) Types
export const LoDLevel = {
  L0: 0,   // 10ps - 100%
  L1: 1,   // 100ps - ~50%
  L2: 2,   // 1ns - ~25%
  L3: 3,   // 10ns - ~10%
  L4: 4,   // 100ns - ~5%
  L5: 5,   // 1us - ~1%
  L6: 6,   // 10us - ~0.5%
  L7: 7,   // 100us - ~0.1%
  L8: 8,   // 1ms - ~0.05%
  L9: 9,   // 10ms - ~0.01%
  L10: 10, // 100ms - ~0.005%
  L11: 11, // 1s - ~0.001%
} as const;

export type LoDLevelType = typeof LoDLevel[keyof typeof LoDLevel];

export interface LoDConfig {
  baseWindowNs: number;
  levels: number;
  chunkSizeBytes: number;
}

// Viewport Types
export interface Viewport {
  timeStart: number;
  timeEnd: number;
  signalStart: number;
  signalEnd: number;
  pixelsPerTime: number;
  pixelsPerSignal: number;
}

export interface ZoomState {
  timeRange: TimeRange;
  lodLevel: LoDLevelType;
  scale: number;
}

// Cache Types
export interface CacheKey {
  signalId: string;
  lodLevel: LoDLevelType;
  chunkId: number;
}

export interface CacheEntry<T> {
  key: string;
  data: T;
  timestamp: number;
  size: number;
}

// Render Types
export interface RenderChunk {
  lodLevel: number;
  timeStart: number;
  timeEnd: number;
  segmentBuffer: Float32Array;
  segmentCount: number;
  textMeta?: TextMeta[];
}

export interface TextMeta {
  x: number;
  y: number;
  text: string;
  color: number;
}

export interface Segment {
  t0: number;
  t1: number;
  row: number;
  value: number;
}

// UI Types
export interface CursorState {
  position: number;
  visible: boolean;
}

export interface MarkerState {
  position: number;
  label: string;
  color: string;
}

export interface SignalGroup {
  id: string;
  name: string;
  signals: string[];
  expanded: boolean;
  children?: SignalGroup[];
}

export interface BusConfig {
  name: string;
  signals: string[];
  msbFirst: boolean;
}

// Worker Message Types
export interface WorkerRequest {
  id: string;
  type: WorkerMessageType;
  payload: unknown;
}

export interface WorkerResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export enum WorkerMessageType {
  PARSE_FST = 'parse_fst',
  DECODE_CHUNK = 'decode_chunk',
  GENERATE_LOD = 'generate_lod',
  SEARCH_SIGNAL = 'search_signal',
  QUERY_KDB = 'query_kdb',
}

// API Types
export interface ApiResponse<T> {
  status: 'success' | 'error';
  data: T | null;
  error: ApiError | null;
}

export interface ApiError {
  code: string;
  message: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  useHttps: boolean;
}

// ============================================
// Legacy Types (for backward compatibility)
// ============================================

/**
 * @deprecated Use Signal from './kdb' instead
 */
export interface LegacySignal {
  handle: number;
  name: string;
  fullPath: string;
  bitWidth: number;
  msb: number;
  lsb: number;
  type: LegacySignalType;
  direction: LegacySignalDirection;
  filePath: string;
  lineNumber: number;
  column: number;
}

export enum LegacySignalType {
  WIRE = 0,
  REG = 1,
  LOGIC = 2,
  BIT = 3,
  INTEGER = 4,
  REAL = 5,
  ENUM = 6,
  STRUCT = 7,
  INTERFACE = 8,
}

export enum LegacySignalDirection {
  INPUT = 0,
  OUTPUT = 1,
  INOUT = 2,
  INTERNAL = 3,
}

/**
 * @deprecated Use Module from './kdb' instead
 */
export interface LegacyModule {
  id?: number;
  name: string;
  fullName?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  ports: LegacyPort[];
  parameters: LegacyParameter[];
  parentModuleId?: number;
  fileId?: number;
  declaration?: { fileId: number; line: number };
  signals?: LegacySignal[];
  isInstance?: boolean;
}

export interface LegacyPort {
  name: string;
  direction: LegacySignalDirection;
  type: LegacySignalType;
  bitWidth: number;
}

export interface LegacyParameter {
  name: string;
  value: string;
}

/**
 * @deprecated Use hierarchical module tree from kdbManager instead
 */
export interface LegacyInstance {
  name: string;
  fullPath: string;
  moduleName: string;
  parentPath: string;
  children: string[];
}

export interface LegacyConnection {
  driverSignal: string;
  loadSignal: string;
  driverInstance: string;
  loadInstance: string;
  driverLine: number;
  loadLine: number;
}

/**
 * @deprecated Use new on-demand loading architecture instead
 */
export interface LegacyKnowledgeBase {
  version: number;
  designName: string;
  modules: Map<string, LegacyModule>;
  signals: Map<string, LegacySignal>;
  instances: Map<string, LegacyInstance>;
  connections: LegacyConnection[];
  sourceFiles: Map<string, string>;
}
