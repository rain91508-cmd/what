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
import type { TimeUnit } from '../../components/TabPanel';
import { psToDisplayValue, TIME_UNIT_MULTIPLIERS } from '../../components/TabPanel';

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

  // Current time unit for display
  private currentTimeUnit: TimeUnit = 'ns';

  // Set time unit for display
  setTimeUnit(unit: TimeUnit): void {
    this.currentTimeUnit = unit;
  }

  // Format time value according to current unit (returns integer)
  private formatTime(timePs: number): string {
    const displayValue = psToDisplayValue(timePs, this.currentTimeUnit);
    return Math.round(displayValue).toString();
  }

  // Render waveform data
  render(
    segments: Segment[],
    viewport: Viewport,
    canvasWidth: number,
    canvasHeight: number,
    rulerHeight: number = 20
  ): void {
    if (!this.ctx || !this.canvas) {
      throw new Error('Renderer not initialized');
    }

    // Clear canvas
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const timeRange = viewport.timeEnd - viewport.timeStart;

    // Always draw time ruler at top
    this.drawTimeRuler(canvasWidth, rulerHeight, viewport);

    // Draw segments (below ruler)
    if (segments.length > 0) {
      this.ctx.lineWidth = 2;
      
      for (const seg of segments) {
        const x0 = ((seg.t0 - viewport.timeStart) / timeRange) * canvasWidth;
        const x1 = ((seg.t1 - viewport.timeStart) / timeRange) * canvasWidth;
        const yOffset = rulerHeight + seg.row * (this.signalHeight + this.signalSpacing);
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
  }

  private drawTimeRuler(width: number, height: number, viewport: Viewport): void {
    if (!this.ctx) return;

    // Draw ruler background
    this.ctx.fillStyle = '#f5f5f5';
    this.ctx.fillRect(0, 0, width, height);
    
    // Draw bottom border
    this.ctx.strokeStyle = '#c0c0c0';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, height - 1);
    this.ctx.lineTo(width, height - 1);
    this.ctx.stroke();

    // Draw time labels
    const timeRange = viewport.timeEnd - viewport.timeStart;
    const gridCount = 10;

    for (let i = 0; i <= gridCount; i++) {
      const x = (i / gridCount) * width;
      
      // Draw time label (formatted according to current unit)
      const timePs = viewport.timeStart + (i / gridCount) * timeRange;
      this.ctx.fillStyle = '#333';
      this.ctx.font = '11px Consolas, Monaco, monospace';
      this.ctx.fillText(this.formatTime(timePs), x + 2, height - 4);
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
