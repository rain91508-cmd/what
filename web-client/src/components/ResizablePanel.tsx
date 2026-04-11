import { useState, useRef, useCallback, ReactNode } from 'react';

interface ResizablePanelProps {
  children: ReactNode;
  direction: 'horizontal' | 'vertical';
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
  onResize?: (size: number) => void;
}

export function ResizablePanel({
  children,
  direction,
  defaultSize = 200,
  minSize = 100,
  maxSize = 500,
  onResize,
}: ResizablePanelProps) {
  const [size, setSize] = useState(defaultSize);
  const [isResizing, setIsResizing] = useState(false);
  const startPosRef = useRef(0);
  const startSizeRef = useRef(size);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY;
    startSizeRef.current = size;

    const handleMouseMove = (e: MouseEvent) => {
      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = currentPos - startPosRef.current;
      const newSize = Math.max(minSize, Math.min(maxSize, startSizeRef.current + delta));
      setSize(newSize);
      onResize?.(newSize);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [direction, minSize, maxSize, onResize, size]);

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    [direction === 'horizontal' ? 'width' : 'height']: size,
    [direction === 'horizontal' ? 'minWidth' : 'minHeight']: minSize,
    [direction === 'horizontal' ? 'maxWidth' : 'maxHeight']: maxSize,
    display: 'flex',
    flexDirection: direction === 'horizontal' ? 'column' : 'row',
    overflow: 'hidden',
  };

  const resizerStyle: React.CSSProperties = {
    position: 'absolute',
    [direction === 'horizontal' ? 'right' : 'bottom']: 0,
    [direction === 'horizontal' ? 'top' : 'left']: 0,
    [direction === 'horizontal' ? 'width' : 'height']: 4,
    [direction === 'horizontal' ? 'height' : 'width']: '100%',
    cursor: direction === 'horizontal' ? 'col-resize' : 'row-resize',
    backgroundColor: isResizing ? '#4080c0' : 'transparent',
    zIndex: 10,
  };

  return (
    <div style={containerStyle}>
      {children}
      <div
        style={resizerStyle}
        onMouseDown={handleMouseDown}
        title={direction === 'horizontal' ? 'Drag to resize width' : 'Drag to resize height'}
      />
    </div>
  );
}

// Splitter component for between panels
interface SplitterProps {
  direction: 'horizontal' | 'vertical';
  onDrag: (delta: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDoubleClick?: () => void;
  tooltip?: string;
  splitterRef?: React.RefObject<HTMLDivElement>;
}

export function Splitter({ direction, onDrag, onDragStart, onDragEnd, onDoubleClick, tooltip, splitterRef }: SplitterProps) {
  const [isDragging, setIsDragging] = useState(false);
  const internalRef = useRef<HTMLDivElement>(null);
  const actualSplitterRef = splitterRef || internalRef;
  const lastPosRef = useRef<number>(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    onDragStart?.();
    
    // Record the initial splitter position
    const splitter = actualSplitterRef.current;
    if (splitter) {
      const rect = splitter.getBoundingClientRect();
      lastPosRef.current = direction === 'horizontal' ? rect.left : rect.top;
    }

    const handleMouseMove = (e: MouseEvent) => {
      const splitter = actualSplitterRef.current;
      if (splitter) {
        // Get current splitter position
        const rect = splitter.getBoundingClientRect();
        const currentPos = direction === 'horizontal' ? rect.left : rect.top;
        
        // Calculate delta based on actual splitter movement
        const delta = currentPos - lastPosRef.current;
        
        // Update last position for next calculation
        lastPosRef.current = currentPos;
        
        // Only call onDrag if there was actual movement
        if (delta !== 0) {
          onDrag(delta);
        }
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      onDragEnd?.();
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [direction, onDrag, onDragStart, onDragEnd, actualSplitterRef]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDoubleClick?.();
  }, [onDoubleClick]);

  return (
    <div
      ref={splitterRef}
      className="panel-splitter"
      style={{
        [direction === 'horizontal' ? 'width' : 'height']: 8,
        [direction === 'horizontal' ? 'height' : 'width']: '100%',
        backgroundColor: isDragging ? '#b0b0b0' : '#e8e8e8',
        borderLeft: direction === 'horizontal' ? '1px solid #c0c0c0' : undefined,
        borderRight: direction === 'horizontal' ? '1px solid #c0c0c0' : undefined,
        borderTop: direction === 'vertical' ? '1px solid #c0c0c0' : undefined,
        borderBottom: direction === 'vertical' ? '1px solid #c0c0c0' : undefined,
        cursor: direction === 'horizontal' ? 'col-resize' : 'row-resize',
        flexShrink: 0,
        transition: 'background-color 0.2s',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      title={tooltip || (direction === 'horizontal' ? 'Drag to resize, double-click to toggle left panel' : 'Drag to resize')}
    >
      <div
        style={{
          [direction === 'horizontal' ? 'width' : 'height']: 3,
          [direction === 'horizontal' ? 'height' : 'width']: direction === 'horizontal' ? 30 : 30,
          backgroundColor: '#909090',
          borderRadius: 1.5,
        }}
      />
    </div>
  );
}
