/**
 * WaveformErrorBoundary - 错误边界组件
 * 
 * 捕获 Waveform 渲染过程中的错误，提供优雅降级。
 */

import { Component, ErrorInfo, ReactNode } from 'react';
import { WaveformError } from '../core/waveformProviderInterface';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class WaveformErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({
      error,
      errorInfo,
    });

    // 调用外部错误处理
    this.props.onError?.(error, errorInfo);

    // 记录错误日志
    console.error('[WaveformErrorBoundary] Caught error:', error);
    console.error('[WaveformErrorBoundary] Component stack:', errorInfo.componentStack);
  }

  handleRetry = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render(): ReactNode {
    const { hasError, error } = this.state;
    const { children, fallback } = this.props;

    if (hasError) {
      // 使用自定义 fallback 或默认错误 UI
      if (fallback) {
        return fallback;
      }

      return (
        <WaveformErrorFallback
          error={error}
          onRetry={this.handleRetry}
        />
      );
    }

    return children;
  }
}

interface WaveformErrorFallbackProps {
  error: Error | null;
  onRetry: () => void;
}

function WaveformErrorFallback({ error, onRetry }: WaveformErrorFallbackProps) {
  const isRecoverable = error && 'recoverable' in error
    ? (error as unknown as WaveformError).recoverable
    : true;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        backgroundColor: '#fef2f2',
        border: '1px solid #fecaca',
        borderRadius: '8px',
        color: '#dc2626',
        minHeight: '200px',
      }}
    >
      <svg
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        style={{ marginBottom: '16px' }}
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>

      <h3 style={{ margin: '0 0 8px 0', fontSize: '18px' }}>
        波形渲染出错
      </h3>

      <p
        style={{
          margin: '0 0 16px 0',
          fontSize: '14px',
          color: '#991b1b',
          textAlign: 'center',
          maxWidth: '400px',
        }}
      >
        {error?.message || '发生未知错误'}
      </p>

      {isRecoverable && (
        <button
          onClick={onRetry}
          style={{
            padding: '8px 16px',
            backgroundColor: '#dc2626',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#b91c1c';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#dc2626';
          }}
        >
          重试
        </button>
      )}
    </div>
  );
}

/**
 * WorkerLifecycleManager - Worker 生命周期管理组件
 * 
 * 监控 Worker 状态，处理崩溃恢复。
 */
interface WorkerLifecycleManagerProps {
  children: ReactNode;
  maxRestarts?: number;
  onWorkerCrash?: () => void;
}

interface WorkerLifecycleState {
  restartCount: number;
  isCrashed: boolean;
}

export class WorkerLifecycleManager extends Component<
  WorkerLifecycleManagerProps,
  WorkerLifecycleState
> {
  constructor(props: WorkerLifecycleManagerProps) {
    super(props);
    this.state = {
      restartCount: 0,
      isCrashed: false,
    };
  }

  handleWorkerCrash = (): void => {
    const { maxRestarts = 3, onWorkerCrash } = this.props;
    const { restartCount } = this.state;

    console.warn(`[WorkerLifecycleManager] Worker crashed, restart count: ${restartCount}`);

    if (restartCount >= maxRestarts) {
      console.error('[WorkerLifecycleManager] Max restarts reached, falling back to direct mode');
      this.setState({ isCrashed: true });
      onWorkerCrash?.();
      return;
    }

    // 尝试重启
    this.setState(prev => ({
      restartCount: prev.restartCount + 1,
    }));
  };

  handleManualRestart = (): void => {
    this.setState({
      restartCount: 0,
      isCrashed: false,
    });
  };

  render(): ReactNode {
    const { children } = this.props;
    const { isCrashed, restartCount } = this.state;

    if (isCrashed) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            backgroundColor: '#fffbeb',
            border: '1px solid #fcd34d',
            borderRadius: '8px',
            color: '#d97706',
          }}
        >
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            style={{ marginBottom: '16px' }}
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>

          <h3 style={{ margin: '0 0 8px 0', fontSize: '18px' }}>
            Worker 模式不可用
          </h3>

          <p
            style={{
              margin: '0 0 16px 0',
              fontSize: '14px',
              color: '#92400e',
              textAlign: 'center',
            }}
          >
            Worker 已崩溃 {restartCount} 次，已自动切换到直接模式
          </p>

          <button
            onClick={this.handleManualRestart}
            style={{
              padding: '8px 16px',
              backgroundColor: '#d97706',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            尝试重新启用 Worker 模式
          </button>
        </div>
      );
    }

    return children;
  }
}

/**
 * MemoryMonitor - 内存监控组件
 * 
 * 监控内存使用情况，在内存不足时发出警告。
 */
interface MemoryMonitorProps {
  children: ReactNode;
  warningThreshold?: number; // MB
  criticalThreshold?: number; // MB
  onMemoryWarning?: (usage: number) => void;
  onMemoryCritical?: (usage: number) => void;
}

interface MemoryMonitorState {
  currentUsage: number;
  status: 'normal' | 'warning' | 'critical';
}

export class MemoryMonitor extends Component<
  MemoryMonitorProps,
  MemoryMonitorState
> {
  private intervalId: number | null = null;

  constructor(props: MemoryMonitorProps) {
    super(props);
    this.state = {
      currentUsage: 0,
      status: 'normal',
    };
  }

  componentDidMount(): void {
    // 每 5 秒检查一次内存
    this.intervalId = window.setInterval(() => {
      this.checkMemory();
    }, 5000);
  }

  componentWillUnmount(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
    }
  }

  private checkMemory(): void {
    const { warningThreshold = 500, criticalThreshold = 800 } = this.props;

    // 使用 performance.memory API（Chrome 专用）
    const memory = (performance as any).memory;
    if (!memory) return;

    const usedMB = memory.usedJSHeapSize / (1024 * 1024);
    let status: 'normal' | 'warning' | 'critical' = 'normal';

    if (usedMB > criticalThreshold) {
      status = 'critical';
      this.props.onMemoryCritical?.(usedMB);
    } else if (usedMB > warningThreshold) {
      status = 'warning';
      this.props.onMemoryWarning?.(usedMB);
    }

    this.setState({
      currentUsage: usedMB,
      status,
    });

    // 在控制台输出内存信息
    if (status !== 'normal') {
      console.warn(`[MemoryMonitor] Memory usage: ${usedMB.toFixed(2)}MB (${status})`);
    }
  }

  render(): ReactNode {
    const { children } = this.props;
    const { status, currentUsage } = this.state;

    return (
      <div style={{ position: 'relative' }}>
        {status !== 'normal' && (
          <div
            style={{
              position: 'absolute',
              top: '8px',
              right: '8px',
              padding: '4px 8px',
              borderRadius: '4px',
              fontSize: '12px',
              fontWeight: 'bold',
              zIndex: 1000,
              backgroundColor: status === 'critical' ? '#dc2626' : '#d97706',
              color: 'white',
            }}
          >
            内存: {currentUsage.toFixed(0)}MB
          </div>
        )}
        {children}
      </div>
    );
  }
}

export default WaveformErrorBoundary;
