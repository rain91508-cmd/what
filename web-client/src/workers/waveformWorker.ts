/**
 * Waveform Worker
 *
 * Worker 线程中运行 WASM 和渲染引擎。
 * 处理来自主线程的消息，执行波形数据获取和渲染。
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
console.log('[WaveformWorker] Worker started');

// Worker 内部状态
let wasmProvider: WaveformDataProvider | null = null;
let wasmInitialized = false;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

// 当前渲染任务 ID，用于取消过期任务
let currentRenderId: number | null = null;

// 当前视口配置
let currentViewport: TimeRangeOnly = { timeStart: 0, timeEnd: 1000 };

// 时间配置
let currentTimeConfig: TimeConfig | undefined = undefined;

/**
 * 初始化 WASM 模块
 */
async function initializeWasm(): Promise<void> {
  if (wasmInitialized) return;

  await init();
  wasmInitialized = true;
}

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

      // ==================== 配置设置 ====================

      case 'SET_VIEWPORT': {
        handleSetViewport(payload, id);
        break;
      }

      case 'SET_CANVAS_DIMENSIONS': {
        handleSetCanvasDimensions(payload, id);
        break;
      }

      case 'SET_SIGNAL_LIST': {
        handleSetSignalList(payload, id);
        break;
      }

      case 'SET_DISPLAY_FORMAT': {
        handleSetDisplayFormat(payload, id);
        break;
      }

      // ==================== 数据获取 ====================

      case 'GET_SIGNAL_VALUE_AT_TIME': {
        await handleGetSignalValueAtTime(payload, id);
        break;
      }

      case 'FIND_TRANSITIONS_AROUND': {
        await handleFindTransitionsAround(payload, id);
        break;
      }

      // ==================== 渲染 ====================

      case 'FETCH_AND_GET_SEGMENTS': {
        await handleFetchAndGetSegments(payload, id);
        break;
      }

      case 'RENDER_WAVEFORM': {
        await handleRenderWaveform(payload, id);
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

      default: {
        throw new Error(`Unknown message type: ${type}`);
      }
    }
  } catch (error) {
    sendError(id, error instanceof Error ? error.message : String(error));
  }
};

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
    config.spaceBeforeBracket,
    BigInt(config.timeStamp)
  );

  // 设置内存缓存
  if (config.enableMemoryCache !== undefined) {
    wasmProvider.set_memory_cache_enabled(config.enableMemoryCache);
  }

  // 初始化时间配置
  if (config.timeConfig) {
    currentTimeConfig = config.timeConfig;
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

  canvas = null;
  ctx = null;
  currentRenderId = null;

  sendSuccess(id, null);
}

/**
 * 处理 SET_VIEWPORT
 */
function handleSetViewport(payload: any, id: number): void {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { timeStart, timeEnd } = payload;
  wasmProvider.set_viewport(timeStart, timeEnd);

  // 更新当前视口
  currentViewport = { timeStart, timeEnd };

  // 同步消息不发送响应
}

/**
 * 处理 SET_CANVAS_DIMENSIONS
 */
function handleSetCanvasDimensions(payload: any, id: number): void {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { width, height, rowHeight } = payload;
  wasmProvider.set_canvas_dimensions(width, height, rowHeight);

  // 同步消息不发送响应
}

/**
 * 处理 SET_SIGNAL_LIST
 */
function handleSetSignalList(payload: any, id: number): void {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { signals } = payload;

  // 转换信号格式
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
  }));

  wasmProvider.set_draw_list(wasmSignals);

  // 同步消息不发送响应
}

/**
 * 处理 SET_DISPLAY_FORMAT
 */
function handleSetDisplayFormat(payload: any, id: number): void {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { format } = payload;
  wasmProvider.display_format = format;

  // 同步消息不发送响应
}

/**
 * 处理 GET_SIGNAL_VALUE_AT_TIME
 */
async function handleGetSignalValueAtTime(payload: any, id: number): Promise<void> {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { signalName, time } = payload;
  const value = wasmProvider.get_signal_value_at_time(signalName, time);

  sendSuccess(id, value);
}

/**
 * 处理 FIND_TRANSITIONS_AROUND
 */
async function handleFindTransitionsAround(payload: any, id: number): Promise<void> {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { signalName, time } = payload;
  const transitions = wasmProvider.find_transitions_around(signalName, time);

  sendSuccess(id, transitions);
}

/**
 * 处理 FETCH_AND_GET_SEGMENTS
 */
