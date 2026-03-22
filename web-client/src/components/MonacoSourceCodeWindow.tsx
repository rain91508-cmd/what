import { useState, useEffect, useRef, useCallback } from 'react';
import Editor, { useMonaco, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { kdbManager } from '../modules/knowledge/kdbManager';
import type { editor } from 'monaco-editor';
import { LargeFileController, type FileMetadata } from '../services/largeFileController';
import type { WaveformProviderInterface, WasmSignalInfo, DisplayFormat } from '../core/waveformProviderInterface';
import { useWaveformProvider } from '../contexts/WaveformProviderContext';
import { buildWasmSignals, getSignalManager } from '../wasm/waveformProvider';
import { useT } from '../i18n';

// Configure monaco loader to use local files
// Local files are copied to public/monaco-editor during build
// Use relative path to work with base URL
const getMonacoUrl = () => {
  const base = import.meta.env.BASE_URL || '/';
  return `${base}monaco-editor/min/vs`.replace(/\/+/g, '/');
};

// Configure loader to use local files
loader.config({
  paths: {
    vs: getMonacoUrl()
  }
});

// Handle loader errors (ignore cancelation errors)
loader.init().catch((err) => {
  if (err?.type === 'cancelation') {
    return;
  }
  console.error('[Monaco] Loader error:', err);
});

// Global cache for editor state (key: moduleIndex_fileId)
interface EditorStateCache {
  viewState: editor.ICodeEditorViewState;
  expandedLines: number[];
  topLineNumber: number;
  cursorLineNumber: number | null;  // Mouse click line position
}
const editorStateCache = new Map<string, EditorStateCache>();

interface MonacoSourceCodeWindowProps {
  tabId: string;  // Tab ID for state caching
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
  // Signal value expansion props
  currentTime?: number;  // Current cursor time from waveform tab (LoD0Unit)
  signalRadixMap?: Map<string, DisplayFormat>;  // Signal radix map from waveform tab
  // Prefix settings for signal name conversion (from WaveformProviderContext)
  signalPrefix?: string;      // Local prefix (removed from local signal name)
  serverPrefix?: string;      // Server prefix (added to server signal name)
  spaceBeforeBracket?: boolean;  // Whether to add space before bracket in signal name
}

const modelCache = new Map<string, editor.ITextModel>();

function MonacoSourceCodeWindow({
  tabId,
  moduleIndex,
  displayModuleIndex,
  fileId,
  startFromLine1,
  signalDeclarationLine,
  moduleStartLine,
  moduleEndLine,
  moduleFullName,
  editorRef: externalEditorRef,
  onWordClick,
  currentTime,
  signalRadixMap,
  signalPrefix = '',
  serverPrefix = '',
  spaceBeforeBracket = false
}: MonacoSourceCodeWindowProps) {
  // Get shared provider from context
  const { provider, waveformName } = useWaveformProvider();
  const { t } = useT();
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

  // Signal value expansion state
  const expandedLines = useRef<Set<number>>(new Set());
  const viewZones = useRef<Record<number, string>>({});
  const loadingLines = useRef<Set<number>>(new Set());
  const expandDecorationsRef = useRef<string[]>([]);

  // Apply highlight to a specific line
  const applyHighlight = useCallback((editor: editor.IStandaloneCodeEditor, line: number, revealInCenter: boolean = true) => {
    if (!line) return;
    
    // Reveal the line in center of view only if requested
    if (revealInCenter) {
      editor.revealLineInCenter(line);
    }
    
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
    }
  }, []);

  // ==================== Signal Value Expansion Functions ====================

  // Extract identifiers from line content
  const extractIdentifiers = useCallback((lineContent: string): string[] => {
    const identifierRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
    const matches = lineContent.match(identifierRegex) || [];

    // Verilog/SystemVerilog keywords to exclude
    const keywords = new Set([
      'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic',
      'integer', 'real', 'parameter', 'localparam', 'assign', 'always', 'initial',
      'begin', 'end', 'if', 'else', 'case', 'casex', 'casez', 'endcase', 'for',
      'while', 'repeat', 'forever', 'posedge', 'negedge', 'or', 'and', 'not',
      'function', 'endfunction', 'task', 'endtask', 'generate', 'endgenerate',
      'specify', 'endspecify', 'primitive', 'endprimitive', 'table', 'endtable',
      'defparam', 'disable', 'force', 'release', 'fork', 'join', 'wait',
      'event', 'typedef', 'enum', 'struct', 'union', 'packed', 'signed', 'unsigned',
      'bit', 'byte', 'shortint', 'int', 'longint', 'time', 'shortreal', 'string',
      'chandle', 'virtual', 'void', 'const', 'var', 'automatic', 'static',
      'ref', 'extern', 'export', 'context', 'pure', 'import', 'export',
      'extends', 'implements', 'super', 'null', 'this', 'new', 'return',
      'break', 'continue', 'do', 'while', 'foreach', 'with', 'inside',
      'dist', 'rand', 'randc', 'constraint', 'solve', 'before', 'soft',
      'unique', 'priority', 'matches', 'tagged', 'accept_on', 'reject_on',
      'sync_accept_on', 'sync_reject_on', 'eventually', 'nexttime', 'always_ff',
      'always_comb', 'always_latch', 'assert', 'assume', 'cover', 'expect',
      'property', 'sequence', 'clocking', 'default', 'clocking', 'disable',
      'iff', 'strong', 'weak', 'until', 's_until', 'until_with', 's_until_with',
      'implies', 'iff', 'not', 'and', 'or', 'intersect', 'first_match',
      'throughout', 'within', 'ended', 'matched', 'triggered', 'posedge', 'negedge',
      'edge', 'deassign', 'release', 'wait', 'wait_order', 'alias', 'modport',
      'clockvar', 'input', 'output', 'inout', 'ref'
    ]);

    return [...new Set(matches.filter(id => !keywords.has(id)))];
  }, []);

  // Convert signal name for server query (apply prefix settings)
  const convertSignalNameForServer = useCallback((localFullName: string, localspaceBeforeBracket: boolean = spaceBeforeBracket): string => {
    // Step 1: Remove local prefix if present
    let serverName = localFullName;
    if (signalPrefix && localFullName.startsWith(signalPrefix)) {
      serverName = localFullName.slice(signalPrefix.length);
    }

    // Step 2: Add server prefix
    if (serverPrefix) {
      serverName = serverPrefix + serverName;
    }

    // Step 3: Handle space before bracket
    if (localspaceBeforeBracket) {
      // Add space before [ if not already present
      serverName = serverName.replace(/\[/g, ' [');
    }

    return serverName;
  }, [signalPrefix, serverPrefix, spaceBeforeBracket]);

  // Lookup signals in KDB
  const lookupSignals = useCallback(async (
    identifiers: string[],
    lookupModuleIndex: number
  ): Promise<Array<{
    globalId: number;
    shortName: string;
    fullName: string;
    width: number;
    msb: number;
    lsb: number;
  }>> => {
    const signals: Array<{
      globalId: number;
      shortName: string;
      fullName: string;
      width: number;
      msb: number;
      lsb: number;
    }> = [];

    for (const id of identifiers) {
      try {
        const globalId = await kdbManager.findSignalByName(lookupModuleIndex, id);
        if (globalId !== null) {
          const signal = kdbManager.buildSignal(globalId);
          if (signal) {
            const width = signal.msb !== signal.lsb
              ? signal.msb - signal.lsb + 1
              : 1;
            signals.push({
              globalId,
              shortName: signal.name,
              fullName: signal.fullName,
              width,
              msb: signal.msb,
              lsb: signal.lsb,
            });
          }
        }
      } catch (err) {
        console.warn('[MonacoSourceCodeWindow] Failed to lookup signal:', id, err);
      }
    }

    return signals;
  }, []);

  // Create ViewZone for signal values
  const createSignalValueViewZone = useCallback((
    editor: editor.IStandaloneCodeEditor,
    lineNumber: number,
    signalValues: Array<{
      shortName: string;
      fullName: string;
      value: string;
      width: number;
      msb: number;
      lsb: number;
      radix: DisplayFormat;
      valueType: string;
    }>
  ) => {
    const domNode = document.createElement('div');
    domNode.className = 'signal-value-zone';

    // Format time display
    const timeNs = currentTime !== undefined ? currentTime / 1000 : 0;
    const timeDisplay = `${timeNs.toFixed(3)} ns`;

    let html = `
      <div class="signal-zone-header">
        <span class="time-icon">⏱</span>
        <span class="time-label">${t('panel.source.cursorTime')}</span>
        <span class="time-value">${timeDisplay}</span>
      </div>
      <table class="signal-value-table">
        <thead>
          <tr>
            <th>Signal</th>
            <th>Value</th>
            <th>Width</th>
            <th>Radix</th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const sig of signalValues) {
      const valueClass = sig.valueType === 'has_x' ? 'value-x' :
                         sig.valueType === 'has_z' ? 'value-z' : 'value-normal';
      const widthStr = sig.width > 1 ? `[${sig.msb}:${sig.lsb}]` : '[0]';

      html += `
        <tr>
          <td class="signal-name" title="${sig.fullName}">${sig.shortName}</td>
          <td class="signal-value ${valueClass}">${sig.value}</td>
          <td class="signal-width">${widthStr}</td>
          <td class="signal-radix">${sig.radix}</td>
        </tr>
      `;
    }

    html += '</tbody></table>';
    domNode.innerHTML = html;

    // Calculate dynamic height - increased for better visibility
    const rowHeight = 28; // Increased from 22
    const headerHeight = 32; // Increased from 28
    const padding = 24; // Increased from 20 to accommodate bottom margin/padding
    const heightInPx = headerHeight + signalValues.length * rowHeight + padding;

    editor.changeViewZones(accessor => {
      // Remove existing zone if any
      if (viewZones.current[lineNumber]) {
        accessor.removeZone(viewZones.current[lineNumber]);
      }

      const zoneId = accessor.addZone({
        afterLineNumber: lineNumber,
        heightInPx,
        domNode,
      });

      viewZones.current[lineNumber] = zoneId;
    });
  }, [currentTime]);

  // Create ViewZone for error messages
  const createErrorViewZone = useCallback((
    editor: editor.IStandaloneCodeEditor,
    lineNumber: number,
    errorMessage: string
  ) => {
    const domNode = document.createElement('div');
    domNode.className = 'signal-value-zone';
    domNode.style.borderLeftColor = '#f44336'; // Red for errors

    const html = `
      <div style="padding: 8px 12px; color: #f44336; font-family: 'Consolas', monospace; font-size: 12px;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <span>⚠️</span>
          <span style="font-weight: 600;">Failed to load signal values</span>
        </div>
        <div style="color: #666;">${errorMessage}</div>
      </div>
    `;

    domNode.innerHTML = html;

    const heightInPx = 60; // Fixed height for error message

    editor.changeViewZones(accessor => {
      // Remove existing zone if any
      if (viewZones.current[lineNumber]) {
        accessor.removeZone(viewZones.current[lineNumber]);
      }

      const zoneId = accessor.addZone({
        afterLineNumber: lineNumber,
        heightInPx,
        domNode,
      });

      viewZones.current[lineNumber] = zoneId;
    });
  }, []);

  // Remove ViewZone
  const removeViewZone = useCallback((
    editor: editor.IStandaloneCodeEditor,
    lineNumber: number
  ) => {
    if (!viewZones.current[lineNumber]) return;

    editor.changeViewZones(accessor => {
      accessor.removeZone(viewZones.current[lineNumber]);
      delete viewZones.current[lineNumber];
    });
  }, []);

  // Update expand decorations (only within module range)
  const updateExpandDecorations = useCallback((
    editor: editor.IStandaloneCodeEditor,
    startLine?: number,
    endLine?: number
  ) => {
    const model = editor.getModel();
    if (!model) return;

    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const lineCount = model.getLineCount();

    // Determine range to show expand icons
    const effectiveStartLine = startLine || 1;
    const effectiveEndLine = endLine || lineCount;

    for (let line = 1; line <= lineCount; line++) {
      // Only show decoration if within module range
      const isInModuleRange = line >= effectiveStartLine && line <= effectiveEndLine;
      if (!isInModuleRange) continue;

      let className = 'signal-expand-icon';
      if (loadingLines.current.has(line)) {
        className = 'signal-loading-icon';
      } else if (expandedLines.current.has(line)) {
        className = 'signal-collapse-icon';
      }

      decorations.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          glyphMarginClassName: className,
        }
      });
    }

    expandDecorationsRef.current = editor.deltaDecorations(
      expandDecorationsRef.current,
      decorations
    );
  }, []);

  // Expand line to show signal values
  const expandLine = useCallback(async (
    editor: editor.IStandaloneCodeEditor,
    lineNumber: number
  ) => {
    const model = editor.getModel();
    if (!model) {
      console.warn('[Expand] No model available for line:', lineNumber);
      return;
    }

    if (!displayModuleIndex) {
      console.warn('[Expand] No displayModuleIndex available for line:', lineNumber);
      return;
    }

    // Get line content
    const lineContent = model.getLineContent(lineNumber);
    console.log('[Expand] Expanding line', lineNumber, 'content:', lineContent.substring(0, 50));

    // Extract identifiers
    const identifiers = extractIdentifiers(lineContent);
    if (identifiers.length === 0) {
      console.log('[Expand] No identifiers found in line:', lineNumber);
      return;
    }
    console.log('[Expand] Found identifiers:', identifiers);

    // Lookup signals in KDB
    const signals = await lookupSignals(identifiers, displayModuleIndex);
    if (signals.length === 0) {
      console.log('[Expand] No matching signals found for line:', lineNumber);
      return;
    }
    console.log('[Expand] Found signals:', signals.map(s => s.shortName));

    // Fetch values for each signal
    const signalValues: Array<{
      shortName: string;
      fullName: string;
      value: string;
      width: number;
      msb: number;
      lsb: number;
      radix: DisplayFormat;
      valueType: string;
    }> = [];

    // First, fetch data for all signals to populate the cache
    // This is necessary because getSignalValueAtTime reads from the cache
    // Use original signal names (not converted), let WASM handle the conversion
    let fetchError: string | null = null;
    let fetchSuccess = false;
    let lastSpaceBeforeBracket = false;
    
    if (provider && currentTime !== undefined && signals.length > 0 && waveformName) {
      try {
        // Build WasmSignalInfo array for all signals using ORIGINAL names
        // Use buildWasmSignals to get correct draw_sig_id from SignalIdManager
        const uiSignals = signals.map((sig) => ({
          global_id: sig.globalId,
          name: sig.fullName,
          row: 0,
          width: sig.width,
          displayFormat: (() => {
            const serverName = convertSignalNameForServer(sig.fullName);
            const mapFormat = signalRadixMap?.get(serverName);
            return mapFormat || (sig.width > 1 ? 'hex' as const : 'bin' as const);
          })(),
        }));

        // Build wasm signals with correct draw_sig_id from SignalIdManager
        const wasmSignalsWithDrawId = await buildWasmSignals(uiSignals, waveformName);
        
        // Convert to WasmSignalInfo format
        const allWasmSignals: WasmSignalInfo[] = wasmSignalsWithDrawId.map((sig, index) => ({
          globalId: sig.global_id,
          name: sig.name,
          row: sig.row,
          width: sig.width,
          drawSigId: sig.draw_sig_id,  // Use correct draw_sig_id from SignalIdManager
          displayFormat: sig.display_format === 'auto' ? undefined : sig.display_format as DisplayFormat,
        }));

        // Define a small viewport around the current time to fetch data
        // Use ±10 to ensure we get LoD0 (original data, no downsampling)
        const timeWindow = 10; // Fetch 10 units around current time (LoD0)
        const viewport = {
          startTime: Math.max(0, currentTime - timeWindow),
          endTime: currentTime + timeWindow,
          width: 800,
          height: 600,
        };

        const signalNames = allWasmSignals.map(s => s.name);

        // Helper function to check if error is 404 (signal not found)
        // Check both the error message and the cause (for wrapped errors)
        const is404Error = (err: any) => {
          const message = err?.message || '';
          const causeMessage = err?.cause?.message || '';
          return message.includes('404') || message.includes('SIGNAL_NOT_FOUND') ||
                 causeMessage.includes('404') || causeMessage.includes('SIGNAL_NOT_FOUND');
        };
        
        // Helper function to fetch with timeout and wait for WASM to be ready
        const fetchWithTimeout = async (sigNames: string[], spaceBeforeBracketSetting: boolean) => {
          const fetchPromise = provider.fetchAndGetSegments(
            sigNames,
            viewport,
            allWasmSignals,
            'hex',
            signalPrefix,
            serverPrefix,
            spaceBeforeBracketSetting
          );
          
          const timeoutPromise = new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Fetch timeout')), 5000)
          );
          
          const result = await Promise.race([fetchPromise, timeoutPromise]);
          
          // Wait for WASM to process the fetched data
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          return result;
        };

        // First attempt with current spaceBeforeBracket setting
        let is404 = false;
        lastSpaceBeforeBracket = spaceBeforeBracket;
        let hasActualData = false;  // Track if signal_data has actual data
        
        try {
          const segments = await fetchWithTimeout(signalNames, spaceBeforeBracket);
          
          if (segments && segments.length > 0) {
            fetchSuccess = true;
            hasActualData = true;
          } else {
            console.log('[Expand] Fetch returned empty segments');
            // Check if signal_data has actual data (transitions or buckets > 0)
            for (const sigName of signalNames) {
              const stats = await (provider as any).getSignalDataStats?.(sigName);
              if (stats && (stats.transitions > 0 || stats.buckets > 0)) {
                hasActualData = true;
                break;
              }
            }
            if (hasActualData) {
              fetchSuccess = true;
            }
          }
        } catch (err: any) {
          console.log(`[Expand] Fetch failed with current spaceBeforeBracket:`, err.message);
          
          if (is404Error(err)) {
            // 404 error means signal not found - don't retry, try opposite space immediately
            is404 = true;
            console.log('[Expand] 404 error detected - will try opposite spaceBeforeBracket');
          } else {
            // Timeout or other error - retry with current setting
            console.log('[Expand] Timeout or other error - will retry');
            const maxRetries = 2;
            for (let attempt = 1; attempt <= maxRetries && !fetchSuccess; attempt++) {
              try {
                console.log(`[Expand] Retrying (attempt ${attempt + 1}/${maxRetries + 1})...`);
                const retrySegments = await fetchWithTimeout(signalNames, spaceBeforeBracket);
                
                if (retrySegments && retrySegments.length > 0) {
                  fetchSuccess = true;
                  console.log(`[Expand] Retry succeeded: ${retrySegments.length} segments`);
                  break;
                }
              } catch (retryErr: any) {
                if (is404Error(retryErr)) {
                  is404 = true;
                  console.log('[Expand] 404 error on retry - will try opposite space');
                  break;
                }
                console.log(`[Expand] Retry failed (attempt ${attempt + 1}):`, retryErr.message);
                
                if (attempt < maxRetries) {
                  await new Promise(resolve => setTimeout(resolve, 100));
                }
              }
            }
          }
        }

        // If fetch failed (404, timeout, or empty), try with opposite spaceBeforeBracket
        const hasMultiBitSignals = signals.some(s => s.width > 1);
        if (!fetchSuccess && (is404 || hasMultiBitSignals || !fetchError)) {
          console.log(`[Expand] Trying opposite spaceBeforeBracket (is404=${is404}, hasMultiBit=${hasMultiBitSignals})`);
          let oppositeFetchSuccess = false;
          try {
            const oppositeSegments = await fetchWithTimeout(signalNames, !spaceBeforeBracket);
            
            if (oppositeSegments && oppositeSegments.length > 0) {
              console.log(`[Expand] Successfully fetched ${oppositeSegments.length} segments with opposite spaceBeforeBracket=${!spaceBeforeBracket} (LoD0)`);
              fetchSuccess = true;
              oppositeFetchSuccess = true;
              fetchError = null;
              lastSpaceBeforeBracket = !spaceBeforeBracket;  // Use opposite space for getSignalValueAtTime
            } else {
              console.log('[Expand] Fetch returned empty segments with opposite space setting');
              // Revert to original space setting for getSignalValueAtTime
              lastSpaceBeforeBracket = spaceBeforeBracket;
            }
          } catch (err: any) {
            console.log(`[Expand] Failed with opposite spaceBeforeBracket:`, err.message);
            // Revert to original space setting for getSignalValueAtTime
            lastSpaceBeforeBracket = spaceBeforeBracket;
          }
          
          // If opposite space fetch failed, use original space for getSignalValueAtTime
          if (!oppositeFetchSuccess) {
            console.log(`[Expand] Opposite space fetch failed, will use original spaceBeforeBracket=${spaceBeforeBracket} for getSignalValueAtTime`);
          }
        }
        
        if (!fetchSuccess && !fetchError) {
          fetchError = 'No data fetched';
        }
        
        console.log('[Expand] Fetch completed, success=' + fetchSuccess + ', error=' + fetchError);
      } catch (err: any) {
        console.warn('[MonacoSourceCodeWindow] Failed to fetch signal data:', err.message);
        fetchError = `Failed to fetch data: ${err.message}`;
      }
    }
    
    // Note: Don't return early on fetch error - continue to getSignalValueAtTime which has retry logic
    // The getSignalValueAtTime will handle the case where data is not yet available

    // Now get values for each signal
    for (const sig of signals) {
      // Calculate server name for display and radix lookup
      const serverName = convertSignalNameForServer(sig.fullName, lastSpaceBeforeBracket);
      
      // Get radix from waveform tab using server name, or use default
      const mapFormat = signalRadixMap?.get(serverName);
      const radix: DisplayFormat = mapFormat || (sig.width > 1 ? 'hex' : 'bin');

      try {
        if (provider && currentTime !== undefined && waveformName) {
          // Use ORIGINAL signal name for cache lookup
          // The cache is populated by fetchAndGetSegments using original names
          const originalSignalName = sig.fullName;
          
          // Build UI signal format for buildWasmSignals
          const uiSignal = {
            global_id: sig.globalId,
            name: originalSignalName,
            row: 0,
            width: sig.width,
            displayFormat: radix as 'hex' | 'bin' | 'oct' | 'dec',
          };
          
          // Build wasm signal with correct draw_sig_id from SignalIdManager
          const wasmSignalsWithDrawId = await buildWasmSignals([uiSignal], waveformName);
          
          // Convert to WasmSignalInfo format
          const wasmSignals: WasmSignalInfo[] = wasmSignalsWithDrawId.map((s) => ({
            globalId: s.global_id,
            name: s.name,
            row: s.row,
            width: s.width,
            drawSigId: s.draw_sig_id,  // Use correct draw_sig_id from SignalIdManager
            displayFormat: s.display_format === 'auto' ? undefined : s.display_format as DisplayFormat,
          }));

          // First attempt: use current spaceBeforeBracket setting
          let valueInfo = await provider.getSignalValueAtTime(
            originalSignalName,  // Use ORIGINAL name for cache lookup
            currentTime,
            wasmSignals,
            radix,
            signalPrefix,
            serverPrefix,
            lastSpaceBeforeBracket
          );

          // If no value found, retry with delay (WASM may still be processing fetched data)
          if (!valueInfo) {
            for (let retryCount = 0; retryCount < 10 && !valueInfo; retryCount++) {
              await new Promise(resolve => setTimeout(resolve, 500));
              valueInfo = await provider.getSignalValueAtTime(
                originalSignalName,
                currentTime,
                wasmSignals,
                radix,
                signalPrefix,
                serverPrefix,
                lastSpaceBeforeBracket
              );
              if (valueInfo) {
                break;
              }
            }
          }

          if (valueInfo) {
            // Handle both camelCase (displayStr) and snake_case (display_str) from WASM
            const displayStr = (valueInfo as any).displayStr || (valueInfo as any).display_str || '0x0';
            const valueType = (valueInfo as any).valueType || (valueInfo as any).value_type || 'normal';
            
            signalValues.push({
              ...sig,
              value: displayStr,
              radix,
              valueType: valueType,
            });
          }
        }
      } catch (err) {
        console.warn('[MonacoSourceCodeWindow] Failed to get value for', serverName, err);
      }
    }

    if (signalValues.length === 0) {
      console.log('[Expand] No signal values to display for line:', lineNumber);
      // Show error message if fetch had an error
      if (fetchError) {
        createErrorViewZone(editor, lineNumber, fetchError);
      }
      return;
    }

    // Create ViewZone
    console.log('[Expand] Creating ViewZone for line', lineNumber, 'with', signalValues.length, 'signals');
    createSignalValueViewZone(editor, lineNumber, signalValues);
    console.log('[Expand] Successfully expanded line:', lineNumber);
  }, [currentTime, displayModuleIndex, provider, signalRadixMap, extractIdentifiers, lookupSignals, createSignalValueViewZone]);

  // Toggle line expansion
  const toggleLineExpansion = useCallback(async (
    editor: editor.IStandaloneCodeEditor,
    lineNumber: number
  ) => {
    const isExpanded = expandedLines.current.has(lineNumber);

    if (isExpanded) {
      // Collapse
      removeViewZone(editor, lineNumber);
      expandedLines.current.delete(lineNumber);
      
      // Update cache immediately with a copy of the array
      const cacheKey = tabId;
      const existingState = editorStateCache.get(cacheKey);
      const expandedLinesCopy = Array.from(expandedLines.current);
      if (existingState) {
        editorStateCache.set(cacheKey, {
          ...existingState,
          expandedLines: expandedLinesCopy,
        });
        console.log('[State] Collapsed line', lineNumber, '- saved', expandedLinesCopy.length, 'expanded lines to cache');
      } else {
        // Cache doesn't exist yet, create it with expandedLines
        const topLineNumber = editor.getVisibleRanges()[0]?.startLineNumber || 1;
        const cursorPosition = editor.getPosition();
        const cursorLineNumber = cursorPosition?.lineNumber || null;
        const viewState = editor.saveViewState();
        
        editorStateCache.set(cacheKey, {
          viewState: viewState!,
          expandedLines: expandedLinesCopy,
          topLineNumber,
          cursorLineNumber,
        });
        console.log('[State] Collapsed line', lineNumber, '- created cache with', expandedLinesCopy.length, 'expanded lines');
      }
    } else {
      // Expand
      if (!provider) {
        alert('No waveform loaded. Please open a waveform file first to view signal values.');
        return;
      }

      if (currentTime === undefined) {
        alert('No cursor time available. Please open a waveform tab first.');
        return;
      }

      if (!displayModuleIndex) {
        return;
      }

      loadingLines.current.add(lineNumber);
      updateExpandDecorations(editor, moduleStartLine, moduleEndLine);

      try {
        await expandLine(editor, lineNumber);
        expandedLines.current.add(lineNumber);
        
        // Update cache immediately with a copy of the array
        const cacheKey = tabId;
        const existingState = editorStateCache.get(cacheKey);
        const expandedLinesCopy = Array.from(expandedLines.current);
        if (existingState) {
          editorStateCache.set(cacheKey, {
            ...existingState,
            expandedLines: expandedLinesCopy,
          });
          console.log('[State] Expanded line', lineNumber, '- saved', expandedLinesCopy.length, 'expanded lines to cache');
        } else {
          // Cache doesn't exist yet, create it with expandedLines
          const topLineNumber = editor.getVisibleRanges()[0]?.startLineNumber || 1;
          const cursorPosition = editor.getPosition();
          const cursorLineNumber = cursorPosition?.lineNumber || null;
          const viewState = editor.saveViewState();
          
          editorStateCache.set(cacheKey, {
            viewState: viewState!,
            expandedLines: expandedLinesCopy,
            topLineNumber,
            cursorLineNumber,
          });
          console.log('[State] Expanded line', lineNumber, '- created cache with', expandedLinesCopy.length, 'expanded lines');
        }
      } finally {
        loadingLines.current.delete(lineNumber);
        updateExpandDecorations(editor, moduleStartLine, moduleEndLine);
      }
    }
  }, [currentTime, displayModuleIndex, moduleStartLine, moduleEndLine, expandLine, removeViewZone, updateExpandDecorations, provider, tabId]);

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
    console.log('[State] Editor mounted for tabId:', tabId);

    // Restore state if available (use tabId as cache key for stable identity)
    const cacheKey = tabId;
    const savedState = editorStateCache.get(cacheKey);
    if (savedState) {
      console.log('[State] Found saved state for tabId:', cacheKey, {
        expandedLinesCount: savedState.expandedLines.length,
        topLineNumber: savedState.topLineNumber,
        cursorLineNumber: savedState.cursorLineNumber,
      });

      // Restore view state (includes scroll position and cursor position)
      editor.restoreViewState(savedState.viewState);

      // Restore expanded lines after a short delay to ensure editor is ready
      setTimeout(async () => {
        console.log('[State] Restoring', savedState.expandedLines.length, 'expanded lines...');
        
        // Restore each expanded line sequentially
        for (const lineNumber of savedState.expandedLines) {
          console.log('[State] Attempting to restore line:', lineNumber);
          await expandLine(editor, lineNumber);
          console.log('[State] Finished restoring line:', lineNumber);
        }
        
        console.log('[State] Successfully restored expanded lines:', savedState.expandedLines);

        // Update expandedLines ref to match restored state
        savedState.expandedLines.forEach(lineNumber => {
          expandedLines.current.add(lineNumber);
        });
        console.log('[State] Updated expandedLines ref:', Array.from(expandedLines.current));

        // Apply highlight line if exists (from Tab's signalDeclarationLine)
        // Don't reveal in center when restoring from cache (preserve scroll position)
        if (highlightLine) {
          applyHighlight(editor, highlightLine, false);
        }

        // Restore top line position (what was at the top of the viewport)
        if (savedState.topLineNumber) {
          editor.setScrollTop(editor.getTopForLineNumber(savedState.topLineNumber));
          console.log('[State] Restored top line position to:', savedState.topLineNumber);
        }

        // After restoration is complete, clear the cache
        // This ensures that subsequent double-clicks will scroll to the target
        setTimeout(() => {
          editorStateCache.delete(cacheKey);
          console.log('[State] Cleared cache after restoration for tabId:', cacheKey);
        }, 200);
      }, 100);
    } else {
      console.log('[State] No saved state found for tabId:', tabId);
      // No cached state, but have highlightLine - apply it directly
      // Reveal in center since there's no previous scroll position to preserve
      if (highlightLine) {
        setTimeout(() => {
          applyHighlight(editor, highlightLine, true);
        }, 100);
      }
    }

    // Handle single click - use onMouseDown
    const handleMouseDown = (e: monaco.editor.IEditorMouseEvent) => {
      if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return;

      const position = e.target.position;
      if (!position) return;

      const lineNumber = position.lineNumber;

      // Check if line is within module range (if module info is available)
      if (moduleStartLine && moduleEndLine) {
        if (lineNumber < moduleStartLine || lineNumber > moduleEndLine) {
          return; // Outside range, do nothing
        }
      }

      // Get the word at the clicked position
      const model = editor.getModel();
      if (!model) return;

      const wordInfo = model.getWordAtPosition(position);
      if (!wordInfo) return;

      const word = wordInfo.word;

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
          return; // Outside range, do nothing
        }
      }

      // Get the selected text (word)
      const model = editor.getModel();
      if (!model) return;

      const word = model.getValueInRange(selection);
      if (!word) return;

      // Call the callback for double click
      if (onWordClick) {
        onWordClick(word, lineNumber, true); // true = double click
      }
    };

    // Handle glyph margin click for signal value expansion
    const handleGlyphMarginClick = (e: monaco.editor.IEditorMouseEvent) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        return;
      }

      const lineNumber = e.target.position?.lineNumber;
      if (!lineNumber) return;

      // Check if line is within display module range (same logic as driver lookup)
      if (moduleStartLine && moduleEndLine) {
        if (lineNumber < moduleStartLine || lineNumber > moduleEndLine) {
          return; // Silently ignore clicks outside module range
        }
      }

      toggleLineExpansion(editor, lineNumber);
    };

    // Subscribe to events
    const disposable1 = editor.onMouseDown(handleMouseDown);
    const disposable2 = editor.onDidChangeCursorSelection(handleSelectionChange);
    const disposable4 = editor.onMouseDown(handleGlyphMarginClick);

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
    // Only reveal in center if no cached state (preserve scroll position when restoring)
    const hasCachedState = editorStateCache.has(tabId);
    setTimeout(() => {
      if (pendingHighlightRef.current) {
        applyHighlight(editor, pendingHighlightRef.current, !hasCachedState);
        pendingHighlightRef.current = null;
      } else if (highlightLine && !hasCachedState) {
        // Only apply highlight with scroll if no cached state
        // (highlight is already applied in the cache restoration logic above)
        applyHighlight(editor, highlightLine, true);
      }

      // Apply gray out decoration if module range is set
      if (moduleStartLine && moduleEndLine && totalLines > 0) {
        applyGrayOutDecoration(editor, moduleStartLine, moduleEndLine, totalLines);
      }

      // Initialize expand decorations (only within module range)
      updateExpandDecorations(editor, moduleStartLine, moduleEndLine);
    }, 100);

    // Cleanup function
    return () => {
      // Save state before unmounting (use tabId as cache key for stable identity)
      const cacheKey = tabId;
      const viewState = editor.saveViewState();
      
      // Use a copy of expandedLines array (already saved in cache by toggleLineExpansion)
      const expandedLinesArray = Array.from(expandedLines.current);
      
      const topLineNumber = editor.getVisibleRanges()[0]?.startLineNumber || 1;
      
      // Get cursor position (mouse click line)
      const cursorPosition = editor.getPosition();
      const cursorLineNumber = cursorPosition?.lineNumber || null;

      if (viewState) {
        editorStateCache.set(cacheKey, {
          viewState,
          expandedLines: expandedLinesArray,
          topLineNumber,
          cursorLineNumber,
        });
        console.log('[State] Saved state on unmount for tabId:', cacheKey, {
          expandedLines: expandedLinesArray,
          topLineNumber,
          cursorLineNumber,
        });
      } else {
        console.log('[State] Failed to save state (no viewState) for tabId:', cacheKey);
      }

      disposable1.dispose();
      disposable2.dispose();
      disposable3.dispose();
      disposable4.dispose();
    };
  }, [highlightLine, applyHighlight, moduleStartLine, moduleEndLine, content, applyGrayOutDecoration, onWordClick, windowStartLine, toggleLineExpansion, displayModuleIndex, fileId, tabId]);

  // Save editor state when component unmounts
  // Note: We don't rely on this for expandedLines since the ref may be reset on remount
  // expandedLines are saved immediately in toggleLineExpansion
  useEffect(() => {
    return () => {
      const editor = editorRef.current;
      if (!editor) {
        console.log('[State] Cannot save state on unmount - no editor for tabId:', tabId);
        return;
      }
      
      const cacheKey = tabId;
      const viewState = editor.saveViewState();
      
      // Use expandedLines ref directly (it's always up-to-date)
      const expandedLinesArray = Array.from(expandedLines.current);
      
      const topLineNumber = editor.getVisibleRanges()[0]?.startLineNumber || 1;
      const cursorPosition = editor.getPosition();
      const cursorLineNumber = cursorPosition?.lineNumber || null;

      if (viewState) {
        editorStateCache.set(cacheKey, {
          viewState,
          expandedLines: expandedLinesArray,
          topLineNumber,
          cursorLineNumber,
        });
        console.log('[State] Saved state on unmount (useEffect) for tabId:', cacheKey, {
          expandedLines: expandedLinesArray,
          topLineNumber,
          cursorLineNumber,
        });
      } else {
        console.log('[State] Failed to save state on unmount (no viewState) for tabId:', cacheKey);
      }
    };
  }, [tabId]);

  // Update cache when expandedLines changes
  // Note: This effect won't work because expandedLines is a Set (mutable reference)
  // We manually update cache in toggleLineExpansion instead
  // useEffect(() => {
  //   const cacheKey = tabId;
  //   const expandedLinesArray = Array.from(expandedLines.current);
  //   
  //   // Only update cache if it already exists (don't create new cache entries)
  //   const existingState = editorStateCache.get(cacheKey);
  //   if (existingState) {
  //     editorStateCache.set(cacheKey, {
  //       ...existingState,
  //       expandedLines: expandedLinesArray,
  //     });
  //     console.log('[MonacoSourceCodeWindow] Updated cache expandedLines:', expandedLinesArray);
  //   }
  // }, [tabId]);

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
  // Clear cache after applying highlight to ensure subsequent double-clicks work
  useEffect(() => {
    if (editorRef.current && highlightLine) {
      const cacheKey = tabId;
      const hasCachedState = editorStateCache.has(cacheKey);
      
      // Only reveal in center if no cached state (first time or after cache cleared)
      const shouldRevealInCenter = !hasCachedState;
      applyHighlight(editorRef.current, highlightLine, shouldRevealInCenter);
      
      // Don't clear cache here - it will be cleared by handleEditorDidMount after restoration
      // This prevents race condition where cache is cleared before expanded lines are restored
    } else if (highlightLine && !editorRef.current) {
      pendingHighlightRef.current = highlightLine;
    }
  }, [highlightLine, applyHighlight, tabId]);

  // Handle signalDeclarationLine change (when jumping to different signal in same file)
  // Always reveal in center when user explicitly jumps to a signal (double-click)
  useEffect(() => {
    if (editorRef.current && signalDeclarationLine && content) {
      setHighlightLine(signalDeclarationLine);
      // Always reveal in center for explicit jumps (double-click from hierarchy/signal panel)
      applyHighlight(editorRef.current, signalDeclarationLine, true);
    }
  }, [signalDeclarationLine, content, applyHighlight, tabId]);

  const loadSourceFile = async () => {
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
      setContent('');
      setFilePath('');
      setHighlightLine(null);
      setModuleName('');
      return;
    }

    try {
      setLoading(true);
      
      setModuleName(targetModuleName);
      
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
        
        const fileContent = await kdbManager.getSourceFileContent(targetFileId);
        
        if (fileContent !== null) {
          setContent(fileContent);
          setWindowStartLine(1);
          
          // Priority: signalDeclarationLine > startFromLine1 > module.startLine
          if (signalDeclarationLine) {
            setHighlightLine(signalDeclarationLine);
          } else if (startFromLine1) {
            setHighlightLine(1);
          } else if (targetModuleStartLine) {
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
        {moduleName ? `No source file for: ${moduleName}` : t('panel.source.selectInstance')}
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
        /* Signal value expansion styles */
        /* Default: hide expand icons */
        .monaco-editor .signal-expand-icon {
          background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="%23666" d="M6 4l4 4-4 4V4z"/></svg>') center no-repeat;
          cursor: pointer;
          opacity: 0;
          transition: opacity 0.2s;
        }
        /* Show expand icon on line hover */
        .monaco-editor .view-line:hover .signal-expand-icon {
          opacity: 0.5;
        }
        .monaco-editor .signal-expand-icon:hover {
          opacity: 1 !important;
        }
        /* Collapse icon is always visible when expanded */
        .monaco-editor .signal-collapse-icon {
          background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="%231976d2" d="M4 6l4 4 4-4H4z"/></svg>') center no-repeat;
          cursor: pointer;
          opacity: 1;
        }
        /* Loading icon is always visible when loading */
        .monaco-editor .signal-loading-icon {
          background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" stroke="%23999" stroke-width="2" fill="none" stroke-dasharray="20" stroke-dashoffset="0"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/></circle></svg>') center no-repeat;
          opacity: 1;
        }
        .monaco-editor .signal-value-zone {
          background: linear-gradient(to right, #f8f9fa, #ffffff);
          border-left: 3px solid #1976d2;
          border-radius: 0 4px 4px 0;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          margin: 4px 0 8px 20px;
          padding: 8px 12px 12px 12px;
          font-family: 'Consolas', 'Monaco', monospace;
          font-size: 12px;
        }
        .signal-zone-header {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 8px;
          padding-bottom: 6px;
          border-bottom: 1px solid #e0e0e0;
          color: #666;
          font-size: 11px;
        }
        .signal-zone-header .time-value {
          color: #1976d2;
          font-weight: 600;
        }
        .signal-value-table {
          width: 100%;
          border-collapse: collapse;
        }
        .signal-value-table th {
          text-align: left;
          padding: 4px 8px;
          color: #999;
          font-size: 10px;
          font-weight: normal;
          text-transform: uppercase;
        }
        .signal-value-table td {
          padding: 4px 8px;
        }
        .signal-name {
          color: #1976d2;
          font-weight: 500;
        }
        .signal-value {
          font-weight: 500;
          font-family: 'Consolas', monospace;
        }
        .signal-value.value-x {
          color: #ff5722;
        }
        .signal-value.value-z {
          color: #ff9800;
        }
        .signal-value.value-normal {
          color: #333;
        }
        .signal-width, .signal-radix {
          color: #666;
          font-size: 10px;
        }
      `}</style>
    </div>
  );
}

// Default export for React.lazy
export default MonacoSourceCodeWindow;
