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

import { createContext, useContext, useEffect, useState, ReactNode, useRef } from 'react';
import { WaveformProviderInterface } from '../core/waveformProviderInterface';
import { createWaveformProvider } from '../wasm/waveformProviderFactory';

/**
 * Provider Context 类型
 */
interface WaveformProviderContextType {
  provider: WaveformProviderInterface | null;
  isLoading: boolean;
  error: Error | null;
  waveformName: string | null;
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
  signalPrefix?: string;      // Local prefix (removed from local signal name)
  serverPrefix?: string;      // Server prefix (added to server signal name)
  spaceBeforeBracket?: boolean;
  timeStamp?: number;
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
  signalPrefix = '',      // Local prefix
  serverPrefix = '',      // Server prefix
  spaceBeforeBracket = false,
  timeStamp = 0,
  enableOpfs = false,
  enableMemoryCache = true,
}: WaveformProviderProviderProps) {
  const [provider, setProvider] = useState<WaveformProviderInterface | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  
  // Track previous values of props that require recreating provider
  const prevPropsRef = useRef({
    serverUrl: '',
    waveformName: '',
    timeStamp: 0,
    enableOpfs: false,
    enableMemoryCache: true,
  });

  useEffect(() => {
    const prevProps = prevPropsRef.current;
    const needsNewProvider = 
      prevProps.serverUrl !== serverUrl ||
      prevProps.waveformName !== waveformName ||
      prevProps.timeStamp !== timeStamp ||
      prevProps.enableOpfs !== enableOpfs ||
      prevProps.enableMemoryCache !== enableMemoryCache;

    // 只有在有有效的配置时才创建 Provider
    // 必须要有 waveformName，否则我们不知道要渲染什么波形
    const hasValidConfig = serverUrl && waveformName;

    console.log('[WaveformProviderContext] Checking provider:', {
      prevProps,
      currentProps: { serverUrl, waveformName, timeStamp, enableOpfs, enableMemoryCache },
      needsNewProvider,
      hasValidConfig
    });

    if (needsNewProvider && hasValidConfig) {
      console.log('[WaveformProviderContext] Recreating provider...');
      // Recreate provider
      let isMounted = true;
      let oldProvider: WaveformProviderInterface | null = null;

      const initProvider = async () => {
        try {
          setIsLoading(true);
          setError(null);

          console.log('[WaveformProviderContext] Creating provider with:', {
            serverUrl,
            waveformName,
            timeStamp,
            enableOpfs,
            enableMemoryCache
          });

          const newProvider = await createWaveformProvider({
            useWorker: true,
            serverUrl,
            waveformName,
            signalPrefix,
            serverPrefix,
            spaceBeforeBracket,
            timeStamp,
            enableOpfs,
            enableMemoryCache,
          });

          if (isMounted) {
            oldProvider = provider;
            setProvider(newProvider);
            setIsLoading(false);
            prevPropsRef.current = { serverUrl, waveformName, timeStamp, enableOpfs, enableMemoryCache };
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
        if (oldProvider) {
          oldProvider.dispose();
        } else if (provider) {
          provider.dispose();
        }
      };
    } else if (!needsNewProvider && provider) {
      // Just update signalPrefix, serverPrefix and/or spaceBeforeBracket on existing provider
      if (provider) {
        provider.setSignalPrefix(signalPrefix);
        provider.setServerPrefix(serverPrefix);
        provider.setSpaceBeforeBracket(spaceBeforeBracket);
      }
    }
  }, [serverUrl, waveformName, signalPrefix, serverPrefix, spaceBeforeBracket, timeStamp, enableOpfs, enableMemoryCache]);

  const value: WaveformProviderContextType = {
    provider,
    isLoading,
    error,
    waveformName: waveformName || null,
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
