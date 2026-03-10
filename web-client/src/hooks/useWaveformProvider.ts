/**
 * useWaveformProvider - React Hook for Waveform Provider
 * 
 * 功能：
 * 1. 管理 WaveformProvider 的生命周期
 * 2. 自动初始化和清理
 * 3. 提供错误处理和重试机制
 * 4. 支持 Worker 和 Direct 两种模式
 * 
 * 使用示例：
 * ```tsx
 * const { provider, isReady, error, retry } = useWaveformProvider({
 *   useWorker: true,
 *   wasmPath: '/wasm/waveform.wasm'
 * });
 * 
 * useEffect(() => {
 *   if (provider && canvasRef.current) {
 *     provider.renderWaveform(['signal1'], viewport, canvasRef.current);
 *   }
 * }, [provider, viewport]);
 * ```
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  WaveformProviderInterface,
  FactoryConfig,
  WaveformError,
  ViewportConfig,
  SignalInfo,
  SignalSegment,
} from '../core/waveformProviderInterface';
import { createWaveformProvider } from '../wasm/waveformProviderFactory';
import { RenderCache } from '../core/renderCache';

interface UseWaveformProviderOptions extends FactoryConfig {
  /** 是否启用渲染缓存 */
  enableCache?: boolean;
  /** 缓存最大条目数 */
  cacheSize?: number;
}

interface UseWaveformProviderReturn {
  /** Provider 实例 */
  provider: WaveformProviderInterface | null;
  /** 是否已就绪 */
  isReady: boolean;
  /** 是否正在初始化 */
  isInitializing: boolean;
  /** 错误信息 */
  error: WaveformError | null;
  /** 重试初始化 */
  retry: () => void;
  /** 渲染波形（带缓存） */
  renderWaveform: (
    signalNames: string[],
    viewport: ViewportConfig,
    canvas: HTMLCanvasElement
  ) => Promise<void>;
  /** 获取信号列表 */
  getSignals: () => Promise<SignalInfo[]>;
  /** 获取信号段数据 */
  getSignalSegments: (
    signalName: string,
    startTime: number,
    endTime: number
  ) => Promise<SignalSegment[]>;
  /** 获取缓存统计 */
  cacheStats: {
    hits: number;
    misses: number;
    hitRate: number;
    size: number;
  } | null;
}

export function useWaveformProvider(
  options: UseWaveformProviderOptions
): UseWaveformProviderReturn {
  const {
    enableCache = true,
    cacheSize = 50,
    ...factoryConfig
  } = options;

  const [provider, setProvider] = useState<WaveformProviderInterface | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [error, setError] = useState<WaveformError | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const cacheRef = useRef<RenderCache | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 初始化缓存
  useEffect(() => {
    if (enableCache && !cacheRef.current) {
      cacheRef.current = new RenderCache(cacheSize);
    }
    return () => {
      cacheRef.current?.clear();
      cacheRef.current = null;
    };
  }, [enableCache, cacheSize]);

  // 初始化 Provider
  useEffect(() => {
    let isMounted = true;
    abortControllerRef.current = new AbortController();

    const initProvider = async () => {
      setIsInitializing(true);
      setError(null);

      try {
        const newProvider = await createWaveformProvider(factoryConfig);

        if (!isMounted) {
          newProvider.dispose();
          return;
        }

        setProvider(newProvider);
        setIsReady(true);
        console.log('[useWaveformProvider] Provider initialized successfully');
      } catch (err) {
        if (!isMounted) return;

        const waveformError: WaveformError = {
          code: 'INIT_ERROR',
          message: err instanceof Error ? err.message : 'Unknown initialization error',
          recoverable: true,
        };

        setError(waveformError);
        console.error('[useWaveformProvider] Initialization failed:', err);
      } finally {
        if (isMounted) {
          setIsInitializing(false);
        }
      }
    };

    initProvider();

    return () => {
      isMounted = false;
      abortControllerRef.current?.abort();
      provider?.dispose();
    };
  }, [retryCount, JSON.stringify(factoryConfig)]);

  // 重试函数
  const retry = useCallback(() => {
    setRetryCount(prev => prev + 1);
  }, []);

  // 带缓存的渲染函数
  const renderWaveform = useCallback(
    async (signalNames: string[], viewport: ViewportConfig, canvas: HTMLCanvasElement) => {
      if (!provider) {
        throw new Error('Provider not initialized');
      }

      // 检查缓存
      if (enableCache && cacheRef.current) {
        const cached = cacheRef.current.get(signalNames, viewport);
        if (cached?.imageBitmap) {
          // 使用缓存渲染
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(cached.imageBitmap, 0, 0);
            return;
          }
        }
      }

      // 执行渲染
      const result = await provider.renderWaveform(signalNames, viewport, canvas);

      // 存入缓存
      if (enableCache && cacheRef.current) {
        cacheRef.current.set(signalNames, viewport, { imageBitmap: result });
      }
    },
    [provider, enableCache]
  );

  // 获取信号列表
  const getSignals = useCallback(async (): Promise<SignalInfo[]> => {
    if (!provider) {
      throw new Error('Provider not initialized');
    }
    return provider.getSignals();
  }, [provider]);

  // 获取信号段数据
  const getSignalSegments = useCallback(
    async (signalName: string, startTime: number, endTime: number): Promise<SignalSegment[]> => {
      if (!provider) {
        throw new Error('Provider not initialized');
      }
      return provider.getSignalSegments(signalName, startTime, endTime);
    },
    [provider]
  );

  // 缓存统计
  const cacheStats = cacheRef.current
    ? {
        hits: cacheRef.current.getStats().hits,
        misses: cacheRef.current.getStats().misses,
        hitRate: cacheRef.current.getHitRate(),
        size: cacheRef.current.size(),
      }
    : null;

  return {
    provider,
    isReady,
    isInitializing,
    error,
    retry,
    renderWaveform,
    getSignals,
    getSignalSegments,
    cacheStats,
  };
}

