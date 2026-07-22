/**
 * Waveform Worker
 *
 * Worker 线程中运行 WASM 和渲染引擎。
 * 处理来自主线程的消息，执行波形数据获取和渲染。
 *
 * 架构：共享 Provider + 参数化 Render
 * - 一个 WASM 实例服务所有 Tab
 * - Worker 管理多个 Canvas（每个 Tab 一个）
 * - 所有操作通过参数传递，不保存 Tab 相关状态
 */

import init, { WaveformDataProvider } from '../../wasm-pkg/hwda_wasm.js';
import {
  renderWaveform,
  FormattedValue,
  TimeRangeOnly,
  TimeConfig,
} from '../core/render/waveformDrawing';
import { opfsRead, opfsWrite, opfsExists, isOpfsSupported } from '../core/cache/opfsAccess';
import type { RenderSegment } from '../core/waveformProviderInterface';

// Worker 启动日志
// Debug: console.log('[WaveformWorker] Worker started');

// ==================== Worker 状态 ====================

// WASM Provider（单例）
let wasmProvider: WaveformDataProvider | null = null;
let wasmInitialized = false;

// Canvas 管理器 - 保存所有 transfer 来的 Canvas（每个 Tab 一个）
const canvasManager = new Map<string, {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  devicePixelRatio: number;
}>();

// 渲染任务管理
interface RenderTask {
  id: number;
  canvasId: string;
  timestamp: number;
}
let currentRenderTask: RenderTask | null = null;

// 预取任务管理
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPrefetchSignals: string[] | null = null;
let lastRenderSignalNames: string[] = []; // 最近一次渲染的信号名，用于切换预取开关后立即触发
let prefetchEnabled = false; // 是否在渲染后预取相邻 tile（可由 SET_PREFETCH_ENABLED 或初始化配置控制）
const PREFETCH_DELAY_MS = 500; // 延迟500ms后才开始预取，避免频繁渲染时触发

// 请求队列（用于处理并发请求）
const requestQueue: Array<() => Promise<void>> = [];
let isProcessingQueue = false;

// 请求类型标识（用于队列去重）
const requestMetadata = new WeakMap<() => Promise<void>, { type: 'render' | 'prefetch' | 'other'; id: number; timestamp: number }>();
let requestIdCounter = 0;

// 暴露给 WASM 的检查函数：是否有待处理的高优先级请求（render）
(self as any).hasPendingRenderRequests = (): boolean => {
  // 检查队列中是否有 render 请求（prefetch 应该让路）
  for (const request of requestQueue) {
    const meta = requestMetadata.get(request);
    if (meta && meta.type === 'render') {
      return true;
    }
  }
  return false;
};

// ==================== 初始化 ====================

/**
 * 初始化 WASM 模块
 */
async function initializeWasm(): Promise<void> {
  if (wasmInitialized) return;
  await init();
  wasmInitialized = true;
}

// ==================== 消息处理主循环 ====================

/**
 * 消息处理主循环
 */
