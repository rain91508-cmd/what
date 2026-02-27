// ============================================
// Cursor Renderer - Lightweight overlay for cursor/mouse lines
// ============================================
// 
// Design:
// - Separate layer from waveform rendering
// - Only draws cursor and mouse lines
// - Uses requestAnimationFrame for smooth updates
// - No heavy computation in render path

import type { TimeUnit } from '../../components/TabPanel';

interface CursorState {
  position: number;  // in ps
  visible: boolean;
}

interface RenderState {
  cursor: CursorState;
  mouseX: number | null;
  viewport: {
    timeStart: number;
    timeEnd: number;
  };
  timeUnit: TimeUnit;
  containerWidth: number;
  rulerHeight: number;
}

class CursorRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private animationId: number | null = null;
  private state: RenderState | null = null;
  private dirty = false;  // Flag to track if canvas needs redraw

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    if (!this.ctx) {
      throw new Error('Failed to get Canvas 2D context for cursor');
    }

    // Start render loop
    this.startRenderLoop();

    console.log('[CursorRenderer] Initialized successfully');
  }

  isInitialized(): boolean {
    return this.canvas !== null && this.ctx !== null;
  }

  // Update render state (lightweight, just updates state)
  updateState(state: RenderState): void {
    this.state = state;
    this.dirty = true;
  }

  // Mark as dirty to trigger redraw
  markDirty(): void {
    this.dirty = true;
  }

  private startRenderLoop(): void {
    const loop = () => {
      // Only render when dirty flag is set
      if (this.state && this.dirty) {
        this.render();
        this.dirty = false;
      }
      this.animationId = requestAnimationFrame(loop);
    };
    this.animationId = requestAnimationFrame(loop);
  }

  private render(): void {
    if (!this.ctx || !this.canvas || !this.state) return;

    const { width, height } = this.canvas;
    const { cursor, mouseX, viewport, rulerHeight } = this.state;

    // Clear only the necessary area (transparent)
    this.ctx.clearRect(0, 0, width, height);

    // Draw cursor line (without time label - shown in info bar)
    if (cursor.visible) {
      const cursorX = ((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * width;
      
      // Draw line
      this.ctx.strokeStyle = '#ff00ff';
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([5, 5]);
      this.ctx.beginPath();
      this.ctx.moveTo(cursorX, rulerHeight);
      this.ctx.lineTo(cursorX, height);
      this.ctx.stroke();
      this.ctx.setLineDash([]);
    }

    // Draw mouse line (without time label - shown in info bar)
    if (mouseX !== null) {
      // Draw line only
      this.ctx.strokeStyle = '#00aa00';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(mouseX, rulerHeight);
      this.ctx.lineTo(mouseX, height);
      this.ctx.stroke();
    }
  }

  resize(width: number, height: number): void {
    if (this.canvas) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  dispose(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.canvas = null;
    this.ctx = null;
    this.state = null;
  }
}

// Singleton instance
export const cursorRenderer = new CursorRenderer();
export { CursorRenderer };
