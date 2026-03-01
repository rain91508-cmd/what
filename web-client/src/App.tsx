// ============================================
// HWDA Web Client - Main Application
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

// Bookmark
import { bookmarkManager, type Bookmark } from './types/bookmark'

// Types
import type { Signal } from './types/kdb'
import type { WaveformInfo, ColumnWidths, TimeConfig, Tab, NavigationHistoryEntry } from './components/TabPanel'

// 默认时间配置
// 默认 10ns/px = 10,000 ps/px
const DEFAULT_TIME_CONFIG: TimeConfig = {
  unitTimePs: 10000,  // 默认 10,000 ps/px (10 ns/px)
  unit: 'ns',
  pixelsPerUnit: 10,  // 固定 10 像素每单位
}

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
  
  // Global selected module index for hierarchy/signal panel (1-based)
  const [selectedModuleIndex, setSelectedModuleIndex] = useState<number | null>(null)
  
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
    setMessages(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`])
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
  const addNavigationEntry = useCallback((fileId: number, line: number) => {
    setTabs(prev => prev.map(tab => {
      if (tab.id !== activeTab || tab.type !== 'source') return tab;
      
      const history = tab.navigationHistory || [];
      const pointer = tab.navigationPointer || 0;
      
      // Create new entry
      const newEntry: NavigationHistoryEntry = {
        fileId,
        line,
        timestamp: Date.now()
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

  // Navigate to previous location in history
  const navigatePrevious = useCallback(() => {
    const activeTabData = tabs.find(t => t.id === activeTab);
    if (!activeTabData || activeTabData.type !== 'source') return;
    
    const pointer = activeTabData.navigationPointer || 0;
    if (pointer <= 1) return; // Can't go back if at start
    
    const newPointer = pointer - 1;
    const history = activeTabData.navigationHistory || [];
    const entry = history[newPointer - 1]; // -1 because pointer is 1-based for next insertion
    
    if (!entry) return;
    
    // Find module that uses this file
    const modules = kdbManager.getAllModules();
    const moduleIndex = modules.findIndex(m => m.definition?.fileId === entry.fileId);
    
    if (moduleIndex >= 0) {
      const moduleIdx = moduleIndex + 1;
      setTabs(prev => prev.map(tab => 
        tab.id === activeTab 
          ? { 
              ...tab, 
              moduleIndex: moduleIdx,
              signalDeclarationLine: entry.line,
              navigationPointer: newPointer
            } 
          : tab
      ));
      addMessage(`Navigate back to line ${entry.line}`);
    }
  }, [activeTab, tabs, addMessage]);

  // Navigate to next location in history
  const navigateNext = useCallback(() => {
    const activeTabData = tabs.find(t => t.id === activeTab);
    if (!activeTabData || activeTabData.type !== 'source') return;
    
    const pointer = activeTabData.navigationPointer || 0;
    const history = activeTabData.navigationHistory || [];
    
    if (pointer >= history.length) return; // Can't go forward if at end
    
    const newPointer = pointer + 1;
    const entry = history[newPointer - 1]; // -1 because pointer is 1-based for next insertion
    
    if (!entry) return;
    
    // Find module that uses this file
    const modules = kdbManager.getAllModules();
    const moduleIndex = modules.findIndex(m => m.definition?.fileId === entry.fileId);
    
    if (moduleIndex >= 0) {
      const moduleIdx = moduleIndex + 1;
      setTabs(prev => prev.map(tab => 
        tab.id === activeTab 
          ? { 
              ...tab, 
              moduleIndex: moduleIdx,
              signalDeclarationLine: entry.line,
              navigationPointer: newPointer
            } 
          : tab
      ));
      addMessage(`Navigate forward to line ${entry.line}`);
    }
  }, [activeTab, tabs, addMessage]);

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
    
    const moduleIndex = activeSourceTab.moduleIndex;
    if (!moduleIndex) {
      addMessage('Cannot bookmark: no module loaded');
      return;
    }
    
    // Get current line from Monaco editor
    let lineNumber = 1;
    if (monacoEditorRef.current) {
      const position = monacoEditorRef.current.getPosition();
      if (position) {
        lineNumber = position.lineNumber;
      }
    } else if (activeSourceTab.signalDeclarationLine) {
      lineNumber = activeSourceTab.signalDeclarationLine;
    }
    
    // Get file info
    const fileId = await kdbManager.getModuleFileId(moduleIndex);
    if (!fileId) {
      addMessage('Cannot bookmark: file not found');
      return;
    }
    
    const fileInfo = await kdbManager.getFileInfo(fileId);
    if (!fileInfo) {
      addMessage('Cannot bookmark: file info not found');
      return;
    }
    
    // Get line content (we need to fetch the source content)
    const sourceFile = await kdbManager.getSourceFile(fileId);
    if (!sourceFile) {
      addMessage('Cannot bookmark: source file not found');
      return;
    }
    const lines = sourceFile.content.split('\n');
    const lineContent = lines[lineNumber - 1]?.trim() || '';
    
    // Create bookmark (name will be auto-generated as "Mark N")
    const bookmark = bookmarkManager.addBookmark({
      moduleIndex: moduleIndex,  // Store module index for navigation
      fileId: fileId,
      fileName: fileInfo.name,
      fileFullName: fileInfo.fullName,
      lineNumber: lineNumber,
      lineContent: lineContent,
    });
    
    addMessage(`Added bookmark: ${bookmark.name}`);
  }, [activeTab, tabs, addMessage]);
  
  // Handle bookmark click - jump to source
  const handleBookmarkClick = useCallback((bookmark: Bookmark) => {
    // Use stored moduleIndex from bookmark
    const moduleIndex = bookmark.moduleIndex;
    
    // Check if there's an active source tab
    const activeSourceTab = tabs.find(t => t.type === 'source' && t.id === activeTab);
    
    if (activeSourceTab) {
      // Update existing source tab
      setTabs(prev => prev.map(tab => 
        tab.id === activeSourceTab.id 
          ? { 
              ...tab, 
              moduleIndex: moduleIndex,
              signalDeclarationLine: bookmark.lineNumber,
              startFromLine1: true
            } 
          : tab
      ));
      setActiveTab(activeSourceTab.id);
      
      // Add navigation entry
      addNavigationEntry(bookmark.fileId, bookmark.lineNumber);
      addMessage(`Jump to bookmark: ${bookmark.name}`);
    } else {
      // No active source tab, create one
      const newId = `source-${tabCounter.current++}`;
      const newTab: Tab = {
        id: newId,
        label: 'Source',
        type: 'source',
        moduleIndex: moduleIndex,
        signalDeclarationLine: bookmark.lineNumber,
        startFromLine1: true,
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTab(newId);
      
      // Add navigation entry after tab is created
      setTimeout(() => addNavigationEntry(bookmark.fileId, bookmark.lineNumber), 0);
      addMessage(`Open source at bookmark: ${bookmark.name}`);
    }
  }, [activeTab, tabs, addNavigationEntry, addMessage]);

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
  const handleWaveSelect = async (waveName: string) => {
    setShowWaveSelectionDialog(false)
    waveManager.setCurrentWaveform(waveName)
    setCurrentWaveform(waveName)
    addMessage(`Selected waveform: ${waveName}`)
    
    // Get checksum from list API
    const listResponse = await apiService.getWaveformList()
    let waveChecksum: string | null = null
    if (listResponse.status === 'success' && listResponse.data?.waves) {
      const serverWave = listResponse.data.waves.find(w => w.name === waveName)
      if (serverWave) {
        waveChecksum = serverWave.checksum
      }
    }
    
    setCurrentWaveName(waveName)
    setCurrentWaveChecksum(waveChecksum)
    
    // Reset mock data flag when loading real waveform
    if (useMockData) {
      setUseMockData(false)
      addMessage('Switched from mock data to real waveform data')
    }
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
    addMessage(`Selected module: ${fullName}`)
  }

  const handleModuleDoubleClick = (moduleIndex: number) => {
    console.log('[App] handleModuleDoubleClick called, moduleIndex:', moduleIndex);
    
    // Update global selected module index
    setSelectedModuleIndex(moduleIndex)
    
    // Get module info for navigation history
    const module = kdbManager.getModuleById(moduleIndex);
    const fileId = module?.definition?.fileId;
    const line = module?.definition?.startLine || 1;
    
    // Find or create a source tab for this module and switch to it
    const existingSourceTab = tabs.find(t => t.type === 'source')
    console.log('[App] Existing source tab:', existingSourceTab);
    
    if (existingSourceTab) {
      // Update existing source tab with the new module index
      // Clear startFromLine1 and signalDeclarationLine to use module's startLine
      setTabs(prev => prev.map(tab => 
        tab.id === existingSourceTab.id 
          ? { ...tab, moduleIndex, startFromLine1: undefined, signalDeclarationLine: undefined } 
          : tab
      ))
      setActiveTab(existingSourceTab.id)
      console.log('[App] Updated existing source tab, set active to:', existingSourceTab.id);
      
      // Add navigation entry
      if (fileId) {
        addNavigationEntry(fileId, line);
      }
    } else {
      // Create a new source tab
      const newId = `source-${tabCounter.current++}`
      const newTab: Tab = {
        id: newId,
        label: 'Source',
        type: 'source',
        moduleIndex,
      }
      console.log('[App] Creating new source tab:', newTab);
      setTabs(prev => [...prev, newTab])
      setActiveTab(newId)
      console.log('[App] Created new source tab, set active to:', newId);
      
      // Add navigation entry after tab is created and active
      if (fileId) {
        setTimeout(() => addNavigationEntry(fileId, line), 0);
      }
    }
    // Calculate fullName on demand
    const fullName = kdbManager.calculateModuleFullName(moduleIndex)
    addMessage(`Open source for: ${fullName}`)
  }

  const handleFileDoubleClick = (fileId: number) => {
    console.log('[App] handleFileDoubleClick called, fileId:', fileId);
    
    // Open file directly - find a module that uses this file
    // and open it from line 1 (not from module's start line)
    const modules = kdbManager.getAllModules();
    const moduleIndex = modules.findIndex(m => m.definition?.fileId === fileId);
    
    if (moduleIndex >= 0) {
      const moduleIdx = moduleIndex + 1; // Convert to 1-based index
      
      // Update global selected module index
      setSelectedModuleIndex(moduleIdx)
      
      // Find or create a source tab for this file and switch to it
      const existingSourceTab = tabs.find(t => t.type === 'source')
      
      if (existingSourceTab) {
        // Update existing source tab with the new module index
        // Clear signalDeclarationLine to ensure startFromLine1 takes effect
        setTabs(prev => prev.map(tab => 
          tab.id === existingSourceTab.id 
            ? { ...tab, moduleIndex: moduleIdx, startFromLine1: true, signalDeclarationLine: undefined } 
            : tab
        ))
        setActiveTab(existingSourceTab.id)
        
        // Add navigation entry (line 1 for file mode)
        addNavigationEntry(fileId, 1);
      } else {
        // Create a new source tab
        const newId = `source-${tabCounter.current++}`
        const newTab: Tab = {
          id: newId,
          label: 'Source',
          type: 'source',
          moduleIndex: moduleIdx,
          startFromLine1: true,
        }
        setTabs(prev => [...prev, newTab])
        setActiveTab(newId)
        
        // Add navigation entry after tab is created
        setTimeout(() => addNavigationEntry(fileId, 1), 0);
      }
      addMessage(`Open file from line 1`)
    }
  }

  const handleSignalDoubleClick = (signal: Signal, moduleIndex: number) => {
    console.log('[App] handleSignalDoubleClick called, signal:', signal.name, 'declaration:', signal.declaration, 'moduleIndex:', moduleIndex)
    
    if (!signal.declaration) {
      addMessage(`No declaration info for ${signal.name}`)
      return
    }
    
    const line = signal.declaration.line;
    const fileId = signal.declaration.fileId;
    
    // Check if there's an active source tab
    const activeSourceTab = tabs.find(t => t.type === 'source' && t.id === activeTab)
    
    if (activeSourceTab) {
      // Update the active source tab to jump to signal declaration
      setTabs(prev => prev.map(tab => 
        tab.id === activeSourceTab.id 
          ? { 
              ...tab, 
              moduleIndex: moduleIndex,
              signalDeclarationLine: line 
            } 
          : tab
      ))
      setActiveTab(activeSourceTab.id)
      
      // Add navigation entry
      addNavigationEntry(fileId, line);
      addMessage(`Jump to ${signal.name} declaration (line ${line})`)
    } else {
      // No active source tab, create one
      const newId = `source-${tabCounter.current++}`
      const newTab: Tab = {
        id: newId,
        label: 'Source',
        type: 'source',
        moduleIndex: moduleIndex,
        signalDeclarationLine: line,
      }
      setTabs(prev => [...prev, newTab])
      setActiveTab(newId)
      
      // Add navigation entry after tab is created
      setTimeout(() => addNavigationEntry(fileId, line), 0);
      addMessage(`Open source at ${signal.name} declaration (line ${line})`)
    }
  }

  const handleSignalAddToWaveform = (signal: Signal) => {
    // If no waveform loaded and not already using mock data, ask user
    if (!currentWaveName && !useMockData) {
      setPendingMockSignal(signal)
      setShowMockDataDialog(true)
      return
    }
    
    // Add signal to waveform
    addSignalToWaveform(signal)
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
  const handleAddTab = (type: 'source' | 'waveform') => {
    const newId = `${type}-${tabCounter.current++}`
    const newTab: Tab = {
      id: newId,
      label: type === 'source' ? `Source ${tabCounter.current - 1}` : `Waveform ${tabCounter.current - 1}`,
      type,
      moduleIndex: type === 'source' ? null : undefined,
      signals: type === 'waveform' ? [] : undefined,
      groups: type === 'waveform' ? createDefaultGroups() : undefined,
      selectedGroup: type === 'waveform' ? 'group_1' : undefined,
      timeConfig: type === 'waveform' ? { ...DEFAULT_TIME_CONFIG } : undefined,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTab(newId)
    addMessage(`Added new ${type} tab`)
  }

  // Update time configuration for a specific tab
  const handleTimeConfigChange = (tabId: string, timeConfig: TimeConfig) => {
    setTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, timeConfig } : tab
    ))
  }

  // Zoom in (decrease unit time by half, but not below minUnitTime)
  const handleZoomIn = () => {
    const currentTab = tabs.find(t => t.id === activeTab)
    if (currentTab?.type === 'waveform' && currentTab.timeConfig) {
      // Calculate new unit time (half of current, but at least 1 ps)
      const newUnitTimePs = Math.max(1, Math.floor(currentTab.timeConfig.unitTimePs / 2))
      
      // Check if we can zoom in further
      if (newUnitTimePs < currentTab.timeConfig.unitTimePs) {
        handleTimeConfigChange(activeTab, {
          ...currentTab.timeConfig,
          unitTimePs: newUnitTimePs,
        })
        addMessage(`Zoom in: ${newUnitTimePs} ps/px`)
      } else {
        addMessage('Already at maximum zoom')
      }
    }
  }

  // Zoom out (increase unit time by double, but not beyond max time range)
  const handleZoomOut = () => {
    const currentTab = tabs.find(t => t.id === activeTab)
    if (currentTab?.type === 'waveform' && currentTab.timeConfig) {
      // Get max time from mock data (assume 1,000,000 ps = 1000 ns for now)
      const maxTimePs = 1000000
      
      // Calculate new unit time (double of current)
      const newUnitTimePs = currentTab.timeConfig.unitTimePs * 2
      
      // Calculate current viewport width (assume 800px for now)
      const viewportWidth = 800
      const newTimeRange = (viewportWidth / currentTab.timeConfig.pixelsPerUnit) * newUnitTimePs
      
      // Check if new time range would exceed max time
      if (newTimeRange <= maxTimePs) {
        handleTimeConfigChange(activeTab, {
          ...currentTab.timeConfig,
          unitTimePs: newUnitTimePs,
        })
        addMessage(`Zoom out: ${newUnitTimePs} ps/px`)
      } else {
        addMessage('Already at minimum zoom (max time range reached)')
      }
    }
  }

  // Zoom to fit - set viewport to 0 to max time
  const handleZoomFit = () => {
    const currentTab = tabs.find(t => t.id === activeTab)
    if (currentTab?.type === 'waveform' && currentTab.timeConfig) {
      // Get max time from mock data
      const maxTimePs = 1000000
      
      // Calculate viewport width (assume 800px for now)
      const viewportWidth = 800
      
      // Calculate unit time to fit entire waveform: maxTime / (width / pixelsPerUnit)
      const newUnitTimePs = Math.floor(maxTimePs / (viewportWidth / currentTab.timeConfig.pixelsPerUnit))
      
      handleTimeConfigChange(activeTab, {
        ...currentTab.timeConfig,
        unitTimePs: Math.max(1, newUnitTimePs),
      })
      addMessage('Zoom to fit: 0 to 1000 ns')
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

  // Use refs to store start values during resize
  const hierarchyStartWidthRef = useRef(hierarchyWidth)
  const signalStartWidthRef = useRef(signalWidth)
  const messageStartHeightRef = useRef(messageHeight)

  const handleHierarchyResize = (delta: number) => {
    setHierarchyWidth(Math.max(180, Math.min(300, hierarchyStartWidthRef.current + delta)))
  }

  const handleSignalPanelResize = (delta: number) => {
    setSignalWidth(Math.max(160, Math.min(280, signalStartWidthRef.current + delta)))
  }

  const handleMessageResize = (delta: number) => {
    setMessageHeight(Math.max(60, messageStartHeightRef.current - delta))
  }

  if (!initialized) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner"></div>
        <p>Initializing HWDA...</p>
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
      />

      {/* Tool Bar */}
      <ToolBar
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomFit={handleZoomFit}
        onSearch={() => {}}
        onAddSourceTab={() => handleAddTab('source')}
        onAddWaveformTab={() => handleAddTab('waveform')}
        onNavigatePrevious={navigatePrevious}
        onNavigateNext={navigateNext}
        canNavigatePrevious={canNavigatePrevious()}
        canNavigateNext={canNavigateNext()}
        timeConfig={activeTabData?.timeConfig}
        onTimeConfigChange={(config) => handleTimeConfigChange(activeTab, config)}
        maxWaveformTimePs={1000000}
        onConnect={() => setShowConnectionDialog(true)}
        onOpenKdb={() => setShowKdbSelectionDialog(true)}
        onOpenWaveform={() => setShowWaveSelectionDialog(true)}
        connected={connected}
        onRefreshCheck={handleManualRefreshCheck}
        onToggleAutoCheck={handleToggleAutoCheck}
        autoCheckEnabled={autoCheckEnabled}
        onAddBookmark={handleAddBookmark}
      />

      {/* Main Content */}
      <div className="main-content">
        {/* Left Panel - Design Browser (Hierarchy) */}
        <div 
          className="left-panel hierarchy-panel"
          style={{ width: hierarchyWidth, minWidth: 180, maxWidth: 300 }}
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
        <Splitter direction="horizontal" onDrag={handleHierarchyResize} />

        {/* Middle Panel - Signal Panel */}
        <div 
          className="signal-panel"
          style={{ width: signalWidth, minWidth: 160, maxWidth: 280 }}
        >
          <SignalPanel
            selectedModuleIndex={selectedModuleIndex}
            onSignalAddToWaveform={handleSignalAddToWaveform}
            onSignalDoubleClick={handleSignalDoubleClick}
            activeTabType={tabs.find(t => t.id === activeTab)?.type}
          />
        </div>

        {/* Splitter between signal panel and main panel */}
        <Splitter direction="horizontal" onDrag={handleSignalPanelResize} />

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
                startFromLine1={activeTabData.startFromLine1}
                signalDeclarationLine={activeTabData.signalDeclarationLine}
                editorRef={monacoEditorRef}
              />
            ) : activeTabData ? (
              <WaveformWindow
                key={activeTabData.id}
                signals={activeTabData.signals || []}
                groups={activeTabData.groups || createDefaultGroups()}
                selectedGroup={activeTabData.selectedGroup || 'group_1'}
                columnWidths={activeTabData.columnWidths}
                timeConfig={activeTabData.timeConfig}
                onSignalRemove={handleSignalRemove}
                onGroupsUpdate={(groups) => handleGroupsUpdate(activeTabData.id, groups)}
                onSelectedGroupUpdate={(selectedGroup) => handleSelectedGroupUpdate(activeTabData.id, selectedGroup)}
                onSignalsProcessed={(processedIds) => handleSignalsProcessed(activeTabData.id, processedIds)}
                onColumnWidthsChange={(widths) => handleColumnWidthsChange(activeTabData.id, widths)}
              />
            ) : null}
          </TabPanel>
        </div>
      </div>

      {/* Splitter between main content and messages */}
      <Splitter direction="vertical" onDrag={handleMessageResize} />

      {/* Bottom Panel - Messages */}
      <div 
        className="bottom-panel"
        style={{ height: messageHeight, minHeight: 60 }}
      >
        <MessageWindow messages={messages} onBookmarkClick={handleBookmarkClick} />
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
    </div>
  )
}

export default App
