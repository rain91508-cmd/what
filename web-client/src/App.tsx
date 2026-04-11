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

import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import './App.css'

// Core services
import { indexedDBManager } from './core/storage/indexedDB'
import { opfsManager } from './core/storage/opfs'
import { apiService } from './services/api'
import { isOpfsAvailable } from './utils/opfsUtils'

// Modules
import { kdbManager } from './modules/knowledge/kdbManager'
import { waveManager } from './modules/wSignal'
import { searchManager } from './modules/search/searchManager'
import { performHierarchySearch, CancelToken } from './modules/search/searchService'
import { waveformSearchService, type WaveformSearchType, type WaveformSearchDirection } from './modules/search/waveformSearchService'

// Utils
import { zoomIn, zoomOut } from './utils/zoomHelpers'
import { sanitizeTimeRange } from './utils/viewport'

// WASM
import { initWasm, updateProviderSettings, setOpfsEnabled, checkOpfsSupport, setMemoryCacheEnabled as setWasmMemoryCacheEnabled, buildWasmSignals } from './wasm/waveformProvider'

// Components
import { MenuBar } from './components/MenuBar'
import { ToolBar } from './components/ToolBar'
import { DesignBrowser } from './components/DesignBrowser'
import { SignalPanel } from './components/SignalPanel'
import { TabPanel } from './components/TabPanel'
import { WaveformWindow } from './components/WaveformWindow'
import { TableViewWindow } from './components/TableViewWindow'
import { MessageWindow } from './components/MessageWindow'
import { ConnectionDialog } from './components/ConnectionDialog'
import { KdbSelectionDialog } from './components/KdbSelectionDialog'
import { WaveSelectionDialog } from './components/WaveSelectionDialog'
import { FileChangeDialog } from './components/FileChangeDialog'
import { MockDataDialog } from './components/MockDataDialog'
import { Splitter } from './components/ResizablePanel'
import { SessionDialog } from './components/SessionDialog'
import { SessionLoadingOverlay } from './components/SessionLoadingOverlay'

// Lazy load Monaco editor to reduce initial bundle size
const MonacoSourceCodeWindow = lazy(() => import('./components/MonacoSourceCodeWindow'))

// Contexts
import { WaveformProviderProvider, useWaveformProvider } from './contexts/WaveformProviderContext'

// Bookmark
import { bookmarkManager, type Bookmark } from './types/bookmark'
import type { Wavemark } from './types/wavemark'
import type { SearchResultGroup, SearchResultItem } from './types/search'

// Session
import { sessionManager } from './modules/session/sessionManager'
import type { Session } from './types/session'
import { SESSION_VERSION } from './types/session'

// Types
import type { Signal } from './types/kdb'
import type { WaveformInfo, ColumnWidths, TimeConfig, Tab, NavigationHistoryEntry, SignalGroup } from './components/TabPanel'
import { initTimeConfig, parseTimeUnitStr } from './components/TabPanel'
import type { SignalWithFormat, RawSignalValuesResult } from './core/waveformProviderInterface'
import type { DisplayFormat } from './core/waveformProviderInterface'

