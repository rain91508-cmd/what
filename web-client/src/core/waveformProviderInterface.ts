/**
 * Waveform Provider Interface
 *
 * 定义波形数据提供者的标准接口，与具体实现解耦。
 * 支持直接 WASM 模式和 Worker 模式。
 *
 * 架构：共享 Provider + 参数化 Render
 * - 一个 WASM 实例服务所有 Tab
 * - Provider 无状态，所有参数通过方法传递
 * - Worker 管理多个 Canvas（每个 Tab 一个）
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
 * 时间配置
 */
export interface TimeConfig {
  displayUnit: string;
  lod0Unit: number;
  displayUnitPerLoD0Unit: number;
}

/**
 * 显示格式
 */
export type DisplayFormat = 'hex' | 'bin' | 'oct' | 'dec';

/**
 * 提供者配置
 */
export interface ProviderConfig {
  serverUrl: string;
  waveformName: string;
  signalPrefix: string;      // Local prefix (removed from local signal name)
  serverPrefix: string;      // Server prefix (added to server signal name)
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
 * 波形数据提供者接口（无状态版本）
 *
 * 架构：共享 Provider + 参数化 Render
 * - 所有方法都通过参数传递所需数据，不保存状态
 * - Worker 管理多个 Canvas，通过 ID 访问
 * - 支持多 Tab 共享同一个 Provider 实例
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

  // ==================== Canvas 管理 ====================

  /**
   * 注册 Canvas（Tab 创建时调用）
   * @param canvasId Canvas 唯一标识
   * @param canvas OffscreenCanvas 实例
   * @param devicePixelRatio 设备像素比
   */
  registerCanvas(canvasId: string, canvas: OffscreenCanvas, devicePixelRatio?: number): Promise<void>;

  /**
   * 注销 Canvas（Tab 关闭时调用）
   * @param canvasId Canvas 唯一标识
   */
  unregisterCanvas(canvasId: string): Promise<void>;

  // ==================== 数据获取（无状态）====================

  /**
   * 获取指定时间点的信号值
   * @param signalName 信号名称
   * @param time 时间点
   * @param signals 信号列表（参数传递，不依赖内部状态）
   */
  getSignalValueAtTime(
    signalName: string,
    time: number,
    signals: WasmSignalInfo[]
  ): Promise<ValueInfo | null>;

  /**
   * 查找指定时间点前后的跳变
   * @param signalName 信号名称
   * @param time 时间点
   * @param signals 信号列表（参数传递，不依赖内部状态）
   */
  findTransitionsAround(
    signalName: string,
    time: number,
    signals: WasmSignalInfo[]
  ): Promise<{ prev: number | null; next: number | null }>;

  // ==================== 渲染（参数化）====================

  /**
   * 获取渲染段（用于主线程渲染模式）
   * @param signalNames 信号名称列表
   * @param viewport 视口配置
   * @param signals 信号列表
   */
  fetchAndGetSegments(
    signalNames: string[],
    viewport: ViewportConfig,
    signals: WasmSignalInfo[]
  ): Promise<RenderSegment[]>;

  /**
   * 渲染波形到 OffscreenCanvas（参数化）
   * @param params 渲染参数
   */
  renderWaveform(params: {
    canvasId: string;              // Canvas ID（Worker 中通过 ID 获取 Canvas）
    signals: WasmSignalInfo[];     // 信号列表
    viewport: ViewportConfig;      // 视口配置
    canvasConfig: CanvasConfig;    // Canvas 配置
    displayFormat: DisplayFormat;  // 显示格式
    timeConfig: TimeConfig;        // 时间配置
    devicePixelRatio?: number;     // 设备像素比
    // Prefix settings for signal name conversion
    signalPrefix?: string;         // Local prefix (removed from local signal name)
    serverPrefix?: string;         // Server prefix (added to server signal name)
    spaceBeforeBracket?: boolean;  // Whether to add space before bracket
  }): Promise<void>;

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

  /**
   * 设置信号前缀（local prefix）
   */
  setSignalPrefix(prefix: string): void;

  /**
   * 设置服务器前缀
   */
  setServerPrefix(prefix: string): void;

  /**
   * 设置是否在 [ 前加空格
   */
  setSpaceBeforeBracket(enabled: boolean): void;

  // ==================== 属性 ====================

  readonly isOpfsEnabled: boolean;
  readonly isMemoryCacheEnabled: boolean;
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
  canvasId: string;
  signals: WasmSignalInfo[];
  viewport: ViewportConfig;
  canvasConfig: CanvasConfig;
  displayFormat: DisplayFormat;
  timeConfig: TimeConfig;
  timestamp: number;
}

/**
 * 缓存键
 */
export interface CacheKey {
  canvasId: string;
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
