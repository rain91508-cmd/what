/**
 * Render Scheduler
 *
 * 渲染调度器，仅管理 Render 命令的防抖和去重。
 * 其他命令直接发送，不经过此调度器。
 */

import { ViewportConfig, RenderTask } from './waveformProviderInterface';

/**
 * 渲染调度器
 *
 * 设计原则：
 * 1. 只有 render 命令需要防抖和去重
 * 2. 其他命令（set_viewport、get_value 等）直接发送，不经过此调度器
 * 3. 使用任务 ID 机制，自动跳过过期的 render 请求
 */
export class RenderScheduler {
  private worker: Worker;
  private currentTaskId = 0;
  private pendingTask: RenderTask | null = null;
  private isRendering = false;
  private debounceTimer: number | null = null;

  // 防抖延迟（毫秒）
  private readonly DEBOUNCE_DELAY = 50;

  constructor(worker: Worker) {
    this.worker = worker;
  }

  /**
   * 请求渲染（带防抖）
   *
   * 适用场景：拖动、缩放等连续操作
   * 快速连续调用时，只会在停止操作 50ms 后执行最后一次
   */
  requestRender(signalNames: string[], viewport: ViewportConfig): void {
    // 生成新任务 ID
    const taskId = ++this.currentTaskId;

    // 创建任务（复制参数）
    const task: RenderTask = {
      id: taskId,
      signalNames: [...signalNames],
      viewport: { ...viewport },
      timestamp: Date.now(),
    };

    // 取消之前的防抖定时器
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // 保存为待处理任务（覆盖之前的）
    this.pendingTask = task;

    // 设置防抖定时器
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.executeRender();
    }, this.DEBOUNCE_DELAY);
  }

  /**
   * 立即执行渲染（跳过防抖）
   *
   * 适用场景：
   * - 初始化首次渲染
   * - 强制刷新
   * - 用户明确触发的操作（如点击刷新按钮）
   */
  requestRenderImmediate(signalNames: string[], viewport: ViewportConfig): Promise<void> {
    // 取消防抖
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // 生成新任务
    const taskId = ++this.currentTaskId;
    this.pendingTask = {
      id: taskId,
      signalNames: [...signalNames],
      viewport: { ...viewport },
      timestamp: Date.now(),
    };

    return this.executeRender();
  }

  /**
   * 执行渲染任务
   *
   * 核心逻辑：
   * 1. 检查是否有待处理任务
   * 2. 检查是否正在渲染（避免并发）
   * 3. 检查任务是否过期（不是最新的）
   * 4. 发送命令到 Worker
   * 5. 完成后检查是否有新的待处理任务
   */
  private async executeRender(): Promise<void> {
    // 如果没有待处理任务，直接返回
    if (!this.pendingTask) return;

    // 如果正在渲染，等待完成后再处理新任务
    if (this.isRendering) {
      console.log('[RenderScheduler] Render in progress, will process new task after');
      return;
    }

    // 获取待处理任务并清空队列
    const task = this.pendingTask;
    this.pendingTask = null;

    // 关键：检查任务是否已过期（不是最新的）
    if (task.id !== this.currentTaskId) {
      console.log(`[RenderScheduler] Task ${task.id} is outdated, skipping`);
      return;
    }

    this.isRendering = true;

    try {
      console.log(`[RenderScheduler] Executing render task ${task.id}`);

      // 发送渲染命令到 Worker
      await this.sendRenderCommand(task);
    } catch (error) {
      console.error(`[RenderScheduler] Render task ${task.id} failed:`, error);
      this.onRenderError?.(error as Error);
    } finally {
      this.isRendering = false;

      // 检查是否有新的待处理任务
      if (this.pendingTask) {
        console.log('[RenderScheduler] Processing pending task');
        await this.executeRender();
      }
    }
  }

  /**
   * 发送渲染命令到 Worker
   */
  private sendRenderCommand(task: RenderTask): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = task.id;

      // 设置超时
      const timeout = setTimeout(() => {
        reject(new Error('Render timeout'));
      }, 30000);

      // 监听 Worker 响应
      const handler = (event: MessageEvent) => {
        const { type: responseType, id: responseId, data, error } = event.data;

        if (responseId !== id) return; // 不是本次请求的响应

        clearTimeout(timeout);
        this.worker.removeEventListener('message', handler);

        if (responseType === 'ERROR') {
          reject(new Error(error));
        } else {
          this.onRenderComplete?.(data);
          resolve();
        }
      };

      this.worker.addEventListener('message', handler);

      // 发送渲染命令
      this.worker.postMessage({
        type: 'RENDER_WAVEFORM',
        payload: {
          commandId: task.id,
          signalNames: task.signalNames,
          viewport: task.viewport,
        },
        id,
      });
    });
  }

  /**
   * 渲染完成回调
   */
  onRenderComplete?: (data: any) => void;

  /**
   * 渲染错误回调
   */
  onRenderError?: (error: Error) => void;

  /**
   * 取消所有待处理的渲染任务
   */
  cancelPending(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingTask = null;
    console.log('[RenderScheduler] Pending render tasks cancelled');
  }

  /**
   * 销毁调度器
   */
  destroy(): void {
    this.cancelPending();
  }
}

/**
 * 其他命令直接发送（不经过调度器）
 *
 * 这些命令轻量，无需防抖和去重：
 * - set_viewport: 只是设置状态
 * - set_canvas_dimensions: 只是设置状态
 * - get_signal_value_at_time: 查询操作，快速返回
 * - find_transitions_around: 查询操作，快速返回
 * - clear_cache: 清理操作
 */
export function sendDirectCommand<T>(
  worker: Worker,
  type: string,
  payload: any,
  timeout: number = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = Date.now() + Math.random();

    const timeoutId = setTimeout(() => {
      reject(new Error(`Command ${type} timeout`));
    }, timeout);

    const handler = (event: MessageEvent) => {
      const { type: responseType, id: responseId, data, error } = event.data;
      if (responseId !== id) return;

      clearTimeout(timeoutId);
      worker.removeEventListener('message', handler);

      if (responseType === 'ERROR') {
        reject(new Error(error));
      } else {
        resolve(data);
      }
    };

    worker.addEventListener('message', handler);
    worker.postMessage({ type, payload, id });
  });
}
