/**
 * WorkerTest - 测试 Worker 是否正确创建的组件
 * 
 * 使用方法：
 * 1. 在 App.tsx 中导入并添加 <WorkerTest />
 * 2. 打开浏览器控制台查看日志
 * 3. 点击"测试 Worker 模式"按钮
 */

import { useState, useCallback } from 'react';
import {
  createWaveformProvider,
  getEnvironmentSupport,
  logEnvironmentSupport,
} from '../wasm/waveformProviderFactory';

export function WorkerTest() {
  const [logs, setLogs] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const addLog = useCallback((message: string) => {
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()}: ${message}`]);
    console.log(message);
  }, []);

  const testWorkerMode = async () => {
    setIsLoading(true);
    addLog('=== 开始测试 Worker 模式 ===');

    // 1. 检查浏览器支持
    addLog('检查浏览器支持...');
    logEnvironmentSupport();
    const support = getEnvironmentSupport();
    addLog(`Worker 支持: ${support.worker ? '✓' : '✗'}`);
    addLog(`OffscreenCanvas 支持: ${support.offscreenCanvas ? '✓' : '✗'}`);
    addLog(`Worker 渲染模式: ${support.workerRender ? '✓' : '✗'}`);

    if (!support.workerRender) {
      addLog('❌ 浏览器不支持 Worker 渲染模式，测试结束');
      setIsLoading(false);
      return;
    }

    // 2. 尝试创建 Worker Provider
    addLog('尝试创建 Worker Provider...');
    try {
      const provider = await createWaveformProvider({
        useWorker: true,
        serverUrl: 'http://localhost:8080',
        waveformName: 'test',
        signalPrefix: '',
        spaceBeforeBracket: false,
        timeStamp: Date.now(),
      });

      addLog('✅ Worker Provider 创建成功');
      addLog(`Provider 类型: ${provider.constructor.name}`);

      // 3. 检查 Worker 是否在 Chrome DevTools 中可见
      addLog('');
      addLog('=== 如何在 Chrome DevTools 中查看 Worker ===');
      addLog('1. 打开 Chrome DevTools (F12)');
      addLog('2. 切换到 Sources 面板');
      addLog('3. 在右侧找到 "Threads" 或 "Workers" 部分');
      addLog('4. 应该能看到 "waveformWorker.ts" 或类似名称的 Worker');
      addLog('');
      addLog('或者:');
      addLog('1. 打开 Chrome DevTools');
      addLog('2. 切换到 Console 面板');
      addLog('3. 查看是否有 [WaveformWorker] 开头的日志');

      // 4. 清理
      addLog('');
      addLog('清理 Provider...');
      await provider.dispose();
      addLog('✅ 测试完成');
    } catch (error) {
      addLog(`❌ 错误: ${error instanceof Error ? error.message : String(error)}`);
      console.error('Worker test error:', error);
    }

    setIsLoading(false);
  };

  const testDirectMode = async () => {
    setIsLoading(true);
    addLog('=== 开始测试直接模式 ===');

    try {
      const provider = await createWaveformProvider({
        useWorker: false,
        serverUrl: 'http://localhost:8080',
        waveformName: 'test',
        signalPrefix: '',
        spaceBeforeBracket: false,
        timeStamp: Date.now(),
      });

      addLog('✅ Direct Provider 创建成功');
      addLog(`Provider 类型: ${provider.constructor.name}`);

      await provider.dispose();
      addLog('✅ 测试完成');
    } catch (error) {
      addLog(`❌ 错误: ${error instanceof Error ? error.message : String(error)}`);
    }

    setIsLoading(false);
  };

  const clearLogs = () => {
    setLogs([]);
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: '10px',
        right: '10px',
        width: '500px',
        maxHeight: '80vh',
        backgroundColor: '#f5f5f5',
        border: '1px solid #ccc',
        borderRadius: '8px',
        padding: '16px',
        overflow: 'auto',
        zIndex: 9999,
        fontFamily: 'monospace',
        fontSize: '12px',
      }}
    >
      <h3 style={{ margin: '0 0 12px 0' }}>Worker 测试面板</h3>

      <div style={{ marginBottom: '12px' }}>
        <button
          onClick={testWorkerMode}
          disabled={isLoading}
          style={{
            marginRight: '8px',
            padding: '8px 16px',
            backgroundColor: '#4CAF50',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: isLoading ? 'not-allowed' : 'pointer',
          }}
        >
          测试 Worker 模式
        </button>
        <button
          onClick={testDirectMode}
          disabled={isLoading}
          style={{
            marginRight: '8px',
            padding: '8px 16px',
            backgroundColor: '#2196F3',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: isLoading ? 'not-allowed' : 'pointer',
          }}
        >
          测试直接模式
        </button>
        <button
          onClick={clearLogs}
          style={{
            padding: '8px 16px',
            backgroundColor: '#f44336',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          清除日志
        </button>
      </div>

      {isLoading && (
        <div style={{ marginBottom: '12px', color: '#666' }}>加载中...</div>
      )}

      <div
        style={{
          backgroundColor: '#fff',
          border: '1px solid #ddd',
          borderRadius: '4px',
          padding: '8px',
          maxHeight: '400px',
          overflow: 'auto',
        }}
      >
        {logs.length === 0 ? (
          <div style={{ color: '#999' }}>点击按钮开始测试...</div>
        ) : (
          logs.map((log, index) => (
            <div
              key={index}
              style={{
                marginBottom: '4px',
                color: log.startsWith('❌')
                  ? '#f44336'
                  : log.startsWith('✅')
                  ? '#4CAF50'
                  : '#333',
              }}
            >
              {log}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default WorkerTest;
