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

import { createContext, useContext, useEffect, useState, ReactNode, useRef, MutableRefObject } from 'react';
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
  waveformName: null,
});

/**
 * Provider Props
 */
interface WaveformProviderProviderProps {
  children: ReactNode;
  // Optional ref that the live provider instance is written into, so consumers
  // that live OUTSIDE this provider's subtree (e.g. App, which is the parent)
  // can still reach the live provider for dynamic settings.
  providerRef?: MutableRefObject<WaveformProviderInterface | null>;
  serverUrl?: string;
  waveformName?: string;
  signalPrefix?: string;      // Local prefix (removed from local signal name)
  serverPrefix?: string;      // Server prefix (added to server signal name)
  spaceBeforeBracket?: boolean;
  timeStamp?: number;
  enableOpfs?: boolean;
  enableMemoryCache?: boolean;
  enablePrefetch?: boolean;
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
  enablePrefetch = true,
  providerRef,
}: WaveformProviderProviderProps) {
  const [provider, setProvider] = useState<WaveformProviderInterface | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  
  // Track previous values of props that require recreating provider.
  // NOTE: enableOpfs / enablePrefetch are intentionally NOT in this list. They are
  // applied dynamically via the live provider's setOpfsEnabled / setPrefetchEnabled
  // (which post messages to the worker). Recreating the whole WASM worker on those
  // toggles would be wasteful and lose the OPFS/in-memory cache.
  const prevPropsRef = useRef({
    serverUrl: '',
    waveformName: '',
    timeStamp: 0,
    enableMemoryCache: true,
  });

  // Effect A: (re)create the provider only when the *recreate-relevant* config changes
  // (server URL, waveform name, timestamp, memory cache). OPFS / Prefetch toggles and the
  // signal-name formatting settings are applied dynamically and must NOT tear down the
  // worker — otherwise the live-provider ref consumed by the parent (menu toggles) would be
  // invalidated on every unrelated re-render.
  useEffect(() => {
    const prevProps = prevPropsRef.current;
    const needsNewProvider =
      prevProps.serverUrl !== serverUrl ||
      prevProps.waveformName !== waveformName ||
      prevProps.timeStamp !== timeStamp ||
      prevProps.enableMemoryCache !== enableMemoryCache;

    // 只有在有有效的配置时才创建 Provider
    // 必须要有 waveformName，否则我们不知道要渲染什么波形
    const hasValidConfig = serverUrl && waveformName;

    console.log('[WaveformProviderContext] Checking provider:', {
      prevProps,
      currentProps: { serverUrl, waveformName, timeStamp, enableOpfs, enableMemoryCache, enablePrefetch },
      needsNewProvider,
      hasValidConfig
    });

    // Only formatting/prefix settings changed (handled by Effect B) while the worker is
    // already alive — do NOT recreate or dispose it.
    if (!needsNewProvider && hasValidConfig && providerRef?.current) {
      return;
    }

    if (needsNewProvider && hasValidConfig) {
      console.log('[WaveformProviderContext] Recreating provider...');
      let isMounted = true;

      const initProvider = async () => {
        try {
          setIsLoading(true);
          setError(null);

          console.log('[WaveformProviderContext] Creating provider with:', {
            serverUrl,
            waveformName,
            timeStamp,
            enableOpfs,
            enableMemoryCache,
            enablePrefetch,
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
            enablePrefetch,
          });

          if (isMounted) {
            setProvider(newProvider);
            if (providerRef) providerRef.current = newProvider;
            setIsLoading(false);
            prevPropsRef.current = { serverUrl, waveformName, timeStamp, enableMemoryCache };
          } else {
            // Superseded by a newer effect before creation finished.
            newProvider.dispose();
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
        // Tearing down the worker: clear the live-provider ref so consumers in the
        // parent (e.g. the menu toggles) can no longer call into a disposed instance.
        if (providerRef) providerRef.current = null;
        setProvider(null);
      };
    }
  }, [serverUrl, waveformName, timeStamp, enableMemoryCache, providerRef]);

  // Effect B: apply signal-name formatting settings to the live provider WITHOUT
  // recreating the worker. Runs whenever those props change; never disposes anything.
  useEffect(() => {
    const liveProvider = providerRef?.current ?? provider;
    if (liveProvider) {
      liveProvider.setSignalPrefix(signalPrefix);
      liveProvider.setServerPrefix(serverPrefix);
      liveProvider.setSpaceBeforeBracket(spaceBeforeBracket);
    }
  }, [signalPrefix, serverPrefix, spaceBeforeBracket, provider]);

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
