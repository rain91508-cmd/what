// ============================================
// Cursor Renderer - Lightweight overlay for cursor/mouse lines
// ============================================
// 
// Design:
// - Separate layer from waveform rendering
// - Only draws cursor and mouse lines
// - Uses requestAnimationFrame for smooth updates
// - No heavy computation in render path
// - Incremental mouse line rendering for better performance

import type { TimeConfig } from '../../components/TabPanel';

interface CursorState {
  position: number;  // in LoD0Unit
  visible: boolean;
}

interface RenderState {
  cursor: CursorState;
  mouseX: number | null;
  viewport: {
    timeStart: number;  // LoD0Unit
    timeEnd: number;    // LoD0Unit
  };
  timeConfig: TimeConfig;
  containerWidth: number;
  rulerHeight: number;
}

class CursorRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private animationId: number | null = null;
  private state: RenderState | null = null;
  private dirty = false;  // Flag to track if canvas needs full redraw
  
  // For incremental mouse line rendering
  private lastMouseX: number | null = null;  // Last drawn mouse X position (in canvas coordinates)
  private mouseLineMargin = 2;  // Extra pixels to clear around mouse line

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

  // Update only mouse position (for incremental rendering)
  updateMousePosition(mouseX: number | null, containerWidth: number): void {
    if (!this.state || !this.canvas) return;
    
    const width = this.canvas.width;
    const newMouseX = mouseX !== null && containerWidth > 0 
      ? (mouseX / containerWidth) * width 
      : null;
    
    // If only mouse position changed, use incremental rendering
    if (!this.dirty && newMouseX !== null && this.lastMouseX !== null) {
      this.renderMouseLineIncremental(newMouseX);
    } else {
      // Need full redraw
      this.state = { ...this.state, mouseX };
      this.dirty = true;
    }
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

  // Full render - clears everything and redraws cursor + mouse
  private render(): void {
    if (!this.ctx || !this.canvas || !this.state) return;

    const { width, height } = this.canvas;
    const { cursor, mouseX, viewport, containerWidth, rulerHeight } = this.state;

    // Clear entire canvas
    this.ctx.clearRect(0, 0, width, height);

    // Draw cursor line
    if (cursor.visible) {
      const cursorX = ((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * width;
      this.drawCursorLine(cursorX, rulerHeight, height);
    }

    // Draw mouse line
    if (mouseX !== null && containerWidth > 0) {
      const scaledMouseX = (mouseX / containerWidth) * width;
      this.drawMouseLine(scaledMouseX, rulerHeight, height);
      this.lastMouseX = scaledMouseX;
    } else {
      this.lastMouseX = null;
    }
  }

  // Incremental mouse line render - only updates mouse line area
  private renderMouseLineIncremental(newMouseX: number): void {
    if (!this.ctx || !this.canvas || !this.state) return;

    const { height } = this.canvas;
    const { rulerHeight } = this.state;

    // Clear old mouse line area
    if (this.lastMouseX !== null) {
      const clearX = Math.max(0, Math.floor(this.lastMouseX) - this.mouseLineMargin);
      const clearWidth = this.mouseLineMargin * 2 + 1;
      this.ctx.clearRect(clearX, rulerHeight, clearWidth, height - rulerHeight);
    }

    // Draw new mouse line
    this.drawMouseLine(newMouseX, rulerHeight, height);
    
    // Redraw cursor line if it was in the cleared area
    if (this.state.cursor.visible) {
      const width = this.canvas.width;
      const { cursor, viewport } = this.state;
      const cursorX = ((cursor.position - viewport.timeStart) / (viewport.timeEnd - viewport.timeStart)) * width;
      
      // Check if cursor line was in the cleared area
      if (this.lastMouseX !== null && 
          Math.abs(cursorX - this.lastMouseX) <= this.mouseLineMargin) {
        this.drawCursorLine(cursorX, rulerHeight, height);
      }
    }

    this.lastMouseX = newMouseX;
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

  private drawMouseLine(x: number, top: number, bottom: number): void {
    if (!this.ctx) return;
    
    this.ctx.strokeStyle = '#00aa00';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(x, top);
    this.ctx.lineTo(x, bottom);
    this.ctx.stroke();
  }

  resize(width: number, height: number): void {
    if (this.canvas) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.lastMouseX = null;  // Reset on resize
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
    this.lastMouseX = null;
  }
}

// Singleton instance
export const cursorRenderer = new CursorRenderer();
export { CursorRenderer };
