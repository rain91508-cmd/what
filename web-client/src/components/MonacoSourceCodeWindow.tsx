import { useState, useEffect, useRef, useCallback } from 'react';
import Editor, { useMonaco, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { kdbManager } from '../modules/knowledge/kdbManager';
import type { editor } from 'monaco-editor';

// Configure monaco loader to use local files instead of CDN
loader.config({
  paths: {
    vs: '/node_modules/monaco-editor/min/vs'
  }
});

// Handle loader errors (ignore cancelation errors)
loader.init().catch((err) => {
  if (err?.type === 'cancelation') {
    return;
  }
  console.error('[Monaco] Loader error:', err);
});

interface MonacoSourceCodeWindowProps {
  moduleIndex: number | null;
  startFromLine1?: boolean;
  signalDeclarationLine?: number;
  moduleStartLine?: number;  // Module start line for graying out
  moduleEndLine?: number;    // Module end line for graying out
  moduleFullName?: string;   // Module full hierarchy name for display
  editorRef?: React.MutableRefObject<editor.IStandaloneCodeEditor | null>;
}

const modelCache = new Map<string, editor.ITextModel>();

export function MonacoSourceCodeWindow({ moduleIndex, startFromLine1, signalDeclarationLine, moduleStartLine, moduleEndLine, moduleFullName, editorRef: externalEditorRef }: MonacoSourceCodeWindowProps) {
  const [content, setContent] = useState<string>('');
  const [filePath, setFilePath] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [highlightLine, setHighlightLine] = useState<number | null>(null);
  const [moduleName, setModuleName] = useState<string>('');
  const internalEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const editorRef = externalEditorRef || internalEditorRef;
  const pendingHighlightRef = useRef<number | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const grayOutDecorationsRef = useRef<string[]>([]);
  const monacoInstance = useMonaco();

  // Widths for header sections (module info and file path)
  const [moduleInfoWidth, setModuleInfoWidth] = useState(300);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  // Apply highlight to a specific line
  const applyHighlight = useCallback((editor: editor.IStandaloneCodeEditor, line: number) => {
    if (!line) return;
    
    console.log('[MonacoSourceCodeWindow] Applying highlight to line:', line);
    
    // Reveal the line in center of view
    editor.revealLineInCenter(line);
    
    // Use Monaco's built-in line highlighting via selection
    editor.setSelection(new monaco.Range(line, 1, line, 1));
    
    // Clear previous decorations
    if (decorationsRef.current.length > 0) {
      editor.deltaDecorations(decorationsRef.current, []);
      decorationsRef.current = [];
    }
    
    // Add decoration for persistent highlighting
    decorationsRef.current = editor.deltaDecorations([], [
      {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: 'my-highlighted-line',
          linesDecorationsClassName: 'my-line-decoration',
        }
      }
    ]);
  }, []);

  // Apply gray out decoration for lines outside module range
  const applyGrayOutDecoration = useCallback((editor: editor.IStandaloneCodeEditor, startLine: number, endLine: number, totalLines: number) => {
    if (!startLine || !endLine || totalLines <= 0) return;

    console.log('[MonacoSourceCodeWindow] Applying gray out decoration:', startLine, '-', endLine, 'of', totalLines);

    // Clear previous gray out decorations
    if (grayOutDecorationsRef.current.length > 0) {
      editor.deltaDecorations(grayOutDecorationsRef.current, []);
      grayOutDecorationsRef.current = [];
    }

    const decorations: monaco.editor.IModelDeltaDecoration[] = [];

    // Gray out lines before module start - use className for whole line background
    if (startLine > 1) {
      decorations.push({
        range: new monaco.Range(1, 1, startLine - 1, 1),
        options: {
          isWholeLine: true,
          className: 'grayed-out-line',
          overviewRuler: {
            color: 'rgba(200, 200, 200, 0.3)',
            position: monaco.editor.OverviewRulerLane.Full
          }
        }
      });
    }

    // Gray out lines after module end - use className for whole line background
    if (endLine < totalLines) {
      decorations.push({
        range: new monaco.Range(endLine + 1, 1, totalLines, 1),
        options: {
          isWholeLine: true,
          className: 'grayed-out-line',
          overviewRuler: {
            color: 'rgba(200, 200, 200, 0.3)',
            position: monaco.editor.OverviewRulerLane.Full
          }
        }
      });
    }

    if (decorations.length > 0) {
      grayOutDecorationsRef.current = editor.deltaDecorations([], decorations);
      console.log('[MonacoSourceCodeWindow] Applied', decorations.length, 'gray out decorations');
    }
  }, []);

  // Handle drag start for resizing module info width
  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartX.current = e.clientX;
    dragStartWidth.current = moduleInfoWidth;
  };

  // Handle drag move
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const delta = e.clientX - dragStartX.current;
      const newWidth = Math.max(100, Math.min(600, dragStartWidth.current + delta));
      setModuleInfoWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, moduleInfoWidth]);

  // Handle editor mount
  const handleEditorDidMount = useCallback((editor: editor.IStandaloneCodeEditor) => {
    editorRef.current = editor;
    console.log('[MonacoSourceCodeWindow] Editor mounted');
    
    // Check if there's a pending highlight to apply
    setTimeout(() => {
      if (pendingHighlightRef.current) {
        applyHighlight(editor, pendingHighlightRef.current);
        pendingHighlightRef.current = null;
      } else if (highlightLine) {
        applyHighlight(editor, highlightLine);
      }
      
      // Apply gray out decoration if module range is set
      if (moduleStartLine && moduleEndLine && content) {
        const totalLines = content.split('\n').length;
        applyGrayOutDecoration(editor, moduleStartLine, moduleEndLine, totalLines);
      }
    }, 100);
  }, [highlightLine, applyHighlight, moduleStartLine, moduleEndLine, content, applyGrayOutDecoration]);

  // Load source file when module or highlight settings change
  useEffect(() => {
    loadSourceFile();
  }, [moduleIndex, startFromLine1, signalDeclarationLine]);

  // Register Verilog language
  useEffect(() => {
    if (monacoInstance) {
      if (!monacoInstance.languages.getLanguages().some(l => l.id === 'verilog')) {
        monacoInstance.languages.register({ id: 'verilog' });
        
        monacoInstance.languages.setMonarchTokensProvider('verilog', {
          keywords: [
            'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic',
            'integer', 'real', 'parameter', 'localparam', 'assign', 'always', 'initial',
            'begin', 'end', 'if', 'else', 'case', 'casex', 'casez', 'endcase', 'for',
            'while', 'repeat', 'forever', 'posedge', 'negedge', 'or', 'and', 'not',
            'function', 'endfunction', 'task', 'endtask', 'generate', 'endgenerate',
            'specify', 'endspecify', 'primitive', 'endprimitive', 'table', 'endtable',
            'defparam', 'disable', 'force', 'release', 'fork', 'join', 'wait',
            'event', 'typedef', 'enum', 'struct', 'union', 'packed', 'signed', 'unsigned'
          ],
          operators: [
            '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=',
            '&&', '||', '++', '--', '+', '-', '*', '/', '&', '|', '^', '%',
            '<<', '>>', '>>>', '<<<', '+=', '-=', '*=', '/=', '&=', '|=',
            '^=', '%=', '<<=', '>>=', '>>>=', '<<<=', '&&&'
          ],
          symbols: /[=><!~?:&|+\-*\/\^%]+/,
          tokenizer: {
            root: [
              [/[a-zA-Z_]\w*/, {
                cases: {
                  '@keywords': 'keyword',
                  '@default': 'identifier'
                }
              }],
              { include: '@whitespace' },
              [/@symbols/, {
                cases: {
                  '@operators': 'operator',
                  '@default': ''
                }
              }],
              [/\d*'[bBoOdDhH][\dxXzZ?]+/, 'number.binary'],
              [/[0-9]+/, 'number'],
              [/"[^"]*"/, 'string'],
              [/'[^']*'/, 'string'],
              [/[{}()\[\]]/, '@brackets'],
              [/[;,.]/, 'delimiter'],
              [/[`]\w+/, 'preprocessor'],
              [/\/\/.*$/, 'comment'],
              [/\/\*/, 'comment', '@comment'],
            ],
            whitespace: [
              [/[ \t\r\n]+/, 'white'],
            ],
            comment: [
              [/[^\/*]+/, 'comment'],
              [/\/\*/, 'comment', '@push'],
              ["\\*/", 'comment', '@pop'],
              [/[^\/*]/, 'comment']
            ]
          }
        });
        
        monacoInstance.languages.setLanguageConfiguration('verilog', {
          comments: {
            lineComment: '//',
            blockComment: ['/*', '*/']
          },
          brackets: [
            ['{', '}'],
            ['[', ']'],
            ['(', ')']
          ],
          autoClosingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '(', close: ')' },
            { open: '"', close: '"' },
            { open: "'", close: "'" }
          ],
          surroundingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '(', close: ')' },
            { open: '"', close: '"' },
            { open: "'", close: "'" }
          ]
        });
      }
    }
  }, [monacoInstance]);

  // Apply highlight when highlightLine changes and editor is ready
  useEffect(() => {
    if (editorRef.current && highlightLine) {
      applyHighlight(editorRef.current, highlightLine);
    } else if (highlightLine && !editorRef.current) {
      pendingHighlightRef.current = highlightLine;
    }
  }, [highlightLine, applyHighlight]);

  // Handle signalDeclarationLine change (when jumping to different signal in same file)
  useEffect(() => {
    if (editorRef.current && signalDeclarationLine && content) {
      console.log('[MonacoSourceCodeWindow] signalDeclarationLine changed to:', signalDeclarationLine);
      setHighlightLine(signalDeclarationLine);
      applyHighlight(editorRef.current, signalDeclarationLine);
    }
  }, [signalDeclarationLine, content, applyHighlight]);

  const loadSourceFile = async () => {
    console.log('[MonacoSourceCodeWindow] loadSourceFile called, moduleIndex:', moduleIndex);
    
    if (!moduleIndex) {
      setContent('');
      setFilePath('');
      setHighlightLine(null);
      setModuleName('');
      return;
    }

    try {
      setLoading(true);
      
      const module = kdbManager.getModuleById(moduleIndex);
      if (!module) {
        setContent('// Module not found');
        setFilePath('');
        setHighlightLine(null);
        setModuleName('');
        return;
      }
      
      setModuleName(module.name);
      console.log('[MonacoSourceCodeWindow] Loading source file for module:', module.name, 'fileId:', module.definition?.fileId);
      
      const sourceFile = await kdbManager.getSourceFile(module.definition.fileId);
      console.log('[MonacoSourceCodeWindow] Source file result:', sourceFile);
      
      if (sourceFile) {
        console.log('[MonacoSourceCodeWindow] Source file content length:', sourceFile.content?.length || 0);
        setContent(sourceFile.content || '');
        setFilePath(sourceFile.path || '');
        
        // Priority: signalDeclarationLine > startFromLine1 > module.startLine
        if (signalDeclarationLine) {
          console.log('[MonacoSourceCodeWindow] Jumping to signal declaration line:', signalDeclarationLine);
          setHighlightLine(signalDeclarationLine);
        } else if (startFromLine1) {
          console.log('[MonacoSourceCodeWindow] Opening from line 1 (file mode)');
          setHighlightLine(1);
        } else if (module.definition?.startLine) {
          console.log('[MonacoSourceCodeWindow] Highlight line:', module.definition.startLine);
          setHighlightLine(module.definition.startLine);
        } else {
          setHighlightLine(null);
        }
      } else {
        console.log('[MonacoSourceCodeWindow] Source file not found for fileId:', module.definition?.fileId);
        setContent(`// Source file not found for module: ${module.name}\n// File ID: ${module.definition?.fileId}`);
        setFilePath('');
        setHighlightLine(null);
      }
    } catch (err) {
      console.error('[MonacoSourceCodeWindow] Error loading source file:', err);
      setContent(`// Error loading source file: ${err}`);
      setFilePath('');
      setHighlightLine(null);
    } finally {
      setLoading(false);
    }
  };

  // Get or create model for the file
  const getModel = useCallback(() => {
    if (!monacoInstance || !filePath || !content) return null;
    
    if (modelCache.has(filePath)) {
      const cachedModel = modelCache.get(filePath)!;
      if (cachedModel.getValue() !== content) {
        cachedModel.setValue(content);
      }
      return cachedModel;
    }
    
    const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
    const model = monacoInstance.editor.createModel(
      content,
      'verilog',
      monacoInstance.Uri.parse(`file://${normalizedPath}`)
    );
    
    modelCache.set(filePath, model);
    
    if (modelCache.size > 10) {
      const firstKey = modelCache.keys().next().value as string;
      const oldModel = modelCache.get(firstKey);
      if (oldModel) {
        oldModel.dispose();
      }
      modelCache.delete(firstKey);
    }
    
    return model;
  }, [monacoInstance, filePath, content]);

  getModel();

  if (loading) {
    return (
      <div style={{ 
        height: '100%', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
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
        height: '100%', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        color: '#999',
        fontSize: '12px',
      }}>
        {moduleName ? `No source file for: ${moduleName}` : 'Select an instance to view source code'}
      </div>
    );
  }

  // Format long text to show rightmost part
  const formatLongText = (text: string, maxLen: number = 50): string => {
    if (!text || text.length <= maxLen) return text || '';
    return '...' + text.slice(-(maxLen - 3));
  };

  // Check if we should show module info (only when moduleFullName is provided and not from file tab)
  const showModuleInfo = moduleFullName && moduleStartLine && moduleEndLine;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        height: '22px',
        background: 'linear-gradient(to bottom, #e0e8f0, #c0d0e0)',
        borderBottom: '1px solid #a0b0c0',
        display: 'flex',
        alignItems: 'center',
        fontSize: '11px',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}>
        {/* Module info section (only show when module info is available) */}
        {showModuleInfo && (
          <>
            <div style={{
              width: moduleInfoWidth,
              minWidth: 100,
              maxWidth: 600,
              padding: '0 6px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              direction: 'rtl',
              textAlign: 'left',
            }} title={moduleFullName}>
              <span style={{ color: '#1976d2' }}>{moduleFullName}</span>
            </div>
            {/* Draggable splitter */}
            <div
              style={{
                width: '4px',
                cursor: 'col-resize',
                background: isDragging ? '#1976d2' : 'transparent',
                height: '100%',
              }}
              onMouseDown={handleDragStart}
              title="Drag to resize"
            />
            <div style={{ width: '1px', height: '100%', background: '#a0b0c0' }} />
          </>
        )}
        {/* File path section */}
        <div style={{
          flex: 1,
          padding: '0 6px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          direction: 'rtl',  // Show rightmost part
          textAlign: 'left',
        }} title={filePath}>
          {formatLongText(filePath, 60) || moduleName || 'Source Code'}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Editor
          height="100%"
          defaultLanguage="verilog"
          theme="vs"
          value={content}
          path={filePath || undefined}
          onMount={handleEditorDidMount}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 12,
            fontFamily: 'Consolas, Monaco, monospace',
            lineNumbers: 'on',
            renderLineHighlight: 'all',
            automaticLayout: true,
            folding: true,
            wordWrap: 'off',
            glyphMargin: true,
            selectOnLineNumbers: false,
          }}
        />
      </div>
      <style>{`
        .monaco-editor .my-highlighted-line {
          background-color: rgba(255, 235, 59, 0.3) !important;
        }
        .monaco-editor .my-line-decoration {
          background-color: #ff9800;
          width: 4px !important;
          margin-left: 2px;
          border-radius: 2px;
        }
        .monaco-editor .grayed-out-line {
          background-color: rgba(200, 200, 200, 0.25) !important;
        }
      `}</style>
    </div>
  );
}
