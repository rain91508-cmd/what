/**
 * Worker Waveform Provider
 *
 * Worker 模式下的波形提供者实现。
 * 通过 postMessage 与 Worker 线程通信。
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
  SignalInfo,
  SignalSegment,
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
 */
export class WorkerWaveformProvider implements WaveformProviderInterface {
  private worker: Worker | null = null;
  private pendingMessages = new Map<number, PendingMessage>();
  private viewport: ViewportConfig = { startTime: 0, endTime: 1000, width: 800, height: 600 };
  private canvas: CanvasConfig = { width: 800, height: 600, rowHeight: 24 };
  private currentSignals: WasmSignalInfo[] = [];  // 当前信号列表
  private currentDisplayFormat: 'hex' | 'bin' | 'oct' | 'dec' = 'hex';  // 当前显示格式
  private _isOpfsEnabled = false;
  private _isMemoryCacheEnabled = true;
  private _isDisposed = false;  // 标记是否已销毁
  private instanceId: number;  // 唯一实例 ID，用于调试
  private minMessageId: number = 0;  // 该实例的最小消息 ID，用于过滤旧消息

  // 默认超时时间 30 秒
  private readonly DEFAULT_TIMEOUT = 30000;

  /**
   * 构造函数 - 初始化实例 ID 和最小消息 ID
   */
  constructor() {
    this.instanceId = ++globalProviderId;
    // 记录实例创建时的全局消息 ID，用于过滤旧消息
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

      console.log(`[WorkerWaveformProvider][Inst${this.instanceId}] Initialized: OPFS=${this._isOpfsEnabled}, MemoryCache=${this._isMemoryCacheEnabled}`);
    } catch (error) {
      console.error(`[WorkerWaveformProvider][Inst${this.instanceId}] Initialization failed:`, error);
      throw new WaveformProviderError('Failed to initialize Worker provider', error);
    }
  }

  /**
   * 销毁提供者，释放资源
   */
  async dispose(): Promise<void> {
    // 设置销毁标志，阻止后续消息处理
    this._isDisposed = true;

    try {
      // 先立即清除 onmessage 处理器，防止旧消息被处理
      if (this.worker) {
        this.worker.onmessage = null;
        this.worker.onerror = null;
      }

      // 然后立即终止 Worker，阻止它继续发送消息
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }

      // 然后清理所有 pending 操作
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

  // ==================== 配置设置 ====================

  /**
   * 设置视口范围
   */
  setViewport(timeStart: number, timeEnd: number): void {
    this.viewport = { ...this.viewport, startTime: timeStart, endTime: timeEnd };

    this.worker?.postMessage({
      type: 'SET_VIEWPORT',
      payload: { timeStart, timeEnd },
      id: ++globalMessageId,
    });
  }

  /**
   * 设置画布尺寸
   */
  setCanvasDimensions(config: CanvasConfig): void {
    this.canvas = { ...config };

    this.worker?.postMessage({
      type: 'SET_CANVAS_DIMENSIONS',
      payload: { config: { ...config } },
      id: ++globalMessageId,
    });
  }

  /**
   * 设置信号列表
   */
  setSignalList(signals: WasmSignalInfo[]): void {
    // 保存当前信号列表
    this.currentSignals = [...signals];

    const wasmSignals = signals.map((sig) => ({
      globalId: sig.globalId,
      name: sig.name,
      row: sig.row,
      width: sig.width,
      drawSigId: sig.drawSigId,
      bitExtract: sig.bitExtract,
    }));

    this.worker?.postMessage({
      type: 'SET_SIGNAL_LIST',
      payload: { signals: wasmSignals },
      id: ++globalMessageId,
    });
  }

  /**
   * 设置显示格式
   */
  setDisplayFormat(format: 'hex' | 'bin' | 'oct' | 'dec'): void {
    // 保存当前显示格式
    this.currentDisplayFormat = format;

    this.worker?.postMessage({
      type: 'SET_DISPLAY_FORMAT',
      payload: { format },
      id: ++globalMessageId,
    });
  }

  // ==================== 数据获取 ====================

  /**
   * 获取指定时间点的信号值
   */
  async getSignalValueAtTime(signalName: string, time: number): Promise<ValueInfo | null> {
    try {
      return await this.sendMessage('GET_SIGNAL_VALUE_AT_TIME', { signalName, time });
    } catch (error) {
      console.warn('[WorkerWaveformProvider] getSignalValueAtTime failed:', error);
      return null;
    }
  }

  /**
   * 查找指定时间点前后的跳变
   */
  async findTransitionsAround(
    signalName: string,
    time: number
  ): Promise<{ prev: number | null; next: number | null }> {
    try {
      return await this.sendMessage('FIND_TRANSITIONS_AROUND', { signalName, time });
    } catch (error) {
      console.warn('[WorkerWaveformProvider] findTransitionsAround failed:', error);
      return { prev: null, next: null };
    }
  }

  // ==================== 渲染 ====================

  /**
   * 获取渲染段（用于主线程渲染模式）
   */
  async fetchAndGetSegments(signalNames: string[]): Promise<RenderSegment[]> {
    try {
      // 将完整配置打包到请求中，确保数据一致性
      const fetchConfig = {
        viewport: {
          startTime: this.viewport.startTime,
          endTime: this.viewport.endTime,
        },
        canvas: {
          width: this.canvas.width,
          height: this.canvas.height,
          rowHeight: this.canvas.rowHeight,
        },
        signals: this.currentSignals.map((sig) => ({
          globalId: sig.globalId,
          name: sig.name,
          row: sig.row,
          width: sig.width,
          drawSigId: sig.drawSigId,
          bitExtract: sig.bitExtract,
        })),
        displayFormat: this.currentDisplayFormat,
      };

      console.log(`[WorkerWaveformProvider][Inst${this.instanceId}] Fetching segments: viewport=${fetchConfig.viewport.startTime}-${fetchConfig.viewport.endTime}, signals=${fetchConfig.signals.length}, format=${fetchConfig.displayFormat}, OPFS=${this._isOpfsEnabled}, MemCache=${this._isMemoryCacheEnabled}`);

      const segments = await this.sendMessage('FETCH_AND_GET_SEGMENTS', { 
        signalNames,
        config: fetchConfig,
      });

      // 验证返回数据
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
   * 渲染波形到 Canvas
   *
   * @param signalNames 信号名称列表
   * @param viewport 视口配置
   * @param canvas HTMLCanvasElement
   * @returns 渲染结果 ImageBitmap
   */
  async renderWaveform(
    signalNames: string[],
    viewport: ViewportConfig,
    canvas: HTMLCanvasElement
  ): Promise<ImageBitmap> {
    if (!this.worker) {
      throw new WaveformProviderError('Worker not initialized');
    }

    // 更新本地状态（用于后续调用）
    this.viewport = { ...this.viewport, startTime: viewport.startTime, endTime: viewport.endTime };
    this.canvas = { width: viewport.width, height: viewport.height, rowHeight: 24 };

    // 将配置打包到渲染请求中，确保渲染使用正确的参数
    // 这样可以避免在发送渲染请求和 Worker 实际处理之间参数被改变的问题
    const renderConfig = {
      viewport: {
        startTime: viewport.startTime,
        endTime: viewport.endTime,
      },
      canvas: {
        width: viewport.width,
        height: viewport.height,
        rowHeight: 24,
      },
      signals: this.currentSignals.map((sig) => ({
        globalId: sig.globalId,
        name: sig.name,
        row: sig.row,
        width: sig.width,
        drawSigId: sig.drawSigId,
        bitExtract: sig.bitExtract,
      })),
      displayFormat: this.currentDisplayFormat,
    };

    console.log(`[WorkerWaveformProvider][Inst${this.instanceId}] Rendering: viewport=${renderConfig.viewport.startTime}-${renderConfig.viewport.endTime}, signals=${renderConfig.signals.length}, format=${renderConfig.displayFormat}, OPFS=${this._isOpfsEnabled}, MemCache=${this._isMemoryCacheEnabled}`);

    // 将 Canvas 控制权转移给 Worker
    const offscreen = canvas.transferControlToOffscreen();

    // 发送渲染命令，包含完整配置，Transfer OffscreenCanvas
    await this.sendMessage(
      'RENDER_WAVEFORM',
      { signalNames, config: renderConfig },
      60000, // 渲染超时 60 秒
      [offscreen]
    );

    // 返回空 ImageBitmap（实际渲染在 Worker 中完成）
    // 由于 canvas 已转移，我们需要创建一个新的 ImageBitmap
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = 1;
    tempCanvas.height = 1;
    return createImageBitmap(tempCanvas);
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

  // ==================== 属性 ====================

  get viewportTimeStart(): number {
    return this.viewport.startTime;
  }

  get viewportTimeEnd(): number {
    return this.viewport.endTime;
  }

  get canvasWidth(): number {
    return this.canvas.width;
  }

  get canvasHeight(): number {
    return this.canvas.height;
  }

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
    // 如果已销毁，忽略所有消息
    if (this._isDisposed) {
      return;
    }

    const { type, id, data, error, success } = event.data;

    // 过滤掉 ID 小于 minMessageId 的旧消息（来自之前的 Worker 实例）
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

    // 拒绝所有 pending 的消息
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
      // 使用全局消息 ID 计数器，确保唯一性
      const id = ++globalMessageId;

      // 设置超时
      const timeoutId = window.setTimeout(() => {
        this.pendingMessages.delete(id);
        reject(new WaveformProviderError(`Operation timeout after ${timeout}ms`));
      }, timeout);

      this.pendingMessages.set(id, {
        resolve,
        reject,
        timeout: timeoutId,
      });

      // 发送消息到 Worker
      if (transfer) {
        this.worker?.postMessage({ type, payload, id }, transfer);
      } else {
        this.worker?.postMessage({ type, payload, id });
      }
    });
  }

  // ==================== 额外方法（用于 Hook）====================

  /**
   * 获取信号列表
   */
  async getSignals(): Promise<SignalInfo[]> {
    try {
      return await this.sendMessage('GET_SIGNALS', {});
    } catch (error) {
      console.warn('[WorkerWaveformProvider] getSignals failed:', error);
      return [];
    }
  }

  /**
   * 获取信号段数据
   */
  async getSignalSegments(
    signalName: string,
    startTime: number,
    endTime: number
  ): Promise<SignalSegment[]> {
    try {
      return await this.sendMessage('GET_SIGNAL_SEGMENTS', {
        signalName,
        startTime,
        endTime,
      });
    } catch (error) {
      console.warn('[WorkerWaveformProvider] getSignalSegments failed:', error);
      return [];
    }
  }
}
