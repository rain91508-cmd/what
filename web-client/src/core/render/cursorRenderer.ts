// ============================================
// Cursor Renderer - Lightweight overlay for cursor line
// ============================================
// 
// Design:
// - Separate layer from waveform rendering
// - Only draws cursor line (mouse line is handled by HTML layer)
// - Uses requestAnimationFrame for smooth updates
// - No heavy computation in render path

import type { TimeConfig } from '../../components/TabPanel';

interface CursorState {
  position: number;  // in LoD0Unit
  visible: boolean;
}

interface RenderState {
  cursor: CursorState;
  viewport: {
    timeStart: number;  // LoD0Unit
    timeEnd: number;    // LoD0Unit
  };
  timeConfig: TimeConfig;
  rulerHeight: number;
}

class CursorRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private animationId: number | null = null;
  private state: RenderState | null = null;
  private dirty = false;  // Flag to track if canvas needs full redraw

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

  // Full render - clears everything and redraws cursor
  private render(): void {
    if (!this.ctx || !this.canvas || !this.state) return;

    const { width, height } = this.canvas;
    const { cursor, viewport, rulerHeight } = this.state;

    // Clear entire canvas
    this.ctx.clearRect(0, 0, width, height);

    // Draw cursor line
    if (cursor.visible) {
      const cursorX = ((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * width;
      this.drawCursorLine(cursorX, rulerHeight, height);
    }
  }

  private drawCursorLine(x: number, top: number, bottom: number): void {
    if (!this.ctx) return;
    
    this.ctx.strokeStyle = '#ff00ff';
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([5, 5]);
    this.ctx.beginPath();
    this.ctx.moveTo(x, top);
    this.ctx.lineTo(x, bottom);
    this.ctx.stroke();
    this.ctx.setLineDash([]);
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
