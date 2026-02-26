// ============================================
// Canvas 2D Waveform Renderer (Simplified)
// ============================================
// 
// Architecture (per spec.md & hint2.md):
// - Canvas 2D API for waveform rendering
// - Simple and stable implementation
//
// Data Flow:
// OPFS -> WASM decode -> TypedArray -> Canvas 2D draw

import type { RenderChunk, Segment, Viewport } from '../../types';

class WaveformRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  // Configuration
  private signalHeight = 20;
  private signalSpacing = 4;

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    if (!this.ctx) {
      throw new Error('Failed to get Canvas 2D context');
    }

    console.log('[WaveformRenderer] Initialized successfully');
  }

  isInitialized(): boolean {
    return this.canvas !== null && this.ctx !== null;
  }

  // Render waveform data
  render(
    segments: Segment[],
    viewport: Viewport,
    canvasWidth: number,
    canvasHeight: number
  ): void {
    if (!this.ctx || !this.canvas) {
      throw new Error('Renderer not initialized');
    }

    // Clear canvas
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    if (segments.length === 0) {
      return;
    }

    const timeRange = viewport.timeEnd - viewport.timeStart;

    // Draw grid lines
    this.drawGrid(canvasWidth, canvasHeight, viewport);

    // Draw segments
    this.ctx.lineWidth = 2;
    
    for (const seg of segments) {
      const x0 = ((seg.t0 - viewport.timeStart) / timeRange) * canvasWidth;
      const x1 = ((seg.t1 - viewport.timeStart) / timeRange) * canvasWidth;
      const yOffset = seg.row * (this.signalHeight + this.signalSpacing);
      const y = yOffset + (seg.value > 0.5 ? 2 : this.signalHeight - 2);

      // Set color based on value
      if (seg.value < 0.25) {
        this.ctx.strokeStyle = '#000000'; // 0 - Black
      } else if (seg.value < 0.75) {
        this.ctx.strokeStyle = '#ff0000'; // X - Red
      } else if (seg.value < 1.25) {
        this.ctx.strokeStyle = '#00aa00'; // 1 - Green
      } else {
        this.ctx.strokeStyle = '#ff00ff'; // Z - Magenta
      }

      // Draw horizontal line
      this.ctx.beginPath();
      this.ctx.moveTo(x0, y);
      this.ctx.lineTo(x1, y);
      this.ctx.stroke();

      // Draw vertical edge (transition)
      if (x1 < canvasWidth) {
        const nextY = yOffset + (seg.value > 0.5 ? this.signalHeight - 2 : 2);
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y);
        this.ctx.lineTo(x1, nextY);
        this.ctx.stroke();
      }
    }
  }

  private drawGrid(width: number, height: number, viewport: Viewport): void {
    if (!this.ctx) return;

    // Draw time grid
    this.ctx.strokeStyle = '#e0e0e0';
    this.ctx.lineWidth = 1;

    const timeRange = viewport.timeEnd - viewport.timeStart;
    const gridCount = 10;

    for (let i = 0; i <= gridCount; i++) {
      const x = (i / gridCount) * width;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height);
      this.ctx.stroke();

      // Draw time label
      const time = viewport.timeStart + (i / gridCount) * timeRange;
      this.ctx.fillStyle = '#666';
      this.ctx.font = '10px sans-serif';
      this.ctx.fillText(time.toFixed(0), x + 2, 12);
    }

    // Draw signal separators
    for (let i = 0; i < 10; i++) {
      const y = i * (this.signalHeight + this.signalSpacing);
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(width, y);
      this.ctx.stroke();
    }
  }

  // Render from RenderChunk (GPU-ready data)
  renderChunk(
    _chunk: RenderChunk,
    _viewport: Viewport,
    canvasWidth: number,
    canvasHeight: number
  ): void {
    // For now, just clear the canvas
    if (!this.ctx || !this.canvas) return;
    
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  }

  // Clear canvas
  clear(): void {
    if (!this.ctx || !this.canvas) return;
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // Resize canvas
  resize(width: number, height: number): void {
    if (this.canvas) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  // Set signal height
  setSignalHeight(height: number): void {
    this.signalHeight = height;
  }

  // Set signal spacing
  setSignalSpacing(spacing: number): void {
    this.signalSpacing = spacing;
  }

  // Dispose resources
  dispose(): void {
    this.canvas = null;
    this.ctx = null;
  }
}

// Singleton instance
export const waveformRenderer = new WaveformRenderer();

export { WaveformRenderer };
