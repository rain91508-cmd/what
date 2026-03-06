// ============================================
// WHAT Web Client - Main Application
// ============================================
//
// Layout (参考DVE风格):
// ┌─────────────────────────────────────────────────────────────────┐
// │  Menu Bar                                                       │
// ├─────────────────────────────────────────────────────────────────┤
// │  Tool Bar                                                       │
// ├──────────┬──────────┬───────────────────────────────────────────┤
// │          │          │                                           │
// │ Hierarchy│ Signal   │   Source/Waveform (Tab)                   │
// │ (Design  │ List     │   ┌─────────────────────────────────────┐ │
// │ Browser) │          │   │ Source Code / Waveform              │ │
// │          │          │   │                                     │ │
// │          │          │   │                                     │ │
// │          │          │   └─────────────────────────────────────┘ │
// │          │          │                                           │
// ├──────────┴──────────┴───────────────────────────────────────────┤
// │  Message Window                                                 │
// └─────────────────────────────────────────────────────────────────┘

import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

// Core services
import { indexedDBManager } from './core/storage/indexedDB'
import { opfsManager } from './core/storage/opfs'
import { apiService } from './services/api'

// Modules
import { kdbManager } from './modules/knowledge/kdbManager'
import { waveManager } from './modules/wSignal'

// Utils
import { zoomIn, zoomOut } from './utils/zoomHelpers'
import { sanitizeTimeRange } from './utils/viewport'

// WASM
import { initWasm, createProvider, updateProviderSettings } from './wasm/waveformProvider'

// Components
import { MenuBar } from './components/MenuBar'
import { ToolBar } from './components/ToolBar'
import { DesignBrowser } from './components/DesignBrowser'
import { SignalPanel } from './components/SignalPanel'
import { TabPanel } from './components/TabPanel'
import { MonacoSourceCodeWindow } from './components/MonacoSourceCodeWindow'
import { WaveformWindow } from './components/WaveformWindow'
import { MessageWindow } from './components/MessageWindow'
import { ConnectionDialog } from './components/ConnectionDialog'
import { KdbSelectionDialog } from './components/KdbSelectionDialog'
import { WaveSelectionDialog } from './components/WaveSelectionDialog'
import { FileChangeDialog } from './components/FileChangeDialog'
import { MockDataDialog } from './components/MockDataDialog'
import { Splitter } from './components/ResizablePanel'
import { SessionDialog } from './components/SessionDialog'
import { SessionLoadingOverlay } from './components/SessionLoadingOverlay'

// Bookmark
import { bookmarkManager, type Bookmark } from './types/bookmark'

// Session
import { sessionManager } from './modules/session/sessionManager'
import type { Session } from './types/session'
import { SESSION_VERSION } from './types/session'

// Types
import type { Signal } from './types/kdb'
import type { WaveformInfo, ColumnWidths, TimeConfig, Tab, NavigationHistoryEntry } from './components/TabPanel'
import { initTimeConfig, parseTimeUnitStr } from './components/TabPanel'

// 默认时间配置
// DisplayUnitPerLoD0Unit = 1 表示 1 DisplayUnit = 1 LoD0Unit
// 这样时间标尺上显示的数值就是 LoD0Unit 的值
const DEFAULT_TIME_CONFIG: TimeConfig = initTimeConfig(1);

// 默认列宽配置
const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  hierarchy: 100,
  name: 150,
  value: 80,
  panel: 250,
};

