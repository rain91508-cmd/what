/**
 * Worker Waveform Provider
 *
 * Worker 模式下的波形提供者实现。
 * 通过 postMessage 与 Worker 线程通信。
 *
 * 架构：共享 Provider + 参数化 Render
 * - 一个 Worker 实例服务所有 Tab
 * - Provider 无状态，所有参数通过方法传递
 * - Worker 管理多个 Canvas（每个 Tab 一个）
 */

import {
  WaveformProviderInterface,
  ProviderConfig,
  ViewportConfig,
  CanvasConfig,
  WasmSignalInfo,
  RenderSegment,
  ValueInfo,
  WaveformProviderError,
  TimeConfig,
  DisplayFormat,
  GetSignalValuesAtTransitionsParams,
  RawSignalValuesResult,
} from '../core/waveformProviderInterface';

interface PendingMessage {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: number;
}

// 全局消息 ID 计数器，确保所有 Provider 实例的消息 ID 都是唯一的
let globalMessageId = 0;
// 全局 Provider 实例 ID 计数器
let globalProviderId = 0;

/**
 * Worker 模式下的波形提供者实现
 *
 * 通过 postMessage 与 Worker 线程通信，
 * 所有耗时操作在 Worker 中执行，不阻塞主线程。
 *
 * 架构特点：
 * - 一个 Worker 实例可以被多个 Tab 共享
 * - 所有方法都通过参数传递，不保存 Tab 相关状态
 * - Worker 管理多个 Canvas，通过 ID 访问
 */
export class WorkerWaveformProvider implements WaveformProviderInterface {
  private worker: Worker | null = null;
  private pendingMessages = new Map<number, PendingMessage>();
  private _isOpfsEnabled = false;
  private _isMemoryCacheEnabled = true;
  private _isPrefetchEnabled = true;
  private _isDisposed = false;
  private instanceId: number;
  private minMessageId: number = 0;

  // 默认超时时间 30 秒
  private readonly DEFAULT_TIMEOUT = 30000;

  /**
   * 构造函数 - 初始化实例 ID 和最小消息 ID
   */
  constructor() {
    this.instanceId = ++globalProviderId;
    this.minMessageId = globalMessageId + 1;
  }

  /**
   * 初始化提供者
   */
  async initialize(config: ProviderConfig): Promise<void> {
    try {
      // 创建 Worker
      this.worker = new Worker(
        new URL('../workers/waveformWorker.ts', import.meta.url),
        { type: 'module' }
      );

      // 设置消息处理
      this.worker.onmessage = this.handleMessage.bind(this);
      this.worker.onerror = this.handleError.bind(this);

      // 初始化 Worker
      await this.sendMessage('INITIALIZE', { config }, 10000);

      this._isOpfsEnabled = config.enableOpfs ?? false;
      this._isMemoryCacheEnabled = config.enableMemoryCache ?? true;
      this._isPrefetchEnabled = config.enablePrefetch ?? false;

      // Debug: console.log(`[WorkerWaveformProvider][Inst${this.instanceId}] Initialized: OPFS=${this._isOpfsEnabled}, MemoryCache=${this._isMemoryCacheEnabled}`);
    } catch (error) {
      // Debug: console.error(`[WorkerWaveformProvider][Inst${this.instanceId}] Initialization failed:`, error);
      throw new WaveformProviderError('Failed to initialize Worker provider', error);
    }
  }

