import { useEffect, useRef, useState } from 'react';
import { waveformRenderer } from '../core/render/waveformRenderer';
import type { Viewport, Segment } from '../types';

export function WaveformWindow() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport] = useState<Viewport>({
    timeStart: 0,
    timeEnd: 1000,
    signalStart: 0,
    signalEnd: 10,
    pixelsPerTime: 1,
    pixelsPerSignal: 24,
  });

  useEffect(() => {
    const initRenderer = async () => {
      if (canvasRef.current) {
        await waveformRenderer.initialize(canvasRef.current);
        renderWaveform();
      }
    };

    initRenderer();

    return () => {
      waveformRenderer.dispose();
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current && canvasRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        canvasRef.current.width = width;
        canvasRef.current.height = height;
        waveformRenderer.resize(width, height);
        renderWaveform();
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const renderWaveform = () => {
    if (!canvasRef.current) return;

    const { width, height } = canvasRef.current;

    // Generate mock segments for demonstration
    const segments: Segment[] = [];
    const signalCount = 5;
    const timeStep = (viewport.timeEnd - viewport.timeStart) / 20;

    for (let signalIdx = 0; signalIdx < signalCount; signalIdx++) {
      let currentTime = viewport.timeStart;
      let currentValue = 0;

      while (currentTime < viewport.timeEnd) {
        const nextTime = currentTime + timeStep;
        segments.push({
          t0: currentTime,
          t1: nextTime,
          row: signalIdx,
          value: currentValue,
        });

        currentTime = nextTime;
        currentValue = currentValue === 0 ? 1 : 0;
      }
    }

    waveformRenderer.render(segments, viewport, width, height);
  };

  return (
    <div ref={containerRef} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="panel-header">
        Waveform
        <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#666' }}>
          Time: {viewport.timeStart} - {viewport.timeEnd}
        </span>
      </div>
      <div style={{ flex: 1, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          className="waveform-canvas"
          style={{ display: 'block' }}
        />
      </div>
    </div>
  );
}