self.onmessage = async (event) => {
  const { type, payload, id } = event.data;

  try {
    switch (type) {
      // ==================== 生命周期 ====================

      case 'INITIALIZE': {
        await handleInitialize(payload, id);
        break;
      }

      case 'DISPOSE': {
        handleDispose(id);
        break;
      }

      // ==================== Canvas 管理 ====================

      case 'REGISTER_CANVAS': {
        handleRegisterCanvas(payload, id);
        break;
      }

      case 'UNREGISTER_CANVAS': {
        handleUnregisterCanvas(payload, id);
        break;
      }

      // ==================== 数据获取（参数化）====================

      case 'GET_SIGNAL_VALUE_AT_TIME': {
        await enqueueRequest(() => handleGetSignalValueAtTime(payload, id));
        break;
      }

      case 'FIND_TRANSITIONS_AROUND': {
        await enqueueRequest(() => handleFindTransitionsAround(payload, id));
        break;
      }

      case 'GET_SIGNAL_DATA_STATS': {
        await enqueueRequest(() => handleGetSignalDataStats(payload, id));
        break;
      }

      case 'GET_SIGNAL_VALUES_AT_TRANSITIONS': {
        await enqueueRequest(() => handleGetSignalValuesAtTransitions(payload, id));
        break;
      }

      // ==================== 渲染（参数化）====================

      case 'FETCH_AND_GET_SEGMENTS': {
        await enqueueRequest(() => handleFetchAndGetSegments(payload, id), 'render');
        break;
      }

      case 'RENDER_WAVEFORM': {
        await enqueueRequest(() => handleRenderWaveform(payload, id), 'render');
        break;
      }

      // ==================== 缓存管理 ====================

      case 'CLEAR_CACHE': {
        handleClearCache(id);
        break;
      }

      case 'SET_OPFS_ENABLED': {
        handleSetOpfsEnabled(payload, id);
        break;
      }

      case 'SET_MEMORY_CACHE_ENABLED': {
        handleSetMemoryCacheEnabled(payload, id);
        break;
      }

      case 'SET_PREFETCH_ENABLED': {
        handleSetPrefetchEnabled(payload, id);
        break;
      }

      case 'SET_SIGNAL_PREFIX': {
        handleSetSignalPrefix(payload, id);
        break;
      }

      case 'SET_SERVER_PREFIX': {
        handleSetServerPrefix(payload, id);
        break;
      }

      case 'SET_SPACE_BEFORE_BRACKET': {
        handleSetSpaceBeforeBracket(payload, id);
        break;
      }

      default: {
        throw new Error(`Unknown message type: ${type}`);
      }
    }
  } catch (error) {
    sendError(id, error instanceof Error ? error.message : String(error));
  }
};

// ==================== 请求队列管理 ====================

/**
 * 将请求加入队列（带类型标识）
 */