/**
 * useWaveformViewport - 管理视口状态
 * 
 * 提供流畅的视口操作体验，支持缩放和平移
 */
interface ViewportState extends ViewportConfig {
  /** 缩放比例（用于 UI 显示） */
  zoomLevel: number;
}

interface UseWaveformViewportOptions {
  initialStartTime?: number;
  initialEndTime?: number;
  initialWidth?: number;
  initialHeight?: number;
  minZoom?: number;
  maxZoom?: number;
}

interface UseWaveformViewportReturn {
  viewport: ViewportState;
  setViewport: (viewport: Partial<ViewportConfig>) => void;
  zoom: (factor: number, centerTime?: number) => void;
  pan: (deltaTime: number) => void;
  reset: () => void;
}

export function useWaveformViewport(
  options: UseWaveformViewportOptions = {}
): UseWaveformViewportReturn {
  const {
    initialStartTime = 0,
    initialEndTime = 1000,
    initialWidth = 800,
    initialHeight = 400,
    minZoom = 0.1,
    maxZoom = 100,
  } = options;

  const [viewport, setViewportState] = useState<ViewportState>({
    startTime: initialStartTime,
    endTime: initialEndTime,
    width: initialWidth,
    height: initialHeight,
    zoomLevel: 1,
  });

  const setViewport = useCallback((update: Partial<ViewportConfig>) => {
    setViewportState(prev => ({
      ...prev,
      ...update,
    }));
  }, []);

  const zoom = useCallback(
    (factor: number, centerTime?: number) => {
      setViewportState(prev => {
        const center = centerTime ?? (prev.startTime + prev.endTime) / 2;
        const currentRange = prev.endTime - prev.startTime;
        const newRange = Math.max(
          currentRange / maxZoom,
          Math.min(currentRange / minZoom, currentRange / factor)
        );

        const newStart = center - (newRange * (center - prev.startTime)) / currentRange;
        const newEnd = newStart + newRange;

        return {
          ...prev,
          startTime: newStart,
          endTime: newEnd,
          zoomLevel: prev.zoomLevel * factor,
        };
      });
    },
    [minZoom, maxZoom]
  );

  const pan = useCallback((deltaTime: number) => {
    setViewportState(prev => ({
      ...prev,
      startTime: prev.startTime + deltaTime,
      endTime: prev.endTime + deltaTime,
    }));
  }, []);

  const reset = useCallback(() => {
    setViewportState({
      startTime: initialStartTime,
      endTime: initialEndTime,
      width: initialWidth,
      height: initialHeight,
      zoomLevel: 1,
    });
  }, [initialStartTime, initialEndTime, initialWidth, initialHeight]);

  return {
    viewport,
    setViewport,
    zoom,
    pan,
    reset,
  };
}


