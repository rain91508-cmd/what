/**
 * Waveform Provider Context
 *
 * 提供共享的 WaveformProvider 实例，所有 Tab 共享同一个 Provider。
 *
 * 架构：共享 Provider + 参数化 Render
 * - 一个 WASM 实例服务所有 Tab
 * - Provider 无状态，所有参数通过方法传递
 * - Worker 管理多个 Canvas（每个 Tab 一个）
 */

import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { WaveformProviderInterface } from '../core/waveformProviderInterface';
import { createWaveformProvider } from '../wasm/waveformProviderFactory';

/**
 * Provider Context 类型
 */
interface WaveformProviderContextType {
  provider: WaveformProviderInterface | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * 创建 Context
 */
const WaveformProviderContext = createContext<WaveformProviderContextType>({
  provider: null,
  isLoading: true,
  error: null,
});

/**
 * Provider Props
 */
interface WaveformProviderProviderProps {
  children: ReactNode;
  serverUrl?: string;
  waveformName?: string;
  signalPrefix?: string;
  spaceBeforeBracket?: boolean;
  enableOpfs?: boolean;
  enableMemoryCache?: boolean;
}

/**
 * 共享 WaveformProvider Provider
 *
 * 在 App 级别提供，所有 Tab 共享同一个 Provider 实例
 */
export function WaveformProviderProvider({
  children,
  serverUrl = '',
  waveformName = '',
  signalPrefix = '',
  spaceBeforeBracket = false,
  enableOpfs = false,
  enableMemoryCache = true,
}: WaveformProviderProviderProps) {
  const [provider, setProvider] = useState<WaveformProviderInterface | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let isMounted = true;

    const initProvider = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // 创建共享 Provider（Worker 模式）
        const newProvider = await createWaveformProvider({
          useWorker: true,
          serverUrl,
          waveformName,
          signalPrefix,
          spaceBeforeBracket,
          timeStamp: Date.now(),
          enableOpfs,
          enableMemoryCache,
        });

        if (isMounted) {
          setProvider(newProvider);
          setIsLoading(false);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      }
    };

    initProvider();

    return () => {
      isMounted = false;
      // Provider 在 App 级别，不应该在这里销毁
      // 应该在 App 卸载时销毁
    };
  }, [serverUrl, waveformName, signalPrefix, spaceBeforeBracket, enableOpfs, enableMemoryCache]);

  const value: WaveformProviderContextType = {
    provider,
    isLoading,
    error,
  };

  return (
    <WaveformProviderContext.Provider value={value}>
      {children}
    </WaveformProviderContext.Provider>
  );
}

/**
 * 使用共享 WaveformProvider
 *
 * @example
 * ```tsx
 * function WaveformWindow() {
 *   const { provider, isLoading } = useWaveformProvider();
 *
 *   if (isLoading) return <div>Loading...</div>;
 *   if (!provider) return <div>Error</div>;
 *
 *   // 使用 provider
 *   return <canvas ref={canvasRef} />;
 * }
 * ```
 */
export function useWaveformProvider(): WaveformProviderContextType {
  const context = useContext(WaveformProviderContext);
  if (!context) {
    throw new Error('useWaveformProvider must be used within WaveformProviderProvider');
  }
  return context;
}

/**
 * 使用 Provider 实例（便捷方法）
 *
 * @returns Provider 实例，如果未加载则为 null
 */
export function useWaveformProviderInstance(): WaveformProviderInterface | null {
  const { provider } = useWaveformProvider();
  return provider;
}

/**
 * 检查 Provider 是否已加载
 *
 * @returns Provider 是否已加载
 */
export function useIsWaveformProviderReady(): boolean {
  const { provider, isLoading } = useWaveformProvider();
  return !isLoading && provider !== null;
}

export default WaveformProviderContext;
