/**
 * Waveform Provider Interface
 * 
 * 定义波形数据提供者的标准接口，与具体实现解耦。
 * 支持直接 WASM 模式和 Worker 模式。
 */

// ==================== 类型定义 ====================

/**
 * 渲染段信息
 */
export interface RenderSegment {
  x0: number;
  x1: number;
  y: number;
  value: ValueInfo;
  signalName: string;
}

/**
 * 值信息
 */
export interface ValueInfo {
  valueType: string;
  displayStr: string;
  width: number;
  hasXZ: boolean;
  minValue?: string;
  maxValue?: string;
  isMinMax: boolean;
}

/**
 * WASM 信号信息
 */
export interface WasmSignalInfo {
  globalId: number;
  name: string;
  row: number;
  width: number;
  drawSigId: number;
  bitExtract?: {
    parentName: string;
    msb: number;
    lsb: number;
  };
}

/**
 * 视口配置
 */
export interface ViewportConfig {
  startTime: number;
  endTime: number;
  width: number;
  height: number;
}

/**
 * 画布配置
 */
export interface CanvasConfig {
  width: number;
  height: number;
  rowHeight: number;
}

/**
 * 提供者配置
 */
export interface ProviderConfig {
  serverUrl: string;
  waveformName: string;
  signalPrefix: string;
  spaceBeforeBracket: boolean;
  timeStamp: number;
  enableOpfs?: boolean;
  enableMemoryCache?: boolean;
}

/**
 * 工厂配置
 */
export interface FactoryConfig extends ProviderConfig {
  /**
   * 是否使用 Worker 模式
   * @default false
   */
  useWorker?: boolean;
}

// ==================== 接口定义 ====================

/**
 * 波形数据提供者接口
 * 
 * 定义所有对外暴露的方法，与具体实现解耦。
 * 实现类：WasmWaveformProvider（直接模式）、WorkerWaveformProvider（Worker 模式）
 */
export interface WaveformProviderInterface {
  // ==================== 生命周期 ====================
  
  /**
   * 初始化提供者
   */
  initialize(config: ProviderConfig): Promise<void>;
  
  /**
   * 销毁提供者，释放资源
   */
  dispose(): Promise<void>;
  
  // ==================== 配置设置 ====================
  
  /**
   * 设置视口范围
   */
  setViewport(timeStart: number, timeEnd: number): void;
  
  /**
   * 设置画布尺寸
   */
  setCanvasDimensions(config: CanvasConfig): void;
  
  /**
   * 设置信号列表
   */
  setSignalList(signals: WasmSignalInfo[]): void;
  
  /**
   * 设置显示格式
   */
  setDisplayFormat(format: 'hex' | 'bin' | 'oct' | 'dec'): void;
  
  // ==================== 数据获取 ====================
  
  /**
   * 获取指定时间点的信号值
   */
  getSignalValueAtTime(signalName: string, time: number): Promise<ValueInfo | null>;
  
  /**
   * 查找指定时间点前后的跳变
   */
  findTransitionsAround(
    signalName: string, 
    time: number
  ): Promise<{ prev: number | null; next: number | null }>;
  
  // ==================== 渲染 ====================
  
  /**
   * 获取渲染段（用于主线程渲染模式）
   */
  fetchAndGetSegments(signalNames: string[]): Promise<RenderSegment[]>;
  
  /**
   * 渲染波形到 OffscreenCanvas（用于 Worker 渲染模式）
   * @returns ImageBitmap 或 transfer 对象
   */
  renderWaveform(
    signalNames: string[],
    viewport: ViewportConfig,
    canvas: HTMLCanvasElement
  ): Promise<ImageBitmap>;
  
  // ==================== 缓存管理 ====================
  
  /**
   * 清除所有缓存
   */
  clearCache(): Promise<void>;
  
  /**
   * 设置 OPFS 缓存启用状态
   */
  setOpfsEnabled(enabled: boolean): void;
  
  /**
   * 设置内存缓存启用状态
   */
  setMemoryCacheEnabled(enabled: boolean): void;
  
  // ==================== 属性 ====================
  
  readonly viewportTimeStart: number;
  readonly viewportTimeEnd: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly isOpfsEnabled: boolean;
  readonly isMemoryCacheEnabled: boolean;

  // ==================== 额外方法（用于 Hook）====================

  /**
   * 获取信号列表
   */
  getSignals(): Promise<SignalInfo[]>;

  /**
   * 获取信号段数据
   */
  getSignalSegments(
    signalName: string,
    startTime: number,
    endTime: number
  ): Promise<SignalSegment[]>;
}

// ==================== 错误类 ====================

/**
 * 波形提供者错误
 */
export class WaveformProviderError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'WaveformProviderError';
  }
}

// ==================== 工具类型 ====================

/**
 * 渲染任务
 */
export interface RenderTask {
  id: number;
  signalNames: string[];
  viewport: ViewportConfig;
  timestamp: number;
}

/**
 * 缓存键
 */
export interface CacheKey {
  viewportHash: string;
  signalListHash: string;
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * 缓存的渲染结果
 */
export interface CachedRender {
  key: CacheKey;
  bitmap: ImageBitmap;
  timestamp: number;
}

// ==================== 额外类型（用于 Hook 和缓存）====================

/**
 * 信号信息
 */
export interface SignalInfo {
  name: string;
  width: number;
  type: string;
}

/**
 * 信号段数据
 */
export interface SignalSegment {
  x0: number;
  x1: number;
  y: number;
  value: ValueInfo;
}

/**
 * 渲染结果
 */
export interface RenderResult {
  imageBitmap?: ImageBitmap;
  segments?: Record<string, SignalSegment[]>;
}

/**
 * 波形错误
 */
export interface WaveformError {
  code: string;
  message: string;
  recoverable: boolean;
}