// i18n
import { useT } from './i18n'

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
  const { t } = useT()
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
  const [serverUrl, setServerUrl] = useState<string>('')
  const [currentKdbName, setCurrentKdbName] = useState<string | null>(null)
  const [currentKdbChecksum, setCurrentKdbChecksum] = useState<string | null>(null)
  const [currentWaveName, setCurrentWaveName] = useState<string | null>(null)
  const [currentWaveChecksum, setCurrentWaveChecksum] = useState<string | null>(null)
  const [currentWaveTimeStamp, setCurrentWaveTimeStamp] = useState<number>(0)  // Waveform modification timestamp for CDN cache
  const [currentWaveSignalPrefix, setCurrentWaveSignalPrefix] = useState<string>('')  // Local signal prefix (removed from local signal name)
  const [currentWaveSignalServerPrefix, setCurrentWaveSignalServerPrefix] = useState<string>('')  // Server signal prefix (added to server signal name)
  const [currentWaveSignalSpaceBeforeBracket, setCurrentWaveSignalSpaceBeforeBracket] = useState<boolean>(false)  // Whether to add space before [msb:lsb]
  const [currentWaveTimeUnit, setCurrentWaveTimeUnit] = useState<number>(2)  // Waveform time unit enum (0=fs, 1=ps, 2=ns, etc.)
  const [currentWaveEndTime, setCurrentWaveEndTime] = useState<number>(1000000)  // Waveform end time in LoD0 units (time_unit)
  const [currentWaveDisplayUnitPerLoD0, setCurrentWaveDisplayUnitPerLoD0] = useState<number>(1)  // DisplayUnit per LoD0Unit
  const [currentWaveCustomRange, setCurrentWaveCustomRange] = useState<{ start: number; end: number } | undefined>(undefined)  // User custom time range
  const [selectedDisplayUnit, setSelectedDisplayUnit] = useState<'fs' | 'ps' | 'ns' | 'us' | 'ms' | 's'>('ns')  // Global display unit selection (shared across all tabs)
  const [tableViewRefreshTrigger, setTableViewRefreshTrigger] = useState<number>(0)  // Trigger TableView data refresh
  const [autoCheckEnabled, setAutoCheckEnabled] = useState(false)
  const autoCheckIntervalRef = useRef<NodeJS.Timeout | null>(null)
  
  // Health check interval ref
  const healthCheckIntervalRef = useRef<NodeJS.Timeout | null>(null)
  
  // File change dialog state
  const [showFileChangeDialog, setShowFileChangeDialog] = useState(false)
  const [pendingFileChanges, setPendingFileChanges] = useState<{ kdbChanged: boolean; waveChanged: boolean }>({ kdbChanged: false, waveChanged: false })

  // Mock data state for waveform when no real wave file is loaded
  const [useMockData, setUseMockData] = useState(false)

  const [showMockDataDialog, setShowMockDataDialog] = useState(false)
  const [pendingMockSignal, setPendingMockSignal] = useState<Signal | null>(null)

  // Signal not found dialog state
  const [showSignalNotFoundDialog, setShowSignalNotFoundDialog] = useState(false)
  const [signalNotFoundInfo, setSignalNotFoundInfo] = useState<{
    attempted: string;
    matched: string;
    prefix: string;  // local prefix
    serverPrefix: string;  // server prefix
    spaceBeforeBracket: boolean;  // whether there's a space before bracket
    firstAvailable: string;
    success: boolean;
    // For multiple server prefix selection
    allMatches?: Array<{
      serverPrefix: string;
      matchedNames: string[];
      localPrefix: string;
      spaceBeforeBracket: boolean;
    }>;
    selectedMatchIndex?: number;
  } | null>(null)
  // Store pending signal to add after user confirms in dialog
  const [pendingSignalToAdd, setPendingSignalToAdd] = useState<Signal | null>(null)
  // Store the tab type for the pending signal (waveform or tableview)
  const [pendingSignalTabType, setPendingSignalTabType] = useState<'waveform' | 'tableview' | null>(null)

  // Session dialog state
  const [showSessionDialog, setShowSessionDialog] = useState(false)
  const [sessionDialogMode, setSessionDialogMode] = useState<'save' | 'restore'>('save')
  const [isSessionLoading, setIsSessionLoading] = useState(false)
  const [sessionLoadingMessage, setSessionLoadingMessage] = useState('')
  
  // Global selected module index for hierarchy/signal panel (1-based)
  const [selectedModuleIndex, setSelectedModuleIndex] = useState<number | null>(null)
  
  // Expanded modules in hierarchy panel (1-based module indices)
  const [expandedModules, setExpandedModules] = useState<Set<number>>(new Set())

  // Pagination state for hierarchy panel: nodeId -> { startPosition, pageSize }
  const [hierarchyPagination, setHierarchyPagination] = useState<Map<number, { startPosition: number; pageSize: number }>>(new Map())

  // Pending signal to select in Signal Panel (from drag-drop)
  const [pendingSelectedSignal, setPendingSelectedSignal] = useState<number | null>(null)

  // Info text for MenuBar (full hierarchy name)
  const [menuBarInfoText, setMenuBarInfoText] = useState<string>('')
  
  // OPFS Cache enabled state
  const [opfsCacheEnabled, setOpfsCacheEnabled] = useState<boolean>(() => {
    // Check localStorage for saved preference, default to false
    const saved = localStorage.getItem('opfs_cache_enabled');
    return saved === 'true' && checkOpfsSupport();
  })

  // Memory LRU Cache enabled state
  const [memoryCacheEnabled, setMemoryCacheEnabled] = useState<boolean>(() => {
    // Check localStorage for saved preference, default to true
    const saved = localStorage.getItem('memory_cache_enabled');
    return saved !== 'false'; // Default to true if not set
  })
  
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
  // Separate counters for each tab type to ensure correct numbering
  const tabCounters = useRef({
    source: 1,
    waveform: 1,
    tableview: 1,
  })
  
  // Global counter for waveform signal unique_id (starts from 1, increments forever)
  const nextWaveformSignalIdRef = useRef(1)

  // Ref for Monaco editor to get current cursor position
  const monacoEditorRef = useRef<any>(null)

  // Get current active tab data
  const activeTabData = tabs.find(t => t.id === activeTab)

  // Get shared waveform provider
  const { provider: waveformProvider, isLoading: isProviderLoading } = useWaveformProvider()

  // Get last active waveform tab's cursor time
  const getLastActiveWaveformCursorTime = useCallback((): number | undefined => {
    // First, check if there's a currently active waveform tab
    const currentWaveformTab = tabs.find(t =>
      t.id === activeTab && t.type === 'waveform'
    )

    if (currentWaveformTab?.cursorPosition !== undefined) {
      return currentWaveformTab.cursorPosition
    }

    // If no current waveform tab, find the most recent one with cursorPosition
    // Sort by last access time or just find any waveform tab with cursorPosition
    for (let i = tabs.length - 1; i >= 0; i--) {
      const tab = tabs[i]
      if (tab.type === 'waveform' && tab.cursorPosition !== undefined) {
        return tab.cursorPosition
      }
    }

    return undefined
  }, [tabs, activeTab])

  // Build signal radix map from active waveform tab
  const getSignalRadixMap = useCallback((): Map<string, DisplayFormat> => {
    const radixMap = new Map<string, DisplayFormat>()

    // Find active waveform tab
    const activeWaveformTab = tabs.find(t =>
      t.id === activeTab && t.type === 'waveform'
    )

    if (activeWaveformTab?.signals && activeWaveformTab?.signalDisplayFormats) {
      for (const signal of activeWaveformTab.signals) {
        const format = activeWaveformTab.signalDisplayFormats[signal.unique_id]
        if (format) {
          radixMap.set(signal.name, format)
        }
      }
    }

    return radixMap
  }, [tabs, activeTab])

  // Get view range from active waveform tab
  const getWaveformViewRange = useCallback((): { start: number; end: number } | undefined => {
    // Find active waveform tab
    const activeWaveformTab = tabs.find(t =>
      t.id === activeTab && t.type === 'waveform'
    )

    if (activeWaveformTab?.viewport) {
      return {
        start: activeWaveformTab.viewport.timeStart,
        end: activeWaveformTab.viewport.timeEnd
      }
    }

    // If no current waveform tab, find the most recent one with viewport
    for (let i = tabs.length - 1; i >= 0; i--) {
      const tab = tabs[i]
      if (tab.type === 'waveform' && tab.viewport) {
        return {
          start: tab.viewport.timeStart,
          end: tab.viewport.timeEnd
        }
      }
    }

    return undefined
  }, [tabs, activeTab])
  
  // Panel sizes
  const [hierarchyWidth, setHierarchyWidth] = useState(300)
  const [signalWidth, setSignalWidth] = useState(250)
  const [messageHeight, setMessageHeight] = useState(180)
  
  // Left panel visibility state
  const [isLeftPanelVisible, setIsLeftPanelVisible] = useState(true)
  const savedLeftPanelWidthRef = useRef(550) // Save total width of left panels (hierarchy + signal + splitters)
  
  // Ref for main content container to calculate available space
  const mainContentRef = useRef<HTMLDivElement>(null)

  // Hierarchy Search state
  const [searchPattern, setSearchPattern] = useState('')
  const [searchHistory, setSearchHistory] = useState<string[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchSignals, setSearchSignals] = useState(false)
  const [searchResults, setSearchResults] = useState<SearchResultGroup[]>([])
  const cancelTokenRef = useRef<CancelToken | null>(null)

  // Waveform Search state
  const [waveformSearchType, setWaveformSearchType] = useState<WaveformSearchType>('value')
  const [waveformEdgeType, setWaveformEdgeType] = useState<'rising' | 'falling' | 'any'>('any')
  const [waveformFromValue, setWaveformFromValue] = useState('')
  const [waveformToValue, setWaveformToValue] = useState('')
  const [isWaveformSearching, setIsWaveformSearching] = useState(false)
  // Waveform search history
  const [waveformFromValueHistory, setWaveformFromValueHistory] = useState<string[]>([])
  const [waveformToValueHistory, setWaveformToValueHistory] = useState<string[]>([])

  // Track if OPFS warning has been shown (to prevent double alert in StrictMode)
  const opfsWarningShown = useRef(false)

  // Initialize application
  useEffect(() => {
    const init = async () => {
      try {
        // Check OPFS availability first (only show warning once)
        if (!isOpfsAvailable() && !opfsWarningShown.current) {
          opfsWarningShown.current = true
          console.warn('[App] OPFS not available - using memory fallback')
          
          // Detect browser language
          const userLang = navigator.language || navigator.languages[0] || 'en'
          const isChinese = userLang.startsWith('zh')
          
          // Show warning to user based on language
          const message = isChinese
            ? '⚠️ 本地存储(OPFS)不可用\n\n' +
              '当前访问方式无法使用本地缓存功能，大量数据将存储在内存中。\n\n' +
              '建议：\n' +
              '• 使用 https:// 协议访问\n' +
              '• 或使用 localhost 访问\n\n' +
              '点击"确定"继续使用，点击"取消"查看帮助。'
            : '⚠️ Local Storage (OPFS) Unavailable\n\n' +
              'Your current access method cannot use local cache. Large amounts of data will be stored in memory.\n\n' +
              'Recommendations:\n' +
              '• Use https:// protocol\n' +
              '• Or use localhost\n\n' +
              'Click "OK" to continue, or "Cancel" for help.'
          
          const useHttps = window.confirm(message)
          if (!useHttps) {
            window.open('https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system', '_blank')
          }
        }

        // Update loading progress
        const updateProgress = (progress: number, text: string) => {
          const progressEl = document.getElementById('loading-progress')
          const barEl = document.getElementById('progress-bar-fill')
          if (progressEl) progressEl.textContent = text
          if (barEl) barEl.style.width = `${progress}%`
        }

        // Initialize WASM module (30% of loading time)
        updateProgress(10, 'Loading WASM module...')
        await initWasm()
        console.log('[App] WASM initialized')
        
        // Initialize storage layers (60% of loading time)
        updateProgress(40, 'Initializing storage...')
        await indexedDBManager.initialize()
        if (opfsManager.isSupported()) {
          await opfsManager.initialize()
        }
        
        updateProgress(80, 'Preparing application...')

        // Initialize storage layers but don't auto-connect to server
        // Server starts in disconnected state - user must manually connect
        setConnected(false)
        addMessage(`${t('messages.appInitialized')} - ${t('messages.pleaseConnect')}`)

        // Don't restore previous connection automatically
        // User can manually connect via Connect button

        setInitialized(true)
        
        // Hide initial loader after React is ready
        const loader = document.getElementById('initial-loader')
        if (loader) {
          loader.classList.add('hidden')
          // Remove from DOM after transition
          setTimeout(() => {
            loader.remove()
          }, 500)
        }
        
        // Preload WASM files in background after main UI is ready
        preloadWasmFiles()
      } catch (error) {
        console.error('Initialization error:', error)
        addMessage(`Initialization error: ${error}`)
        setInitialized(true)
        
        // Hide loader even on error
        const loader = document.getElementById('initial-loader')
        if (loader) {
          loader.classList.add('hidden')
          setTimeout(() => {
            loader.remove()
          }, 500)
        }
      }
    }

    init()
  }, [])

  // Preload WASM files in background
  const preloadWasmFiles = useCallback(async () => {
    const base = import.meta.env.BASE_URL || '/'
    const wasmFiles = [
      `${base}wasm-pkg/hwda_wasm_bg.wasm`.replace(/\/+/g, '/'),
      `${base}wasm-pkg/hwda_wasm.js`.replace(/\/+/g, '/')
    ]
    
    console.log('[App] Preloading WASM files in background...')
    
    for (const file of wasmFiles) {
      try {
        const link = document.createElement('link')
        link.rel = 'prefetch'
        link.href = file
        link.as = file.endsWith('.wasm') ? 'fetch' : 'script'
        link.crossOrigin = 'anonymous'
        document.head.appendChild(link)
        console.log(`[App] Prefetching: ${file}`)
      } catch (error) {
        console.warn(`[App] Failed to prefetch ${file}:`, error)
      }
    }
  }, [])

  // Toggle OPFS cache
  const handleToggleOpfs = useCallback(() => {
    const newValue = !opfsCacheEnabled;
    setOpfsCacheEnabled(newValue);
    setOpfsEnabled(newValue);
    localStorage.setItem('opfs_cache_enabled', newValue.toString());
    // Use setTimeout to avoid circular dependency with addMessage
    setTimeout(() => {
      addMessage(`OPFS Cache ${newValue ? 'enabled' : 'disabled'}`);
    }, 0);
  }, [opfsCacheEnabled]);

  const handleToggleMemoryCache = useCallback(() => {
    const newValue = !memoryCacheEnabled;
    setMemoryCacheEnabled(newValue);  // Update React state
    setWasmMemoryCacheEnabled(newValue);  // Call WASM function
    localStorage.setItem('memory_cache_enabled', newValue.toString());
    // Use setTimeout to avoid circular dependency with addMessage
    setTimeout(() => {
      addMessage(`Memory Cache ${newValue ? 'enabled' : 'disabled'}`);
    }, 0);
  }, [memoryCacheEnabled]);

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
      const sourceCounter = tabCounters.current.source++
      const newId = `source-${sourceCounter}`;
      const newTab: Tab = {
        id: newId,
        label: `Source ${sourceCounter}`,
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
  
  // Add bookmark at current source position or wavemark at current waveform position
  const handleAddBookmark = useCallback(async () => {
    // Check if there's an active source tab
    const activeSourceTab = tabs.find(t => t.type === 'source' && t.id === activeTab);
    const activeWaveformTab = tabs.find(t => t.type === 'waveform' && t.id === activeTab);
    
    // Handle waveform tab - create wavemark
    if (activeWaveformTab) {
      // Get current cursor position
      const cursorPosition = activeWaveformTab.cursorPosition;
      if (cursorPosition === undefined) {
        addMessage('No cursor position to create wavemark');
        return;
      }
      
      // Get expanded groups
      const groups = activeWaveformTab.groups || {};
      const expandedGroups = Object.values(groups)
        .filter(g => g.expanded)
        .map(g => g.id);
      
      // Generate wavemark name (Wavemark N)
      const existingWavemarks = activeWaveformTab.wavemarks || [];
      const wavemarkNumber = existingWavemarks.length + 1;
      const wavemarkName = `Wavemark ${wavemarkNumber}`;
      
      // Create wavemark with default color
      const newWavemark: Wavemark = {
        id: `wavemark_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: wavemarkName,
        time: cursorPosition,
        createdAt: Date.now(),
        color: '#ff6600', // Default orange color
        expandedGroups: expandedGroups,
      };
      
      // Add to tab's wavemarks
      setTabs(prev => prev.map(tab =>
        tab.id === activeTab ? {
          ...tab,
          wavemarks: [...(tab.wavemarks || []), newWavemark],
        } : tab
      ));
      
      addMessage(`Added wavemark: ${newWavemark.name} at time ${cursorPosition}`);
      return;
    }
    
    // Handle source tab - create bookmark
    if (!activeSourceTab) {
      addMessage('No active source or waveform tab to bookmark');
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
  
  // Handle wavemark click - jump to waveform position and restore group expansion
  const handleWavemarkClick = useCallback((wavemark: Wavemark) => {
    const activeWaveformTab = tabs.find(t => t.type === 'waveform' && t.id === activeTab);
    if (!activeWaveformTab) return;
    
    // Center the viewport on the wavemark time
    const timeSpan = activeWaveformTab.viewport 
      ? activeWaveformTab.viewport.timeEnd - activeWaveformTab.viewport.timeStart 
      : 1000;
    const newViewport = {
      timeStart: wavemark.time - timeSpan / 2,
      timeEnd: wavemark.time + timeSpan / 2,
    };
    
    // Update groups expansion state
    const groups = activeWaveformTab.groups || {};
    const updatedGroups = Object.entries(groups).reduce((acc, [id, group]) => {
      acc[id] = {
        ...group,
        expanded: wavemark.expandedGroups.includes(id),
      };
      return acc;
    }, {} as Record<string, typeof groups[string]>);
    
    // Update tab with new viewport, cursor position, and group states
    setTabs(prev => prev.map(tab =>
      tab.id === activeTab ? {
        ...tab,
        viewport: newViewport,
        cursorPosition: wavemark.time,
        groups: updatedGroups,
      } : tab
    ));
    
    addMessage(`Jump to wavemark: ${wavemark.name} at time ${wavemark.time}`);
  }, [activeTab, tabs, addMessage]);
  
  // Handle wavemark delete
  const handleWavemarkDelete = useCallback((wavemarkId: string) => {
    setTabs(prev => prev.map(tab =>
      tab.id === activeTab ? {
        ...tab,
        wavemarks: (tab.wavemarks || []).filter(w => w.id !== wavemarkId),
      } : tab
    ));
    addMessage('Wavemark deleted');
  }, [activeTab, addMessage]);
  
  // Handle wavemark rename
  const handleWavemarkRename = useCallback((wavemarkId: string, newName: string) => {
    setTabs(prev => prev.map(tab =>
      tab.id === activeTab ? {
        ...tab,
        wavemarks: (tab.wavemarks || []).map(w =>
          w.id === wavemarkId ? { ...w, name: newName } : w
        ),
      } : tab
    ));
  }, [activeTab]);
  
  // Handle wavemark color change
  const handleWavemarkColorChange = useCallback((wavemarkId: string, newColor: string) => {
    setTabs(prev => prev.map(tab =>
      tab.id === activeTab ? {
        ...tab,
        wavemarks: (tab.wavemarks || []).map(w =>
          w.id === wavemarkId ? { ...w, color: newColor as import('./types/wavemark').WavemarkColor } : w
        ),
      } : tab
    ));
  }, [activeTab]);
  
  // Handle wavemark expanded groups change
  const handleWavemarkGroupsChange = useCallback((wavemarkId: string, newGroups: string[]) => {
    setTabs(prev => prev.map(tab =>
      tab.id === activeTab ? {
        ...tab,
        wavemarks: (tab.wavemarks || []).map(w =>
          w.id === wavemarkId ? { ...w, expandedGroups: newGroups } : w
        ),
      } : tab
    ));
  }, [activeTab]);

  // ============================================
  // Search Functionality
  // ============================================

  // Subscribe to search manager updates
  useEffect(() => {
    const unsubscribe = searchManager.subscribe(() => {
      setSearchResults(searchManager.getSearchResults());
      setSearchHistory(searchManager.getSearchHistory().map(h => h.pattern));
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Execute search
  const handleSearchExecute = useCallback(async () => {
    if (!searchPattern.trim()) {
      addMessage('Please enter a search pattern');
      return;
    }

    // Check if in hierarchy search mode (no tabs or source tab active)
    const isHierarchyMode = tabs.length === 0 || activeTabData?.type === 'source';

    if (!isHierarchyMode) {
      addMessage('Hierarchy search is only available when no tabs are open or a source tab is active');
      return;
    }

    // Get selected hierarchy node as starting point
    const startModuleIndex = selectedModuleIndex || 0;

    if (startModuleIndex === 0) {
      addMessage('Please select a module in the hierarchy panel as the search starting point');
      return;
    }

    setIsSearching(true);

    // Create cancel token
    const cancelToken = new CancelToken();
    cancelTokenRef.current = cancelToken;

    try {
      addMessage(`Starting search for "${searchPattern}"...`);

      // Perform search with async batching
      const results = await performHierarchySearch({
        pattern: searchPattern,
        isSignalSearch: searchSignals,
        startModuleIndex,
        maxResults: 100,
        shouldCancel: () => cancelToken.isCancelled,
      });

      if (cancelToken.isCancelled) {
        addMessage('Search cancelled');
        setIsSearching(false);
        return;
      }

      // Create search result group
      const resultGroup = {
        id: `search_${Date.now()}`,
        pattern: searchPattern,
        timestamp: Date.now(),
        isSignalSearch: searchSignals,
        resultCount: results.length,
        results: results,
      };

      // Add to search manager
      searchManager.addSearchResult(resultGroup);
      searchManager.addToHistory(searchPattern, searchSignals);

      // Update state
      setSearchResults(searchManager.getSearchResults());
      setSearchHistory(searchManager.getSearchHistory().map(h => h.pattern));

      addMessage(`Search completed: found ${results.length} results for "${searchPattern}"`);
    } catch (error) {
      addMessage(`Search error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsSearching(false);
      cancelTokenRef.current = null;
    }
  }, [searchPattern, searchSignals, tabs.length, activeTabData?.type, selectedModuleIndex, addMessage]);

  // Cancel search
  const handleSearchCancel = useCallback(() => {
    cancelTokenRef.current?.cancel();
  }, []);

  // Handle search result click (double click)
  const handleSearchResultClick = useCallback(async (result: SearchResultItem) => {
    if (result.type === 'module') {
      // For instance: 
      // - displayModuleId = parent module (for grey out)
      // - selectedModuleId = result module
      // - startFromLine & fileId = result module's definition
      const moduleInfo = kdbManager.getModuleById(result.globalId);
      if (!moduleInfo) {
        addMessage(`Module not found: ${result.fullName}`);
        return;
      }

      const definition = moduleInfo.definition;
      const fileId = definition?.fileId;
      const lineNumber = definition?.startLine; // Use startLine for module definition start

      if (!fileId) {
        addMessage(`No definition file found for module: ${result.fullName}`);
        return;
      }

      // Set parent as display module, result as selected module
      await setSourceDisplay({
        displayModuleId: result.parentModuleIndex || result.globalId,
        selectedModuleId: result.globalId,
        startFromLine: lineNumber,
        fileId: fileId,
        addToHistory: true,
      });
      addMessage(`Jump to module: ${result.fullName} (line ${lineNumber})`);
    } else if (result.type === 'signal') {
      // For signal: 
      // - displayModuleId = parent module (correct)
      // - selectedModuleId = parent module (correct)
      // - startFromLine & fileId = from signal.declaration (same as driver)
      const signal = kdbManager.buildSignal(result.globalId);
      if (!signal) {
        addMessage(`Signal not found: ${result.fullName}`);
        return;
      }

      // Get parent module info
      const parentModuleId = signal.parentModuleId;
      const parentModule = kdbManager.getModuleById(parentModuleId);

      if (!parentModule) {
        addMessage(`Parent module not found for signal: ${signal.name}`);
        return;
      }

      // Get file ID and line from signal.declaration (same as driver)
      const signalDef = signal.declaration;
      const fileId = signalDef?.fileId;
      const lineNumber = signalDef?.line;

      if (!fileId) {
        addMessage(`File not found for signal: ${signal.name}`);
        return;
      }

      // Set parent module as display module and jump to signal declaration
      await setSourceDisplay({
        displayModuleId: parentModuleId,
        selectedModuleId: parentModuleId,
        startFromLine: lineNumber,
        fileId: fileId,
        addToHistory: true,
      });
      addMessage(`Jump to signal: ${signal.name} (line ${lineNumber})`);
    }
  }, [setSourceDisplay, addMessage]);

  // Handle search result delete
  const handleSearchResultDelete = useCallback((searchId: string) => {
    searchManager.deleteSearchResult(searchId);
    setSearchResults(searchManager.getSearchResults());
  }, []);

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
      setServerUrl(apiService.getBaseUrl())
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
    setCurrentWaveTimeStamp(waveTimeStamp)  // Set waveform modification timestamp
    setCurrentWaveSignalPrefix('')  // Clear previous local prefix
    setCurrentWaveSignalServerPrefix('')  // Clear previous server prefix
    setCurrentWaveSignalSpaceBeforeBracket(false)  // Clear previous space setting
    setCurrentWaveTimeUnit(waveTimeUnit)  // Set time unit from waveform
    setCurrentWaveEndTime(waveEndTime)  // Set end time from waveform
    setCurrentWaveDisplayUnitPerLoD0(displayUnitPerLoD0Unit)  // Set display unit ratio
    setCurrentWaveCustomRange(customRange)  // Save user custom range (if any)

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
    setCurrentWaveSignalPrefix('')  // Clear local signal prefix when closing waveform
    setCurrentWaveSignalServerPrefix('')  // Clear server signal prefix when closing waveform
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
      const sourceCounter = tabCounters.current.source++
      const newId = `source-${sourceCounter}`
      const newTab: Tab = {
        id: newId,
        label: `Source ${sourceCounter}`,
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

  // Handle double-click on signal in waveform window
  // Uses globalId to build full signal info and jump to declaration
  const handleWaveformSignalDoubleClick = (signal: Signal & { unique_id: number }) => {
    console.log('[App] handleWaveformSignalDoubleClick called, signal:', signal.name, 'globalId:', signal.globalId);

    // Use kdbManager to build full signal info from globalId
    const fullSignal = kdbManager.buildSignal(signal.globalId);
    if (!fullSignal) {
      addMessage(`Cannot find signal info for ${signal.name}`);
      return;
    }
    
    if (!fullSignal.declaration) {
      addMessage(`No declaration info for ${signal.name}`);
      return;
    }
    
    const line = fullSignal.declaration.line;
    const fileId = fullSignal.declaration.fileId;
    
    // Determine display range based on signal's parent module
    let displayStartLine: number | undefined;
    let displayEndLine: number | undefined;
    let displayModuleIndex = fullSignal.parentModuleId;
    
    // Get the parent module of this signal
    const parentModuleId = fullSignal.parentModuleId;
    if (parentModuleId > 0) {
      const parentModule = kdbManager.getModuleById(parentModuleId);
      
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
    
    console.log('[App] Waveform signal display range:', displayStartLine, '-', displayEndLine, 'for parentModuleId:', parentModuleId);
    
    // Always create a new source tab (simplified approach)
    const sourceCounter = tabCounters.current.source++;
    const newId = `source-${sourceCounter}`;
    const newTab: Tab = {
      id: newId,
      label: `Source ${sourceCounter}`,
      type: 'source',
      moduleIndex: displayModuleIndex,
      displayModuleIndex: displayModuleIndex,
      signalDeclarationLine: line,
      moduleStartLine: displayStartLine,
      moduleEndLine: displayEndLine,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTab(newId);
    
    // Add navigation entry after tab is created
    setTimeout(() => addNavigationEntry(fileId, line, displayModuleIndex), 0);
    addMessage(`Open source at ${signal.name} declaration (line ${line})`);
  };

  // Calculate module chain from root to target module
  const getModuleChain = (targetModuleId: number): number[] => {
    const chain: number[] = [];
    let currentId = targetModuleId;

    while (currentId > 0) {
      chain.unshift(currentId); // Add to beginning to maintain root -> child order
      const module = kdbManager.getModuleById(currentId);
      currentId = module?.parentModuleId || 0;
    }

    return chain; // [rootModule, childModule, ..., targetModule]
  };

  // Expand hierarchy to target module (reuses session manager mechanism)
  const expandHierarchyToModule = useCallback((targetModuleId: number) => {
    console.log('[App] Expanding hierarchy to module:', targetModuleId);

    // 1. Calculate all modules to expand (from root to target)
    const chain = getModuleChain(targetModuleId);
    console.log('[App] Module chain:', chain);

    // 2. Update expandedModules (triggers DesignBrowser useEffect)
    setExpandedModules(prev => {
      const newExpanded = new Set(prev);
      chain.forEach(id => newExpanded.add(id));
      return newExpanded;
    });

    // 3. Set selected module
    setSelectedModuleIndex(targetModuleId);
  }, []);

  // Handle signal drop from waveform to signal panel
  const handleSignalDropFromWaveform = useCallback((signalData: {
    globalId: number;
    parentModuleId: number;
    name: string;
    fullName: string;
  }) => {
    console.log('[App] Signal dropped from waveform:', signalData);

    if (!kdbManager.isLoaded()) {
      addMessage('KDB not loaded, cannot navigate to signal');
      return;
    }

    // 1. Expand hierarchy to signal's parent module
    if (signalData.parentModuleId > 0) {
      expandHierarchyToModule(signalData.parentModuleId);
    }

    // 2. Set pending signal to select (for SignalPanel highlight)
    setPendingSelectedSignal(signalData.globalId);
  }, [expandHierarchyToModule]);

  const handleSignalSelect = async (signal: Signal) => {
    console.log('[App] handleSignalSelect called:', signal?.name, 'activeTab:', activeTab);

    // Update MenuBar info text with signal's full hierarchy name
    setMenuBarInfoText(signal.fullName)

    // Store selected signal in active tab for waveform search
    const currentTab = tabs.find(t => t.id === activeTab)
    console.log('[App] Current tab:', currentTab?.type, currentTab?.id);

    if (currentTab?.type === 'waveform') {
      console.log('[App] Storing selected signal in tab:', signal.name);
      setTabs(prev => prev.map(tab =>
        tab.id === activeTab ? {
          ...tab,
          selectedSignal: signal
        } : tab
      ))
    } else if (currentTab?.type === 'tableview') {
      // For tableview, only select the signal on click (add is on double-click via onSignalAddToTableView)
      console.log('[App] Tableview tab selected signal:', signal.name);
    } else {
      console.log('[App] Not a waveform/tableview tab, skipping selectedSignal storage');
    }
  }

  // Convert local signal name to server signal name (similar to WASM local_to_server_name)
  const convertSignalNameForServer = (
    localName: string,
    signalPrefix: string,
    serverPrefix: string,
    spaceBeforeBracket: boolean
  ): string => {
    // Step 1: Remove local prefix (e.g., "work@tb_top.u_dut.signal" -> "tb_top.u_dut.signal")
    let serverName = localName
    if (signalPrefix && localName.startsWith(signalPrefix)) {
      serverName = localName.slice(signalPrefix.length)
    }
    
    // Step 2: Add server prefix (e.g., "tb_top.u_dut.signal" -> "server@tb_top.u_dut.signal")
    if (serverPrefix) {
      serverName = serverPrefix + serverName
    }
    
    // Step 3: Add space before bracket if needed (e.g., "signal[7:0]" -> "signal [7:0]")
    if (spaceBeforeBracket) {
      serverName = serverName.replace(/\[/g, ' [').replace(/\]\]/g, ']')
    }
    
    return serverName
  }

  // Add signal to TableView tab directly (after user confirms in dialog)
  const addSignalToTableViewDirect = (signal: Signal) => {
    // Generate unique_id for this signal instance
    const unique_id = nextWaveformSignalIdRef.current++

    // Add signal to the active tableview tab
    // Store original signal name (not converted), WASM will handle conversion using prefix settings
    setTabs(prev => prev.map(tab => {
      if (tab.id === activeTab && tab.type === 'tableview') {
        const currentSignals = tab.tableSignals || []
        // Check if signal already exists (by original full name)
        const exists = currentSignals.some(s => s.name === signal.fullName)
        if (!exists) {
          // Create SignalWithFormat for TableView
          // Store original name, WASM will convert using tab's prefix settings
          const newSignal = {
            globalId: signal.globalId,
            name: signal.fullName, // Store original name, WASM will convert
            row: currentSignals.length,
            width: Math.abs(signal.msb - signal.lsb) + 1,
            drawSigId: signal.globalId, // Will be updated by buildWasmSignals
            displayFormat: 'hex' as const, // Default format
          }
          return { ...tab, tableSignals: [...currentSignals, newSignal] }
        }
      }
      return tab
    }))

    addMessage(`Added signal to tableview: ${signal.name} (ID: ${unique_id})`)
  }

  // Handle signal add to TableView with dialog (similar to handleSignalAddToWaveform)
  const handleSignalAddToTableView = async (signal: Signal) => {
    if (!currentWaveName) {
      addMessage('No waveform loaded')
      return
    }

    // Get current active tab's prefix settings
    const activeTabData = tabs.find(t => t.id === activeTab && t.type === 'tableview')
    const tabSignalPrefix = activeTabData?.signalPrefix
    const tabServerPrefix = activeTabData?.serverPrefix
    const tabSpaceBeforeBracket = activeTabData?.spaceBeforeBracket

    // Check if this tab has its own prefix settings
    const hasTabPrefixSettings = tabSignalPrefix !== undefined && tabSignalPrefix !== ''

    // If waveform is loaded from server, verify signal exists
    if (currentWaveName && apiService.isConnected()) {
      try {
        // If this tab already has its own prefix settings, use them directly
        if (hasTabPrefixSettings) {
          const result = await searchSignalOnServer(currentWaveName, signal.fullName, tabSignalPrefix)

          if (result.found) {
            // Check if multiple server prefixes found
            if (result.multipleServerPrefixes && result.matchedNames && result.matchedNames.length > 0) {
              // Multiple server prefixes - need to check if our saved one is among them
              const savedServerPrefix = tabServerPrefix
              const matchingWithSavedPrefix = result.matchedNames.filter(name =>
                savedServerPrefix ? name.startsWith(savedServerPrefix) : true
              )
            }

            // Signal found with existing prefix - AUTO ADD (no confirmation needed)
            // Only update spaceBeforeBracket if this signal has bit width (has '[')
            const signalHasBitWidth = signal.fullName.includes('[')
            if (signalHasBitWidth && result.spaceBeforeBracket !== undefined && result.spaceBeforeBracket !== tabSpaceBeforeBracket) {
              // Update tab's settings
              setTabs(prev => prev.map(tab =>
                tab.id === activeTab ? { ...tab, spaceBeforeBracket: result.spaceBeforeBracket } : tab
              ))
            }

            // Auto add signal without confirmation
            addSignalToTableViewDirect(signal)
            return
          }
          // If not found with existing prefix, fall through to try finding new prefix
        }

        // Try to find signal with prefix removal
        const result = await tryFindSignalWithPrefixRemoval(currentWaveName, signal.fullName)

        if (result.found) {
          // Check if multiple server prefixes found - need user selection
          if (result.multipleServerPrefixes && result.allMatches && result.allMatches.length > 1) {

            // Show selection dialog with all matches
            const firstSignalResponse = await apiService.getWaveformSignals(currentWaveName, {
              limit: 1
            })
            const firstSignalName = firstSignalResponse.status === 'success' &&
              firstSignalResponse.data &&
              firstSignalResponse.data.signals.length > 0
              ? firstSignalResponse.data.signals[0].name
              : 'N/A'

            const allMatchesForDialog = result.allMatches.map((match, index) => ({
              index,
              name: match.matchedNames[0] || '',
              localPrefix: match.localPrefix,
              serverPrefix: match.serverPrefix,
              spaceBeforeBracket: match.spaceBeforeBracket,
              matchedNames: match.matchedNames
            }))

            setSignalNotFoundInfo({
              attempted: signal.fullName,
              matched: result.matchedNames?.[0] || '',
              prefix: '',  // Will be set after user selection
              serverPrefix: '',  // Will be set after user selection
              spaceBeforeBracket: false,  // Will be set after user selection
              firstAvailable: firstSignalName,
              success: true,
              allMatches: allMatchesForDialog,
              selectedMatchIndex: undefined  // User needs to select
            })
            setPendingSignalToAdd(signal)
            setPendingSignalTabType('tableview')
            setShowSignalNotFoundDialog(true)

            // Wait for user selection in the dialog, then add signal
            return
          }

          // Signal found with single server prefix - always show dialog for user confirmation
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
            matched: result.matchedNames?.[0] || '',
            prefix: result.localPrefix || '',
            serverPrefix: result.serverPrefix || '',
            spaceBeforeBracket: result.spaceBeforeBracket ?? false,
            firstAvailable: firstSignalName,
            success: true
          })
          setPendingSignalToAdd(signal)
          setPendingSignalTabType('tableview')
          setShowSignalNotFoundDialog(true)
          return
        }

        // Signal not found - show error dialog
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
          matched: '',
          prefix: '',
          serverPrefix: '',
          spaceBeforeBracket: false,
          firstAvailable: firstSignalName,
          success: false
        })
        setPendingSignalToAdd(signal)
        setPendingSignalTabType('tableview')
        setShowSignalNotFoundDialog(true)
        return

      } catch (error) {
        addMessage(`Error searching signal: ${signal.name}`)
        return
      }
    }

    // If using mock data or not connected, just add the signal directly
    addSignalToTableViewDirect(signal)
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

  // Helper function to search signal on server with prefix removal and bit width handling
  // Inputs:
  //   - fullName: full hierarchical name (e.g., "tb_top.u_dut.mem_arid[7:0]")
  //   - localPrefix: local prefix to remove (e.g., "tb_top.u_dut.")
  // Returns: { found, matchedNames?, localPrefix?, serverPrefix?, spaceBeforeBracket?, multipleServerPrefixes? }
  // Note: Now uses $ (end of line) matching to allow server signals with different prefixes
  const searchSignalOnServer = async (
    waveName: string,
    fullName: string,
    localPrefix: string = ''
  ): Promise<{
    found: boolean;
    matchedNames?: string[];  // All matching server signal names
    localPrefix?: string;     // The local prefix that was removed
    serverPrefix?: string;    // The server prefix extracted from matches
    spaceBeforeBracket?: boolean;
    multipleServerPrefixes?: boolean;  // True if multiple different server prefixes found
  }> => {
    // Remove local prefix if provided
    let sharedName = localPrefix && fullName.startsWith(localPrefix)
      ? fullName.substring(localPrefix.length)
      : fullName

    // Try with bit width first (no space) - match end of line only
    // Use .* prefix to match any server prefix
    let escapedName = escapeRegex(sharedName)

    let response = await apiService.getWaveformSignals(waveName, {
      nameRegex: `.*${escapedName}$`
      // Note: No limit, get all matches
    })

    const signalCount = (response.data as any)?.signal_count ?? 0

    // Check if signal has bit width - if so, we need to also try with space
    const hasBitWidth = sharedName.includes('[')
    
    if (response.status === 'success' && signalCount > 0) {
      const signals = (response.data as any)?.signals ?? []
      const matchedNames = signals.map((s: any) => s.name as string)

      // Extract server prefixes from matched names
      const serverPrefixes = new Set<string>()
      for (const matchedName of matchedNames) {
        if (matchedName.endsWith(sharedName)) {
          const serverPrefix = matchedName.substring(0, matchedName.length - sharedName.length)
          serverPrefixes.add(serverPrefix)
        }
      }

      // If signal has bit width, also try with space
      if (hasBitWidth) {
        const bracketIndex = sharedName.indexOf('[')
        const nameWithSpace = sharedName.substring(0, bracketIndex) + ' ' + sharedName.substring(bracketIndex)
        const escapedNameWithSpace = escapeRegex(nameWithSpace)

        const responseWithSpace = await apiService.getWaveformSignals(waveName, {
          nameRegex: `.*${escapedNameWithSpace}$`
        })

        const signalCountWithSpace = (responseWithSpace.data as any)?.signal_count ?? 0

        if (responseWithSpace.status === 'success' && signalCountWithSpace > 0) {
          const signalsWithSpace = (responseWithSpace.data as any)?.signals ?? []
          const matchedNamesWithSpace = signalsWithSpace.map((s: any) => s.name as string)

          // Extract server prefixes
          const serverPrefixesWithSpace = new Set<string>()
          for (const matchedName of matchedNamesWithSpace) {
            if (matchedName.endsWith(nameWithSpace)) {
              const serverPrefix = matchedName.substring(0, matchedName.length - nameWithSpace.length)
              serverPrefixesWithSpace.add(serverPrefix)
            }
          }

          // Return with space = true
          return {
            found: true,
            matchedNames: matchedNamesWithSpace,
            localPrefix,
            serverPrefix: serverPrefixesWithSpace.size === 1 ? Array.from(serverPrefixesWithSpace)[0] : undefined,
            spaceBeforeBracket: true,
            multipleServerPrefixes: serverPrefixesWithSpace.size > 1
          }
        }
      }

      // Return with space = false (either no bit width, or no match with space)
      return {
        found: true,
        matchedNames,
        localPrefix,
        serverPrefix: serverPrefixes.size === 1 ? Array.from(serverPrefixes)[0] : undefined,
        spaceBeforeBracket: false,
        multipleServerPrefixes: serverPrefixes.size > 1
      }
    }

    // If not found with bit width, and has bit width, try without bit width or with space
    if (hasBitWidth) {
      const bracketIndex = sharedName.indexOf('[')
      const nameWithoutBitWidth = sharedName.substring(0, bracketIndex)
      escapedName = escapeRegex(nameWithoutBitWidth)

      response = await apiService.getWaveformSignals(waveName, {
        nameRegex: `.*${escapedName}$`
      })

      const signalCountNoWidth = (response.data as any)?.signal_count ?? 0

      // Don't return immediately - continue to try with space
      // Store result for later use
      let foundWithoutBitWidth = false
      let matchedNamesWithoutBitWidth: string[] = []
      let serverPrefixesWithoutBitWidth = new Set<string>()
      
      if (response.status === 'success' && signalCountNoWidth > 0) {
        const signals = (response.data as any)?.signals ?? []
        matchedNamesWithoutBitWidth = signals.map((s: any) => s.name as string)

        // Extract server prefixes
        for (const matchedName of matchedNamesWithoutBitWidth) {
          if (matchedName.endsWith(nameWithoutBitWidth)) {
            const serverPrefix = matchedName.substring(0, matchedName.length - nameWithoutBitWidth.length)
            serverPrefixesWithoutBitWidth.add(serverPrefix)
          }
        }
        foundWithoutBitWidth = true
      }

      // Try with space before bracket (e.g., "mem_arid [7:0]")
      const nameWithSpace = sharedName.substring(0, bracketIndex) + ' ' + sharedName.substring(bracketIndex)
      escapedName = escapeRegex(nameWithSpace)

      response = await apiService.getWaveformSignals(waveName, {
        nameRegex: `.*${escapedName}$`
      })

      const signalCountWithSpace = (response.data as any)?.signal_count ?? 0

      if (response.status === 'success' && signalCountWithSpace > 0) {
        const signals = (response.data as any)?.signals ?? []
        const matchedNames = signals.map((s: any) => s.name as string)

        // Extract server prefixes
        const serverPrefixes = new Set<string>()
        for (const matchedName of matchedNames) {
          if (matchedName.endsWith(nameWithSpace)) {
            const serverPrefix = matchedName.substring(0, matchedName.length - nameWithSpace.length)
            serverPrefixes.add(serverPrefix)
          }
        }

        return {
          found: true,
          matchedNames,
          localPrefix,
          serverPrefix: serverPrefixes.size === 1 ? Array.from(serverPrefixes)[0] : undefined,
          spaceBeforeBracket: true,
          multipleServerPrefixes: serverPrefixes.size > 1
        }
      }

      // If no match with space, return result without bit width
      if (foundWithoutBitWidth) {
        return {
          found: true,
          matchedNames: matchedNamesWithoutBitWidth,
          localPrefix,
          serverPrefix: serverPrefixesWithoutBitWidth.size === 1 ? Array.from(serverPrefixesWithoutBitWidth)[0] : undefined,
          spaceBeforeBracket: false,
          multipleServerPrefixes: serverPrefixesWithoutBitWidth.size > 1
        }
      }
    }

    return { found: false }
  }

  // Helper function to try finding signal with prefix removal
  // Returns all matching results for user selection if multiple server prefixes found
  const tryFindSignalWithPrefixRemoval = async (
    waveName: string,
    signalName: string
  ): Promise<{
    found: boolean;
    matchedNames?: string[];
    localPrefix?: string;
    serverPrefix?: string;
    spaceBeforeBracket?: boolean;
    multipleServerPrefixes?: boolean;
    allMatches?: Array<{
      serverPrefix: string;
      matchedNames: string[];
      localPrefix: string;
      spaceBeforeBracket: boolean;
    }>;
  }> => {
    // Collect all successful matches with different prefixes
    const allMatches: Array<{
      serverPrefix: string;
      matchedNames: string[];
      localPrefix: string;
      spaceBeforeBracket: boolean;
    }> = []

    // Try hierarchical prefix removal
    // Start with empty prefix and progressively remove hierarchical levels
    // Both '.' and '@' are treated as hierarchical separators
    let currentName = signalName
    let removedHierarchicalPrefix = ''

    while (currentName.length > 0) {
      const fullLocalPrefix = removedHierarchicalPrefix

      const result = await searchSignalOnServer(waveName, signalName, fullLocalPrefix)
      if (result.found) {

        if (result.serverPrefix !== undefined && result.matchedNames) {
          // Single server prefix - add to matches
          allMatches.push({
            serverPrefix: result.serverPrefix,
            matchedNames: result.matchedNames,
            localPrefix: fullLocalPrefix,
            spaceBeforeBracket: result.spaceBeforeBracket ?? false
          })

          // If only one server prefix found, return immediately
          if (!result.multipleServerPrefixes) {
            return {
              found: true,
              matchedNames: result.matchedNames,
              localPrefix: fullLocalPrefix,
              serverPrefix: result.serverPrefix,
              spaceBeforeBracket: result.spaceBeforeBracket
            }
          }
          // If multiple server prefixes, continue searching to collect all options
        }
      }

      // Remove next hierarchical level (find first separator: '.' or '@')
      const dotIndex = currentName.indexOf('.')
      const atIndex = currentName.indexOf('@')
      
      // Find the earliest separator
      let separatorIndex = -1
      if (dotIndex !== -1 && atIndex !== -1) {
        separatorIndex = Math.min(dotIndex, atIndex)
      } else if (dotIndex !== -1) {
        separatorIndex = dotIndex
      } else if (atIndex !== -1) {
        separatorIndex = atIndex
      }
      
      if (separatorIndex === -1) break

      removedHierarchicalPrefix = removedHierarchicalPrefix + currentName.substring(0, separatorIndex + 1)
      currentName = currentName.substring(separatorIndex + 1)
    }

    // If we found matches but need user to select server prefix
    if (allMatches.length > 0) {
      // Group matches by server prefix
      const groupedByServerPrefix = new Map<string, typeof allMatches[0]>()
      for (const match of allMatches) {
        if (!groupedByServerPrefix.has(match.serverPrefix)) {
          groupedByServerPrefix.set(match.serverPrefix, match)
        }
      }

      if (groupedByServerPrefix.size === 1) {
        // Only one unique server prefix across all matches
        const match = Array.from(groupedByServerPrefix.values())[0]
        return {
          found: true,
          matchedNames: match.matchedNames,
          localPrefix: match.localPrefix,
          serverPrefix: match.serverPrefix,
          spaceBeforeBracket: match.spaceBeforeBracket
        }
      } else {
        // Multiple server prefixes - need user selection
        return {
          found: true,
          multipleServerPrefixes: true,
          allMatches: Array.from(groupedByServerPrefix.values())
        }
      }
    }

    return { found: false }
  }

  const handleSignalAddToWaveform = async (signal: Signal) => {
    // If no waveform loaded and not already using mock data, ask user
    if (!currentWaveName && !useMockData) {
      setPendingMockSignal(signal)
      setShowMockDataDialog(true)
      return
    }

    // Get current active tab's prefix settings
    const activeTabData = tabs.find(t => t.id === activeTab && t.type === 'waveform')
    const tabSignalPrefix = activeTabData?.signalPrefix
    const tabServerPrefix = activeTabData?.serverPrefix
    const tabSpaceBeforeBracket = activeTabData?.spaceBeforeBracket
    
    // Check if this tab has its own prefix settings
    const hasTabPrefixSettings = tabSignalPrefix !== undefined && tabSignalPrefix !== ''

    // If waveform is loaded from server, verify signal exists
    if (currentWaveName && apiService.isConnected()) {
      try {
        // If this tab already has its own prefix settings, use them directly
        if (hasTabPrefixSettings) {
          const result = await searchSignalOnServer(currentWaveName, signal.fullName, tabSignalPrefix)

          if (result.found) {
            // Check if multiple server prefixes found
            if (result.multipleServerPrefixes && result.matchedNames && result.matchedNames.length > 0) {
              // Multiple server prefixes - need to check if our saved one is among them
              const savedServerPrefix = tabServerPrefix
              const matchingWithSavedPrefix = result.matchedNames.filter(name =>
                savedServerPrefix ? name.startsWith(savedServerPrefix) : true
              )
            }

            // Signal found with existing prefix - AUTO ADD (no confirmation needed)
            // Only update spaceBeforeBracket if this signal has bit width (has '[')
            const signalHasBitWidth = signal.fullName.includes('[')
            if (signalHasBitWidth && result.spaceBeforeBracket !== undefined && result.spaceBeforeBracket !== tabSpaceBeforeBracket) {
              // Update tab's settings
              setTabs(prev => prev.map(tab =>
                tab.id === activeTab ? { ...tab, spaceBeforeBracket: result.spaceBeforeBracket } : tab
              ))
              updateProviderSettings(tabSignalPrefix, tabServerPrefix || '', result.spaceBeforeBracket)
            }
            
            // Auto add signal without confirmation
            addSignalToWaveform(signal)
            return
          }
          // If not found with existing prefix, fall through to try finding new prefix
        }

        // Try to find signal with prefix removal
        const result = await tryFindSignalWithPrefixRemoval(currentWaveName, signal.fullName)

        if (result.found) {
          // Check if multiple server prefixes found - need user selection
          if (result.multipleServerPrefixes && result.allMatches && result.allMatches.length > 1) {

            // Show selection dialog with all matches
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
              matched: result.matchedNames?.[0] || '',
              prefix: '',  // Will be set after user selection
              serverPrefix: '',  // Will be set after user selection
              spaceBeforeBracket: false,  // Will be set after user selection
              firstAvailable: firstSignalName,
              success: true,
              allMatches: result.allMatches,
              selectedMatchIndex: undefined  // User needs to select
            })
            setPendingSignalToAdd(signal)  // Store signal to add after user confirms
            setPendingSignalTabType('waveform')  // Set tab type for waveform
            setShowSignalNotFoundDialog(true)

            // Wait for user selection in the dialog, then add signal
            return
          }

          // Signal found with single server prefix - always show dialog for user confirmation
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
            matched: result.matchedNames?.[0] || '',
            prefix: result.localPrefix || '',
            serverPrefix: result.serverPrefix || '',
            spaceBeforeBracket: result.spaceBeforeBracket ?? false,
            firstAvailable: firstSignalName,
            success: true
          })
          setPendingSignalToAdd(signal)  // Store signal to add after user confirms
          setPendingSignalTabType('waveform')  // Set tab type for waveform
          setShowSignalNotFoundDialog(true)
          return
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
            serverPrefix: '',
            spaceBeforeBracket: false,
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
  const handleAddTab = (type: 'source' | 'waveform' | 'tableview', customRange?: { start: number; end: number }) => {
    // Get the counter for this tab type and increment it
    const counter = tabCounters.current[type]++
    const newId = `${type}-${counter}`

    // For waveform tabs, use current waveform's time settings
    const isWaveform = type === 'waveform'
    const isTableView = type === 'tableview'
    // Note: timeConfig is now global only, no longer stored per-tab
    // All waveform and tableview tabs use currentWaveDisplayUnitPerLoD0

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

    // Check if current active tab is waveform and we're creating a tableview
    // If so, inherit viewport time range and signals from expanded groups
    let tableStartTime: number | undefined = undefined
    let tableEndTime: number | undefined = undefined
    let tableSignals: SignalWithFormat[] | undefined = undefined
    let tableSignalPrefix: string | undefined = undefined
    let tableServerPrefix: string | undefined = undefined
    let tableSpaceBeforeBracket: boolean | undefined = undefined
    let tableColumnRadix: Record<string, 'hex' | 'bin' | 'oct' | 'dec'> | undefined = undefined

    if (isTableView) {
      const activeWaveformTab = tabs.find(t => t.type === 'waveform' && t.id === activeTab)
      if (activeWaveformTab) {
        // Inherit viewport time range from waveform
        if (activeWaveformTab.viewport) {
          tableStartTime = activeWaveformTab.viewport.timeStart
          tableEndTime = activeWaveformTab.viewport.timeEnd
        }

        // Inherit prefix settings from waveform tab
        tableSignalPrefix = activeWaveformTab.signalPrefix
        tableServerPrefix = activeWaveformTab.serverPrefix
        tableSpaceBeforeBracket = activeWaveformTab.spaceBeforeBracket

        // Extract signals from expanded groups
        const groups = activeWaveformTab.groups || {}
        const signalDisplayFormats = activeWaveformTab.signalDisplayFormats || {}
        const extractedSignals: SignalWithFormat[] = []
        const columnRadixMap: Record<string, 'hex' | 'bin' | 'oct' | 'dec'> = {}
        let rowCounter = 0

        Object.values(groups).forEach(group => {
          if (group.expanded && group.signals) {
            group.signals.forEach(signal => {
              // Get the display format for this signal from waveform tab
              const displayFormat = signalDisplayFormats[signal.unique_id] || 'hex'

              extractedSignals.push({
                globalId: signal.globalId,
                name: signal.fullName, // Use full name, WASM will handle prefix conversion
                row: rowCounter++,
                width: Math.abs(signal.msb - signal.lsb) + 1,
                drawSigId: signal.globalId,
                displayFormat: displayFormat as 'hex' | 'bin' | 'oct' | 'dec',
              })

              // Also populate columnRadix for the dropdown menu
              columnRadixMap[signal.fullName] = displayFormat as 'hex' | 'bin' | 'oct' | 'dec'
            })
          }
        })

        if (extractedSignals.length > 0) {
          tableSignals = extractedSignals
          tableColumnRadix = columnRadixMap
        }

        addMessage(`${t('messages.createdTableView')}: ${extractedSignals.length} ${t('messages.signals')}, ${t('messages.timeRange')} ${tableStartTime}-${tableEndTime}`)
      }
    }

    const newTab: Tab = {
      id: newId,
      label: type === 'source' ? `Source ${counter}` :
             type === 'waveform' ? `Waveform ${counter}` :
             `Table ${counter}`,
      type,
      moduleIndex: type === 'source' ? null : undefined,
      signals: isWaveform ? [] : undefined,
      groups: isWaveform ? createDefaultGroups() : undefined,
      selectedGroup: isWaveform ? 'group_1' : undefined,
      // Note: timeConfig is now global only, removed from tab-level storage
      viewport,
      cursorPosition: isWaveform && waveformRange
        ? Math.floor((waveformRange.start + waveformRange.end) / 2)
        : undefined, // Default cursor at middle of range
      waveformTimeUnit: isWaveform ? currentWaveTimeUnit : undefined,
      waveformRange, // Save the total range for sanity checks
      // TableView specific
      tableStartTime: isTableView ? (tableStartTime ?? 0) : undefined,
      tableEndTime: isTableView ? (tableEndTime ?? 0) : undefined,
      tableSignals: isTableView ? (tableSignals ?? []) : undefined,
      tableData: undefined,
      tableCurrentPage: isTableView ? 0 : undefined,
      // Inherit column radix from waveform signals
      tableColumnRadix: isTableView ? tableColumnRadix : undefined,
      // Inherit prefix settings from waveform if available
      signalPrefix: isTableView ? tableSignalPrefix : undefined,
      serverPrefix: isTableView ? tableServerPrefix : undefined,
      spaceBeforeBracket: isTableView ? tableSpaceBeforeBracket : undefined,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTab(newId)
    addMessage(`Added new ${type} tab` + (customRange ? ` (custom range: ${customRange.start}-${customRange.end})` : ''))
  }

  // Update time configuration - global only, all tabs share the same timeConfig
  const handleTimeConfigChange = (tabId: string, timeConfig: TimeConfig) => {
    console.log('[App] handleTimeConfigChange called', { tabId, timeConfig });
    // Only update the global currentWaveDisplayUnitPerLoD0
    // All waveform and tableview tabs will use this global value
    setCurrentWaveDisplayUnitPerLoD0(timeConfig.DisplayUnitPerLoD0Unit);
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
      }
    }
  }

  // ============================================
  // TableView Functionality
  // ============================================

  // Handle TableView start time change
  const handleTableStartTimeChange = (newStart: number) => {
    setTabs(prev => prev.map(tab =>
      tab.id === activeTab ? { ...tab, tableStartTime: newStart } : tab
    ))
  }

  // Handle TableView end time change
  const handleTableEndTimeChange = (newEnd: number) => {
    setTabs(prev => prev.map(tab =>
      tab.id === activeTab ? { ...tab, tableEndTime: newEnd } : tab
    ))
  }

  // Handle TableView start time change with span preservation
  const handleTableStartTimeChangeWithSpan = (newStart: number, newEnd: number) => {
    setTabs(prev => prev.map(tab =>
      tab.id === activeTab ? { ...tab, tableStartTime: newStart, tableEndTime: newEnd } : tab
    ))
  }

  // Handle TableView page change
  const handleTablePageChange = (newPage: number) => {
    setTabs(prev => prev.map(tab =>
      tab.id === activeTab ? { ...tab, tableCurrentPage: newPage } : tab
    ))
  }

  // Fetch TableView data from WASM
  // Note: This is now handled by TableViewWindow itself using adapter
  // This function is called as a callback when data is fetched
  const handleFetchTableData = useCallback((data: RawSignalValuesResult) => {
    // Update tab with fetched data
    setTabs(prev => prev.map(tab =>
      tab.id === activeTab ? { ...tab, tableData: data, tableCurrentPage: 0 } : tab
    ))
    addMessage(`Fetched ${data.data.length} rows for TableView`)
  }, [activeTab, addMessage])

  // Ref to trigger TableView data fetch from Toolbar
  const tableViewFetchRef = useRef<() => void>()

  // Handle TableView Apply button click from Toolbar
  const handleTableTimeApply = useCallback(() => {
    // Increment refresh trigger to notify TableViewWindow to fetch data
    setTableViewRefreshTrigger(prev => prev + 1)
  }, [])

  // ============================================
  // Waveform Search Functionality
  // ============================================

  // Perform waveform pattern search
  const handleWaveformSearch = useCallback(async (direction: WaveformSearchDirection) => {
    // Check if active tab is waveform
    if (activeTabData?.type !== 'waveform') {
      addMessage('Waveform search is only available in waveform tabs');
      return;
    }

    // Validate input based on search type
    if (waveformSearchType === 'value' && !searchPattern.trim()) {
      addMessage('Please enter a search pattern');
      return;
    }
    if (waveformSearchType === 'transition' && (!waveformFromValue.trim() || !waveformToValue.trim())) {
      addMessage('Please enter both From and To values');
      return;
    }

    // Get selected signal from Signal Panel or use first signal in waveform
    let selectedSignal = activeTabData.selectedSignal as (Signal & { unique_id?: number }) | undefined;

    // If no selected signal, try to get first signal from waveform
    if (!selectedSignal && activeTabData.signals && activeTabData.signals.length > 0) {
      selectedSignal = activeTabData.signals[0] as Signal & { unique_id?: number };
    }
    
    if (!selectedSignal) {
      addMessage('Please select a signal in the Signal Panel');
      return;
    }

    // Get waveform name from global state
    const waveformName = currentWaveName;
    if (!waveformName) {
      addMessage('No waveform loaded');
      return;
    }

    // Get current cursor position as start time
    const cursorPosition = activeTabData.cursorPosition || 0;

    // Get signal radix (display format)
    // signalDisplayFormats is a Record<number, SignalDisplayFormat>, not a Map
    const signalFormatKey = (selectedSignal as Signal & { unique_id?: number }).unique_id || selectedSignal.globalId;
    const signalFormat = signalFormatKey !== undefined ? activeTabData.signalDisplayFormats?.[signalFormatKey] : undefined;
    
    // Determine default format based on signal bit width
    // Single bit: binary, Multi-bit: hex
    const isSingleBit = selectedSignal.msb === selectedSignal.lsb;
    const defaultFormat = isSingleBit ? 'bin' : 'hex';
    
    // Convert display format to API radix format
    // Display: 'bin' | 'hex' | 'oct' | 'dec'
    // API: 'binary' | 'hex' | 'octal' | 'decimal'
    const radixMap: Record<string, string> = {
      'bin': 'binary',
      'hex': 'hex',
      'oct': 'octal',
      'dec': 'decimal',
    };
    const radix = radixMap[signalFormat || defaultFormat] || 'binary';

    setIsWaveformSearching(true);

    try {
      // Build server signal name from fullName and prefixes
      // fullName is like "work@picorv32_wb.pcpi_insn[31:0]"
      // We need to convert it to server signal name like "testbench.top.uut.pcpi_insn[31:0]"
      const localPrefix = activeTabData.signalPrefix ?? currentWaveSignalPrefix;
      const serverPrefix = activeTabData.serverPrefix ?? currentWaveSignalServerPrefix;
      const spaceBeforeBracket = activeTabData.spaceBeforeBracket ?? currentWaveSignalSpaceBeforeBracket;
      
      let serverSignalName = selectedSignal.fullName;
      if (localPrefix && serverSignalName.startsWith(localPrefix)) {
        // Remove local prefix and add server prefix
        const sharedName = serverSignalName.substring(localPrefix.length);
        serverSignalName = serverPrefix + sharedName;
      }
      
      // Handle space before bracket for multi-bit signals
      // Local name: "pcpi_insn[31:0]" or "pcpi_insn [31:0]"
      // Server name may need space: "testbench.top.uut.pcpi_insn[31:0]" or "testbench.top.uut.pcpi_insn [31:0]"
      if (spaceBeforeBracket && serverSignalName.includes('[') && !serverSignalName.includes(' [')) {
        // Add space before bracket if needed
        serverSignalName = serverSignalName.replace('[', ' [');
      } else if (!spaceBeforeBracket && serverSignalName.includes(' [')) {
        // Remove space before bracket if not needed
        serverSignalName = serverSignalName.replace(' [', '[');
      }

      const searchParams: import('./modules/search/waveformSearchService').WaveformSearchParams = {
        signalName: serverSignalName,
        searchType: waveformSearchType,
        radix: radix,
      };

      // Set type-specific parameters
      if (waveformSearchType === 'value') {
        searchParams.valuePattern = searchPattern;
        searchParams.radix = radix;
        addMessage(`Searching ${direction} for "${searchPattern}" in ${selectedSignal.name}...`);
      } else if (waveformSearchType === 'edge') {
        searchParams.edgeType = waveformEdgeType;
        // Edge mode doesn't need radix
        addMessage(`Searching ${direction} for ${waveformEdgeType} edge in ${selectedSignal.name}...`);
      } else if (waveformSearchType === 'transition') {
        searchParams.fromValue = waveformFromValue;
        searchParams.toValue = waveformToValue;
        searchParams.radix = radix;
        addMessage(`Searching ${direction} for ${waveformFromValue}→${waveformToValue} in ${selectedSignal.name}...`);
      }

      // Perform search
      const results = await waveformSearchService.search(
        waveformName,
        searchParams,
        cursorPosition,
        direction,
        100
      );

      if (results.length === 0) {
        addMessage(`No matches found for "${searchPattern}"`);
        setIsWaveformSearching(false);
        return;
      }

      // Find closest result to cursor
      const closestResult = waveformSearchService.findClosestResult(
        results,
        cursorPosition,
        direction
      );

      if (!closestResult) {
        addMessage(`No ${direction} matches found from current position`);
        setIsWaveformSearching(false);
        return;
      }

      // Move cursor and viewport to the result
      const newTime = closestResult.time;

      // Update cursor position
      handleCursorPositionChange(newTime);

      // Center viewport on the result
      const viewport = activeTabData.viewport;
      if (viewport) {
        const viewportWidth = viewport.timeEnd - viewport.timeStart;
        const newStart = newTime - viewportWidth / 2;
        const newEnd = newTime + viewportWidth / 2;

        setTabs(prev => prev.map(tab =>
          tab.id === activeTab ? {
            ...tab,
            viewport: {
              ...viewport,
              timeStart: newStart,
              timeEnd: newEnd,
            }
          } : tab
        ));
      }

      addMessage(`Found match at time ${newTime}: ${closestResult.value}`);

      // Add to search history based on search type
      if (waveformSearchType === 'value' && searchPattern) {
        searchManager.addToHistory(searchPattern, false);
      } else if (waveformSearchType === 'transition') {
        if (waveformFromValue) {
          setWaveformFromValueHistory(prev => {
            const newHistory = [waveformFromValue, ...prev.filter(v => v !== waveformFromValue)].slice(0, 10);
            return newHistory;
          });
        }
        if (waveformToValue) {
          setWaveformToValueHistory(prev => {
            const newHistory = [waveformToValue, ...prev.filter(v => v !== waveformToValue)].slice(0, 10);
            return newHistory;
          });
        }
      }
    } catch (error) {
      console.error('[WaveformSearch] Error:', error);
      
      // Extract error message from API response
      let errorMessage = 'Unknown error';
      if (error instanceof Error) {
        // error.message might be an object string like "[object Object]"
        // Try to get detailed error info
        const msg = error.message;
        if (msg === '[object Object]') {
          // Try to stringify the error object itself
          try {
            const errorStr = JSON.stringify(error);
            const errorData = JSON.parse(errorStr);
            if (errorData.error && errorData.error.message) {
              errorMessage = errorData.error.message;
            } else if (errorData.message) {
              errorMessage = errorData.message;
            } else {
              errorMessage = 'Request failed';
            }
          } catch {
            errorMessage = 'Request failed';
          }
        } else {
          errorMessage = msg;
          // Try to parse JSON error response
          try {
            const errorData = JSON.parse(msg);
            if (errorData.error && errorData.error.message) {
              errorMessage = errorData.error.message;
            } else if (errorData.message) {
              errorMessage = errorData.message;
            }
          } catch {
            // Not JSON, use original message
          }
        }
      }
      
      addMessage(`Search failed: ${errorMessage}`);
    } finally {
      setIsWaveformSearching(false);
    }
  }, [activeTabData, searchPattern, waveformSearchType, waveformEdgeType, waveformFromValue, waveformToValue, currentWaveName, currentWaveSignalPrefix, currentWaveSignalServerPrefix, currentWaveSignalSpaceBeforeBracket, addMessage, activeTab, setTabs]);

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
    setTabs(prev => prev.map(tab => {
      if (tab.id !== tabId) return tab;
      
      // Check if any groups were removed
      const oldGroupIds = tab.groups ? Object.keys(tab.groups) : [];
      const newGroupIds = groups ? Object.keys(groups) : [];
      const removedGroupIds = oldGroupIds.filter(id => !newGroupIds.includes(id));
      
      // If groups were removed, update wavemarks to remove references to deleted groups
      let updatedWavemarks = tab.wavemarks;
      if (removedGroupIds.length > 0 && tab.wavemarks) {
        updatedWavemarks = tab.wavemarks.map(wavemark => ({
          ...wavemark,
          expandedGroups: wavemark.expandedGroups.filter(id => !removedGroupIds.includes(id))
        }));
      }
      
      return { 
        ...tab, 
        groups,
        wavemarks: updatedWavemarks
      };
    }));
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

      // Build waveform tabs data (without nextSignalUniqueId - it's now global)
      const waveformTabsData = tabs
        .filter(tab => tab.type === 'waveform')
        .map(tab => ({
          id: tab.id,
          label: tab.label,
          groups: tab.groups || {},
          selectedGroup: tab.selectedGroup,
          viewport: tab.viewport,
          cursorPosition: tab.cursorPosition,
          waveformRange: tab.waveformRange,
          signalDisplayFormats: tab.signalDisplayFormats,
          signalHierarchySelections: tab.signalHierarchySelections,
          // Per-tab prefix settings (fallback to global settings for backward compatibility)
          signalPrefix: tab.signalPrefix ?? currentWaveSignalPrefix,
          serverPrefix: tab.serverPrefix ?? currentWaveSignalServerPrefix,
          spaceBeforeBracket: tab.spaceBeforeBracket ?? currentWaveSignalSpaceBeforeBracket,
          // Wavemarks
          wavemarks: tab.wavemarks || [],
          // Note: timeConfig is now global only, no longer saved per-tab
        }))

      // Build tableview tabs data
      const tableviewTabsData = tabs
        .filter(tab => tab.type === 'tableview')
        .map(tab => ({
          id: tab.id,
          label: tab.label,
          signals: (tab.tableSignals || []).map(s => ({
            globalId: s.globalId,
            drawSigId: s.drawSigId,
            name: s.name,
            row: s.row,
            width: s.width,
            radix: s.displayFormat || 'hex',
          })),
          startTime: tab.tableStartTime || 0,
          endTime: tab.tableEndTime || 0,
          currentPage: tab.tableCurrentPage || 0,
          columnFilters: tab.tableColumnFilters || [],
          columnMetadataFilters: tab.tableColumnMetadataFilters || {},
          columnRadix: tab.tableColumnRadix || {},
          // Per-tab prefix settings
          signalPrefix: tab.signalPrefix ?? currentWaveSignalPrefix,
          serverPrefix: tab.serverPrefix ?? currentWaveSignalServerPrefix,
          spaceBeforeBracket: tab.spaceBeforeBracket ?? currentWaveSignalSpaceBeforeBracket,
          // Note: timeConfig is now global only, no longer saved per-tab
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
        sourceTabs: sourceTabsData,
        activeSourceTabId: activeTab,
        nextWaveformSignalId: nextWaveformSignalIdRef.current,
        waveformTabs: waveformTabsData,
        activeWaveformTabId: activeTab,
        tableviewTabs: tableviewTabsData,
        activeTableviewTabId: activeTab,
        bookmarks: bookmarksData,
        hierarchy: {
          expandedModules: Array.from(expandedModules),
          selectedModule: selectedModuleIndex,
          pagination: Object.fromEntries(
            Array.from(hierarchyPagination.entries()).map(([id, state]) => [
              id,
              { startPosition: state.startPosition, pageSize: state.pageSize }
            ])
          ),
        },
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
      
      // Update serverUrl state for WaveformProvider
      const newServerUrl = apiService.getBaseUrl()
      setServerUrl(newServerUrl)
      
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
      
      // Restore global signal ID counter
      nextWaveformSignalIdRef.current = session.nextWaveformSignalId
      
      for (const waveTab of session.waveformTabs) {
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
            id: groupId,
            name: group.name,
            parentId: group.parentId,
            signals: restoredSignals,
            expanded: group.expanded,
            children: group.children || [],
          }
        }

        const newTab: Tab = {
          id: waveTab.id,
          label: waveTab.label,
          type: 'waveform',
          groups: restoredGroups,
          selectedGroup: waveTab.selectedGroup,
          columnWidths: DEFAULT_COLUMN_WIDTHS,
          // Note: timeConfig is now global only, use global currentWaveDisplayUnitPerLoD0
          waveformTimeUnit: 2, // Default to ns
          viewport: waveTab.viewport,
          cursorPosition: waveTab.cursorPosition,
          waveformRange: waveTab.waveformRange,
          signalDisplayFormats: waveTab.signalDisplayFormats,
          signalHierarchySelections: waveTab.signalHierarchySelections,
          // Restore per-tab prefix settings
          signalPrefix: waveTab.signalPrefix,
          serverPrefix: waveTab.serverPrefix,
          spaceBeforeBracket: waveTab.spaceBeforeBracket,
          // Restore wavemarks
          wavemarks: (waveTab.wavemarks || []).map(w => ({
            id: w.id,
            name: w.name,
            time: w.time,
            createdAt: w.createdAt,
            expandedGroups: w.expandedGroups,
            color: '#ff6600' as import('./types/wavemark').WavemarkColor,
          })),
        }
        
        restoredTabs.push(newTab)
      }

      // Step 6b: Restore tableview tabs
      setSessionLoadingMessage('Restoring tableview tabs...')
      for (const tableTab of session.tableviewTabs || []) {
        // Rebuild signals from saved data
        const restoredSignals: SignalWithFormat[] = tableTab.signals.map(sig => ({
          globalId: sig.globalId,
          name: sig.name,
          row: sig.row,
          width: sig.width,
          drawSigId: sig.drawSigId,
          displayFormat: sig.radix,
        }))

        const newTab: Tab = {
          id: tableTab.id,
          label: tableTab.label,
          type: 'tableview',
          // Note: timeConfig is now global only, use global currentWaveDisplayUnitPerLoD0
          tableStartTime: tableTab.startTime,
          tableEndTime: tableTab.endTime,
          tableSignals: restoredSignals,
          tableCurrentPage: tableTab.currentPage,
          tableColumnFilters: tableTab.columnFilters,
          tableColumnMetadataFilters: tableTab.columnMetadataFilters,
          tableColumnRadix: tableTab.columnRadix,
          // Restore per-tab prefix settings
          signalPrefix: tableTab.signalPrefix,
          serverPrefix: tableTab.serverPrefix,
          spaceBeforeBracket: tableTab.spaceBeforeBracket,
        }

        restoredTabs.push(newTab)
      }

      // Update tab counters based on restored tab IDs
      // Extract the maximum counter value from each tab type
      const maxCounters = { source: 0, waveform: 0, tableview: 0 }
      for (const tab of restoredTabs) {
        const match = tab.id.match(/^(source|waveform|tableview)-(\d+)$/)
        if (match) {
          const type = match[1] as 'source' | 'waveform' | 'tableview'
          const num = parseInt(match[2], 10)
          if (num > maxCounters[type]) {
            maxCounters[type] = num
          }
        }
      }
      // Set counters to max + 1 for next new tab
      tabCounters.current.source = maxCounters.source + 1
      tabCounters.current.waveform = maxCounters.waveform + 1
      tabCounters.current.tableview = maxCounters.tableview + 1
      console.log('[App] Restored tab counters:', tabCounters.current)

      setTabs(restoredTabs)

      // Step 7: Restore active tab
      const activeTabId = session.activeSourceTabId || session.activeWaveformTabId || session.activeTableviewTabId
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

      // Step 9: Restore hierarchy panel state
      if (session.hierarchy) {
        setExpandedModules(new Set(session.hierarchy.expandedModules))
        setSelectedModuleIndex(session.hierarchy.selectedModule)
        // Restore pagination state
        if (session.hierarchy.pagination) {
          const paginationMap = new Map<number, { startPosition: number; pageSize: number }>()
          for (const [id, state] of Object.entries(session.hierarchy.pagination)) {
            paginationMap.set(Number(id), { startPosition: state.startPosition, pageSize: state.pageSize })
          }
          setHierarchyPagination(paginationMap)
        }
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
    const newHierarchyWidth = hierarchyStartWidthRef.current + delta
    
    // 获取 main-content 的可用宽度
    const mainContentWidth = mainContentRef.current?.clientWidth || window.innerWidth
    
    // Signal panel 和右侧面板的最小宽度
    const signalPanelMinWidth = 100
    const rightPanelMinWidth = 300
    
    // 计算 hierarchy panel 的最大可用宽度
    // mainContentWidth - signalPanelMinWidth - rightPanelMinWidth - splitters (16px)
    const maxHierarchyWidth = mainContentWidth - signalPanelMinWidth - rightPanelMinWidth - 16
    
    // 限制 hierarchyWidth 在 [100, maxHierarchyWidth] 范围内
    const clampedHierarchyWidth = Math.max(100, Math.min(maxHierarchyWidth, newHierarchyWidth))
    
    setHierarchyWidth(clampedHierarchyWidth)
  }

  const handleSignalPanelResize = (delta: number) => {
    const newSignalWidth = signalStartWidthRef.current + delta
    
    // 获取 main-content 的可用宽度
    const mainContentWidth = mainContentRef.current?.clientWidth || window.innerWidth
    
    // 右侧面板的最小宽度（300px）
    const rightPanelMinWidth = 300
    
    // 计算左侧面板的总宽度（包括 splitter）
    const leftPanelTotalWidth = isLeftPanelVisible 
      ? hierarchyWidth + 8 // hierarchy + splitter
      : 0
    
    // 计算 signal panel 的最大可用宽度
    // mainContentWidth - leftPanelTotalWidth - rightPanelMinWidth - splitterWidth
    const maxSignalWidth = mainContentWidth - leftPanelTotalWidth - rightPanelMinWidth - 8
    
    // 限制 signalWidth 在 [100, maxSignalWidth] 范围内
    const clampedSignalWidth = Math.max(100, Math.min(maxSignalWidth, newSignalWidth))
    
    setSignalWidth(clampedSignalWidth)
  }

  const handleMessageResize = (delta: number) => {
    setMessageHeight(Math.max(60, messageStartHeightRef.current - delta))
  }

  // Toggle left panel visibility
  const handleToggleLeftPanel = useCallback(() => {
    setIsLeftPanelVisible(prev => {
      if (prev) {
        // Currently visible, save current width and hide
        const currentTotalWidth = hierarchyWidth + signalWidth + 8 // 8px for splitter
        savedLeftPanelWidthRef.current = Math.max(200, currentTotalWidth)
        return false
      } else {
        // Currently hidden, restore
        return true
      }
    })
  }, [hierarchyWidth, signalWidth])

  if (!initialized) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner"></div>
        <p>Initializing WHAT...</p>
      </div>
    )
  }

  return (
    <WaveformProviderProvider
      serverUrl={serverUrl}
      waveformName={currentWaveName || ''}
      signalPrefix={currentWaveSignalPrefix}
      serverPrefix={currentWaveSignalServerPrefix}
      spaceBeforeBracket={currentWaveSignalSpaceBeforeBracket}
      timeStamp={currentWaveTimeStamp}
      enableOpfs={opfsCacheEnabled}
      enableMemoryCache={memoryCacheEnabled}
    >
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
        opfsEnabled={opfsCacheEnabled}
        onToggleOpfs={handleToggleOpfs}
        memoryCacheEnabled={memoryCacheEnabled}
        onToggleMemoryCache={handleToggleMemoryCache}
        // View menu
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomFull={handleZoomFull}
        canZoom={activeTabData?.type === 'waveform' && !!currentWaveName}
        // Navigate menu
        onHistoryBack={navigatePrevious}
        onHistoryForward={navigateNext}
        canGoBack={canNavigatePrevious()}
        canGoForward={canNavigateNext()}
        onAddBookmark={handleAddBookmark}
        onFindDriver={() => addMessage('Find Driver: Please double-click a signal in source code view')}
        onFindDefinition={() => addMessage('Find Definition: Please double-click an instance in source code view')}
        hasSelectedWord={false}
        // Waveform menu
        onAddSignal={() => {
          if (activeTabData?.type === 'waveform') {
            addMessage('Add Signal: Please double-click a signal in the Signal Panel')
          } else {
            addMessage('Please open a waveform tab first')
          }
        }}
        onRemoveSignal={() => {
          if (activeTabData?.type === 'waveform' && activeTabData.signals && activeTabData.signals.length > 0) {
            handleSignalRemove(activeTabData.signals[activeTabData.signals.length - 1] as Signal & { unique_id: number })
          } else {
            addMessage('No signal to remove')
          }
        }}
        canAddSignal={activeTabData?.type === 'waveform' && !!currentWaveName}
        canRemoveSignal={activeTabData?.type === 'waveform' && !!activeTabData?.signals && activeTabData.signals.length > 0}
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
        timeConfig={initTimeConfig(currentWaveDisplayUnitPerLoD0)}
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
        onAddTableViewTab={() => handleAddTab('tableview')}
        currentTabType={activeTabData?.type || 'source'}
        currentWaveDisplayUnitPerLoD0={currentWaveDisplayUnitPerLoD0}
        selectedDisplayUnit={selectedDisplayUnit}
        onDisplayUnitChange={setSelectedDisplayUnit}
        // TableView time range
        tableStartTime={activeTabData?.type === 'tableview' ? activeTabData.tableStartTime : undefined}
        tableEndTime={activeTabData?.type === 'tableview' ? activeTabData.tableEndTime : undefined}
        onTableStartTimeChange={handleTableStartTimeChange}
        onTableEndTimeChange={handleTableEndTimeChange}
        onTableStartTimeChangeWithSpan={handleTableStartTimeChangeWithSpan}
        onTableTimeApply={handleTableTimeApply}
        viewportStart={activeTabData?.viewport?.timeStart}
        viewportEnd={activeTabData?.viewport?.timeEnd}
        cursorPosition={activeTabData?.cursorPosition}
        onViewportStartChange={handleViewportStartChange}
        onCursorPositionChange={handleCursorPositionChange}
        // Search functionality
        searchPattern={searchPattern}
        onSearchPatternChange={setSearchPattern}
        onSearchExecute={handleSearchExecute}
        onSearchCancel={handleSearchCancel}
        isSearching={isSearching}
        searchHistory={searchHistory}
        isHierarchySearchMode={tabs.length === 0 || activeTabData?.type === 'source'}
        searchSignals={searchSignals}
        onSearchSignalsChange={setSearchSignals}
        // Waveform search functionality
        isWaveformSearchMode={activeTabData?.type === 'waveform'}
        waveformSearchType={waveformSearchType}
        onWaveformSearchTypeChange={setWaveformSearchType}
        waveformEdgeType={waveformEdgeType}
        onWaveformEdgeTypeChange={setWaveformEdgeType}
        waveformFromValue={waveformFromValue}
        onWaveformFromValueChange={setWaveformFromValue}
        waveformToValue={waveformToValue}
        onWaveformToValueChange={setWaveformToValue}
        onWaveformSearchForward={() => handleWaveformSearch('forward')}
        onWaveformSearchBackward={() => handleWaveformSearch('backward')}
        // Waveform search history
        waveformSearchHistory={searchHistory}
        waveformFromValueHistory={waveformFromValueHistory}
        waveformToValueHistory={waveformToValueHistory}
      />

      {/* Main Content */}
      <div className="main-content" ref={mainContentRef}>
        {/* Left Side Container - Hierarchy + Signal + Bottom Panel */}
        {isLeftPanelVisible && (
        <div className="left-side-container">
          {/* Left Panels Container - Hierarchy + Signal */}
          <div className="left-panels">
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
                expandedModules={expandedModules}
                onExpandedModulesChange={setExpandedModules}
                paginationMap={hierarchyPagination}
                onPaginationChange={setHierarchyPagination}
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
                onSignalAddToTableView={handleSignalAddToTableView}
                onSignalDoubleClick={handleSignalDoubleClick}
                onSignalSelect={handleSignalSelect}
                activeTabType={tabs.find(t => t.id === activeTab)?.type}
                onSignalDrop={handleSignalDropFromWaveform}
                pendingSelectedSignal={pendingSelectedSignal}
              />
            </div>
          </div>

          {/* Splitter between left panels and bottom panel */}
          <Splitter direction="vertical" onDrag={handleMessageResize} onDragStart={handleMessageResizeStart} onDragEnd={handleMessageResizeEnd} />

          {/* Bottom Panel - Messages (only under left panels) */}
          <div
            className="bottom-panel"
            style={{ height: messageHeight, minHeight: 60 }}
          >
            <MessageWindow
              messages={messages}
              onBookmarkClick={handleBookmarkClick}
              onDriverClick={handleDriverClick}
              wavemarks={activeTabData?.wavemarks || []}
              onWavemarkClick={handleWavemarkClick}
              onWavemarkDelete={handleWavemarkDelete}
              onWavemarkRename={handleWavemarkRename}
              onWavemarkColorChange={handleWavemarkColorChange}
              onWavemarkGroupsChange={handleWavemarkGroupsChange}
              availableGroups={activeTabData?.type === 'waveform'
                ? Object.values(activeTabData.groups || {}).map(g => ({ id: g.id, name: g.name }))
                : []
              }
              searchResults={searchResults}
              onSearchResultClick={handleSearchResultClick}
              onSearchResultDelete={handleSearchResultDelete}
            />
          </div>
        </div>
        )}

        {/* Splitter between left side and right panel */}
        <Splitter
          direction="horizontal"
          onDrag={handleSignalPanelResize}
          onDragStart={handleSignalPanelResizeStart}
          onDragEnd={handleSignalPanelResizeEnd}
          onDoubleClick={handleToggleLeftPanel}
          tooltip={isLeftPanelVisible ? (t('panel.splitter.hideLeftPanel') as string) : (t('panel.splitter.showLeftPanel') as string)}
        />

        {/* Right Panel - Tab Panel (Source/Waveform) - extends to bottom */}
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
              <Suspense fallback={<div style={{ padding: '20px', color: '#888' }}>Loading editor...</div>}>
                <MonacoSourceCodeWindow
                  key={activeTabData.id}
                  tabId={activeTabData.id}
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
                  currentTime={getLastActiveWaveformCursorTime()}
                  signalRadixMap={getSignalRadixMap()}

                  signalPrefix={activeTabData.signalPrefix ?? currentWaveSignalPrefix}
                  serverPrefix={activeTabData.serverPrefix ?? currentWaveSignalServerPrefix}
                  spaceBeforeBracket={activeTabData.spaceBeforeBracket ?? currentWaveSignalSpaceBeforeBracket}
                />
              </Suspense>
            ) : activeTabData?.type === 'tableview' ? (
              <TableViewWindow
                key={activeTabData.id}
                tabId={activeTabData.id}
                signals={activeTabData.tableSignals || []}
                startTime={activeTabData.tableStartTime || 0}
                endTime={activeTabData.tableEndTime || 0}
                data={activeTabData.tableData || null}
                timeConfig={initTimeConfig(currentWaveDisplayUnitPerLoD0)}
                onSignalsChange={(signals) => {
                  setTabs(prev => prev.map(tab =>
                    tab.id === activeTabData.id ? { ...tab, tableSignals: signals } : tab
                  ))
                }}
                onStartTimeChange={handleTableStartTimeChange}
                onEndTimeChange={handleTableEndTimeChange}
                onFetchData={handleFetchTableData}
                currentPage={activeTabData.tableCurrentPage || 0}
                onPageChange={handleTablePageChange}
                signalPrefix={activeTabData.signalPrefix ?? currentWaveSignalPrefix}
                serverPrefix={activeTabData.serverPrefix ?? currentWaveSignalServerPrefix}
                spaceBeforeBracket={activeTabData.spaceBeforeBracket ?? currentWaveSignalSpaceBeforeBracket}
                waveformName={currentWaveName || ''}
                refreshTrigger={tableViewRefreshTrigger}
                displayUnitPerLoD0Unit={currentWaveDisplayUnitPerLoD0}
                enableOpfs={opfsCacheEnabled}
                enableMemoryCache={memoryCacheEnabled}
                // Session restore props
                initialColumnFilters={activeTabData.tableColumnFilters}
                initialColumnMetadataFilters={activeTabData.tableColumnMetadataFilters}
                initialColumnRadix={activeTabData.tableColumnRadix}
                onColumnFiltersChange={(filters) => {
                  setTabs(prev => prev.map(tab =>
                    tab.id === activeTabData.id ? { ...tab, tableColumnFilters: filters } : tab
                  ))
                }}
                onColumnMetadataFiltersChange={(filters) => {
                  setTabs(prev => prev.map(tab =>
                    tab.id === activeTabData.id ? { ...tab, tableColumnMetadataFilters: filters } : tab
                  ))
                }}
                onColumnRadixChange={(radix) => {
                  setTabs(prev => prev.map(tab =>
                    tab.id === activeTabData.id ? { ...tab, tableColumnRadix: radix } : tab
                  ))
                }}
              />
            ) : activeTabData ? (
              <WaveformWindow
                key={activeTabData.id}
                activeTabId={activeTab}
                signals={activeTabData.signals || []}
                groups={activeTabData.groups || createDefaultGroups()}
                selectedGroup={activeTabData.selectedGroup || 'group_1'}
                columnWidths={activeTabData.columnWidths}
                timeConfig={initTimeConfig(currentWaveDisplayUnitPerLoD0)}
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
                signalPrefix={activeTabData.signalPrefix ?? currentWaveSignalPrefix}
                serverPrefix={activeTabData.serverPrefix ?? currentWaveSignalServerPrefix}
                spaceBeforeBracket={activeTabData.spaceBeforeBracket ?? currentWaveSignalSpaceBeforeBracket}
                waveformRange={activeTabData.waveformRange}
                initialSignalDisplayFormats={activeTabData.signalDisplayFormats}
                initialSignalHierarchySelections={activeTabData.signalHierarchySelections}
                onSignalSettingsChange={(settings) => {
                  setTabs(prev => prev.map(tab =>
                    tab.id === activeTabData.id ? { 
                      ...tab, 
                      signalDisplayFormats: settings.signalDisplayFormats,
                      signalHierarchySelections: settings.signalHierarchySelections,
                    } : tab
                  ))
                }}
                wavemarks={activeTabData.wavemarks || []}
                onSignalSelect={(signal) => {
                  // Store selected signal in active tab for waveform search
                  setTabs(prev => prev.map(tab =>
                    tab.id === activeTab ? {
                      ...tab,
                      selectedSignal: signal
                    } : tab
                  ));
                }}
                onSignalDoubleClick={handleWaveformSignalDoubleClick}
              />
            ) : null}
          </TabPanel>
        </div>
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
                {signalNotFoundInfo.success
                  ? (signalNotFoundInfo.allMatches && signalNotFoundInfo.allMatches.length > 1
                    ? 'Select Server Signal'
                    : 'Signal Found with Prefix Adjustment')
                  : 'Signal Not Found'}
              </span>
              <button className="dialog-close" onClick={() => setShowSignalNotFoundDialog(false)}>×</button>
            </div>
            <div className="dialog-body">
              {signalNotFoundInfo.success ? (
                <>
                  {signalNotFoundInfo.allMatches && signalNotFoundInfo.allMatches.length > 1 ? (
                    // Multiple server prefixes - show selection list
                    <>
                      <p>Multiple server signals matched. Please select the correct one:</p>
                      <div className="form-group">
                        <label className="form-label">Original Signal</label>
                        <input type="text" className="form-input" value={signalNotFoundInfo.attempted} readOnly />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Select Matched Server Signal</label>
                        <div style={{ maxHeight: '200px', overflowY: 'auto', border: '1px solid #ddd', borderRadius: '4px' }}>
                          {signalNotFoundInfo.allMatches.map((match, index) => (
                            <div
                              key={index}
                              onClick={() => setSignalNotFoundInfo({ ...signalNotFoundInfo, selectedMatchIndex: index })}
                              style={{
                                padding: '10px 12px',
                                cursor: 'pointer',
                                borderBottom: index < signalNotFoundInfo.allMatches!.length - 1 ? '1px solid #eee' : 'none',
                                backgroundColor: signalNotFoundInfo.selectedMatchIndex === index ? '#e3f2fd' : 'transparent',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px'
                              }}
                            >
                              <input
                                type="radio"
                                name="serverPrefix"
                                checked={signalNotFoundInfo.selectedMatchIndex === index}
                                onChange={() => setSignalNotFoundInfo({ ...signalNotFoundInfo, selectedMatchIndex: index })}
                              />
                              <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 500 }}>{match.matchedNames[0]}</div>
                                <div style={{ fontSize: '11px', color: '#666', marginTop: '2px' }}>
                                  Server Prefix: "{match.serverPrefix}" | Local Prefix: "{match.localPrefix}"
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                      {signalNotFoundInfo.selectedMatchIndex !== undefined && (
                        <div className="form-group" style={{ marginTop: '12px', padding: '10px', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
                          <label className="form-label">Selected Configuration</label>
                          <div style={{ fontSize: '12px', color: '#333' }}>
                            <div>Server Prefix: "{signalNotFoundInfo.allMatches[signalNotFoundInfo.selectedMatchIndex].serverPrefix}"</div>
                            <div>Local Prefix: "{signalNotFoundInfo.allMatches[signalNotFoundInfo.selectedMatchIndex].localPrefix}"</div>
                            <div>Space Before Bracket: {signalNotFoundInfo.allMatches[signalNotFoundInfo.selectedMatchIndex].spaceBeforeBracket ? 'Yes' : 'No'}</div>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    // Single match - show simple info
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
                        <label className="form-label">Local Prefix (removed from local name)</label>
                        <input type="text" className="form-input" value={signalNotFoundInfo.prefix} readOnly />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Server Prefix (added to server name)</label>
                        <input type="text" className="form-input" value={signalNotFoundInfo.serverPrefix} readOnly />
                      </div>
                    </>
                  )}
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
              <button className="btn" onClick={() => setShowSignalNotFoundDialog(false)}>
                Cancel
              </button>
              {signalNotFoundInfo.success && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    // Handle confirm action
                    // Update current tab's prefix settings instead of global settings
                    const updateTabPrefixSettings = (localPrefix: string, serverPrefix: string, spaceBeforeBracket: boolean) => {
                      // Check if current active tab is a waveform or tableview tab
                      const activeTabData = tabs.find(t => t.id === activeTab && (t.type === 'waveform' || t.type === 'tableview'))
                      if (activeTabData) {
                        // Update tab's settings
                        setTabs(prev => prev.map(tab =>
                          tab.id === activeTab ? {
                            ...tab,
                            signalPrefix: localPrefix,
                            serverPrefix: serverPrefix,
                            spaceBeforeBracket: spaceBeforeBracket,
                          } : tab
                        ))
                      }
                      // Also update global settings for backward compatibility and new tabs
                      setCurrentWaveSignalPrefix(localPrefix);
                      setCurrentWaveSignalServerPrefix(serverPrefix);
                      setCurrentWaveSignalSpaceBeforeBracket(spaceBeforeBracket);
                      updateProviderSettings(localPrefix, serverPrefix, spaceBeforeBracket);
                    }

                    if (signalNotFoundInfo.allMatches && signalNotFoundInfo.allMatches.length > 1) {
                      // Multiple matches - use selected one
                      if (signalNotFoundInfo.selectedMatchIndex !== undefined) {
                        const selectedMatch = signalNotFoundInfo.allMatches[signalNotFoundInfo.selectedMatchIndex];
                        updateTabPrefixSettings(selectedMatch.localPrefix, selectedMatch.serverPrefix, selectedMatch.spaceBeforeBracket);
                        // Add the pending signal to the appropriate tab type
                        if (pendingSignalToAdd) {
                          if (pendingSignalTabType === 'tableview') {
                            addSignalToTableViewDirect(pendingSignalToAdd);
                          } else {
                            addSignalToWaveform(pendingSignalToAdd);
                          }
                          setPendingSignalToAdd(null);
                          setPendingSignalTabType(null);
                        }
                      }
                    } else {
                      // Single match - use the info directly
                      updateTabPrefixSettings(signalNotFoundInfo.prefix, signalNotFoundInfo.serverPrefix, signalNotFoundInfo.spaceBeforeBracket);
                      // Add the pending signal to the appropriate tab type
                      if (pendingSignalToAdd) {
                        if (pendingSignalTabType === 'tableview') {
                          addSignalToTableViewDirect(pendingSignalToAdd);
                        } else {
                          addSignalToWaveform(pendingSignalToAdd);
                        }
                        setPendingSignalToAdd(null);
                        setPendingSignalTabType(null);
                      }
                    }
                    setShowSignalNotFoundDialog(false);
                  }}
                  disabled={signalNotFoundInfo.allMatches && signalNotFoundInfo.allMatches.length > 1 && signalNotFoundInfo.selectedMatchIndex === undefined}
                >
                  Confirm
                </button>
              )}
              {!signalNotFoundInfo.success && (
                <button className="btn btn-primary" onClick={() => setShowSignalNotFoundDialog(false)}>
                  OK
                </button>
              )}
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
    </WaveformProviderProvider>
  )
}

export default App