async function enqueueRequest(request: () => Promise<void>, type: 'render' | 'prefetch' | 'other' = 'other'): Promise<void> {
  return new Promise((resolve, reject) => {
    const wrappedRequest = async () => {
      try {
        await request();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    // 添加元数据用于去重
    requestMetadata.set(wrappedRequest, {
      type,
      id: ++requestIdCounter,
      timestamp: Date.now()
    });
    requestQueue.push(wrappedRequest);
    processQueue();
  });
}

/**
 * 处理请求队列
 * 批量读取、去重、优先级处理：
 * 1. 一次性取出队列中所有请求
 * 2. 对 render 和 prefetch 去重，只保留最新的
 * 3. 如果 render 比 prefetch 新，取消 prefetch
 * 4. 按顺序执行优化后的请求
 */
async function processQueue(): Promise<void> {
  if (isProcessingQueue || requestQueue.length === 0) return;

  isProcessingQueue = true;

  // 一次性取出所有请求
  const allRequests = [...requestQueue];
  requestQueue.length = 0;

  // 分类并找出最新的 render 和 prefetch
  let latestRender: { request: () => Promise<void>; meta: { type: 'render' | 'prefetch' | 'other'; id: number; timestamp: number } } | null = null;
  let latestPrefetch: { request: () => Promise<void>; meta: { type: 'render' | 'prefetch' | 'other'; id: number; timestamp: number } } | null = null;
  const otherRequests: { request: () => Promise<void>; meta: { type: 'render' | 'prefetch' | 'other'; id: number; timestamp: number } }[] = [];

  for (const request of allRequests) {
    const meta = requestMetadata.get(request);
    if (!meta) {
      // 没有元数据的请求，直接执行
      otherRequests.push({ request, meta: { type: 'other', id: 0, timestamp: 0 } });
      continue;
    }

    if (meta.type === 'render') {
      // 保留最新的 render
      if (!latestRender || meta.id > latestRender.meta.id) {
        latestRender = { request, meta };
      }
    } else if (meta.type === 'prefetch') {
      // 保留最新的 prefetch
      if (!latestPrefetch || meta.id > latestPrefetch.meta.id) {
        latestPrefetch = { request, meta };
      }
    } else {
      otherRequests.push({ request, meta });
    }
  }

  // 构建优化后的执行队列，保持原始插入顺序
  const optimizedQueue: (() => Promise<void>)[] = [];

  // 收集所有需要保留的请求（去重后）
  const requestsToKeep: { request: () => Promise<void>; meta: { type: 'render' | 'prefetch' | 'other'; id: number; timestamp: number } }[] = [];

  // 先添加其他请求
  for (const item of otherRequests) {
    requestsToKeep.push(item);
  }

  // 添加最新的 render（如果有）
  if (latestRender) {
    requestsToKeep.push(latestRender);
  }

  // 添加最新的 prefetch（仅当没有 render 或 prefetch 比 render 更新时）
  if (latestPrefetch) {
    const shouldIncludePrefetch = !latestRender || latestPrefetch.meta.id > latestRender.meta.id;
    if (shouldIncludePrefetch) {
      requestsToKeep.push(latestPrefetch);
    } else {
      // prefetch 比 render 旧，取消 prefetch
      // console.log('[WaveformWorker] Cancelling outdated prefetch, render is newer');
    }
  }

  // 按照原始插入顺序（id）排序
  requestsToKeep.sort((a, b) => a.meta.id - b.meta.id);

  // 添加到执行队列
  for (const { request } of requestsToKeep) {
    optimizedQueue.push(request);
  }

  // 执行优化后的队列
  for (const request of optimizedQueue) {
    try {
      await request();
    } catch (error) {
      console.error('[WaveformWorker] Request failed:', error);
    }
  }

  isProcessingQueue = false;

  // 如果队列又有新请求，继续处理
  if (requestQueue.length > 0) {
    processQueue();
  }
}

// ==================== 处理器函数 ====================

/**
 * 处理 INITIALIZE
 */
async function handleInitialize(payload: any, id: number): Promise<void> {
  const { config } = payload;

  // 初始化 WASM
  await initializeWasm();

  // 创建 WASM provider
  wasmProvider = new WaveformDataProvider(
    config.serverUrl,
    config.waveformName,
    config.signalPrefix,
    config.serverPrefix,
    config.spaceBeforeBracket,
    BigInt(config.timeStamp)
  );

  // 初始化 OPFS 缓存回调（与直接路径一致）
  // 注意：Worker 是模块 Worker，没有 window，需用 globalThis 暴露包装函数。
  if (isOpfsSupported()) {
    const g = globalThis as any;
    g.opfsReadWrapper = async (path: string): Promise<Uint8Array | null> => opfsRead(path);
    g.opfsWriteWrapper = async (path: string, data: Uint8Array): Promise<void> => opfsWrite(path, data);
    g.opfsExistsWrapper = async (path: string): Promise<boolean> => opfsExists(path);

    const readCallback = new Function('path', 'return globalThis.opfsReadWrapper(path);');
    const writeCallback = new Function('path', 'data', 'return globalThis.opfsWriteWrapper(path, data);');
    const existsCallback = new Function('path', 'return globalThis.opfsExistsWrapper(path);');

    wasmProvider.init_with_opfs(
      readCallback as any,
      writeCallback as any,
      existsCallback as any,
      config.enableOpfs === true
    );
  }

  // 设置内存缓存
  if (config.enableMemoryCache !== undefined) {
    wasmProvider.set_memory_cache_enabled(config.enableMemoryCache);
  }

  // 设置预取开关
  prefetchEnabled = config.enablePrefetch !== undefined ? config.enablePrefetch : false;

  sendSuccess(id, null);
}

/**
 * 处理 DISPOSE
 */
function handleDispose(id: number): void {
  if (wasmProvider) {
    wasmProvider.clear_cache();
    wasmProvider = null;
  }

  // 清理所有 Canvas
  canvasManager.clear();
  currentRenderTask = null;

  sendSuccess(id, null);
}

/**
 * 处理 REGISTER_CANVAS
 * Tab 创建时注册 Canvas
 */
function handleRegisterCanvas(payload: any, id: number): void {
  const { canvasId, canvas, devicePixelRatio = 1 } = payload;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context from canvas');
  }

  canvasManager.set(canvasId, { canvas, ctx, devicePixelRatio });
  // Debug: console.log(`[WaveformWorker] Canvas registered: ${canvasId}, dpr=${devicePixelRatio}`);

  sendSuccess(id, null);
}

/**
 * 处理 UNREGISTER_CANVAS
 * Tab 关闭时注销 Canvas
 */
function handleUnregisterCanvas(payload: any, id: number): void {
  const { canvasId } = payload;

  canvasManager.delete(canvasId);
  // Debug: console.log(`[WaveformWorker] Canvas unregistered: ${canvasId}`);

  sendSuccess(id, null);
}

/**
 * 处理 GET_SIGNAL_VALUE_AT_TIME（参数化）
 */
async function handleGetSignalValueAtTime(payload: any, id: number): Promise<void> {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { signalName, time, signals, displayFormat, signalPrefix, serverPrefix, spaceBeforeBracket, viewRange } = payload;

  // Update WASM provider prefix settings if provided
  if (signalPrefix !== undefined) {
    wasmProvider.signal_prefix = signalPrefix;
  }
  if (serverPrefix !== undefined) {
    wasmProvider.server_prefix = serverPrefix;
  }
  if (spaceBeforeBracket !== undefined) {
    wasmProvider.space_before_bracket = spaceBeforeBracket;
  }

  // 设置信号列表（参数传递）
  if (signals) {
    const wasmSignals = signals.map((sig: any) => ({
      global_id: sig.globalId,
      name: sig.name,
      row: sig.row,
      width: sig.width,
      draw_sig_id: sig.drawSigId,
      bit_extract: sig.bitExtract
        ? {
            parent_name: sig.bitExtract.parentName,
            msb: sig.bitExtract.msb,
            lsb: sig.bitExtract.lsb,
          }
        : undefined,
      display_format: sig.displayFormat,
    }));
    wasmProvider.set_draw_list(wasmSignals);
  }

  // 直接使用传入的 displayFormat
  const signalDisplayFormat = displayFormat;

  // 性能优化：使用 viewRange 作为初始 timeWindow，大概率命中 cache
  // 如果获取的值 isMinMax=true，则减半 timeWindow 重试
  // 直到 timeWindow < 1 或者找到非 minmax 值为止
  // 如果 isMinMax=0，说明值是唯一的，和 LoD0 一致
  let timeWindow = viewRange ? (viewRange.end - viewRange.start) / 2 : 10;
  let value = null;

  while (timeWindow >= 1) {
    wasmProvider.set_viewport(Math.max(0, time - timeWindow), time + timeWindow);
    value = wasmProvider.get_signal_value_at_time(signalName, time, signalDisplayFormat);

    // 如果找到非 minmax 值，直接返回
    if (value && !value.is_min_max) {
      break;
    }

    // 减半 timeWindow 重试
    timeWindow /= 2;
  }

  sendSuccess(id, value);
}

/**
 * 处理 FIND_TRANSITIONS_AROUND（参数化）
 */
async function handleFindTransitionsAround(payload: any, id: number): Promise<void> {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { signalName, time, signals, signalPrefix, serverPrefix, spaceBeforeBracket } = payload;

  // Update WASM provider prefix settings if provided
  if (signalPrefix !== undefined) {
    wasmProvider.signal_prefix = signalPrefix;
  }
  if (serverPrefix !== undefined) {
    wasmProvider.server_prefix = serverPrefix;
  }
  if (spaceBeforeBracket !== undefined) {
    wasmProvider.space_before_bracket = spaceBeforeBracket;
  }

  // 设置信号列表（参数传递）
  if (signals) {
    const wasmSignals = signals.map((sig: any) => ({
      global_id: sig.globalId,
      name: sig.name,
      row: sig.row,
      width: sig.width,
      draw_sig_id: sig.drawSigId,
      bit_extract: sig.bitExtract
        ? {
            parent_name: sig.bitExtract.parentName,
            msb: sig.bitExtract.msb,
            lsb: sig.bitExtract.lsb,
          }
        : undefined,
      display_format: sig.displayFormat,
    }));
    wasmProvider.set_draw_list(wasmSignals);
  }

  const transitions = wasmProvider.find_transitions_around(signalName, time);
  sendSuccess(id, transitions);
}

/**
 * 处理 GET_SIGNAL_DATA_STATS
 */
async function handleGetSignalDataStats(payload: any, id: number): Promise<void> {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { signalName } = payload;

  const stats = wasmProvider.getSignalDataStats(signalName);
  sendSuccess(id, stats);
}

/**
 * 处理 GET_SIGNAL_VALUES_AT_TRANSITIONS
 */
async function handleGetSignalValuesAtTransitions(payload: any, id: number): Promise<void> {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const {
    signalNames,
    searchStartTime,
    searchEndTime,
    resultMax,
    signals,
    // LoD parameter
    lod,
    // Early exit parameter
    earlyExitOnInsufficientTransitions,
    // Prefix settings for signal name conversion
    signalPrefix,
    serverPrefix,
    spaceBeforeBracket,
    // Time unit conversion factor
    displayUnitPerLoD0Unit,
    // Cache settings
    enableOpfs,
    enableMemoryCache,
  } = payload;

  // Update WASM provider prefix settings if provided
  if (signalPrefix !== undefined) {
    wasmProvider.signal_prefix = signalPrefix;
  }
  if (serverPrefix !== undefined) {
    wasmProvider.server_prefix = serverPrefix;
  }
  if (spaceBeforeBracket !== undefined) {
    wasmProvider.space_before_bracket = spaceBeforeBracket;
  }

  // Convert signals to WASM format
  const wasmSignals = signals.map((sig: any) => ({
    global_id: sig.globalId,
    name: sig.name,
    row: sig.row,
    width: sig.width,
    draw_sig_id: sig.drawSigId,
    bit_extract: sig.bitExtract
      ? {
          parent_name: sig.bitExtract.parentName,
          msb: sig.bitExtract.msb,
          lsb: sig.bitExtract.lsb,
        }
      : undefined,
    display_format: sig.displayFormat,
  }));

  // Set display unit conversion factor if provided
  if (displayUnitPerLoD0Unit !== undefined) {
    wasmProvider.display_unit_per_lod0_unit = displayUnitPerLoD0Unit;
  }

  // Call WASM function
  // Convert time values to BigInt as required by WASM
  const result = await wasmProvider.get_signal_values_at_transitions(
    signalNames,
    BigInt(searchStartTime),
    BigInt(searchEndTime),
    resultMax,
    wasmSignals,
    lod,
    enableOpfs,
    enableMemoryCache,
    earlyExitOnInsufficientTransitions
  );

  sendSuccess(id, result);
}

/**
 * 处理 FETCH_AND_GET_SEGMENTS（参数化）
 */
async function handleFetchAndGetSegments(payload: any, id: number): Promise<void> {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { signalNames, viewport, signals, displayFormat, signalPrefix, serverPrefix, spaceBeforeBracket } = payload;

  // Update WASM provider prefix settings if provided
  if (signalPrefix !== undefined) {
    wasmProvider.signal_prefix = signalPrefix;
  }
  if (serverPrefix !== undefined) {
    wasmProvider.server_prefix = serverPrefix;
  }
  if (spaceBeforeBracket !== undefined) {
    wasmProvider.space_before_bracket = spaceBeforeBracket;
  }

  // 设置视口（参数传递）
  if (viewport) {
    wasmProvider.set_viewport(viewport.startTime, viewport.endTime);
  }

  // 设置信号列表（参数传递）
  if (signals) {
    const wasmSignals = signals.map((sig: any) => ({
      global_id: sig.globalId,
      name: sig.name,
      row: sig.row,
      width: sig.width,
      draw_sig_id: sig.drawSigId,
      bit_extract: sig.bitExtract
        ? {
            parent_name: sig.bitExtract.parentName,
            msb: sig.bitExtract.msb,
            lsb: sig.bitExtract.lsb,
          }
        : undefined,
      display_format: sig.displayFormat,
    }));
    wasmProvider.set_draw_list(wasmSignals);
  }

  // 注意：不设置全局 display_format，因为每个信号的 display_format 已经在 set_draw_list 中设置

  const segments = await wasmProvider.fetch_and_get_segments(signalNames);
  sendSuccess(id, segments);
}

/**
 * 处理 RENDER_WAVEFORM（参数化）
 */
async function handleRenderWaveform(payload: any, id: number): Promise<void> {
  if (!wasmProvider) throw new Error('Provider not initialized');

  // Debug: console.log('[WaveformWorker] handleRenderWaveform called with:', payload);

  const {
    canvasId,
    signals,
    viewport,
    canvasConfig,
    displayFormat,
    timeConfig,
    // Prefix settings for signal name conversion
    signalPrefix,
    serverPrefix,
    spaceBeforeBracket,
  } = payload;

  // Update WASM provider prefix settings if provided
  if (signalPrefix !== undefined) {
    wasmProvider.signal_prefix = signalPrefix;
    // Debug: console.log('[WaveformWorker] Set signal_prefix:', signalPrefix);
  }
  if (serverPrefix !== undefined) {
    wasmProvider.server_prefix = serverPrefix;
    // Debug: console.log('[WaveformWorker] Set server_prefix:', serverPrefix);
  }
  if (spaceBeforeBracket !== undefined) {
    wasmProvider.space_before_bracket = spaceBeforeBracket;
    // Debug: console.log('[WaveformWorker] Set space_before_bracket:', spaceBeforeBracket);
  }

  // 获取 Canvas
  const canvasEntry = canvasManager.get(canvasId);
  if (!canvasEntry) {
    throw new Error(`Canvas not found: ${canvasId}`);
  }

  const { canvas, ctx } = canvasEntry;

  // 取消任何待执行的预取任务（优先处理当前渲染）
  cancelPendingPrefetch();

  // 记录当前渲染任务
  const renderTask: RenderTask = {
    id,
    canvasId,
    timestamp: Date.now(),
  };
  currentRenderTask = renderTask;

  try {
    // 0. 调整 Canvas 物理尺寸以匹配 CSS 尺寸（保持 1:1）
    if (canvasConfig) {
      if (canvas.width !== canvasConfig.width || canvas.height !== canvasConfig.height) {
        canvas.width = canvasConfig.width;
        canvas.height = canvasConfig.height;
        // Debug: console.log('[WaveformWorker] Resized canvas to:', canvasConfig.width, 'x', canvasConfig.height);
      }
    }

    // 1. 设置视口（参数传递）
    if (viewport) {
      wasmProvider.set_viewport(viewport.startTime, viewport.endTime);
      // Debug: console.log('[WaveformWorker] Set viewport:', viewport.startTime, viewport.endTime);
    }

    // 2. 设置画布尺寸（参数传递）
    if (canvasConfig) {
      wasmProvider.set_canvas_dimensions(
        canvasConfig.width,
        canvasConfig.height,
        canvasConfig.rowHeight
      );
      // Debug: console.log('[WaveformWorker] Set canvas config:', canvasConfig);
    }

    // 3. 设置信号列表（参数传递）
    if (signals) {
      const wasmSignals = signals.map((sig: any) => ({
        global_id: sig.globalId,
        name: sig.name,
        row: sig.row,
        width: sig.width,
        draw_sig_id: sig.drawSigId,
        bit_extract: sig.bitExtract
          ? {
              parent_name: sig.bitExtract.parentName,
              msb: sig.bitExtract.msb,
              lsb: sig.bitExtract.lsb,
            }
          : undefined,
        display_format: sig.displayFormat,
      }));
      wasmProvider.set_draw_list(wasmSignals);
      // Debug: console.log('[WaveformWorker] Set draw list with', wasmSignals.length, 'signals:', wasmSignals);
    }

    // 4. 注意：不设置全局 display_format，因为每个信号的 display_format 已经在 set_draw_list 中设置

    // 5. 获取信号名称列表
    const signalNames = signals?.map((sig: any) => sig.name) || [];
    // Debug: console.log('[WaveformWorker] Fetching segments for signals:', signalNames);

    // 6. 获取 segments（内部会自动触发预取）
    const segments = await wasmProvider.fetch_and_get_segments(signalNames);

    // 检查任务是否已过期（被新任务覆盖）
    if (currentRenderTask?.id !== id) {
      // Debug: console.log(`[WaveformWorker] Render task ${id} cancelled`);
      return;
    }

    // 7. 渲染到 Canvas
    // CSS 尺寸和 canvas 物理尺寸保持 1:1，不需要任何缩放
    // canvasConfig 是逻辑尺寸（CSS像素）
    // WASM 返回的 segments 也是逻辑坐标

    const renderSegments: RenderSegment[] = segments.map((seg: any) => ({
      x0: seg.x0,
      x1: seg.x1,
      y: seg.y,
      value: seg.value as FormattedValue,
      signalName: seg.signal_name,
    }));

    // 转换 viewport 为 TimeRangeOnly 格式
    const timeRangeOnlyViewport: TimeRangeOnly = {
      timeStart: viewport.startTime,
      timeEnd: viewport.endTime,
    };

    renderWaveform(
      ctx,
      renderSegments,
      timeRangeOnlyViewport,
      canvasConfig.width,
      canvasConfig.height,
      20, // rulerHeight
      timeConfig,
      canvasConfig.rowHeight
    );

    // 8. 调度预取任务（延迟执行，避免阻塞下一次渲染）
    lastRenderSignalNames = signalNames;
    schedulePrefetch(signalNames);

    // 9. 返回成功
    // Debug: console.log('[WaveformWorker] Render complete');
    sendSuccess(id, { rendered: true, segmentCount: segments.length });
  } catch (error) {
    console.error('[WaveformWorker] Error in handleRenderWaveform:', error);
    sendError(id, error instanceof Error ? error.message : String(error));
  }
}

/**
 * 取消待执行的预取任务
 * 在新渲染任务开始时被调用，确保优先处理当前渲染
 */
function cancelPendingPrefetch(): void {
  if (prefetchTimer) {
    clearTimeout(prefetchTimer);
    prefetchTimer = null;
    pendingPrefetchSignals = null;
    // Debug: console.log('[WaveformWorker] Cancelled pending prefetch');
  }
}

/**
 * 调度预取任务
 * 使用异步 prefetch，不加入队列，不阻塞渲染
 */
function schedulePrefetch(signalNames: string[]): void {
  // Debug: confirm prefetch gate state on every render
  console.log(`[WaveformWorker] schedulePrefetch prefetchEnabled=${prefetchEnabled} signals=${signalNames.length}`);
  // 预取被禁用时直接跳过（不发起后台 tile 预取）
  if (!prefetchEnabled) {
    return;
  }

  // 取消之前的预取任务（如果有）
  cancelPendingPrefetch();

  // 保存信号列表
  pendingPrefetchSignals = signalNames;

  // 设置延迟预取
  prefetchTimer = setTimeout(() => {
    if (wasmProvider && pendingPrefetchSignals) {
      const signalsToPrefetch = [...pendingPrefetchSignals];
      try {
        // 使用异步 prefetch，不加入队列，不阻塞渲染
        // WASM 内部使用 spawn_local 在独立任务中执行
        wasmProvider.prefetch_tiles_async(signalsToPrefetch);
      } catch (err: any) {
        // 预取失败不影响主流程，只记录日志
        console.warn('[WaveformWorker] Prefetch async failed:', err);
      }
    }
    prefetchTimer = null;
    pendingPrefetchSignals = null;
  }, PREFETCH_DELAY_MS);
}

/**
 * 处理 CLEAR_CACHE
 */
function handleClearCache(id: number): void {
  if (!wasmProvider) throw new Error('Provider not initialized');

  wasmProvider.clear_cache();
  sendSuccess(id, null);
}

/**
 * 处理 SET_OPFS_ENABLED
 */
function handleSetOpfsEnabled(payload: any, id: number): void {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { enabled } = payload;
  wasmProvider.set_opfs_enabled(enabled);
  sendSuccess(id, null);
}

/**
 * 处理 SET_MEMORY_CACHE_ENABLED
 */
function handleSetMemoryCacheEnabled(payload: any, id: number): void {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { enabled } = payload;
  wasmProvider.set_memory_cache_enabled(enabled);
  sendSuccess(id, null);
}

/**
 * 处理 SET_PREFETCH_ENABLED
 * 开关波形渲染后的相邻 tile 后台预取
 */
function handleSetPrefetchEnabled(payload: any, id: number): void {
  const { enabled } = payload;
  prefetchEnabled = enabled !== false; // 默认开启
  console.log(`[WaveformWorker] SET_PREFETCH_ENABLED received enabled=${enabled} -> prefetchEnabled=${prefetchEnabled}`);
  // 关闭时立即取消任何待执行的预取任务
  if (!prefetchEnabled) {
    cancelPendingPrefetch();
  } else if (lastRenderSignalNames.length > 0) {
    // 开启时立即用最近一次渲染的信号触发一次预取，确保开关有立即可见的效果
    console.log(`[WaveformWorker] Prefetch enabled -> re-scheduling with ${lastRenderSignalNames.length} signals`);
    schedulePrefetch(lastRenderSignalNames);
  }
  sendSuccess(id, null);
}

/**
 * 处理 SET_SIGNAL_PREFIX
 */
function handleSetSignalPrefix(payload: any, id: number): void {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { prefix } = payload;
  wasmProvider.signal_prefix = prefix;
  sendSuccess(id, null);
}

/**
 * 处理 SET_SERVER_PREFIX
 */
function handleSetServerPrefix(payload: any, id: number): void {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { prefix } = payload;
  wasmProvider.server_prefix = prefix;
  sendSuccess(id, null);
}

/**
 * 处理 SET_SPACE_BEFORE_BRACKET
 */
function handleSetSpaceBeforeBracket(payload: any, id: number): void {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { enabled } = payload;
  wasmProvider.space_before_bracket = enabled;
  sendSuccess(id, null);
}

// ==================== 辅助函数 ====================

/**
 * 发送成功响应
 */
function sendSuccess(id: number, data: any): void {
  self.postMessage({
    type: 'RESULT',
    id,
    success: true,
    data,
  });
}

/**
 * 发送错误响应
 */
function sendError(id: number, error: string): void {
  self.postMessage({
    type: 'ERROR',
    id,
    success: false,
    error,
  });
}

// Worker 错误处理
self.onerror = (error) => {
  console.error('[WaveformWorker] Uncaught error:', error);
};

// 防止未处理的 Promise 拒绝
self.addEventListener('unhandledrejection', (event) => {
  console.error('[WaveformWorker] Unhandled promise rejection:', event.reason);
});