async function handleFetchAndGetSegments(payload: any, id: number): Promise<void> {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { signalNames, config, commandId } = payload;

  // 记录当前渲染任务 ID
  currentRenderId = commandId;

  try {
    // 应用配置（确保使用正确的参数，避免数据不一致）
    if (config) {
      // 设置视口
      if (config.viewport) {
        wasmProvider.set_viewport(config.viewport.startTime, config.viewport.endTime);
        currentViewport = { timeStart: config.viewport.startTime, timeEnd: config.viewport.endTime };
      }

      // 设置画布尺寸
      if (config.canvas) {
        wasmProvider.set_canvas_dimensions(config.canvas.width, config.canvas.height, config.canvas.rowHeight);
      }

      // 设置信号列表
      if (config.signals) {
        const wasmSignals = config.signals.map((sig: any) => ({
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
        }));
        wasmProvider.set_draw_list(wasmSignals);
      }

      // 设置显示格式
      if (config.displayFormat) {
        wasmProvider.display_format = config.displayFormat;
      }
    }

    const segments = await wasmProvider.fetch_and_get_segments(signalNames);

    // 检查任务是否已过期
    if (currentRenderId !== commandId) {
      sendError(id, 'Task cancelled');
      return;
    }

    sendSuccess(id, segments);
  } catch (error) {
    sendError(id, error instanceof Error ? error.message : String(error));
  }
}

/**
 * 处理 RENDER_WAVEFORM
 */
async function handleRenderWaveform(payload: any, id: number): Promise<void> {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { signalNames, config, commandId } = payload;

  // 记录当前渲染任务 ID
  currentRenderId = commandId;

  try {
    // 1. 应用渲染配置（确保使用正确的参数，避免数据不一致）
    // 配置随渲染请求一起发送，而不是依赖之前发送的同步消息
    if (config) {
      // 设置视口
      if (config.viewport) {
        wasmProvider.set_viewport(config.viewport.startTime, config.viewport.endTime);
        currentViewport = { timeStart: config.viewport.startTime, timeEnd: config.viewport.endTime };
      }

      // 设置画布尺寸
      if (config.canvas) {
        wasmProvider.set_canvas_dimensions(config.canvas.width, config.canvas.height, config.canvas.rowHeight);
      }

      // 设置信号列表
      if (config.signals) {
        const wasmSignals = config.signals.map((sig: any) => ({
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
        }));
        wasmProvider.set_draw_list(wasmSignals);
      }

      // 设置显示格式
      if (config.displayFormat) {
        wasmProvider.display_format = config.displayFormat;
      }
    }

    // 2. 获取 segments
    const segments = await wasmProvider.fetch_and_get_segments(signalNames);

    // 检查任务是否已过期
    if (currentRenderId !== commandId) {
      sendError(id, 'Task cancelled');
      return;
    }

    // 3. 检查 Canvas 是否初始化
    if (!canvas || !ctx) {
      throw new Error('Canvas not initialized');
    }

    // 4. 使用通用渲染函数在 Worker 中渲染
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    // 转换 segments 格式以匹配通用渲染函数
    const renderSegments: RenderSegment[] = segments.map((seg: any) => ({
      x0: seg.x0,
      x1: seg.x1,
      y: seg.y,
      value: seg.value as FormattedValue,
    }));

    // 使用通用渲染函数
    renderWaveform(
      ctx,
      renderSegments,
      currentViewport,
      canvasWidth,
      canvasHeight,
      20, // rulerHeight
      currentTimeConfig,
      25  // rowHeight
    );

    // 5. 返回成功（绘制已完成，无需传输数据）
    sendSuccess(id, { rendered: true, segmentCount: segments.length });
  } catch (error) {
    sendError(id, error instanceof Error ? error.message : String(error));
  }
}

/**
 * 处理 CLEAR_CACHE
 */
function handleClearCache(id: number): void {
  if (!wasmProvider) throw new Error('Provider not initialized');

  wasmProvider.clear_cache();

  // 同步消息不发送响应
}

/**
 * 处理 SET_OPFS_ENABLED
 */
function handleSetOpfsEnabled(payload: any, id: number): void {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { enabled } = payload;
  wasmProvider.set_opfs_enabled(enabled);

  // 同步消息不发送响应
}

/**
 * 处理 SET_MEMORY_CACHE_ENABLED
 */
function handleSetMemoryCacheEnabled(payload: any, id: number): void {
  if (!wasmProvider) throw new Error('Provider not initialized');

  const { enabled } = payload;
  wasmProvider.set_memory_cache_enabled(enabled);

  // 同步消息不发送响应
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
