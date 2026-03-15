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

// 请求队列（用于处理并发请求）
const requestQueue: Array<() => Promise<void>> = [];
let isProcessingQueue = false;

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

      case 'GET_SIGNAL_VALUES_AT_TRANSITIONS': {
        await enqueueRequest(() => handleGetSignalValuesAtTransitions(payload, id));
        break;
      }

      // ==================== 渲染（参数化）====================

      case 'FETCH_AND_GET_SEGMENTS': {
        await enqueueRequest(() => handleFetchAndGetSegments(payload, id));
        break;
      }

      case 'RENDER_WAVEFORM': {
        await enqueueRequest(() => handleRenderWaveform(payload, id));
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
 * 将请求加入队列
 */
async function enqueueRequest(request: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    requestQueue.push(async () => {
      try {
        await request();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    processQueue();
  });
}

/**
 * 处理请求队列
 */
async function processQueue(): Promise<void> {
  if (isProcessingQueue || requestQueue.length === 0) return;

  isProcessingQueue = true;

  while (requestQueue.length > 0) {
    const request = requestQueue.shift();
    if (request) {
      try {
        await request();
      } catch (error) {
        console.error('[WaveformWorker] Request failed:', error);
      }
    }
  }

  isProcessingQueue = false;
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

  // 设置内存缓存
  if (config.enableMemoryCache !== undefined) {
    wasmProvider.set_memory_cache_enabled(config.enableMemoryCache);
  }

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

  const { signalName, time, displayFormat } = payload;

  // 直接使用传入的 displayFormat，不再从 signals 中查找
  // 因为 signals 中的 displayFormat 可能不是最新的
  const signalDisplayFormat = displayFormat;

  const value = wasmProvider.get_signal_value_at_time(signalName, time, signalDisplayFormat);
  sendSuccess(id, value);
}

/**
 * 处理 FIND_TRANSITIONS_AROUND（参数化）
 */
async function handleFindTransitionsAround(payload: any, id: number): Promise<void> {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { signalName, time, signals } = payload;

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
    // Prefix settings for signal name conversion
    signalPrefix,
    serverPrefix,
    spaceBeforeBracket,
    // Time unit conversion factor
    displayUnitPerLoD0Unit,
  } = payload;

  console.log('[WaveformWorker] GET_SIGNAL_VALUES_AT_TRANSITIONS payload:', {
    signalNames,
    searchStartTime,
    searchEndTime,
    resultMax,
    signalCount: signals?.length,
    signalPrefix,
    serverPrefix,
    spaceBeforeBracket,
    displayUnitPerLoD0Unit,
  });

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

  console.log('[WaveformWorker] WASM provider prefix settings:', {
    signal_prefix: wasmProvider.signal_prefix,
    server_prefix: wasmProvider.server_prefix,
    space_before_bracket: wasmProvider.space_before_bracket,
  });

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

  console.log('[WaveformWorker] Calling WASM get_signal_values_at_transitions with:', {
    signalNames,
    searchStartTime,
    searchEndTime,
    resultMax,
    wasmSignalsCount: wasmSignals.length,
  });

  // Set display unit conversion factor if provided
  if (displayUnitPerLoD0Unit !== undefined) {
    wasmProvider.display_unit_per_lod0_unit = displayUnitPerLoD0Unit;
  }

  console.log('[WaveformWorker] WASM provider time settings:', {
    display_unit_per_lod0_unit: wasmProvider.display_unit_per_lod0_unit,
  });

  // Call WASM function
  // Convert time values to BigInt as required by WASM
  const result = await wasmProvider.get_signal_values_at_transitions(
    signalNames,
    BigInt(searchStartTime),
    BigInt(searchEndTime),
    resultMax,
    wasmSignals
  );

  sendSuccess(id, result);
}

/**
 * 处理 FETCH_AND_GET_SEGMENTS（参数化）
 */
async function handleFetchAndGetSegments(payload: any, id: number): Promise<void> {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { signalNames, viewport, signals, displayFormat } = payload;

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

    // 6. 获取 segments
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

    // 8. 返回成功
    // Debug: console.log('[WaveformWorker] Render complete');
    sendSuccess(id, { rendered: true, segmentCount: segments.length });
  } catch (error) {
    console.error('[WaveformWorker] Error in handleRenderWaveform:', error);
    sendError(id, error instanceof Error ? error.message : String(error));
  }
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
