/**
 * WaveformWindowWithProvider - 使用新 Provider 接口的波形窗口组件
 * 
 * 这个组件是 WaveformWindow 的包装版本，使用新的 WaveformProviderInterface
 * 来支持 Worker 模式和直接模式。
 */

import { useEffect, useState } from 'react';
import { WaveformWindow } from './WaveformWindow';
import { useWaveformProvider } from '../hooks/useWaveformProvider';

interface WaveformWindowWithProviderProps {
  // 传递给 WaveformWindow 的 props
  signals: any[];
  groups: Record<string, any>;
  selectedGroup: string;
  columnWidths?: any;
  timeConfig?: any;
  onSignalRemove: (signal: any) => void;
  onGroupsUpdate: (groups: Record<string, any>) => void;
  onSelectedGroupUpdate: (selectedGroup: string) => void;
  onSignalsProcessed: (processedIds: number[]) => void;
  onColumnWidthsChange?: (widths: any) => void;
  viewport?: any;
  onViewportChange?: (viewport: any) => void;
  cursorPosition?: number;
  onCursorPositionChange?: (position: number) => void;
  useMockData?: boolean;
  waveformRange?: {
    start: number;
    end: number;
  };
  
  // Provider 配置
  serverUrl?: string;
  waveformName?: string;
  signalPrefix?: string;
  spaceBeforeBracket?: boolean;
  
  // 模式选择
  useWorker?: boolean;
}

export function WaveformWindowWithProvider({
  // Provider 配置
  serverUrl = 'http://localhost:8080',
  waveformName = '',
  signalPrefix = '',
  spaceBeforeBracket = false,
  useWorker = false,
  useMockData = false,
  
  // 其他 props 传递给 WaveformWindow
  ...waveformWindowProps
}: WaveformWindowWithProviderProps) {
  // 使用新的 Hook 创建 Provider
  const {
    isReady,
    error: newError,
    retry,
  } = useWaveformProvider({
    useWorker,
    serverUrl,
    waveformName,
    signalPrefix,
    spaceBeforeBracket,
    timeStamp: Date.now(),
    enableOpfs: false,
    enableMemoryCache: true,
  });

  // 同步 Provider 状态
  const [error, setError] = useState<string | null>(null);
  
  useEffect(() => {
    setError(newError?.message || null);
  }, [newError]);

  // 如果出错，显示错误界面
  if (error && !useMockData) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: '24px',
        backgroundColor: '#fef2f2',
        border: '1px solid #fecaca',
        borderRadius: '8px',
        color: '#dc2626',
      }}>
        <h3>波形渲染出错</h3>
        <p>{error}</p>
        <button
          onClick={retry}
          style={{
            padding: '8px 16px',
            backgroundColor: '#dc2626',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          重试
        </button>
        <p style={{ marginTop: '16px', fontSize: '12px' }}>
          提示：可以设置 useMockData=true 使用模拟数据
        </p>
      </div>
    );
  }

  // 如果正在初始化，显示加载界面
  if (!isReady && !useMockData && !useWorker) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: '#666',
      }}>
        <div>正在初始化波形渲染...</div>
      </div>
    );
  }

  // 渲染原始的 WaveformWindow
  // 注意：目前 WaveformWindow 仍使用旧的 getProvider() 方式
  // 后续可以逐步迁移到新的 Provider 接口
  return (
    <WaveformWindow
      {...waveformWindowProps}
      useMockData={useMockData}
      serverUrl={serverUrl}
      waveformName={waveformName}
      signalPrefix={signalPrefix}
      spaceBeforeBracket={spaceBeforeBracket}
    />
  );
}

export default WaveformWindowWithProvider;