function App() {
  const [initialized, setInitialized] = useState(false)
  const [connected, setConnected] = useState(false)
  const [showConnectionDialog, setShowConnectionDialog] = useState(false)
  const [showKdbSelectionDialog, setShowKdbSelectionDialog] = useState(false)
  const [showWaveSelectionDialog, setShowWaveSelectionDialog] = useState(false)
  const [messages, setMessages] = useState<string[]>([])
  const [kdbLoaded, setKdbLoaded] = useState(false)
  const [, setWaveforms] = useState<WaveformInfo[]>([])
  const [, setCurrentWaveform] = useState<string | null>(null)
  
  // File change detection state
  const [currentKdbName, setCurrentKdbName] = useState<string | null>(null)
  const [currentKdbChecksum, setCurrentKdbChecksum] = useState<string | null>(null)
  const [currentWaveName, setCurrentWaveName] = useState<string | null>(null)
  const [currentWaveChecksum, setCurrentWaveChecksum] = useState<string | null>(null)
  const [currentWaveSignalPrefix, setCurrentWaveSignalPrefix] = useState<string>('')  // Global signal prefix for current waveform
  const [currentWaveSignalSpaceBeforeBracket, setCurrentWaveSignalSpaceBeforeBracket] = useState<boolean>(false)  // Whether to add space before [msb:lsb]
  const [currentWaveTimeUnit, setCurrentWaveTimeUnit] = useState<number>(2)  // Waveform time unit enum (0=fs, 1=ps, 2=ns, etc.)
  const [currentWaveEndTime, setCurrentWaveEndTime] = useState<number>(1000000)  // Waveform end time in LoD0 units (time_unit)
  const [currentWaveDisplayUnitPerLoD0, setCurrentWaveDisplayUnitPerLoD0] = useState<number>(1)  // DisplayUnit per LoD0Unit
  const [currentWaveCustomRange, setCurrentWaveCustomRange] = useState<{ start: number; end: number } | undefined>(undefined)  // User custom time range
  const [autoCheckEnabled, setAutoCheckEnabled] = useState(false)
  const autoCheckIntervalRef = useRef<NodeJS.Timeout | null>(null)
  
  // Health check interval ref
  const healthCheckIntervalRef = useRef<NodeJS.Timeout | null>(null)
  
  // File change dialog state
  const [showFileChangeDialog, setShowFileChangeDialog] = useState(false)
  const [pendingFileChanges, setPendingFileChanges] = useState<{ kdbChanged: boolean; waveChanged: boolean }>({ kdbChanged: false, waveChanged: false })

  // Mock data state for waveform when no real wave file is loaded
  const [useMockData, setUseMockData] = useState(false)

  // Server URL for WASM provider
  const serverUrl = apiService.getBaseUrl()
  const [showMockDataDialog, setShowMockDataDialog] = useState(false)
  const [pendingMockSignal, setPendingMockSignal] = useState<Signal | null>(null)

  // Signal not found dialog state
  const [showSignalNotFoundDialog, setShowSignalNotFoundDialog] = useState(false)
  const [signalNotFoundInfo, setSignalNotFoundInfo] = useState<{
    attempted: string;
    matched: string;
    prefix: string;
    firstAvailable: string;
    success: boolean;
  } | null>(null)

  // Session dialog state
  const [showSessionDialog, setShowSessionDialog] = useState(false)
  const [sessionDialogMode, setSessionDialogMode] = useState<'save' | 'restore'>('save')
  const [isSessionLoading, setIsSessionLoading] = useState(false)
  const [sessionLoadingMessage, setSessionLoadingMessage] = useState('')
  
  // Global selected module index for hierarchy/signal panel (1-based)
  const [selectedModuleIndex, setSelectedModuleIndex] = useState<number | null>(null)

  // Info text for MenuBar (full hierarchy name)
  const [menuBarInfoText, setMenuBarInfoText] = useState<string>('')
  
  // Helper function to create default groups
  const createDefaultGroups = () => ({
    'root': {
      id: 'root',
      name: 'root',
      parentId: null as string | null,
      signals: [] as Array<Signal & { unique_id: number }>,
      expanded: true,
      children: ['group_1'],
    },
    'group_1': {
      id: 'group_1',
      name: 'Group_1',
      parentId: 'root' as string | null,
      signals: [] as Array<Signal & { unique_id: number }>,
      expanded: true,
      children: [] as string[],
    },
  });

  // Dynamic tabs state - each tab has its own data
  // Initialize with empty tabs - no default source or waveform tabs
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTab, setActiveTab] = useState<string>('')
  const tabCounter = useRef(1)
  
  // Global counter for waveform signal unique_id (starts from 1, increments forever)
  const nextWaveformSignalIdRef = useRef(1)

  // Ref for Monaco editor to get current cursor position
  const monacoEditorRef = useRef<any>(null)

  // Get current active tab data
  const activeTabData = tabs.find(t => t.id === activeTab)
  
  // Panel sizes
  const [hierarchyWidth, setHierarchyWidth] = useState(220)
  const [signalWidth, setSignalWidth] = useState(200)
  const [messageHeight, setMessageHeight] = useState(100)

  // Initialize application
  useEffect(() => {
    const init = async () => {
      try {
        // Initialize WASM module
        await initWasm()
        console.log('[App] WASM initialized')

        // Initialize storage layers
        await indexedDBManager.initialize()
        if (opfsManager.isSupported()) {
          await opfsManager.initialize()
        }

        // Initialize storage layers but don't auto-connect to server
        // Server starts in disconnected state - user must manually connect
        setConnected(false)
        addMessage('Application initialized - please connect to server')

        // Don't restore previous connection automatically
        // User can manually connect via Connect button

        setInitialized(true)
      } catch (error) {
        console.error('Initialization error:', error)
        addMessage(`Initialization error: ${error}`)
        setInitialized(true)
      }
    }

    init()
  }, [])

  const addMessage = useCallback((msg: string) => {
    setMessages(prev => {
      const newMessages = [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]
      // Keep only the last 100 messages
      if (newMessages.length > 100) {
        return newMessages.slice(-100)
      }
      return newMessages
    })
  }, [])

  // ============================================
  // Health Check Management
  // ============================================
  
  // Start periodic health check
  const startHealthCheck = useCallback(() => {
    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
    }
    
    healthCheckIntervalRef.current = setInterval(async () => {
      const isHealthy = await apiService.testConnection();
      
      if (!isHealthy && connected) {
        // Server disconnected
        setConnected(false);
        addMessage('⚠️ Server disconnected');
        // Clear API service configuration so requests fail
        apiService.clearConfig();
        // Clear KDB and waveform lists - content remains in IndexedDB/OPFS
        // but is no longer accessible in the UI until reconnect
        setKdbLoaded(false);
        setWaveforms([]);
        setCurrentWaveform(null);
        setCurrentKdbName(null);
        setCurrentKdbChecksum(null);
        setCurrentWaveName(null);
        setCurrentWaveChecksum(null);
        // Clear kdbManager state so DesignBrowser shows empty
        kdbManager.clear();
        // Note: Actual data remains in IndexedDB/OPFS for offline viewing
        // but UI lists are cleared
      } else if (isHealthy && !connected) {
        // Server reconnected
        setConnected(true);
        addMessage('✓ Server reconnected');
      }
    }, 5000); // Check every 5 seconds
  }, [connected, addMessage]);
  
  // Stop health check
  const stopHealthCheck = useCallback(() => {
    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
      healthCheckIntervalRef.current = null;
    }
  }, []);
  
  // Start/stop health check based on connection state
  useEffect(() => {
    if (connected) {
      startHealthCheck();
    } else {
      stopHealthCheck();
    }
    
    return () => {
      stopHealthCheck();
    };
  }, [connected, startHealthCheck, stopHealthCheck]);

  // ============================================
  // Source Navigation History Management
  // ============================================
  
  // Add a navigation entry to the active source tab
  const addNavigationEntry = useCallback((fileId: number, line: number, displayModuleIndex?: number) => {
    setTabs(prev => prev.map(tab => {
      if (tab.id !== activeTab || tab.type !== 'source') return tab;
      
      const history = tab.navigationHistory || [];
      const pointer = tab.navigationPointer || 0;
      
      // Create new entry
      const newEntry: NavigationHistoryEntry = {
        fileId,
        line,
        timestamp: Date.now(),
        displayModuleIndex  // Store display module for context restoration
      };
      
      // Remove entries after pointer (if any)
      const newHistory = history.slice(0, pointer);
      
      // Add new entry and increment pointer
      newHistory.push(newEntry);
      
      return {
        ...tab,
        navigationHistory: newHistory,
        navigationPointer: newHistory.length
      };
    }));
  }, [activeTab]);

  // ============================================
  // Unified Source Display Function
  // ============================================
  
  interface SetSourceDisplayOptions {
    displayModuleId?: number;    // Display module ID (for range lookup)
    selectedModuleId?: number;   // Selected module ID (for MenuBar info)
    startFromLine?: number;      // Line to highlight/jump to
    fileId?: number;             // File ID (fallback if displayModuleId invalid)
    addToHistory?: boolean;      // Whether to add to navigation history
  }
  
  // Unified function to set source display
  const setSourceDisplay = useCallback(async (options: SetSourceDisplayOptions) => {
    const { 
      displayModuleId, 
      selectedModuleId, 
      startFromLine = 1, 
      fileId: fallbackFileId,
      addToHistory = true 
    } = options;
    
    // Try to get display range from displayModuleId
    let displayRange = null;
    let effectiveFileId = fallbackFileId;
    
    if (displayModuleId) {
      displayRange = kdbManager.getDisplayRange(displayModuleId);
      if (displayRange) {
        effectiveFileId = displayRange.fileId;
      }
    }
    
    // If displayModuleId is 0 or invalid, but fileId is provided,
    // get the file's total lines to show entire file
    if (!displayRange && effectiveFileId) {
      // Use kdbManager to get total lines directly
      const totalLines = await kdbManager.getSourceFileTotalLines(effectiveFileId);
      if (totalLines > 0) {
        displayRange = {
          fileId: effectiveFileId,
          startLine: 1,
          endLine: totalLines
        };
      }
    }
    
    // Find or create source tab
    const existingSourceTab = tabs.find(t => t.type === 'source');
    
    if (existingSourceTab) {
      // Update existing tab
      setTabs(prev => prev.map(tab => 
        tab.id === existingSourceTab.id 
          ? { 
              ...tab, 
              // moduleIndex: use selectedModuleId if provided, otherwise displayModuleId (can be 0)
              moduleIndex: selectedModuleId ?? displayModuleId,
              // displayModuleIndex: use displayModuleId (can be 0 for file mode)
              displayModuleIndex: displayModuleId,
              // fileId: store for loading file directly when displayModuleIndex is 0
              fileId: effectiveFileId,
              signalDeclarationLine: startFromLine,
              // If display range valid, use it; otherwise undefined (show entire file)
              moduleStartLine: displayRange?.startLine,
              moduleEndLine: displayRange?.endLine,
              startFromLine1: !displayRange,  // Start from line 1 if no range
            } 
          : tab
      ));
      setActiveTab(existingSourceTab.id);
      
      // Add to history if requested
      if (addToHistory && effectiveFileId) {
        addNavigationEntry(effectiveFileId, startFromLine, displayModuleId);
      }
    } else {
      // Create new tab
      const newId = `source-${tabCounter.current++}`;
      const newTab: Tab = {
        id: newId,
        label: 'Source',
        type: 'source',
        moduleIndex: selectedModuleId ?? displayModuleId,
        displayModuleIndex: displayModuleId,
        fileId: effectiveFileId,  // Store for loading file directly when displayModuleIndex is 0
        signalDeclarationLine: startFromLine,
        moduleStartLine: displayRange?.startLine,
        moduleEndLine: displayRange?.endLine,
        startFromLine1: !displayRange,
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTab(newId);
      
      // Add to history after tab creation if requested
      if (addToHistory && effectiveFileId) {
        setTimeout(() => addNavigationEntry(effectiveFileId, startFromLine, displayModuleId), 0);
      }
    }
    
    return { displayRange, fileId: effectiveFileId };
  }, [activeTab, tabs, addNavigationEntry]);

  // Navigate to previous location in history
  const navigatePrevious = useCallback(async () => {
    const activeTabData = tabs.find(t => t.id === activeTab);
    if (!activeTabData || activeTabData.type !== 'source') return;
    
    const pointer = activeTabData.navigationPointer || 0;
    if (pointer <= 1) return; // Can't go back if at start
    
    const newPointer = pointer - 1;
    const history = activeTabData.navigationHistory || [];
    const entry = history[newPointer - 1]; // -1 because pointer is 1-based for next insertion
    
    if (!entry) return;
    
    // Use unified function to restore source display from history
    // Must provide fileId for navigation
    await setSourceDisplay({
      displayModuleId: entry.displayModuleIndex,
      startFromLine: entry.line,
      fileId: entry.fileId,      // Required for navigation
      addToHistory: false        // Don't add to history (already in history)
    });
    
    // Update navigation pointer
    setTabs(prev => prev.map(tab => 
      tab.id === activeTab 
        ? { ...tab, navigationPointer: newPointer }
        : tab
    ));
    
    addMessage(`Navigate back to line ${entry.line}`);
  }, [activeTab, tabs, setSourceDisplay, addMessage]);

  // Navigate to next location in history
  const navigateNext = useCallback(async () => {
    const activeTabData = tabs.find(t => t.id === activeTab);
    if (!activeTabData || activeTabData.type !== 'source') return;
    
    const pointer = activeTabData.navigationPointer || 0;
    const history = activeTabData.navigationHistory || [];
    
    if (pointer >= history.length) return; // Can't go forward if at end
    
    const newPointer = pointer + 1;
    const entry = history[newPointer - 1]; // -1 because pointer is 1-based for next insertion
    
    if (!entry) return;
    
    // Use unified function to restore source display from history
    // Must provide fileId for navigation
    await setSourceDisplay({
      displayModuleId: entry.displayModuleIndex,
      startFromLine: entry.line,
      fileId: entry.fileId,      // Required for navigation
      addToHistory: false        // Don't add to history (already in history)
    });
    
    // Update navigation pointer
    setTabs(prev => prev.map(tab => 
      tab.id === activeTab 
        ? { ...tab, navigationPointer: newPointer }
        : tab
    ));
    
    addMessage(`Navigate forward to line ${entry.line}`);
  }, [activeTab, tabs, setSourceDisplay, addMessage]);

  // Check if navigation is possible
  const canNavigatePrevious = useCallback(() => {
    const activeTabData = tabs.find(t => t.id === activeTab);
    if (!activeTabData || activeTabData.type !== 'source') return false;
    const pointer = activeTabData.navigationPointer || 0;
    return pointer > 1;
  }, [activeTab, tabs]);

  const canNavigateNext = useCallback(() => {
    const activeTabData = tabs.find(t => t.id === activeTab);
    if (!activeTabData || activeTabData.type !== 'source') return false;
    const pointer = activeTabData.navigationPointer || 0;
    const history = activeTabData.navigationHistory || [];
    return pointer < history.length;
  }, [activeTab, tabs]);

  // ============================================
  // Bookmark Management
  // ============================================
  
  // Add bookmark at current source position
  const handleAddBookmark = useCallback(async () => {
    // Check if there's an active source tab
    const activeSourceTab = tabs.find(t => t.type === 'source' && t.id === activeTab);
    
    if (!activeSourceTab) {
      addMessage('No active source tab to bookmark');
      return;
    }
    
    // Get current line and content from Monaco editor
    let lineNumber = 1;
    let lineContent = '';
    
    if (monacoEditorRef.current) {
      const editor = monacoEditorRef.current;
      const position = editor.getPosition();
      if (position) {
        lineNumber = position.lineNumber;
        // Use Monaco Editor API to get line content directly
        const model = editor.getModel();
        if (model) {
          lineContent = model.getLineContent(lineNumber).trim();
        }
      }
    } else if (activeSourceTab.signalDeclarationLine) {
      lineNumber = activeSourceTab.signalDeclarationLine;
    }
    
    // Check if line is within display range (if range is defined)
    if (activeSourceTab.moduleStartLine && activeSourceTab.moduleEndLine) {
      if (lineNumber < activeSourceTab.moduleStartLine || lineNumber > activeSourceTab.moduleEndLine) {
        addMessage(`Cannot bookmark: line ${lineNumber} is outside the current display range (${activeSourceTab.moduleStartLine}-${activeSourceTab.moduleEndLine})`);
        return;
      }
    }
    
    // Determine the context for bookmark
    // Use displayModuleIndex if available (>0), otherwise use fileId (for file mode)
    const displayModuleIndex = activeSourceTab.displayModuleIndex;
    const fileId = activeSourceTab.fileId;
    
    if (!displayModuleIndex && !fileId) {
      addMessage('Cannot bookmark: no module or file loaded');
      return;
    }
    
    // Create bookmark (name will be auto-generated as "Mark N")
    // Store displayModuleIndex as the module context for this bookmark
    // If displayModuleIndex is 0 or undefined, store 0 and fileId (file mode bookmark)
    const bookmark = bookmarkManager.addBookmark({
      moduleIndex: displayModuleIndex ?? 0,  // Store display module (0 for file mode)
      fileId: (displayModuleIndex === 0 || displayModuleIndex === undefined) ? (fileId ?? undefined) : undefined,  // Store fileId for file mode
      lineNumber: lineNumber,
      lineContent: lineContent,
    });
    
    addMessage(`Added bookmark: ${bookmark.name}`);
  }, [activeTab, tabs, addMessage]);
  
  // Handle bookmark click - jump to source
  const handleBookmarkClick = useCallback(async (bookmark: Bookmark) => {
    // Use stored moduleIndex from bookmark as both selected and display module
    const moduleIndex = bookmark.moduleIndex;
    
    // If moduleIndex is 0, it's a file mode bookmark, use fileId
    const isFileMode = moduleIndex === 0;
    
    // Use unified function to set source display
    await setSourceDisplay({
      displayModuleId: moduleIndex,  // 0 for file mode
      selectedModuleId: moduleIndex,
      startFromLine: bookmark.lineNumber,
      fileId: isFileMode ? bookmark.fileId : undefined,  // Provide fileId for file mode
      addToHistory: true
    });
    
    addMessage(`Jump to bookmark: ${bookmark.name}`);
  }, [setSourceDisplay, addMessage]);

  // Handle driver click - jump to driver signal location
  const handleDriverClick = useCallback(async (driver: { signalGlobalId: number; line: number; fileId?: number }) => {
    // Build the driver signal to get its information
    const signal = kdbManager.buildSignal(driver.signalGlobalId);
    if (!signal) {
      addMessage(`Driver signal not found: ${driver.signalGlobalId}`);
      return;
    }
    
    // Get the parent module of the driver signal
    const parentModuleId = signal.parentModuleId;
    const parentModule = kdbManager.getModuleById(parentModuleId);
    
    if (!parentModule) {
      addMessage(`Parent module not found for driver signal: ${signal.name}`);
      return;
    }
    
    // Get file ID from parent module or use provided fileId
    const fileId = driver.fileId || parentModule.definition?.fileId;
    
    if (!fileId) {
      addMessage(`File not found for driver signal: ${signal.name}`);
      return;
    }
    
    // Use unified function to set source display
    // Display module is the driver's parent module
    await setSourceDisplay({
      displayModuleId: parentModuleId,
      selectedModuleId: parentModuleId,
      startFromLine: driver.line,
      fileId: fileId,
      addToHistory: true
    });
    
    addMessage(`Jump to driver: ${signal.name} (line ${driver.line})`);
  }, [setSourceDisplay, addMessage]);

  // ============================================
  // File Change Detection
  // ============================================

  // Manual refresh check - check if current KDB or waveform has changed
  const handleRefreshCheck = useCallback(async () => {
    addMessage('Checking for file changes...');
    
    let kdbChanged = false;
    let waveChanged = false;
    
    // Check KDB
    if (currentKdbName && currentKdbChecksum) {
      const kdbResult = await apiService.checkKdbChanged(currentKdbName, currentKdbChecksum);
      if (kdbResult.changed) {
        addMessage(`⚠️ KDB "${currentKdbName}" has changed on server!`);
        kdbChanged = true;
      } else {
        addMessage(`✓ KDB "${currentKdbName}" is up to date`);
      }
    } else if (currentKdbName) {
      addMessage(`ℹ️ KDB "${currentKdbName}" loaded (no checksum stored)`);
    }
    
    // Check Waveform
    if (currentWaveName && currentWaveChecksum) {
      const waveResult = await apiService.checkWaveformChanged(currentWaveName, currentWaveChecksum);
      if (waveResult.changed) {
        addMessage(`⚠️ Waveform "${currentWaveName}" has changed on server!`);
        waveChanged = true;
      } else {
        addMessage(`✓ Waveform "${currentWaveName}" is up to date`);
      }
    } else if (currentWaveName) {
      addMessage(`ℹ️ Waveform "${currentWaveName}" loaded (no checksum stored)`);
    }
    
    const hasChanges = kdbChanged || waveChanged;
    
    if (!currentKdbName && !currentWaveName) {
      addMessage('ℹ️ No KDB or waveform currently loaded');
    } else if (!hasChanges && (currentKdbName || currentWaveName)) {
      addMessage('✓ All files are up to date');
    }
    
    // Return detailed change info
    return { hasChanges, kdbChanged, waveChanged };
  }, [currentKdbName, currentKdbChecksum, currentWaveName, currentWaveChecksum, addMessage]);

  // Toggle auto check
  const handleToggleAutoCheck = useCallback(() => {
    setAutoCheckEnabled(prev => {
      const newValue = !prev;
      if (newValue) {
        addMessage('Auto check enabled (checking every 5 seconds)');
      } else {
        addMessage('Auto check disabled');
      }
      return newValue;
    });
  }, [addMessage]);

  // Auto check effect
  useEffect(() => {
    if (autoCheckEnabled) {
      // Start auto check interval (5 seconds)
      autoCheckIntervalRef.current = setInterval(async () => {
        const result = await handleRefreshCheck();
        if (result.hasChanges) {
          // Show confirmation dialog
          setPendingFileChanges({
            kdbChanged: result.kdbChanged,
            waveChanged: result.waveChanged,
          });
          setShowFileChangeDialog(true);
        }
      }, 5000); // 5 seconds
      
      return () => {
        if (autoCheckIntervalRef.current) {
          clearInterval(autoCheckIntervalRef.current);
          autoCheckIntervalRef.current = null;
        }
      };
    } else {
      // Clear interval when disabled
      if (autoCheckIntervalRef.current) {
        clearInterval(autoCheckIntervalRef.current);
        autoCheckIntervalRef.current = null;
      }
    }
  }, [autoCheckEnabled, handleRefreshCheck, addMessage, currentKdbName, currentWaveName]);

  // Manual refresh check wrapper - shows dialog if changes detected
  const handleManualRefreshCheck = useCallback(async () => {
    const result = await handleRefreshCheck();
    if (result.hasChanges) {
      setPendingFileChanges({
        kdbChanged: result.kdbChanged,
        waveChanged: result.waveChanged,
      });
      setShowFileChangeDialog(true);
    }
  }, [handleRefreshCheck]);

  // Handle reload KDB
  const handleReloadKdb = useCallback(async () => {
    setShowFileChangeDialog(false);
    if (currentKdbName) {
      addMessage(`Reloading KDB: ${currentKdbName}...`);
      // Clear current KDB data
      await kdbManager.clear();
      setKdbLoaded(false);
      setCurrentKdbChecksum(null);
      // Reload KDB (don't show wave dialog since this is a reload)
      await handleKdbSelect(currentKdbName, false);
    }
  }, [currentKdbName, addMessage]);

  // Handle reload waveform
  const handleReloadWave = useCallback(async () => {
    setShowFileChangeDialog(false);
    if (currentWaveName) {
      addMessage(`Reloading waveform: ${currentWaveName}...`);
      // Clear current waveform data
      waveManager.clear();
      setCurrentWaveform(null);
      setCurrentWaveChecksum(null);
      // Reload waveform
      await handleWaveSelect(currentWaveName);
    }
  }, [currentWaveName, addMessage]);

  // Handle reload both
  const handleReloadBoth = useCallback(async () => {
    setShowFileChangeDialog(false);
    if (currentKdbName) {
      await handleReloadKdb();
    }
    if (currentWaveName) {
      await handleReloadWave();
    }
  }, [currentKdbName, currentWaveName, handleReloadKdb, handleReloadWave]);

  // Load waveform list from server
  const loadWaveformList = async () => {
    const waves = await waveManager.fetchWaveformList()
    setWaveforms(waves)
    if (waves.length > 0) {
      waveManager.setCurrentWaveform(waves[0].name)
      setCurrentWaveform(waves[0].name)
      addMessage(`Loaded ${waves.length} waveform(s)`)
    }
  }

  const handleConnect = async (host: string, port: number) => {
    apiService.configure({ host, port, useHttps: false })
    const isConnected = await apiService.testConnection()
    setConnected(isConnected)

    if (isConnected) {
      localStorage.setItem('serverConfig', JSON.stringify({ host, port, useHttps: false }))
      addMessage(`Connected to server at ${host}:${port}`)

      // Load waveform list first
      await loadWaveformList()

      // Show KDB selection dialog
      setShowKdbSelectionDialog(true)
    } else {
      addMessage(`Failed to connect to ${host}:${port}`)
    }
  }

  // Handle KDB selection
  const handleKdbSelect = async (kdbName: string, showWaveDialog: boolean = true) => {
    setShowKdbSelectionDialog(false)
    
    // If a KDB is already loaded, clear it first
    if (kdbLoaded || currentKdbName) {
      addMessage(`Closing previous KDB: ${currentKdbName || 'unknown'}...`);
      await kdbManager.clear();
      setKdbLoaded(false);
      setCurrentKdbName(null);
      setCurrentKdbChecksum(null);
      setSelectedModuleIndex(null);
      
      // Close all source and waveform tabs
      setTabs(prev => {
        const remainingTabs = prev.filter(tab => tab.type !== 'source' && tab.type !== 'waveform');
        if (remainingTabs.length > 0 && !remainingTabs.find(t => t.id === activeTab)) {
          setActiveTab(remainingTabs[0].id);
        } else if (remainingTabs.length === 0) {
          setActiveTab('');
        }
        return remainingTabs;
      });
      
      // Clear waveform state too
      waveManager.clear();
      setCurrentWaveform(null);
      setCurrentWaveName(null);
      setCurrentWaveChecksum(null);
      setWaveforms([]);
      
      addMessage('Previous KDB closed');
    }
    
    addMessage(`Loading KDB: ${kdbName}`)
    
    // Get KDB info first (basic info from server)
    const kdbInfo = await apiService.getKdbInfo(kdbName)
    if (kdbInfo.status === 'success' && kdbInfo.data?.kdb_info) {
      const info = kdbInfo.data.kdb_info
      addMessage(`KDB File: ${info.design_name}, Size: ${formatBytes(info.file_size)}`)
    }
    
    // Get checksum from list API
    const listResponse = await apiService.getKdbList()
    let kdbChecksum: string | null = null
    if (listResponse.status === 'success' && listResponse.data?.kdbs) {
      const serverKdb = listResponse.data.kdbs.find(k => k.name === kdbName)
      if (serverKdb) {
        kdbChecksum = serverKdb.checksum
      }
    }
    
    addMessage(`Starting KDB download...`)
    
    // Download KDB with progress
    const success = await kdbManager.downloadAndLoadKdb(
      kdbName,
      (downloaded, total) => {
        const percent = Math.round((downloaded / total) * 100)
        if (percent % 10 === 0) {
          addMessage(`Downloading KDB: ${percent}%`)
        }
      }
    )
    
    if (success) {
      setKdbLoaded(true)
      setCurrentKdbName(kdbName)
      setCurrentKdbChecksum(kdbChecksum)
      localStorage.setItem('currentKdbId', kdbName)
      
      // Get parsed KDB details (real data after WASM parsing)
      const designName = await kdbManager.getDesignName()
      const header = await kdbManager.getHeader()
      
      addMessage(`✓ KDB parsed successfully`)
      addMessage(`  Design Name: ${designName}`)
      if (header) {
        addMessage(`  Version: ${header.version}`)
        addMessage(`  Created: ${header.createdAt}`)
      }
      
      // Force refresh of components
      setSelectedModuleIndex(null)
      
      // Show waveform selection dialog only for initial load (not reload)
      if (showWaveDialog) {
        setShowWaveSelectionDialog(true)
      }
    } else {
      addMessage('✗ Failed to load KDB')
      addMessage('  Please check browser console for detailed error information')
    }
  }

  // Handle waveform selection
  // Supports optional custom time range from user
  const handleWaveSelect = async (waveName: string, customRange?: { start: number; end: number }) => {
    setShowWaveSelectionDialog(false)
    waveManager.setCurrentWaveform(waveName)
    setCurrentWaveform(waveName)
    
    if (customRange) {
      addMessage(`Selected waveform: ${waveName} (custom range: ${customRange.start}-${customRange.end} fs)`)
    } else {
      addMessage(`Selected waveform: ${waveName}`)
    }

    // Get checksum and modified_time from list API
    const listResponse = await apiService.getWaveformList()
    let waveChecksum: string | null = null
    let waveTimeStamp = 0; // Default timestamp for CDN cache
    if (listResponse.status === 'success' && listResponse.data?.waves) {
      const serverWave = listResponse.data.waves.find(w => w.name === waveName)
      if (serverWave) {
        waveChecksum = serverWave.checksum
        waveTimeStamp = serverWave.modified_time || 0
        console.log(`[App] From list API: checksum=${waveChecksum}, modified_time=${waveTimeStamp}`)
      }
    }

    // Get waveform detailed info (time_unit, start_time, end_time)
    let waveTimeUnit = 2; // Default to ns
    let waveEndTime = 1000000; // Default max time
    let displayUnitPerLoD0Unit = 1; // Default

    try {
      const infoResponse = await apiService.getWaveformInfo(waveName)
      if (infoResponse.status === 'success' && infoResponse.data?.wave_info) {
        const waveInfo = infoResponse.data.wave_info
        console.log('[App] Waveform info:', waveInfo)

        // Parse time_unit to get unit enum
        const parsed = parseTimeUnitStr(waveInfo.time_unit)
        waveTimeUnit = parsed.unitEnum
        console.log(`[App] Time unit: ${waveInfo.time_unit} -> enum ${waveTimeUnit}`)

        // LoD0Unit = time_unit ( server's time unit )
        // waveInfo.end_time is already in time_unit units (LoD0 units)
        // No conversion needed - internal time is always in LoD0 units
        waveEndTime = waveInfo.end_time
        console.log(`[App] End time: ${waveEndTime} ${parsed.unit} (LoD0 units)`)

        // Set DisplayUnitPerLoD0Unit to 1
        // 1 DisplayUnit = 1 LoD0Unit = time_unit
        displayUnitPerLoD0Unit = 1
        console.log(`[App] DisplayUnitPerLoD0Unit: ${displayUnitPerLoD0Unit}`)
      }
    } catch (error) {
      console.error('[App] Failed to get waveform info:', error)
    }

    // Close all waveform tabs before loading new waveform
    setTabs(prev => prev.filter(tab => tab.type !== 'waveform'))
    if (tabs.some(tab => tab.type === 'waveform')) {
      addMessage('Closed all waveform tabs for new waveform')
    }

    setCurrentWaveName(waveName)
    setCurrentWaveChecksum(waveChecksum)
    setCurrentWaveSignalPrefix('')  // Clear previous prefix
    setCurrentWaveSignalSpaceBeforeBracket(false)  // Clear previous space setting
    setCurrentWaveTimeUnit(waveTimeUnit)  // Set time unit from waveform
    setCurrentWaveEndTime(waveEndTime)  // Set end time from waveform
    setCurrentWaveDisplayUnitPerLoD0(displayUnitPerLoD0Unit)  // Set display unit ratio
    setCurrentWaveCustomRange(customRange)  // Save user custom range (if any)

    // Create WASM provider for the new waveform with initial viewport and time stamp
    try {
      createProvider(serverUrl, waveName, 'work@', true, waveTimeStamp)
      console.log('[App] Created WASM provider for waveform:', waveName, 'timeStamp:', waveTimeStamp)
    } catch (error) {
      console.error('[App] Failed to create WASM provider:', error)
    }

    // Reset mock data flag when loading real waveform
    if (useMockData) {
      setUseMockData(false)
      addMessage('Switched from mock data to real waveform data')
    }

    // Store waveform metadata for future use
    // This will be used when creating new waveform tabs
    console.log('[App] Storing waveform metadata:', {
      waveName,
      waveTimeUnit,
      waveEndTime,
      displayUnitPerLoD0Unit
    })
  }

  const handleDisconnect = async () => {
    setConnected(false)
    // Clear API service configuration so requests fail
    apiService.clearConfig()
    localStorage.removeItem('serverConfig')
    
    addMessage('Disconnected from server')
  }

  // Handle close KDB - clear KDB data and close source tabs
  const handleCloseKdb = async () => {
    addMessage('Closing KDB...')
    
    // Clear KDB data from storage
    await kdbManager.clear()
    
    // Clear KDB-related state
    setKdbLoaded(false)
    setCurrentKdbName(null)
    setCurrentKdbChecksum(null)
    setSelectedModuleIndex(null)
    
    // Close all source tabs
    setTabs(prev => {
      const remainingTabs = prev.filter(tab => tab.type !== 'source')
      // Update active tab if the active one was closed
      if (remainingTabs.length > 0 && !remainingTabs.find(t => t.id === activeTab)) {
        setActiveTab(remainingTabs[0].id)
      } else if (remainingTabs.length === 0) {
        setActiveTab('')
      }
      return remainingTabs
    })
    
    addMessage('KDB closed')
  }

  // Handle close Waveform - clear wave data and close waveform tabs
  const handleCloseWave = async () => {
    addMessage('Closing Waveform...')
    
    // Clear waveform data
    waveManager.clear()
    setCurrentWaveform(null)
    setCurrentWaveName(null)
    setCurrentWaveChecksum(null)
    setCurrentWaveSignalPrefix('')  // Clear signal prefix when closing waveform
    setCurrentWaveSignalSpaceBeforeBracket(false)  // Clear space flag when closing waveform
    setWaveforms([])
    
    // Close all waveform tabs
    setTabs(prev => {
      const remainingTabs = prev.filter(tab => tab.type !== 'waveform')
      // Update active tab if the active one was closed
      if (remainingTabs.length > 0 && !remainingTabs.find(t => t.id === activeTab)) {
        setActiveTab(remainingTabs[0].id)
      } else if (remainingTabs.length === 0) {
        setActiveTab('')
      }
      return remainingTabs
    })
    
    addMessage('Waveform closed')
  }



  // Format bytes to human readable string
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  const handleModuleSelect = (moduleIndex: number) => {
    // Update global selected module index for hierarchy/signal panel
    setSelectedModuleIndex(moduleIndex)
    // Calculate fullName on demand
    const fullName = kdbManager.calculateModuleFullName(moduleIndex)
    // Update MenuBar info text
    setMenuBarInfoText(fullName)
    addMessage(`Selected module: ${fullName}`)
  }

  const handleModuleDoubleClick = async (moduleIndex: number) => {
    console.log('[App] handleModuleDoubleClick called, moduleIndex:', moduleIndex);
    
    // Update global selected module index
    setSelectedModuleIndex(moduleIndex)
    
    // Get module info
    const module = kdbManager.getModuleById(moduleIndex);
    
    // For hierarchy double-click:
    // - selectedModule = clicked module (moduleIndex)
    // - displayModule = if clicked module is instance, use its parent; otherwise use itself
    // - highlightLine = selected module's own startLine (instance declaration line)
    const displayModuleId = module?.isInstance ? (module?.parentModuleId || moduleIndex) : moduleIndex;
    const highlightLine = module?.definition?.startLine || 1;
    
    console.log('[App] highlightLine:', highlightLine, 'displayModuleId:', displayModuleId, 'isInstance:', module?.isInstance);
    
    // Use unified function to set source display
    await setSourceDisplay({
      displayModuleId: displayModuleId,
      selectedModuleId: moduleIndex,
      startFromLine: highlightLine,
      addToHistory: true
    });
    
    // Calculate fullName on demand
    const fullName = kdbManager.calculateModuleFullName(moduleIndex)
    addMessage(`Open source for: ${fullName}`)
  }

  const handleFileDoubleClick = async (fileId: number) => {
    console.log('[App] handleFileDoubleClick called, fileId:', fileId);
    
    // Open file directly - find a module that uses this file
    // and open it from line 1 (not from module's start line)
    const modules = kdbManager.getAllModules();
    const moduleIndex = modules.findIndex(m => m.definition?.fileId === fileId);
    
    if (moduleIndex >= 0) {
      const moduleIdx = moduleIndex + 1; // Convert to 1-based index
      
      // Update global selected module index
      setSelectedModuleIndex(moduleIdx)
      
      // Use unified function to set source display
      // displayModuleId: 0 (invalid) to show entire file
      await setSourceDisplay({
        displayModuleId: 0,        // Invalid ID, show entire file
        selectedModuleId: moduleIdx,
        startFromLine: 1,
        fileId: fileId,            // Must provide fileId
        addToHistory: true
      });
      
      addMessage(`Open file from line 1`)
    }
  }

  const handleSignalDoubleClick = (signal: Signal, moduleIndex: number) => {
    console.log('[App] handleSignalDoubleClick called, signal:', signal.name, 'declaration:', signal.declaration, 'moduleIndex:', moduleIndex, 'parentModuleId:', signal.parentModuleId)
    
    if (!signal.declaration) {
      addMessage(`No declaration info for ${signal.name}`)
      return
    }
    
    const line = signal.declaration.line;
    const fileId = signal.declaration.fileId;
    
    // Determine display range based on signal's parent module
    // Use the same logic as hierarchy double click
    let displayStartLine: number | undefined;
    let displayEndLine: number | undefined;
    let displayModuleIndex = moduleIndex;
    
    // Get the parent module of this signal
    const parentModuleId = signal.parentModuleId;
    if (parentModuleId > 0) {
      const parentModule = kdbManager.getModuleById(parentModuleId);
      displayModuleIndex = parentModuleId;
      
      if (parentModule) {
        if (!parentModule.isInstance) {
          // Parent is a module definition, use its range
          displayStartLine = parentModule.definition?.startLine;
          displayEndLine = parentModule.definition?.endLine;
        } else {
          // Parent is an instance, find the def_module_id
          const defModuleId = parentModule.defModuleId;
          if (defModuleId > 0) {
            const defModule = kdbManager.getModuleById(defModuleId);
            displayStartLine = defModule?.definition?.startLine;
            displayEndLine = defModule?.definition?.endLine;
          }
        }
      }
    }
    
    console.log('[App] Signal display range:', displayStartLine, '-', displayEndLine, 'for parentModuleId:', parentModuleId);
    
    // Check if there's an active source tab
    const activeSourceTab = tabs.find(t => t.type === 'source' && t.id === activeTab)
    
    if (activeSourceTab) {
      // Update the active source tab to jump to signal declaration
      // Use signal's parent module as display module
      setTabs(prev => prev.map(tab => 
        tab.id === activeSourceTab.id 
          ? { 
              ...tab, 
              moduleIndex: displayModuleIndex,
              displayModuleIndex: displayModuleIndex,  // Set display module to signal's parent
              signalDeclarationLine: line,
              moduleStartLine: displayStartLine,
              moduleEndLine: displayEndLine,
            } 
          : tab
      ))
      setActiveTab(activeSourceTab.id)
      
      // Add navigation entry with display module
      addNavigationEntry(fileId, line, displayModuleIndex);
      addMessage(`Jump to ${signal.name} declaration (line ${line})`)
    } else {
      // No active source tab, create one
      const newId = `source-${tabCounter.current++}`
      const newTab: Tab = {
        id: newId,
        label: 'Source',
        type: 'source',
        moduleIndex: displayModuleIndex,
        displayModuleIndex: displayModuleIndex,  // Set display module to signal's parent
        signalDeclarationLine: line,
        moduleStartLine: displayStartLine,
        moduleEndLine: displayEndLine,
      }
      setTabs(prev => [...prev, newTab])
      setActiveTab(newId)
      
      // Add navigation entry after tab is created with display module
      setTimeout(() => addNavigationEntry(fileId, line, displayModuleIndex), 0);
      addMessage(`Open source at ${signal.name} declaration (line ${line})`)
    }
  }

  const handleSignalSelect = (signal: Signal) => {
    // Update MenuBar info text with signal's full hierarchy name
    setMenuBarInfoText(signal.fullName)
  }

  // Handle word click in source code editor
  const handleWordClick = async (word: string, lineNumber: number, isDoubleClick: boolean) => {
    console.log('[App] handleWordClick:', word, 'line:', lineNumber, 'double:', isDoubleClick);

    // Get current active source tab
    const activeTabData = tabs.find(t => t.id === activeTab && t.type === 'source');
    if (!activeTabData || !activeTabData.moduleIndex) return;

    // Use displayModuleIndex for lookups (the currently displayed module)
    // If not set, fall back to moduleIndex
    const lookupModuleIndex = activeTabData.displayModuleIndex || activeTabData.moduleIndex;
    const module = kdbManager.getModuleById(lookupModuleIndex);
    if (!module) return;

    // Check if line is within module range
    if (activeTabData.moduleStartLine && activeTabData.moduleEndLine) {
      if (lineNumber < activeTabData.moduleStartLine || lineNumber > activeTabData.moduleEndLine) {
        console.log('[App] Click outside module range');
        return;
      }
    }

    // Try to find instance first (batch search) in the displayed module
    console.log('[App] Looking for instance:', word);
    const instanceId = await kdbManager.findInstanceByName(lookupModuleIndex, word);
    console.log('[App] instanceId:', instanceId);
    if (instanceId) {
      const instance = kdbManager.getModuleById(instanceId);
      if (instance) {
        const fullName = kdbManager.calculateModuleFullName(instanceId);
        setMenuBarInfoText(fullName);

        if (isDoubleClick) {
          // Use getDisplayRange to get the display range for the found instance
          const displayRange = kdbManager.getDisplayRange(instanceId);
          if (displayRange) {
            // Update global selected module index to the clicked instance (not def_module)
            // This is the "selected instance" for MenuBar info
            setSelectedModuleIndex(instanceId);
            
            // Use unified function to set source display
            // For Monaco double-click:
            // - displayModule = clicked instance (for lookup context)
            // - highlightLine = def_module's startLine (from getDisplayRange)
            // - moduleIndex unchanged - keep the previously selected instance context
            await setSourceDisplay({
              displayModuleId: instanceId,      // Displayed instance (clicked instance)
              selectedModuleId: undefined,      // Keep existing moduleIndex unchanged
              startFromLine: displayRange.startLine,  // Highlight def_module's startLine
              addToHistory: true
            });
            
            addMessage(`Jump to instance ${instance.name} definition (line ${displayRange.startLine})`);
          }
        }
        return;
      }
    }

    // Try to find signal (batch search) in the displayed module
    console.log('[App] Looking for signal:', word);
    const signalGlobalId = await kdbManager.findSignalByName(lookupModuleIndex, word);
    console.log('[App] signalGlobalId:', signalGlobalId);
    if (signalGlobalId) {
      const signal = kdbManager.buildSignal(signalGlobalId);
      console.log('[App] built signal:', signal?.name, 'isDoubleClick:', isDoubleClick);
      if (signal) {
        setMenuBarInfoText(signal.fullName);
        
        // For double-click on signal, add to Drivers tab
        if (isDoubleClick) {
          console.log('[App] Getting drivers for signal:', signalGlobalId);
          // Get driver information for this signal
          const driverLocations = await kdbManager.getDriverBySignalId(signalGlobalId);
          console.log('[App] driverLocations:', driverLocations);
          console.log('[App] driverLocations detailed:', driverLocations.map((d: any) => ({ 
            driverSignalGlobalId: d.driverSignalGlobalId, 
            line: d.line,
            raw: d 
          })));
          
          if (driverLocations && driverLocations.length > 0) {
            // Get current file info
            let fileId = activeTabData.fileId;
            let fileName = '';
            
            if (!fileId && activeTabData.displayModuleIndex) {
              const displayModule = kdbManager.getModuleById(activeTabData.displayModuleIndex);
              if (displayModule?.definition?.fileId) {
                fileId = displayModule.definition.fileId;
              }
            }
            
            // Get file name
            if (fileId) {
              const fileInfo = await kdbManager.getFileInfo(fileId);
              if (fileInfo) {
                fileName = fileInfo.fullName;
              }
            }
            
            // Import driverManager dynamically to avoid circular dependency
            const { driverManager } = await import('./modules/knowledge/driverManager');
            
            // Get driver declaration lines for each driver
            const driversWithDeclaration = driverLocations.map(d => {
              const driverSignal = kdbManager.buildSignal(d.driverSignalGlobalId);
              return {
                driverSignalGlobalId: d.driverSignalGlobalId,
                line: d.line,
                driverDeclarationLine: driverSignal?.declaration?.line,
              };
            });
            
            // Add driver group
            driverManager.addDriverGroup({
              targetSignal: {
                globalId: signalGlobalId,
                fullName: signal.fullName,
                parentModuleId: signal.parentModuleId,
              },
              clickLocation: {
                fileId: fileId || 0,
                lineNumber: lineNumber,
                fileName: fileName || 'Unknown',
              },
              drivers: driversWithDeclaration,
            });
            
            addMessage(`Added ${driverLocations.length} driver(s) for signal: ${signal.name}`);
          } else {
            addMessage(`No drivers found for signal: ${signal.name}`);
          }
        }
        return;
      }
    }

    console.log('[App] Word not found as instance or signal:', word);
  }

  // Helper function to escape regex special characters
  const escapeRegex = (str: string): string => {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  // Helper function to build server signal name from local signal info
  // Uses saved prefix and space settings
  // Inputs:
  //   - fullName: local full name (e.g., "work@tb_top.u_dut.mem_arid[7:0]")
  //   - prefix: prefix to remove (e.g., "work@")
  //   - spaceBeforeBracket: whether to add space before [msb:lsb]
  // Returns: server signal name (not escaped, for display or API use)
  const buildServerSignalName = (
    fullName: string,
    prefix: string,
    spaceBeforeBracket: boolean
  ): string => {
    // Remove prefix if present
    let serverName = prefix && fullName.startsWith(prefix)
      ? fullName.substring(prefix.length)
      : fullName

    // Handle space before bracket
    if (spaceBeforeBracket) {
      const bracketIndex = serverName.indexOf('[')
      if (bracketIndex !== -1 && bracketIndex > 0 && serverName[bracketIndex - 1] !== ' ') {
        serverName = serverName.substring(0, bracketIndex) + ' ' + serverName.substring(bracketIndex)
      }
    }

    return serverName
  }

  // Helper function to search signal on server with prefix removal and bit width handling
  // Inputs:
  //   - fullName: full hierarchical name (e.g., "work@tb_top.u_dut.mem_arid[7:0]")
  //   - prefix: prefix to remove (e.g., "work@")
  // Returns: { found, matchedName?, prefix?, spaceBeforeBracket? }
  const searchSignalOnServer = async (
    waveName: string,
    fullName: string,
    prefix: string = ''
  ): Promise<{ found: boolean; matchedName?: string; prefix?: string; spaceBeforeBracket?: boolean }> => {
    // Remove prefix if provided
    let searchName = prefix && fullName.startsWith(prefix)
      ? fullName.substring(prefix.length)
      : fullName

    console.log(`[Signal Search] Original: "${fullName}", Prefix: "${prefix}", Search name: "${searchName}"`)

    // Try with bit width first (no space)
    let escapedName = escapeRegex(searchName)
    console.log(`[Signal Search] Trying with bit width: "${searchName}" -> regex: ^${escapedName}$`)

    let response = await apiService.getWaveformSignals(waveName, {
      nameRegex: `^${escapedName}$`,
      limit: 1
    })

    console.log(`[Signal Search] Response: status=${response.status}, signal_count=${(response.data as any)?.signal_count ?? 0}`)

    if (response.status === 'success' && (response.data as any)?.signal_count > 0) {
      console.log(`[Signal Search] Found with bit width!`)
      return { found: true, matchedName: searchName, prefix, spaceBeforeBracket: false }
    }

    // Try without bit width
    const bracketIndex = searchName.indexOf('[')
    if (bracketIndex !== -1) {
      const nameWithoutBitWidth = searchName.substring(0, bracketIndex)
      escapedName = escapeRegex(nameWithoutBitWidth)
      console.log(`[Signal Search] Trying without bit width: "${nameWithoutBitWidth}" -> regex: ^${escapedName}$`)

      response = await apiService.getWaveformSignals(waveName, {
        nameRegex: `^${escapedName}$`,
        limit: 1
      })

      console.log(`[Signal Search] Response: status=${response.status}, signal_count=${(response.data as any)?.signal_count ?? 0}`)

      if (response.status === 'success' && (response.data as any)?.signal_count > 0) {
        console.log(`[Signal Search] Found without bit width!`)
        return { found: true, matchedName: nameWithoutBitWidth, prefix, spaceBeforeBracket: false }
      }

      // Try with space before bracket (e.g., "mem_arid [7:0]")
      const nameWithSpace = searchName.substring(0, bracketIndex) + ' ' + searchName.substring(bracketIndex)
      escapedName = escapeRegex(nameWithSpace)
      console.log(`[Signal Search] Trying with space before bracket: "${nameWithSpace}" -> regex: ^${escapedName}$`)

      response = await apiService.getWaveformSignals(waveName, {
        nameRegex: `^${escapedName}$`,
        limit: 1
      })

      console.log(`[Signal Search] Response: status=${response.status}, signal_count=${(response.data as any)?.signal_count ?? 0}`)

      if (response.status === 'success' && (response.data as any)?.signal_count > 0) {
        console.log(`[Signal Search] Found with space before bracket!`)
        return { found: true, matchedName: nameWithSpace, prefix, spaceBeforeBracket: true }
      }
    }

    return { found: false }
  }

  // Helper function to try finding signal with prefix removal
  const tryFindSignalWithPrefixRemoval = async (
    waveName: string,
    signalName: string
  ): Promise<{ found: boolean; matchedName?: string; prefix?: string; spaceBeforeBracket?: boolean }> => {
    console.log(`[Signal Search] Starting prefix removal for: ${signalName}`)

    // First, try removing work@ prefix if present (most common case)
    const atIndex = signalName.indexOf('@')
    if (atIndex !== -1) {
      const prefix = signalName.substring(0, atIndex + 1)
      console.log(`[Signal Search] Trying to remove work@ prefix: "${prefix}"`)
      const result = await searchSignalOnServer(waveName, signalName, prefix)
      if (result.found) {
        console.log(`[Signal Search] Found after removing work@ prefix!`)
        return {
          found: true,
          matchedName: result.matchedName,
          prefix: prefix,
          spaceBeforeBracket: result.spaceBeforeBracket
        }
      }
    }

    // If not found with work@ removal, try hierarchical prefix removal
    // But only remove from the part after @ (if @ exists)
    const searchStartIndex = atIndex !== -1 ? atIndex + 1 : 0
    const basePrefix = atIndex !== -1 ? signalName.substring(0, searchStartIndex) : ''
    let currentName = signalName.substring(searchStartIndex)
    let removedHierarchicalPrefix = ''

    console.log(`[Signal Search] Trying hierarchical removal from: "${currentName}"`)

    while (currentName.length > 0) {
      const fullPrefix = basePrefix + removedHierarchicalPrefix
      console.log(`[Signal Search] Trying with prefix: "${fullPrefix}"`)

      const result = await searchSignalOnServer(waveName, signalName, fullPrefix)
      if (result.found) {
        console.log(`[Signal Search] Found with hierarchical prefix removal!`)
        return {
          found: true,
          matchedName: result.matchedName,
          prefix: fullPrefix,
          spaceBeforeBracket: result.spaceBeforeBracket
        }
      }

      // Remove next hierarchical level (find first dot)
      const dotIndex = currentName.indexOf('.')
      if (dotIndex === -1) break

      removedHierarchicalPrefix = removedHierarchicalPrefix + currentName.substring(0, dotIndex + 1)
      currentName = currentName.substring(dotIndex + 1)

      console.log(`[Signal Search] Removed hierarchical prefix: "${removedHierarchicalPrefix}", remaining: "${currentName}"`)
    }

    console.log(`[Signal Search] Signal not found after all prefix removals`)
    return { found: false }
  }

  const handleSignalAddToWaveform = async (signal: Signal) => {
    // If no waveform loaded and not already using mock data, ask user
    if (!currentWaveName && !useMockData) {
      setPendingMockSignal(signal)
      setShowMockDataDialog(true)
      return
    }

    // If waveform is loaded from server, verify signal exists
    if (currentWaveName && apiService.isConnected()) {
      try {
        // If we already have a signal prefix for this waveform, use it directly
        if (currentWaveSignalPrefix) {
          console.log(`[Signal Search] Using existing prefix "${currentWaveSignalPrefix}"`)

          const result = await searchSignalOnServer(currentWaveName, signal.fullName, currentWaveSignalPrefix)

          if (result.found) {
            console.log(`[Signal Search] Found with existing prefix!`)
            // Signal found with existing prefix, add directly
            addSignalToWaveform(signal)
            return
          }
          console.log(`[Signal Search] Not found with existing prefix, trying prefix removal...`)
          // If not found with existing prefix, fall through to try finding new prefix
        }

        // Try to find signal with prefix removal
        const result = await tryFindSignalWithPrefixRemoval(currentWaveName, signal.fullName)

        if (result.found) {
          // Signal found (possibly with prefix removed)
          const needsPrefixAdjustment = result.prefix && result.prefix.length > 0

          if (needsPrefixAdjustment) {
            // Show success dialog with prefix info
            const firstSignalResponse = await apiService.getWaveformSignals(currentWaveName, {
              limit: 1
            })
            const firstSignalName = firstSignalResponse.status === 'success' &&
              firstSignalResponse.data &&
              firstSignalResponse.data.signals.length > 0
              ? firstSignalResponse.data.signals[0].name
              : 'N/A'

            setSignalNotFoundInfo({
              attempted: signal.fullName,
              matched: result.matchedName!,
              prefix: result.prefix!,
              firstAvailable: firstSignalName,
              success: true
            })
            setShowSignalNotFoundDialog(true)

            // Save prefix and space setting globally for this waveform
            setCurrentWaveSignalPrefix(result.prefix!)
            setCurrentWaveSignalSpaceBeforeBracket(result.spaceBeforeBracket ?? false)

            // Update WASM provider settings
            updateProviderSettings(result.prefix!, result.spaceBeforeBracket ?? false)
          }

          // Add signal to waveform (still using mock data for now)
          addSignalToWaveform(signal)
        } else {
          // Signal not found even after prefix removal
          const firstSignalResponse = await apiService.getWaveformSignals(currentWaveName, {
            limit: 1
          })

          const firstSignalName = firstSignalResponse.status === 'success' &&
            firstSignalResponse.data &&
            firstSignalResponse.data.signals.length > 0
            ? firstSignalResponse.data.signals[0].name
            : 'N/A'

          // Show dialog with info
          setSignalNotFoundInfo({
            attempted: signal.fullName,
            matched: '',
            prefix: '',
            firstAvailable: firstSignalName,
            success: false
          })
          setShowSignalNotFoundDialog(true)
        }
      } catch (error) {
        console.error('Error checking signal on server:', error)
        // If API call fails, still add the signal (fallback behavior)
        addSignalToWaveform(signal)
      }
    } else {
      // No server connection or no waveform loaded, add directly
      addSignalToWaveform(signal)
    }
  }
  
  const addSignalToWaveform = (signal: Signal) => {
    // Generate unique_id for this signal instance
    const unique_id = nextWaveformSignalIdRef.current++
    
    // Create waveform signal with unique_id
    const waveformSignal: Signal & { unique_id: number } = {
      ...signal,
      unique_id,
    }
    
    // Add signal to the active waveform tab
    setTabs(prev => prev.map(tab => {
      if (tab.id === activeTab && tab.type === 'waveform') {
        const currentSignals = tab.signals || []
        // Check if signal already exists (by fullName)
        const exists = currentSignals.some(s => s.fullName === signal.fullName)
        if (!exists) {
          return { ...tab, signals: [...currentSignals, waveformSignal] }
        }
      }
      return tab
    }))
    
    addMessage(`Added signal to waveform: ${signal.name} (ID: ${unique_id})`)
  }
  
  const handleMockDataConfirm = () => {
    setShowMockDataDialog(false)
    setUseMockData(true)
    addMessage('Using mock data for waveform display')
    
    // Add the pending signal
    if (pendingMockSignal) {
      addSignalToWaveform(pendingMockSignal)
      setPendingMockSignal(null)
    }
  }
  
  const handleMockDataCancel = () => {
    setShowMockDataDialog(false)
    setPendingMockSignal(null)
    addMessage('Please load a waveform file to view signal data')
  }

  const handleSignalRemove = (signal: Signal & { unique_id: number }) => {
    // Remove signal from the active waveform tab
    setTabs(prev => prev.map(tab => {
      if (tab.id === activeTab && tab.type === 'waveform') {
        const currentSignals = tab.signals || []
        // 使用 unique_id 精确删除指定的信号实例
        const remainingSignals = currentSignals.filter(s => s.unique_id !== signal.unique_id)
        if (remainingSignals.length !== currentSignals.length) {
          return { ...tab, signals: remainingSignals }
        }
      }
      return tab
    }))
    addMessage(`Removed signal from waveform: ${signal.name}`)
  }

  // Tab management functions
  // For waveform tabs, optional customRange can be provided by user
  const handleAddTab = (type: 'source' | 'waveform', customRange?: { start: number; end: number }) => {
    const newId = `${type}-${tabCounter.current++}`

    // For waveform tabs, use current waveform's time settings
    const isWaveform = type === 'waveform'
    const timeConfig = isWaveform
      ? initTimeConfig(currentWaveDisplayUnitPerLoD0)
      : undefined

    // Determine waveform total range:
    // - If user provides customRange, use that
    // - Otherwise use saved custom range from waveform selection
    // - Otherwise use server returned range (currentWaveEndTime)
    // This range will be saved for viewport sanity checks
    const waveformRange = isWaveform
      ? (customRange ?? currentWaveCustomRange ?? { start: 0, end: currentWaveEndTime })
      : undefined

    // Set viewport end time to waveform's range (with validation)
    let viewport = undefined
    if (isWaveform && waveformRange) {
      const sanitized = sanitizeTimeRange(waveformRange.start, waveformRange.end, waveformRange)
      viewport = { timeStart: sanitized.timeStart, timeEnd: sanitized.timeEnd }
    }

    const newTab: Tab = {
      id: newId,
      label: type === 'source' ? `Source ${tabCounter.current - 1}` : `Waveform ${tabCounter.current - 1}`,
      type,
      moduleIndex: type === 'source' ? null : undefined,
      signals: isWaveform ? [] : undefined,
      groups: isWaveform ? createDefaultGroups() : undefined,
      selectedGroup: isWaveform ? 'group_1' : undefined,
      timeConfig,
      viewport,
      cursorPosition: isWaveform && waveformRange
        ? Math.floor((waveformRange.start + waveformRange.end) / 2)
        : undefined, // Default cursor at middle of range
      waveformTimeUnit: isWaveform ? currentWaveTimeUnit : undefined,
      waveformRange, // Save the total range for sanity checks
    }
    setTabs(prev => [...prev, newTab])
    setActiveTab(newId)
    addMessage(`Added new ${type} tab` + (customRange ? ` (custom range: ${customRange.start}-${customRange.end})` : ''))
  }

  // Update time configuration for a specific tab
  const handleTimeConfigChange = (tabId: string, timeConfig: TimeConfig) => {
    setTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, timeConfig } : tab
    ))
  }

  // Handle viewport start time change from toolbar
  const handleViewportStartChange = (newStart: number) => {
    const currentTab = tabs.find(t => t.id === activeTab)
    if (currentTab?.type === 'waveform' && currentTab.viewport) {
      const timeSpan = currentTab.viewport.timeEnd - currentTab.viewport.timeStart
      const newEnd = newStart + timeSpan
      
      // Sanity check
      if (newStart < 0 || newEnd > currentWaveEndTime) {
        console.log('[App] Invalid viewport range:', newStart, newEnd)
        return
      }
      
      setTabs(prev => prev.map(tab =>
        tab.id === activeTab ? {
          ...tab,
          viewport: { timeStart: newStart, timeEnd: newEnd }
        } : tab
      ))
      console.log(`[App] Viewport start changed to ${newStart}, end ${newEnd}`)
    }
  }

  // Handle cursor position change from toolbar
  const handleCursorPositionChange = (newPosition: number) => {
    const currentTab = tabs.find(t => t.id === activeTab)
    if (currentTab?.type === 'waveform' && currentTab.viewport) {
      // Clamp to valid range
      const clampedPosition = Math.max(0, Math.min(currentWaveEndTime, newPosition))
      
      // Center the new cursor position in the viewport (keep time span constant)
      const timeSpan = currentTab.viewport.timeEnd - currentTab.viewport.timeStart
      const halfSpan = timeSpan / 2
      let newStart = clampedPosition - halfSpan
      let newEnd = clampedPosition + halfSpan
      
      // Use sanitizeTimeRange to validate the new viewport
      const sanitized = sanitizeTimeRange(
        newStart,
        newEnd,
        currentTab.waveformRange,
        { minRange: 1 }
      )
      
      // If sanitization changed the range significantly, don't center (keep original viewport)
      const sanitizedSpan = sanitized.timeEnd - sanitized.timeStart
      if (Math.abs(sanitizedSpan - timeSpan) > 1) {
        // Range was adjusted significantly, only update cursor position
        setTabs(prev => prev.map(tab =>
          tab.id === activeTab ? {
            ...tab,
            cursorPosition: clampedPosition
          } : tab
        ))
        console.log(`[App] Cursor position changed to ${clampedPosition} (viewport unchanged due to boundary constraints)`)
      } else {
        // Use sanitized viewport
        setTabs(prev => prev.map(tab =>
          tab.id === activeTab ? {
            ...tab,
            cursorPosition: clampedPosition,
            viewport: { timeStart: sanitized.timeStart, timeEnd: sanitized.timeEnd }
          } : tab
        ))
        console.log(`[App] Cursor position changed to ${clampedPosition}, viewport centered: ${sanitized.timeStart} - ${sanitized.timeEnd}`)
      }
    }
  }

  // Zoom in: move timeStart and timeEnd towards cursor (half distance)
  const handleZoomIn = () => {
    const currentTab = tabs.find(t => t.id === activeTab)
    if (currentTab?.type === 'waveform' && currentTab.viewport) {
      // Use the tab's saved waveformRange for zoom in
      const newViewport = zoomIn(currentTab.viewport, currentTab.cursorPosition, currentTab.waveformRange)
      
      if (!newViewport) {
        console.log('[Zoom In] Already at maximum zoom')
        addMessage('Already at maximum zoom')
        return
      }
      
      console.log(`[Zoom In] After: start=${newViewport.timeStart}, end=${newViewport.timeEnd}`)
      
      // Clamp cursor to new viewport range to ensure it stays visible
      const cursorPos = currentTab.cursorPosition ?? ((currentTab.viewport.timeStart + currentTab.viewport.timeEnd) / 2)
      const newCursorPos = Math.max(newViewport.timeStart, Math.min(newViewport.timeEnd, cursorPos))

      setTabs(prev => prev.map(tab =>
        tab.id === activeTab ? {
          ...tab,
          viewport: newViewport,
          cursorPosition: Math.floor(newCursorPos),
        } : tab
      ))
      addMessage(`Zoom in: ${newViewport.timeStart} to ${newViewport.timeEnd} LoD0Units`)
    }
  }

  // Zoom out: move timeStart and timeEnd away from cursor (double distance)
  const handleZoomOut = () => {
    const currentTab = tabs.find(t => t.id === activeTab)
    if (currentTab?.type === 'waveform' && currentTab.viewport) {
      // Use the tab's saved waveformRange for zoom out
      const newViewport = zoomOut(currentTab.viewport, currentTab.cursorPosition, currentTab.waveformRange)

      if (!newViewport) {
        console.log('[Zoom Out] Already at minimum zoom')
        addMessage('Already at minimum zoom (max time range reached)')
        return
      }

      console.log(`[Zoom Out] After: start=${newViewport.timeStart}, end=${newViewport.timeEnd}`)

      // Clamp cursor to new viewport range to ensure it stays visible
      const cursorPos = currentTab.cursorPosition ?? ((currentTab.viewport.timeStart + currentTab.viewport.timeEnd) / 2)
      const newCursorPos = Math.max(newViewport.timeStart, Math.min(newViewport.timeEnd, cursorPos))
      
      setTabs(prev => prev.map(tab =>
        tab.id === activeTab ? {
          ...tab,
          viewport: newViewport,
          cursorPosition: newCursorPos,
        } : tab
      ))
      addMessage(`Zoom out: ${newViewport.timeStart} to ${newViewport.timeEnd} LoD0Units`)
    }
  }

  // Zoom full - set viewport to show entire waveform range
  const handleZoomFull = () => {
    const currentTab = tabs.find(t => t.id === activeTab)
    if (currentTab?.type === 'waveform' && currentTab.viewport) {
      // Use the tab's saved waveformRange for zoom full
      const sanitized = sanitizeTimeRange(
        currentTab.waveformRange?.start ?? 0,
        currentTab.waveformRange?.end ?? currentWaveEndTime,
        currentTab.waveformRange
      )

      setTabs(prev => prev.map(tab =>
        tab.id === activeTab ? {
          ...tab,
          viewport: {
            ...tab.viewport!,
            timeStart: sanitized.timeStart,
            timeEnd: sanitized.timeEnd,
          },
        } : tab
      ))
      addMessage(`Zoom full: ${sanitized.timeStart} to ${sanitized.timeEnd} LoD0Units`)
    }
  }

  // Update groups for a specific tab
  const handleGroupsUpdate = (tabId: string, groups: any) => {
    setTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, groups } : tab
    ))
  }

  // Update selected group for a specific tab
  const handleSelectedGroupUpdate = (tabId: string, selectedGroup: string) => {
    setTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, selectedGroup } : tab
    ))
  }

  // 处理已添加到 group 的信号 - 从 signals 队列中删除
  const handleSignalsProcessed = (tabId: string, processedIds: number[]) => {
    setTabs(prev => prev.map(tab => {
      if (tab.id === tabId && tab.type === 'waveform') {
        const currentSignals = tab.signals || []
        // 过滤掉已处理的信号
        const remainingSignals = currentSignals.filter(s => !processedIds.includes(s.unique_id))
        return { ...tab, signals: remainingSignals }
      }
      return tab
    }))
  }

  // 更新列宽配置
  const handleColumnWidthsChange = (tabId: string, columnWidths: ColumnWidths) => {
    setTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, columnWidths } : tab
    ))
  }

  const handleCloseTab = (tabId: string) => {
    setTabs(prev => {
      const newTabs = prev.filter(t => t.id !== tabId)
      // If closing active tab, switch to another tab
      if (activeTab === tabId && newTabs.length > 0) {
        setActiveTab(newTabs[0].id)
      }
      return newTabs
    })
  }

  const handleRenameTab = (tabId: string, newLabel: string) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, label: newLabel } : t
    ))
  }

  // ============================================
  // Session Save/Restore Functions
  // ============================================

  const handleSaveSession = async (name: string) => {
    setIsSessionLoading(true)
    setSessionLoadingMessage('Saving session...')

    try {
      // Get server info from apiService
      const serverUrl = apiService.getBaseUrl()
      const serverMatch = serverUrl.match(/http:\/\/([^:]+):(\d+)/)
      const server = serverMatch
        ? { host: serverMatch[1], port: parseInt(serverMatch[2]) }
        : { host: 'localhost', port: 8080 }

      // Build source tabs data
      const sourceTabsData = tabs
        .filter(tab => tab.type === 'source')
        .map(tab => ({
          id: tab.id,
          moduleIndex: tab.moduleIndex ?? null,
          displayModuleIndex: tab.displayModuleIndex ?? null,
          signalDeclarationLine: tab.signalDeclarationLine,
        }))

      // Build waveform tabs data
      const waveformTabsData = tabs
        .filter(tab => tab.type === 'waveform')
        .map(tab => ({
          id: tab.id,
          label: tab.label,
          nextSignalUniqueId: nextWaveformSignalIdRef.current,
          groups: tab.groups || {},
          selectedGroup: tab.selectedGroup,
        }))

      // Get bookmarks
      const bookmarksData = bookmarkManager.getBookmarks().map(b => ({
        name: b.name,
        moduleIndex: b.moduleIndex,
        fileId: b.fileId,
        lineNumber: b.lineNumber,
        lineContent: b.lineContent,
      }))

      const session: Session = {
        version: SESSION_VERSION,
        name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        server,
        kdb: {
          name: currentKdbName || '',
        },
        waveform: currentWaveName
          ? {
              name: currentWaveName,
              useMockData,
            }
          : undefined,
        waveformSettings: {
          signalPrefix: currentWaveSignalPrefix,
          spaceBeforeBracket: currentWaveSignalSpaceBeforeBracket,
        },
        sourceTabs: sourceTabsData,
        activeSourceTabId: activeTab,
        waveformTabs: waveformTabsData,
        activeWaveformTabId: activeTab,
        bookmarks: bookmarksData,
      }

      sessionManager.saveSession(session)
      addMessage(`Session "${name}" saved successfully`)
    } catch (error) {
      console.error('[App] Failed to save session:', error)
      addMessage(`Failed to save session: ${error}`)
    } finally {
      setIsSessionLoading(false)
      setShowSessionDialog(false)
    }
  }

  const handleRestoreSession = async (name: string) => {
    setIsSessionLoading(true)
    setSessionLoadingMessage('Restoring session...')

    try {
      const session = sessionManager.getSession(name)
      if (!session) {
        addMessage(`Session "${name}" not found`)
        return
      }

      // Step 1: Close current state
      setSessionLoadingMessage('Closing current state...')
      await handleCloseKdb()
      await handleCloseWave()
      setTabs([])
      setActiveTab('')
      bookmarkManager.clearAll()

      // Step 2: Connect to server
      setSessionLoadingMessage('Connecting to server...')
      const { host, port } = session.server
      apiService.configure({ host, port, useHttps: false })
      const isConnected = await apiService.testConnection()
      setConnected(isConnected)
      
      if (!isConnected) {
        setShowConnectionDialog(true)
        addMessage('Failed to connect to server. Please enter server address.')
        return
      }

      // Step 3: Load KDB (auto-load without confirmation)
      if (session.kdb.name) {
        setSessionLoadingMessage(`Loading KDB: ${session.kdb.name}...`)
        try {
          await handleKdbSelect(session.kdb.name, false)
        } catch (error) {
          addMessage(`Failed to load KDB "${session.kdb.name}". Please load KDB manually.`)
          // Continue without KDB, user can load manually
        }
      }

      // Step 4: Load Waveform (auto-load without confirmation)
      if (session.waveform) {
        if (session.waveform.useMockData) {
          setUseMockData(true)
          addMessage('Using mock data for waveform')
        } else if (session.waveform.name) {
          setSessionLoadingMessage(`Loading waveform: ${session.waveform.name}...`)
          try {
            await handleWaveSelect(session.waveform.name)
          } catch (error) {
            addMessage(`Failed to load waveform "${session.waveform.name}". Please load waveform manually.`)
            // Continue without waveform, user can load manually
          }
        }
      }

      // Step 4.5: Restore waveform settings
      if (session.waveformSettings) {
        setCurrentWaveSignalPrefix(session.waveformSettings.signalPrefix)
        setCurrentWaveSignalSpaceBeforeBracket(session.waveformSettings.spaceBeforeBracket)
      }

      // Step 5: Restore source tabs
      setSessionLoadingMessage('Restoring source tabs...')
      const restoredTabs: Tab[] = []
      for (const sourceTab of session.sourceTabs) {
        if (sourceTab.displayModuleIndex) {
          const module = kdbManager.getModuleById(sourceTab.displayModuleIndex)
          if (module) {
            const newTab: Tab = {
              id: sourceTab.id,
              label: 'Source',
              type: 'source',
              moduleIndex: sourceTab.moduleIndex,
              displayModuleIndex: sourceTab.displayModuleIndex,
              signalDeclarationLine: sourceTab.signalDeclarationLine,
              moduleStartLine: module.definition?.startLine,
              moduleEndLine: module.definition?.endLine,
            }
            restoredTabs.push(newTab)
          }
        }
      }

      // Step 6: Restore waveform tabs
      setSessionLoadingMessage('Restoring waveform tabs...')
      for (const waveTab of session.waveformTabs) {
        // Restore nextSignalUniqueId
        nextWaveformSignalIdRef.current = waveTab.nextSignalUniqueId

        // Rebuild signals from globalIds
        const restoredGroups: Record<string, SignalGroup> = {}
        for (const [groupId, group] of Object.entries(waveTab.groups)) {
          const restoredSignals: Array<Signal & { unique_id: number }> = []
          for (const sig of group.signals) {
            const signal = kdbManager.buildSignal(sig.globalId)
            if (signal) {
              restoredSignals.push({
                ...signal,
                unique_id: sig.unique_id,
              })
            }
          }
          restoredGroups[groupId] = {
            ...group,
            signals: restoredSignals,
          }
        }

        const newTab: Tab = {
          id: waveTab.id,
          label: waveTab.label,
          type: 'waveform',
          groups: restoredGroups,
          selectedGroup: waveTab.selectedGroup,
          columnWidths: DEFAULT_COLUMN_WIDTHS,
          timeConfig: DEFAULT_TIME_CONFIG,
          waveformTimeUnit: 2, // Default to ns
        }
        restoredTabs.push(newTab)
      }

      setTabs(restoredTabs)

      // Step 7: Restore active tab
      const activeTabId = session.activeSourceTabId || session.activeWaveformTabId
      if (activeTabId && restoredTabs.find(t => t.id === activeTabId)) {
        setActiveTab(activeTabId)
      } else if (restoredTabs.length > 0) {
        setActiveTab(restoredTabs[0].id)
      }

      // Step 8: Restore bookmarks
      setSessionLoadingMessage('Restoring bookmarks...')
      for (const bookmark of session.bookmarks) {
        bookmarkManager.addBookmark({
          moduleIndex: bookmark.moduleIndex,
          fileId: bookmark.fileId,
          lineNumber: bookmark.lineNumber,
          lineContent: bookmark.lineContent,
          name: bookmark.name,
        })
      }

      console.log('[Session] Session restored successfully:', name)
      addMessage(`Session "${name}" restored successfully`)
    } catch (error) {
      console.error('[App] Failed to restore session:', error)
      addMessage(`Failed to restore session: ${error}`)
    } finally {
      setIsSessionLoading(false)
      setShowSessionDialog(false)
    }
  }

  // Use refs to store start values during resize
  const hierarchyStartWidthRef = useRef(hierarchyWidth)
  const signalStartWidthRef = useRef(signalWidth)
  const messageStartHeightRef = useRef(messageHeight)
  const isMessageDraggingRef = useRef(false)
  const isSignalPanelDraggingRef = useRef(false)
  const isHierarchyDraggingRef = useRef(false)

  // Keep refs in sync with state only when NOT dragging
  useEffect(() => {
    if (!isMessageDraggingRef.current) {
      messageStartHeightRef.current = messageHeight
    }
  }, [messageHeight])

  useEffect(() => {
    if (!isSignalPanelDraggingRef.current) {
      signalStartWidthRef.current = signalWidth
    }
  }, [signalWidth])

  useEffect(() => {
    if (!isHierarchyDraggingRef.current) {
      hierarchyStartWidthRef.current = hierarchyWidth
    }
  }, [hierarchyWidth])

  const handleMessageResizeStart = () => {
    isMessageDraggingRef.current = true
    messageStartHeightRef.current = messageHeight
  }

  const handleMessageResizeEnd = () => {
    isMessageDraggingRef.current = false
  }

  const handleSignalPanelResizeStart = () => {
    isSignalPanelDraggingRef.current = true
    signalStartWidthRef.current = signalWidth
  }

  const handleSignalPanelResizeEnd = () => {
    isSignalPanelDraggingRef.current = false
  }

  const handleHierarchyResizeStart = () => {
    isHierarchyDraggingRef.current = true
    hierarchyStartWidthRef.current = hierarchyWidth
  }

  const handleHierarchyResizeEnd = () => {
    isHierarchyDraggingRef.current = false
  }

  const handleHierarchyResize = (delta: number) => {
    // 移除最大宽度限制，只保留最小宽度
    setHierarchyWidth(Math.max(100, hierarchyStartWidthRef.current + delta))
  }

  const handleSignalPanelResize = (delta: number) => {
    // 移除最大宽度限制，只保留最小宽度
    setSignalWidth(Math.max(100, signalStartWidthRef.current + delta))
  }

  const handleMessageResize = (delta: number) => {
    setMessageHeight(Math.max(60, messageStartHeightRef.current - delta))
  }

  if (!initialized) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner"></div>
        <p>Initializing WHAT...</p>
      </div>
    )
  }

  return (
    <div className="app">
      {/* Menu Bar */}
      <MenuBar
        connected={connected}
        onConnect={() => setShowConnectionDialog(true)}
        onDisconnect={handleDisconnect}
        onOpenKdbList={() => setShowKdbSelectionDialog(true)}
        onOpenWaveList={() => setShowWaveSelectionDialog(true)}
        onCloseKdb={handleCloseKdb}
        onCloseWave={handleCloseWave}
        hasKdbLoaded={kdbLoaded}
        hasWaveLoaded={!!currentWaveName}
        infoText={menuBarInfoText}
        onOpenDebugTool={() => window.open('/test-drivers.html', '_blank', 'width=1200,height=800')}
        onSaveSession={() => {
          setSessionDialogMode('save')
          setShowSessionDialog(true)
        }}
        onRestoreSession={() => {
          setSessionDialogMode('restore')
          setShowSessionDialog(true)
        }}
      />

      {/* Tool Bar */}
      <ToolBar
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomFull={handleZoomFull}
        onSearch={() => {}}
        onAddSourceTab={() => handleAddTab('source')}
        onAddWaveformTab={() => handleAddTab('waveform')}
        onNavigatePrevious={navigatePrevious}
        onNavigateNext={navigateNext}
        canNavigatePrevious={canNavigatePrevious()}
        canNavigateNext={canNavigateNext()}
        timeConfig={activeTabData?.timeConfig}
        onTimeConfigChange={(config) => handleTimeConfigChange(activeTab, config)}
        waveformTimeUnit={activeTabData?.waveformTimeUnit ?? currentWaveTimeUnit} // Use tab's or current waveform's time unit
        maxWaveformTimeLod0={currentWaveEndTime}
        onConnect={() => setShowConnectionDialog(true)}
        onOpenKdb={() => setShowKdbSelectionDialog(true)}
        onOpenWaveform={() => setShowWaveSelectionDialog(true)}
        connected={connected}
        onRefreshCheck={handleManualRefreshCheck}
        onToggleAutoCheck={handleToggleAutoCheck}
        autoCheckEnabled={autoCheckEnabled}
        onAddBookmark={handleAddBookmark}
        viewportStart={activeTabData?.viewport?.timeStart}
        viewportEnd={activeTabData?.viewport?.timeEnd}
        cursorPosition={activeTabData?.cursorPosition}
        onViewportStartChange={handleViewportStartChange}
        onCursorPositionChange={handleCursorPositionChange}
      />

      {/* Main Content */}
      <div className="main-content">
        {/* Left Panel - Design Browser (Hierarchy) */}
        <div 
          className="left-panel hierarchy-panel"
          style={{ width: hierarchyWidth, minWidth: 100 }}
        >
          <DesignBrowser
            key={kdbLoaded ? 'kdb-loaded' : 'no-kdb'}
            onModuleSelect={handleModuleSelect}
            onModuleDoubleClick={handleModuleDoubleClick}
            onFileDoubleClick={handleFileDoubleClick}
            selectedModuleIndex={selectedModuleIndex}
            kdbLoaded={kdbLoaded}
          />
        </div>

        {/* Splitter between hierarchy and signal panel */}
        <Splitter direction="horizontal" onDrag={handleHierarchyResize} onDragStart={handleHierarchyResizeStart} onDragEnd={handleHierarchyResizeEnd} />

        {/* Middle Panel - Signal Panel */}
        <div 
          className="signal-panel"
          style={{ width: signalWidth, minWidth: 100 }}
        >
          <SignalPanel
            selectedModuleIndex={selectedModuleIndex}
            onSignalAddToWaveform={handleSignalAddToWaveform}
            onSignalDoubleClick={handleSignalDoubleClick}
            onSignalSelect={handleSignalSelect}
            activeTabType={tabs.find(t => t.id === activeTab)?.type}
          />
        </div>

        {/* Splitter between signal panel and main panel */}
        <Splitter direction="horizontal" onDrag={handleSignalPanelResize} onDragStart={handleSignalPanelResizeStart} onDragEnd={handleSignalPanelResizeEnd} />

        {/* Right Panel - Tab Panel (Source/Waveform) */}
        <div className="right-panel">
          <TabPanel
            activeTab={activeTab}
            onTabChange={setActiveTab}
            tabs={tabs}
            onTabClose={handleCloseTab}
            onTabRename={handleRenameTab}
            onTabsReorder={setTabs}
          >
            {activeTabData?.type === 'source' ? (
              <MonacoSourceCodeWindow
                key={activeTabData.id}
                moduleIndex={activeTabData.moduleIndex || null}
                displayModuleIndex={activeTabData.displayModuleIndex || null}
                fileId={activeTabData.fileId || null}
                startFromLine1={activeTabData.startFromLine1}
                signalDeclarationLine={activeTabData.signalDeclarationLine}
                moduleStartLine={activeTabData.moduleStartLine}
                moduleEndLine={activeTabData.moduleEndLine}
                moduleFullName={activeTabData.displayModuleIndex ? kdbManager.calculateModuleFullName(activeTabData.displayModuleIndex) : 
                  activeTabData.moduleIndex ? kdbManager.calculateModuleFullName(activeTabData.moduleIndex) : undefined}
                editorRef={monacoEditorRef}
                onWordClick={handleWordClick}
              />
            ) : activeTabData ? (
              <WaveformWindow
                key={activeTabData.id}
                signals={activeTabData.signals || []}
                groups={activeTabData.groups || createDefaultGroups()}
                selectedGroup={activeTabData.selectedGroup || 'group_1'}
                columnWidths={activeTabData.columnWidths}
                timeConfig={activeTabData.timeConfig}
                viewport={activeTabData.viewport}
                onViewportChange={(viewport) => {
                  // Validate viewport time range before updating
                  // Use the tab's saved waveformRange for validation
                  const sanitized = sanitizeTimeRange(
                    viewport.timeStart,
                    viewport.timeEnd,
                    activeTabData.waveformRange
                  )
                  const validatedViewport = {
                    ...viewport,
                    timeStart: sanitized.timeStart,
                    timeEnd: sanitized.timeEnd,
                  }
                  setTabs(prev => prev.map(tab =>
                    tab.id === activeTabData.id ? { ...tab, viewport: validatedViewport } : tab
                  ))
                }}
                cursorPosition={activeTabData.cursorPosition}
                onCursorPositionChange={(position) => {
                  setTabs(prev => prev.map(tab =>
                    tab.id === activeTabData.id ? { ...tab, cursorPosition: position } : tab
                  ))
                }}
                onSignalRemove={handleSignalRemove}
                onGroupsUpdate={(groups) => handleGroupsUpdate(activeTabData.id, groups)}
                onSelectedGroupUpdate={(selectedGroup) => handleSelectedGroupUpdate(activeTabData.id, selectedGroup)}
                onSignalsProcessed={(processedIds) => handleSignalsProcessed(activeTabData.id, processedIds)}
                onColumnWidthsChange={(widths) => handleColumnWidthsChange(activeTabData.id, widths)}
                useMockData={useMockData}
                serverUrl={serverUrl}
                waveformName={currentWaveName || ''}
                signalPrefix={currentWaveSignalPrefix}
                spaceBeforeBracket={currentWaveSignalSpaceBeforeBracket}
                waveformRange={activeTabData.waveformRange}
              />
            ) : null}
          </TabPanel>
        </div>
      </div>

      {/* Splitter between main content and messages */}
      <Splitter direction="vertical" onDrag={handleMessageResize} onDragStart={handleMessageResizeStart} onDragEnd={handleMessageResizeEnd} />

      {/* Bottom Panel - Messages */}
      <div 
        className="bottom-panel"
        style={{ height: messageHeight, minHeight: 60 }}
      >
        <MessageWindow messages={messages} onBookmarkClick={handleBookmarkClick} onDriverClick={handleDriverClick} />
      </div>

      {/* Connection Dialog */}
      {showConnectionDialog && (
        <ConnectionDialog
          onConnect={handleConnect}
          onClose={() => setShowConnectionDialog(false)}
        />
      )}

      {/* KDB Selection Dialog */}
      {showKdbSelectionDialog && (
        <KdbSelectionDialog
          onSelect={handleKdbSelect}
          onCancel={() => setShowKdbSelectionDialog(false)}
        />
      )}

      {/* Waveform Selection Dialog */}
      {showWaveSelectionDialog && (
        <WaveSelectionDialog
          onSelect={handleWaveSelect}
          onCancel={() => setShowWaveSelectionDialog(false)}
        />
      )}
      
      {/* File Change Confirmation Dialog */}
      {showFileChangeDialog && (
        <FileChangeDialog
          kdbChanged={pendingFileChanges.kdbChanged}
          waveChanged={pendingFileChanges.waveChanged}
          kdbName={currentKdbName}
          waveName={currentWaveName}
          onReloadKdb={handleReloadKdb}
          onReloadWave={handleReloadWave}
          onReloadBoth={handleReloadBoth}
          onCancel={() => setShowFileChangeDialog(false)}
        />
      )}
      
      {/* Mock Data Confirmation Dialog */}
      {showMockDataDialog && (
        <MockDataDialog
          onConfirm={handleMockDataConfirm}
          onCancel={handleMockDataCancel}
        />
      )}

      {/* Signal Not Found Dialog */}
      {showSignalNotFoundDialog && signalNotFoundInfo && (
        <div className="dialog-overlay" onClick={() => setShowSignalNotFoundDialog(false)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <div className="dialog-header">
              <span className="dialog-title">
                {signalNotFoundInfo.success ? 'Signal Found with Prefix Adjustment' : 'Signal Not Found'}
              </span>
              <button className="dialog-close" onClick={() => setShowSignalNotFoundDialog(false)}>×</button>
            </div>
            <div className="dialog-body">
              {signalNotFoundInfo.success ? (
                <>
                  <p>The signal was found after removing the prefix:</p>
                  <div className="form-group">
                    <label className="form-label">Original Signal</label>
                    <input type="text" className="form-input" value={signalNotFoundInfo.attempted} readOnly />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Matched Signal</label>
                    <input type="text" className="form-input" value={signalNotFoundInfo.matched} readOnly />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Removed Prefix (saved for future use)</label>
                    <input type="text" className="form-input" value={signalNotFoundInfo.prefix} readOnly />
                  </div>
                </>
              ) : (
                <>
                  <p>The signal does not exist on the server:</p>
                  <div className="form-group">
                    <label className="form-label">Attempted Signal</label>
                    <input type="text" className="form-input" value={signalNotFoundInfo.attempted} readOnly />
                  </div>
                  <div className="form-group">
                    <label className="form-label">First Available Signal on Server</label>
                    <input type="text" className="form-input" value={signalNotFoundInfo.firstAvailable} readOnly />
                  </div>
                </>
              )}
            </div>
            <div className="dialog-footer">
              <button className="btn btn-primary" onClick={() => setShowSignalNotFoundDialog(false)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Session Dialog */}
      <SessionDialog
        mode={sessionDialogMode}
        isOpen={showSessionDialog}
        onClose={() => setShowSessionDialog(false)}
        onSave={handleSaveSession}
        onRestore={handleRestoreSession}
      />

      {/* Session Loading Overlay */}
      <SessionLoadingOverlay
        isVisible={isSessionLoading}
        message={sessionLoadingMessage}
      />
    </div>
  )
}

export default App
