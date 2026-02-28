import { useState, useEffect } from 'react';
import { kdbManager } from '../modules/knowledge/kdbManager';
import type { Module } from '../types/kdb';

interface SourceCodeWindowProps {
  module: Module | null;
}

export function SourceCodeWindow({ module }: SourceCodeWindowProps) {
  const [content, setContent] = useState<string>('');
  const [filePath, setFilePath] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [highlightLine, setHighlightLine] = useState<number | null>(null);

  useEffect(() => {
    loadSourceFile();
  }, [module]);

  const loadSourceFile = async () => {
    console.log('[SourceCodeWindow] loadSourceFile called, module:', module);
    
    if (!module) {
      setContent('');
      setFilePath('');
      setHighlightLine(null);
      return;
    }

    try {
      setLoading(true);
      console.log('[SourceCodeWindow] Loading source file for module:', module.name, 'fileId:', module.fileId);
      
      // Get source file from KDB
      const sourceFile = await kdbManager.getSourceFile(module.fileId);
      console.log('[SourceCodeWindow] Source file result:', sourceFile);
      
      if (sourceFile) {
        console.log('[SourceCodeWindow] Source file content length:', sourceFile.content?.length || 0);
        setContent(sourceFile.content || '');
        setFilePath(sourceFile.path || '');
        
        // Set highlight line from declaration
        if (module.declaration?.line) {
          console.log('[SourceCodeWindow] Highlight line:', module.declaration.line);
          setHighlightLine(module.declaration.line);
        } else {
          setHighlightLine(null);
        }
      } else {
        console.log('[SourceCodeWindow] Source file not found for fileId:', module.fileId);
        setContent(`// Source file not found for module: ${module.name}\n// File ID: ${module.fileId}`);
        setFilePath('');
        setHighlightLine(null);
      }
    } catch (err) {
      console.error('[SourceCodeWindow] Error loading source file:', err);
      setContent(`// Error loading source file: ${err}`);
      setFilePath('');
      setHighlightLine(null);
    } finally {
      setLoading(false);
    }
  };

  const renderCode = () => {
    if (loading) {
      return (
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center', 
          height: '100%',
          color: '#999',
          fontSize: '12px',
        }}>
          Loading source file...
        </div>
      );
    }

    if (!content) {
      return (
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center', 
          height: '100%',
          color: '#999',
          fontSize: '12px',
        }}>
          {module ? `No source file for: ${module.name}` : 'Select an instance to view source code'}
        </div>
      );
    }

    const lines = content.split('\n');

    return (
      <div className="code-editor" style={{
        overflow: 'auto',
        height: '100%',
        fontFamily: 'Consolas, Monaco, monospace',
        fontSize: '12px',
        lineHeight: '1.5',
      }}>
        {lines.map((line, index) => {
          const lineNum = index + 1;
          const isHighlighted = highlightLine !== null && lineNum === highlightLine;
          
          return (
            <div 
              key={index} 
              className="code-line"
              style={{
                display: 'flex',
                backgroundColor: isHighlighted ? '#fff3cd' : 'transparent',
              }}
            >
              <div 
                className="code-line-number"
                style={{
                  minWidth: '40px',
                  padding: '0 8px',
                  textAlign: 'right',
                  color: '#999',
                  backgroundColor: '#f5f5f5',
                  borderRight: '1px solid #e0e0e0',
                  userSelect: 'none',
                  flexShrink: 0,
                }}
              >
                {lineNum}
              </div>
              <div 
                className="code-line-content"
                style={{
                  padding: '0 8px',
                  whiteSpace: 'pre',
                  color: '#333',
                }}
              >
                {line || ' '}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        height: '22px',
        background: 'linear-gradient(to bottom, #e0e8f0, #c0d0e0)',
        borderBottom: '1px solid #a0b0c0',
        display: 'flex',
        alignItems: 'center',
        padding: '0 6px',
        fontSize: '11px',
        fontWeight: 600,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {filePath ? `Source: ${filePath}` : module ? `Source: ${module.name}` : 'Source Code'}
      </div>
      {renderCode()}
    </div>
  );
}
