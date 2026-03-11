/**
 * Waveform Provider Factory
 *
 * 工厂函数，创建 Worker 模式的波形提供者。
 */

import {
  WaveformProviderInterface,
  FactoryConfig,
} from '../core/waveformProviderInterface';
import { WorkerWaveformProvider } from './workerWaveformProvider';

/**
 * 检查浏览器是否支持 Worker
 */
export function isWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * 检查浏览器是否支持 OffscreenCanvas
 */
export function isOffscreenCanvasSupported(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

/**
 * 检查浏览器是否完全支持 Worker 渲染模式
 */
export function isWorkerRenderSupported(): boolean {
  return isWorkerSupported() && isOffscreenCanvasSupported();
}

/**
 * 创建波形提供者
 *
 * 只支持 Worker 模式。
 *
 * @param config 工厂配置
 * @returns WaveformProviderInterface 实例
 */
export async function createWaveformProvider(
  config: FactoryConfig
): Promise<WaveformProviderInterface> {
  const { useWorker = true, ...providerConfig } = config;

  // 检查浏览器支持
  if (!isWorkerRenderSupported()) {
    throw new Error(
      '[Factory] Worker mode is required but not supported by browser. ' +
      'Please use a modern browser with Web Worker and OffscreenCanvas support.'
    );
  }

  // 使用 Worker 模式
  return createWorkerProvider(providerConfig);
}

/**
 * 创建 Worker 模式提供者
 *
 * @param config 提供者配置
 * @returns WorkerWaveformProvider 实例
 */
async function createWorkerProvider(
  config: Omit<FactoryConfig, 'useWorker'>
): Promise<WorkerWaveformProvider> {
  console.log('[Factory] Creating WorkerWaveformProvider (worker mode)');
  console.log('[Factory] Browser support:', getEnvironmentSupport());

  const provider = new WorkerWaveformProvider();
  await provider.initialize(config);

  console.log('[Factory] WorkerWaveformProvider created successfully');
  
  return provider;
}

/**
 * 获取当前环境的支持信息
 *
 * @returns 支持信息对象
 */
export function getEnvironmentSupport(): {
  worker: boolean;
  offscreenCanvas: boolean;
  workerRender: boolean;
} {
  return {
    worker: isWorkerSupported(),
    offscreenCanvas: isOffscreenCanvasSupported(),
    workerRender: isWorkerRenderSupported(),
  };
}

/**
 * 打印环境支持信息到控制台
 */
export function logEnvironmentSupport(): void {
  const support = getEnvironmentSupport();

  console.log('[Factory] Environment Support:');
  console.log(`  - Web Worker: ${support.worker ? '✓' : '✗'}`);
  console.log(`  - OffscreenCanvas: ${support.offscreenCanvas ? '✓' : '✗'}`);
  console.log(`  - Worker Render Mode: ${support.workerRender ? '✓' : '✗'}`);
}
