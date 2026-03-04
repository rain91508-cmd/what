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
import type { TimeConfig } from '../../components/TabPanel';
import { lod0ToDisplay } from '../../components/TabPanel';

class WaveformRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  // Configuration
  private signalHeight = 20;
  private signalSpacing = 4;

  // Current time config for display
  private timeConfig: TimeConfig | null = null;

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

  // Set time config for display
  setTimeConfig(timeConfig: TimeConfig): void {
    this.timeConfig = timeConfig;
  }

  // Format time value - DisplayUnit (returns integer, no unit)
  // timeLod0: LoD0Unit value
  private formatTime(timeLod0: number): string {
    if (!this.timeConfig) return timeLod0.toString();
    const displayValue = lod0ToDisplay(timeLod0, this.timeConfig);
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

    const lod0Range = viewport.timeEnd - viewport.timeStart;

    // Calculate major step (for labels) - target ~100 pixels between labels
    const targetLabelCount = Math.max(2, Math.floor(width / 100));
    const majorStep = this.calculateNiceStep(lod0Range / targetLabelCount);

    // Minor step is 1/10 of major step
    const minorStep = majorStep / 10;

    // Calculate first and last major ticks
    const firstMajorTick = Math.ceil(viewport.timeStart / majorStep) * majorStep;
    const lastMajorTick = Math.floor(viewport.timeEnd / majorStep) * majorStep;

    // Draw minor ticks (no labels) - same color as major ticks
    this.ctx.strokeStyle = '#666';
    this.ctx.lineWidth = 1;

    const firstMinorTick = Math.ceil(viewport.timeStart / minorStep) * minorStep;
    const lastMinorTick = Math.floor(viewport.timeEnd / minorStep) * minorStep;

    for (let tick = firstMinorTick; tick <= lastMinorTick; tick += minorStep) {
      // Skip if this is a major tick
      if (Math.abs(tick % majorStep) < minorStep / 2) continue;

      const x = ((tick - viewport.timeStart) / lod0Range) * width;

      // Determine tick height: middle tick (5th) is longer (8px)
      const minorIndex = Math.round((tick % majorStep) / minorStep);
      const tickHeight = minorIndex === 5 ? 8 : 4;

      this.ctx.beginPath();
      this.ctx.moveTo(x, height - tickHeight);
      this.ctx.lineTo(x, height - 1);
      this.ctx.stroke();
    }

    // Draw major ticks (with labels)
    this.ctx.fillStyle = '#333';
    this.ctx.font = '11px Consolas, Monaco, monospace';
    this.ctx.strokeStyle = '#666';
    this.ctx.lineWidth = 1;

    for (let tick = firstMajorTick; tick <= lastMajorTick; tick += majorStep) {
      const x = ((tick - viewport.timeStart) / lod0Range) * width;

      // Draw major tick line
      this.ctx.beginPath();
      this.ctx.moveTo(x, height - 10);
      this.ctx.lineTo(x, height - 1);
      this.ctx.stroke();

      // Draw time label
      this.ctx.fillText(this.formatTime(tick), x + 2, height - 12);
    }
  }

  // Calculate a "nice" step value (1, 2, 5, 10, 20, 50, 100...)
  private calculateNiceStep(rawStep: number): number {
    if (rawStep <= 0) return 1;

    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const normalizedStep = rawStep / magnitude;

    if (normalizedStep < 1.5) return 1 * magnitude;
    if (normalizedStep < 3.5) return 2 * magnitude;
    if (normalizedStep < 7.5) return 5 * magnitude;
    return 10 * magnitude;
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