  /**
   * 销毁提供者，释放资源
   */
  async dispose(): Promise<void> {
    this._isDisposed = true;

    try {
      if (this.worker) {
        this.worker.onmessage = null;
        this.worker.onerror = null;
      }

      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }

      this.pendingMessages.forEach((pending) => {
        clearTimeout(pending.timeout);
        pending.reject(new WaveformProviderError('Provider disposed'));
      });
      this.pendingMessages.clear();
    } catch (error) {
      console.error(`[WorkerWaveformProvider][Inst${this.instanceId}] Dispose failed:`, error);
      throw new WaveformProviderError('Failed to dispose Worker provider', error);
    }
  }

  // ==================== Canvas 管理 ====================

  /**
   * 注册 Canvas（Tab 创建时调用）
   */
  async registerCanvas(canvasId: string, canvas: OffscreenCanvas, devicePixelRatio: number = 1): Promise<void> {
    if (!this.worker) {
      throw new WaveformProviderError('Worker not initialized');
    }

    await this.sendMessage(
      'REGISTER_CANVAS',
      { canvasId, canvas, devicePixelRatio },
      this.DEFAULT_TIMEOUT,
      [canvas]
    );

    // Debug: console.log(`[WorkerWaveformProvider][Inst${this.instanceId}] Canvas registered: ${canvasId}, dpr=${devicePixelRatio}`);
  }

  /**
   * 注销 Canvas（Tab 关闭时调用）
   */
  async unregisterCanvas(canvasId: string): Promise<void> {
    if (!this.worker) {
      throw new WaveformProviderError('Worker not initialized');
    }

    await this.sendMessage('UNREGISTER_CANVAS', { canvasId });

    // Debug: console.log(`[WorkerWaveformProvider][Inst${this.instanceId}] Canvas unregistered: ${canvasId}`);
  }

  // ==================== 数据获取（参数化）====================

  /**
   * 获取指定时间点的信号值（参数化）
   */
  async getSignalValueAtTime(
    signalName: string,
    time: number,
    signals: WasmSignalInfo[],
    displayFormat?: DisplayFormat,
    signalPrefix?: string,
    serverPrefix?: string,
    spaceBeforeBracket?: boolean,
    viewRange?: { start: number; end: number }
  ): Promise<ValueInfo | null> {
    try {
      return await this.sendMessage('GET_SIGNAL_VALUE_AT_TIME', {
        signalName,
        time,
        signals,
        displayFormat,
        signalPrefix,
        serverPrefix,
        spaceBeforeBracket,
        viewRange,
      });
    } catch (error) {
      console.warn('[WorkerWaveformProvider] getSignalValueAtTime failed:', error);
      return null;
    }
  }

  /**
   * Get signal_data stats for debugging
   */
  async getSignalDataStats(signalName: string): Promise<{ transitions: number; buckets: number; tiles: number } | null> {
    try {
      return await this.sendMessage('GET_SIGNAL_DATA_STATS', {
        signalName,
      });
    } catch (error) {
      console.warn('[WorkerWaveformProvider] getSignalDataStats failed:', error);
      return null;
    }
  }

  /**
   * 查找指定时间点前后的跳变（参数化）
   */
  async findTransitionsAround(
    signalName: string,
    time: number,
    signals: WasmSignalInfo[],
    signalPrefix?: string,
    serverPrefix?: string,
    spaceBeforeBracket?: boolean
  ): Promise<{ prev: number | null; next: number | null }> {
    try {
      return await this.sendMessage('FIND_TRANSITIONS_AROUND', {
        signalName,
        time,
        signals,
        signalPrefix,
        serverPrefix,
        spaceBeforeBracket,
      });
    } catch (error) {
      console.warn('[WorkerWaveformProvider] findTransitionsAround failed:', error);
      return { prev: null, next: null };
    }
  }

  /**
   * 获取所有信号在跳变时间点的值
   */
  async getSignalValuesAtTransitions(
    params: GetSignalValuesAtTransitionsParams
  ): Promise<RawSignalValuesResult> {
    try {
      const result = await this.sendMessage('GET_SIGNAL_VALUES_AT_TRANSITIONS', params);

      if (!result || typeof result !== 'object') {
        throw new Error('Invalid result data from Worker');
      }

      return result as RawSignalValuesResult;
    } catch (error) {
      console.error('[WorkerWaveformProvider] getSignalValuesAtTransitions failed:', error);
      throw new WaveformProviderError('Failed to get signal values at transitions', error);
    }
  }

  // ==================== 渲染（参数化）====================

  /**
   * 获取渲染段（参数化）
   */
  async fetchAndGetSegments(
    signalNames: string[],
    viewport: ViewportConfig,
    signals: WasmSignalInfo[],
    displayFormat?: DisplayFormat,
    signalPrefix?: string,
    serverPrefix?: string,
    spaceBeforeBracket?: boolean
  ): Promise<RenderSegment[]> {
    try {
      const segments = await this.sendMessage('FETCH_AND_GET_SEGMENTS', {
        signalNames,
        viewport,
        signals,
        displayFormat,
        signalPrefix,
        serverPrefix,
        spaceBeforeBracket,
      });

      if (!segments || !Array.isArray(segments)) {
        throw new Error('Invalid segments data from Worker');
      }

      return segments as RenderSegment[];
    } catch (error) {
      console.error('[WorkerWaveformProvider] fetchAndGetSegments failed:', error);
      throw new WaveformProviderError('Failed to fetch segments', error);
    }
  }

  /**
   * 渲染波形到 OffscreenCanvas（参数化）
   */
  async renderWaveform(params: {
    canvasId: string;
    signals: WasmSignalInfo[];
    viewport: ViewportConfig;
    canvasConfig: CanvasConfig;
    displayFormat?: DisplayFormat;
    timeConfig: TimeConfig;
    devicePixelRatio?: number;
    // Prefix settings for signal name conversion
    signalPrefix?: string;
    serverPrefix?: string;
    spaceBeforeBracket?: boolean;
  }): Promise<any> {
    if (!this.worker) {
      throw new WaveformProviderError('Worker not initialized');
    }

    const { canvasId, signals, viewport, canvasConfig, timeConfig, devicePixelRatio, signalPrefix, serverPrefix, spaceBeforeBracket } = params;
    // 注意：不再传递全局 displayFormat，因为每个信号的 display_format 已经在 signals 中设置

    // Debug: console.log(`[WorkerWaveformProvider][Inst${this.instanceId}] Rendering: canvasId=${canvasId}, viewport=${viewport.startTime}-${viewport.endTime}, signals=${signals.length}, dpr=${devicePixelRatio}`);
    // Debug: console.log(`[WorkerWaveformProvider][Inst${this.instanceId}] Prefix settings: signalPrefix="${signalPrefix}", serverPrefix="${serverPrefix}", spaceBeforeBracket=${spaceBeforeBracket}`);

    // 转换 timeConfig 格式以匹配 waveformDrawing.ts 中的 TimeConfig 接口
    const adaptedTimeConfig = {
      DisplayUnitPerLoD0Unit: timeConfig.displayUnitPerLoD0Unit
    };

    return this.sendMessage(
      'RENDER_WAVEFORM',
      {
        canvasId,
        signals,
        viewport,
        canvasConfig,
        // 注意：不再传递全局 displayFormat，因为每个信号的 display_format 已经在 signals 中设置
        timeConfig: adaptedTimeConfig,
        devicePixelRatio,
        signalPrefix,
        serverPrefix,
        spaceBeforeBracket,
      },
      60000 // 渲染超时 60 秒
    );
  }

  // ==================== 缓存管理 ====================

  /**
   * 清除所有缓存
   */
  async clearCache(): Promise<void> {
    try {
      await this.sendMessage('CLEAR_CACHE', {});
    } catch (error) {
      console.error('[WorkerWaveformProvider] clearCache failed:', error);
      throw new WaveformProviderError('Failed to clear cache', error);
    }
  }

  /**
   * 设置 OPFS 缓存启用状态
   */
  setOpfsEnabled(enabled: boolean): void {
    this._isOpfsEnabled = enabled;

    this.worker?.postMessage({
      type: 'SET_OPFS_ENABLED',
      payload: { enabled },
      id: ++globalMessageId,
    });
  }

  /**
   * 设置内存缓存启用状态
   */
  setMemoryCacheEnabled(enabled: boolean): void {
    this._isMemoryCacheEnabled = enabled;

    this.worker?.postMessage({
      type: 'SET_MEMORY_CACHE_ENABLED',
      payload: { enabled },
      id: ++globalMessageId,
    });
  }

  /**
   * 设置波形数据预取启用状态（渲染后后台预取相邻 tile）
   */
  setPrefetchEnabled(enabled: boolean): void {
    this._isPrefetchEnabled = enabled;
    console.log(`[WorkerProvider] setPrefetchEnabled posting enabled=${enabled}`);

    this.worker?.postMessage({
      type: 'SET_PREFETCH_ENABLED',
      payload: { enabled },
      id: ++globalMessageId,
    });
  }

  /**
   * 设置信号前缀（local prefix）
   */
  setSignalPrefix(prefix: string): void {
    this.worker?.postMessage({
      type: 'SET_SIGNAL_PREFIX',
      payload: { prefix },
      id: ++globalMessageId,
    });
  }

  /**
   * 设置服务器前缀
   */
  setServerPrefix(prefix: string): void {
    this.worker?.postMessage({
      type: 'SET_SERVER_PREFIX',
      payload: { prefix },
      id: ++globalMessageId,
    });
  }

  /**
   * 设置是否在 [ 前加空格
   */
  setSpaceBeforeBracket(enabled: boolean): void {
    this.worker?.postMessage({
      type: 'SET_SPACE_BEFORE_BRACKET',
      payload: { enabled },
      id: ++globalMessageId,
    });
  }

  // ==================== 属性 ====================

  get isOpfsEnabled(): boolean {
    return this._isOpfsEnabled;
  }

  get isMemoryCacheEnabled(): boolean {
    return this._isMemoryCacheEnabled;
  }

  // ==================== 私有方法 ====================

  /**
   * 处理 Worker 消息
   */
  private handleMessage(event: MessageEvent): void {
    if (this._isDisposed) {
      return;
    }

    const { type, id, data, error, success } = event.data;

    if (id < this.minMessageId) {
      return;
    }

    const pending = this.pendingMessages.get(id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingMessages.delete(id);

    if (type === 'ERROR' || !success) {
      pending.reject(new WaveformProviderError(error || 'Unknown error'));
    } else {
      pending.resolve(data);
    }
  }

  /**
   * 处理 Worker 错误
   */
  private handleError(error: ErrorEvent): void {
    console.error(`[WorkerWaveformProvider][Inst${this.instanceId}] Worker error:`, error);

    this.pendingMessages.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(new WaveformProviderError(`Worker error: ${error.message}`));
    });
    this.pendingMessages.clear();
  }

  /**
   * 发送消息到 Worker
   */
  private sendMessage<T>(
    type: string,
    payload: any,
    timeout: number = this.DEFAULT_TIMEOUT,
    transfer?: Transferable[]
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++globalMessageId;

      const timeoutId = window.setTimeout(() => {
        this.pendingMessages.delete(id);
        reject(new WaveformProviderError(`Operation timeout after ${timeout}ms`));
      }, timeout);

      this.pendingMessages.set(id, {
        resolve,
        reject,
        timeout: timeoutId,
      });

      if (transfer) {
        this.worker?.postMessage({ type, payload, id }, transfer);
      } else {
        this.worker?.postMessage({ type, payload, id });
      }
    });
  }
}
