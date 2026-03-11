import { useState, useEffect, useRef, useCallback } from 'react';
import Editor, { useMonaco, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { kdbManager } from '../modules/knowledge/kdbManager';
import type { editor } from 'monaco-editor';
import { LargeFileController, type FileMetadata } from '../services/largeFileController';

// Configure monaco loader to use CDN first, fallback to local
// CDN is faster for users with good internet, local is more reliable for offline/air-gapped environments
const CDN_URL = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs';
const LOCAL_URL = '/node_modules/monaco-editor/min/vs';

// Try CDN first, fallback to local if CDN fails
async function configureMonacoLoader() {
  try {
    // Test if CDN is accessible by fetching a small file
    const testUrl = `${CDN_URL}/loader.js`;
    const response = await fetch(testUrl, { method: 'HEAD', mode: 'no-cors' });
    
    // If we get here (no error), assume CDN is available
    loader.config({
      paths: {
        vs: CDN_URL
      }
    });
    console.log('[Monaco] Using CDN version');
  } catch (error) {
    // CDN failed, use local
    loader.config({
      paths: {
        vs: LOCAL_URL
      }
    });
    console.log('[Monaco] CDN unavailable, using local version');
  }
}

// Configure loader
configureMonacoLoader();

// Handle loader errors (ignore cancelation errors)
loader.init().catch((err) => {
  if (err?.type === 'cancelation') {
    return;
  }
  console.error('[Monaco] Loader error:', err);
  // If CDN failed during init, try local fallback
  loader.config({
    paths: {
      vs: LOCAL_URL
    }
  });
  return loader.init();
});

interface MonacoSourceCodeWindowProps {
  moduleIndex: number | null;  // Selected module (for lookups)
  displayModuleIndex?: number | null;  // Displayed module (for loading source file, e.g., def_module)
  fileId?: number | null;      // File ID (for loading file directly when displayModuleIndex is 0)
  startFromLine1?: boolean;
  signalDeclarationLine?: number;
  moduleStartLine?: number;  // Module start line for graying out
  moduleEndLine?: number;    // Module end line for graying out
  moduleFullName?: string;   // Module full hierarchy name for display
  editorRef?: React.MutableRefObject<editor.IStandaloneCodeEditor | null>;
  onWordClick?: (word: string, lineNumber: number, isDoubleClick: boolean) => void;  // Click handler for word lookup
}

const modelCache = new Map<string, editor.ITextModel>();

export function MonacoSourceCodeWindow({ moduleIndex, displayModuleIndex, fileId, startFromLine1, signalDeclarationLine, moduleStartLine, moduleEndLine, moduleFullName, editorRef: externalEditorRef, onWordClick }: MonacoSourceCodeWindowProps) {
  const [content, setContent] = useState<string>('');
  const [filePath, setFilePath] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [highlightLine, setHighlightLine] = useState<number | null>(null);
  const [moduleName, setModuleName] = useState<string>('');
  const [totalLines, setTotalLines] = useState<number>(0);
  const [, setIsLargeFile] = useState(false);
  const [windowStartLine, setWindowStartLine] = useState(1);
  const internalEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const editorRef = externalEditorRef || internalEditorRef;
  const pendingHighlightRef = useRef<number | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const grayOutDecorationsRef = useRef<string[]>([]);
  const monacoInstance = useMonaco();
  const largeFileControllerRef = useRef<LargeFileController | null>(null);
  const isLargeFileModeRef = useRef(false);

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

    // Handle single click - use onMouseDown
    const handleMouseDown = (e: monaco.editor.IEditorMouseEvent) => {
      if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return;

      const position = e.target.position;
      if (!position) return;

      const lineNumber = position.lineNumber;

      // Check if line is within module range (if module info is available)
      if (moduleStartLine && moduleEndLine) {
        if (lineNumber < moduleStartLine || lineNumber > moduleEndLine) {
          console.log('[MonacoSourceCodeWindow] Click outside module range:', lineNumber);
          return; // Outside range, do nothing
        }
      }

      // Get the word at the clicked position
      const model = editor.getModel();
      if (!model) return;

      const wordInfo = model.getWordAtPosition(position);
      if (!wordInfo) return;

      const word = wordInfo.word;
      console.log('[MonacoSourceCodeWindow] Clicked word:', word, 'at line:', lineNumber);

      // Call the callback for single click
      if (onWordClick) {
        onWordClick(word, lineNumber, false); // false = single click
      }
    };

    // Handle double click - use onDidChangeCursorSelection (Monaco's built-in double click detection)
    const handleSelectionChange = (e: monaco.editor.ICursorSelectionChangedEvent) => {
      // Check if this is a double-click selection (selection is not empty and reason is 'word')
      if (e.reason !== monaco.editor.CursorChangeReason.Explicit) return;

      const selection = e.selection;
      if (selection.isEmpty()) return;

      // Check if it's a single line selection (word selection from double click)
      if (selection.startLineNumber !== selection.endLineNumber) return;

      const lineNumber = selection.startLineNumber;

      // Check if line is within module range (if module info is available)
      if (moduleStartLine && moduleEndLine) {
        if (lineNumber < moduleStartLine || lineNumber > moduleEndLine) {
          console.log('[MonacoSourceCodeWindow] Double-click outside module range:', lineNumber);
          return; // Outside range, do nothing
        }
      }

      // Get the selected text (word)
      const model = editor.getModel();
      if (!model) return;

      const word = model.getValueInRange(selection);
      if (!word) return;

      console.log('[MonacoSourceCodeWindow] Double-clicked word:', word, 'at line:', lineNumber);

      // Call the callback for double click
      if (onWordClick) {
        onWordClick(word, lineNumber, true); // true = double click
      }
    };

    // Subscribe to events
    const disposable1 = editor.onMouseDown(handleMouseDown);
    const disposable2 = editor.onDidChangeCursorSelection(handleSelectionChange);

    // Handle scroll for large file mode
    const disposable3 = editor.onDidScrollChange(async () => {
      if (!isLargeFileModeRef.current || !largeFileControllerRef.current) return;

      const visibleRanges = editor.getVisibleRanges();
      if (!visibleRanges || visibleRanges.length === 0) return;

      const visibleRange = visibleRanges[0];
      const visibleStart = visibleRange.startLineNumber;
      const visibleEnd = visibleRange.endLineNumber;

      // Adjust for window offset in large file mode
      const adjustedStart = visibleStart + windowStartLine - 1;
      const adjustedEnd = visibleEnd + windowStartLine - 1;

      await largeFileControllerRef.current.ensureWindow(adjustedStart, adjustedEnd);
    });

    // Check if there's a pending highlight to apply
    setTimeout(() => {
      if (pendingHighlightRef.current) {
        applyHighlight(editor, pendingHighlightRef.current);
        pendingHighlightRef.current = null;
      } else if (highlightLine) {
        applyHighlight(editor, highlightLine);
      }

      // Apply gray out decoration if module range is set
      if (moduleStartLine && moduleEndLine && totalLines > 0) {
        applyGrayOutDecoration(editor, moduleStartLine, moduleEndLine, totalLines);
      }
    }, 100);

    // Cleanup function
    return () => {
      disposable1.dispose();
      disposable2.dispose();
      disposable3.dispose();
    };
  }, [highlightLine, applyHighlight, moduleStartLine, moduleEndLine, content, applyGrayOutDecoration, onWordClick, windowStartLine]);

  // Load source file when module or highlight settings change
  useEffect(() => {
    loadSourceFile();

    // Cleanup large file controller when component unmounts or file changes
    return () => {
      if (largeFileControllerRef.current) {
        largeFileControllerRef.current.dispose();
        largeFileControllerRef.current = null;
      }
    };
  }, [moduleIndex, displayModuleIndex, startFromLine1, signalDeclarationLine]);

  // Re-apply gray out decoration when module range changes
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || totalLines <= 0) return;

    if (moduleStartLine && moduleEndLine) {
      applyGrayOutDecoration(editor, moduleStartLine, moduleEndLine, totalLines);
    } else {
      // Clear gray out decorations if no range specified
      if (grayOutDecorationsRef.current.length > 0) {
        editor.deltaDecorations(grayOutDecorationsRef.current, []);
        grayOutDecorationsRef.current = [];
      }
    }
  }, [moduleStartLine, moduleEndLine, totalLines, applyGrayOutDecoration]);

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
    console.log('[MonacoSourceCodeWindow] loadSourceFile called, moduleIndex:', moduleIndex, 'displayModuleIndex:', displayModuleIndex, 'fileId:', fileId);
    
    // Determine how to load the file:
    // 1. If displayModuleIndex > 0, use it to get module and fileId
    // 2. If fileId is provided (for file mode when displayModuleIndex is 0), use it directly
    // 3. Otherwise, try moduleIndex
    let targetFileId: number | null = null;
    let targetModuleName: string = '';
    let targetModuleStartLine: number | null = null;
    
    if (displayModuleIndex && displayModuleIndex > 0) {
      // Use displayModuleIndex to get module info
      const module = kdbManager.getModuleById(displayModuleIndex);
      if (module) {
        targetFileId = module.definition?.fileId || null;
        targetModuleName = module.name;
        targetModuleStartLine = module.definition?.startLine || null;
      }
    } else if (fileId) {
      // Use fileId directly (file mode)
      targetFileId = fileId;
      targetModuleName = '';
      targetModuleStartLine = null;
    } else if (moduleIndex) {
      // Fallback to moduleIndex
      const module = kdbManager.getModuleById(moduleIndex);
      if (module) {
        targetFileId = module.definition?.fileId || null;
        targetModuleName = module.name;
        targetModuleStartLine = module.definition?.startLine || null;
      }
    }
    
    if (!targetFileId) {
      console.log('[MonacoSourceCodeWindow] No fileId available');
      setContent('');
      setFilePath('');
      setHighlightLine(null);
      setModuleName('');
      return;
    }

    try {
      setLoading(true);
      
      setModuleName(targetModuleName);
      console.log('[MonacoSourceCodeWindow] Loading source file for fileId:', targetFileId, 'moduleName:', targetModuleName);
      
      // Get file info first
      const fileInfo = await kdbManager.getSourceFileInfo(targetFileId);
      if (!fileInfo) {
        throw new Error('File info not found');
      }
      
      setFilePath(fileInfo.path);
      setTotalLines(fileInfo.totalLines);
      
      // Check if this is a large file
      // For now, we use totalLines as a proxy for file size
      // In production, you should store actual file size in metadata
      const estimatedSize = fileInfo.totalLines * 50; // Rough estimate: 50 bytes per line
      const metadata: FileMetadata = {
        id: targetFileId,
        path: fileInfo.path,
        name: fileInfo.name,
        fullName: fileInfo.fullName,
        totalLines: fileInfo.totalLines,
        size: estimatedSize,
        kdbId: fileInfo.kdbId,
      };
      
      const isLarge = LargeFileController.isLargeFile(metadata);
      setIsLargeFile(isLarge);
      isLargeFileModeRef.current = isLarge;
      
      if (isLarge) {
        // Large file mode: use windowed loading
        console.log('[MonacoSourceCodeWindow] Large file detected, using windowed loading');
        
        // Clean up previous controller
        if (largeFileControllerRef.current) {
          largeFileControllerRef.current.dispose();
        }
        
        // Create new controller
        const controller = new LargeFileController({
          onContentChange: (content, startLine) => {
            setContent(content);
            setWindowStartLine(startLine);
          },
          onLoadingChange: (loading) => {
            setLoading(loading);
          },
          onError: (error) => {
            console.error('[MonacoSourceCodeWindow] Large file error:', error);
            setContent(`// Error loading large file: ${error}`);
          },
        });
        
        largeFileControllerRef.current = controller;
        
        // Initialize controller
        const success = await controller.init(metadata);
        if (!success) {
          throw new Error('Failed to initialize large file controller');
        }
        
        // Determine initial visible range
        let targetLine = 1;
        if (signalDeclarationLine) {
          targetLine = signalDeclarationLine;
        } else if (targetModuleStartLine) {
          targetLine = targetModuleStartLine;
        }
        
        // Load initial window around target line
        const visibleStart = Math.max(1, targetLine - 50);
        const visibleEnd = Math.min(fileInfo.totalLines, targetLine + 50);
        await controller.ensureWindow(visibleStart, visibleEnd);
        
        // Set highlight
        if (signalDeclarationLine) {
          setHighlightLine(signalDeclarationLine);
        } else if (targetModuleStartLine) {
          setHighlightLine(targetModuleStartLine);
        }
        
      } else {
        // Small file mode: load entire content
        console.log('[MonacoSourceCodeWindow] Small file, loading entire content');
        
        const fileContent = await kdbManager.getSourceFileContent(targetFileId);
        console.log('[MonacoSourceCodeWindow] Source file content length:', fileContent?.length || 0);
        
        if (fileContent !== null) {
          setContent(fileContent);
          setWindowStartLine(1);
          
          // Priority: signalDeclarationLine > startFromLine1 > module.startLine
          if (signalDeclarationLine) {
            console.log('[MonacoSourceCodeWindow] Jumping to signal declaration line:', signalDeclarationLine);
            setHighlightLine(signalDeclarationLine);
          } else if (startFromLine1) {
            console.log('[MonacoSourceCodeWindow] Opening from line 1 (file mode)');
            setHighlightLine(1);
          } else if (targetModuleStartLine) {
            console.log('[MonacoSourceCodeWindow] Highlight line:', targetModuleStartLine);
            setHighlightLine(targetModuleStartLine);
          } else {
            setHighlightLine(null);
          }
        } else {
          throw new Error('File content not found');
        }
      }
    } catch (err) {
      console.error('[MonacoSourceCodeWindow] Error loading source file:', err);
      setContent(`// Error loading source file: ${err}`);
      setFilePath('');
      setTotalLines(0);
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

  // Remove trailing slash from path
  const removeTrailingSlash = (path: string): string => {
    return path.replace(/\/$/, '');
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
            }} title={removeTrailingSlash(moduleFullName || '')}>
              <span style={{ color: '#1976d2' }}>{removeTrailingSlash(moduleFullName || '')}</span>
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
        }} title={removeTrailingSlash(filePath)}>
          {formatLongText(removeTrailingSlash(filePath), 60) || moduleName || 'Source Code'}
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
