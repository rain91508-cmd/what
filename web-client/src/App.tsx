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

import { useState, useEffect, useRef } from 'react'
import './App.css'

// Core services
import { indexedDBManager } from './core/storage/indexedDB'
import { opfsManager } from './core/storage/opfs'
import { apiService } from './services/api'

// Modules
import { wSignal } from './modules/wSignal'

// Components
import { MenuBar } from './components/MenuBar'
import { ToolBar } from './components/ToolBar'
import { DesignBrowser } from './components/DesignBrowser'
import { SignalList } from './components/SignalList'
import { TabPanel, type Tab } from './components/TabPanel'
import { SourceCodeWindow } from './components/SourceCodeWindow'
import { WaveformWindow } from './components/WaveformWindow'
import { MessageWindow } from './components/MessageWindow'
import { ConnectionDialog } from './components/ConnectionDialog'
import { Splitter } from './components/ResizablePanel'

// Types
import type { Instance, Signal } from './types'
import type { WaveformSignal, ColumnWidths, TimeConfig } from './components/TabPanel'

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
  const [messages, setMessages] = useState<string[]>([])
  
  // Global selected instance for hierarchy/signal panel
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(null)
  
  // Global waveform signal ID counter - 用于生成全局唯一的信号 ID
  const nextWaveformSignalIdRef = useRef(1)
  
  // Helper function to create default groups
  const createDefaultGroups = () => ({
    'root': {
      id: 'root',
      name: 'root',
      parentId: null,
      signals: [],
      expanded: true,
      children: ['group_1'],
    },
    'group_1': {
      id: 'group_1',
      name: 'Group_1',
      parentId: 'root',
      signals: [],
      expanded: true,
      children: [],
    },
  });

  // Dynamic tabs state - each tab has its own data
  const [tabs, setTabs] = useState<Tab[]>([
    { id: 'source-1', label: 'Source', type: 'source', instance: null },
    { 
      id: 'waveform-1', 
      label: 'Waveform', 
      type: 'waveform', 
      signals: [],
      groups: createDefaultGroups(),
      selectedGroup: 'group_1',
      timeConfig: { ...DEFAULT_TIME_CONFIG },
    },
  ])
  const [activeTab, setActiveTab] = useState('source-1')
  const tabCounter = useRef(2)
  
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

        // Try to restore connection
        const savedConfig = localStorage.getItem('serverConfig')
        if (savedConfig) {
          const config = JSON.parse(savedConfig)
          apiService.configure(config)
          const isConnected = await apiService.testConnection()
          setConnected(isConnected)
        }

        setInitialized(true)
        addMessage('Application initialized successfully')
      } catch (error) {
        console.error('Initialization error:', error)
        addMessage(`Initialization error: ${error}`)
      }
    }

    init()
  }, [])

  const addMessage = (msg: string) => {
    setMessages(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`])
  }

  const handleConnect = async (host: string, port: number) => {
    apiService.configure({ host, port, useHttps: false })
    const isConnected = await apiService.testConnection()
    setConnected(isConnected)

    if (isConnected) {
      localStorage.setItem('serverConfig', JSON.stringify({ host, port, useHttps: false }))
      addMessage(`Connected to server at ${host}:${port}`)

      // Load knowledge base
      try {
        const kdbData = await apiService.downloadKdb()
        if (kdbData) {
          addMessage('Knowledge base downloaded successfully')
        }
      } catch (error) {
        addMessage(`Failed to download knowledge base: ${error}`)
      }
    } else {
      addMessage(`Failed to connect to ${host}:${port}`)
    }
  }

  const handleInstanceSelect = (instance: Instance) => {
    // Update global selected instance for hierarchy/signal panel
    setSelectedInstance(instance)
    addMessage(`Selected instance: ${instance.fullPath}`)
  }

  const handleInstanceDoubleClick = (instance: Instance) => {
    // Update global selected instance
    setSelectedInstance(instance)
    // Find or create a source tab for this instance and switch to it
    const existingSourceTab = tabs.find(t => t.type === 'source')
    if (existingSourceTab) {
      // Update existing source tab with the new instance
      setTabs(prev => prev.map(tab => 
        tab.id === existingSourceTab.id 
          ? { ...tab, instance } 
          : tab
      ))
      setActiveTab(existingSourceTab.id)
    } else {
      // Create a new source tab
      const newId = `source-${tabCounter.current++}`
      const newTab: Tab = {
        id: newId,
        label: 'Source',
        type: 'source',
        instance,
      }
      setTabs(prev => [...prev, newTab])
      setActiveTab(newId)
    }
    addMessage(`Open source for: ${instance.fullPath}`)
  }

  const handleSignalSelect = (_signal: Signal) => {
    // Just select the signal, don't add to waveform
    // This is called on single click
  }

  const handleSignalAddToWaveform = (signal: Signal) => {
    // 生成全局唯一的信号 ID
    const unique_id = nextWaveformSignalIdRef.current++
    const waveformSignal: WaveformSignal = { ...signal, unique_id }
    
    // Add signal to the active waveform tab, or create one if none exists
    const activeWaveformTab = tabs.find(t => t.id === activeTab && t.type === 'waveform')
    
    if (activeWaveformTab) {
      // Add to current active waveform tab
      setTabs(prev => prev.map(tab => {
        if (tab.id === activeTab && tab.type === 'waveform') {
          const currentSignals = tab.signals || []
          return { ...tab, signals: [...currentSignals, waveformSignal] }
        }
        return tab
      }))
      addMessage(`Added signal to waveform: ${signal.name}`)
    } else {
      // No active waveform tab, find any waveform tab or create new one
      const anyWaveformTab = tabs.find(t => t.type === 'waveform')
      if (anyWaveformTab) {
        // Add to existing waveform tab and switch to it
        setTabs(prev => prev.map(tab => {
          if (tab.id === anyWaveformTab.id) {
            const currentSignals = tab.signals || []
            return { ...tab, signals: [...currentSignals, waveformSignal] }
          }
          return tab
        }))
        setActiveTab(anyWaveformTab.id)
        addMessage(`Added signal to waveform: ${signal.name}`)
      } else {
        // Create a new waveform tab
        const newId = `waveform-${tabCounter.current++}`
        const newTab: Tab = {
          id: newId,
          label: 'Waveform',
          type: 'waveform',
          signals: [waveformSignal],
        }
        setTabs(prev => [...prev, newTab])
        setActiveTab(newId)
        addMessage(`Created new waveform tab with signal: ${signal.name}`)
      }
    }
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
      instance: type === 'source' ? null : undefined,
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
    setMessageHeight(Math.max(60, Math.min(250, messageStartHeightRef.current - delta)))
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
        onDisconnect={() => {
          setConnected(false)
          addMessage('Disconnected from server')
        }}
      />

      {/* Tool Bar */}
      <ToolBar
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomFit={handleZoomFit}
        onSearch={() => {}}
        onAddSourceTab={() => handleAddTab('source')}
        onAddWaveformTab={() => handleAddTab('waveform')}
        timeConfig={activeTabData?.timeConfig}
        onTimeConfigChange={(config) => handleTimeConfigChange(activeTab, config)}
        maxWaveformTimePs={1000000}
      />

      {/* Main Content */}
      <div className="main-content">
        {/* Left Panel - Design Browser (Hierarchy) */}
        <div 
          className="left-panel hierarchy-panel"
          style={{ width: hierarchyWidth, minWidth: 180, maxWidth: 300 }}
        >
          <DesignBrowser
            onInstanceSelect={handleInstanceSelect}
            onInstanceDoubleClick={handleInstanceDoubleClick}
            selectedInstance={selectedInstance}
          />
        </div>

        {/* Splitter between hierarchy and signal panel */}
        <Splitter direction="horizontal" onDrag={handleHierarchyResize} />

        {/* Middle Panel - Signal List */}
        <div 
          className="signal-panel"
          style={{ width: signalWidth, minWidth: 160, maxWidth: 280 }}
        >
          <SignalList
            instance={selectedInstance}
            onSignalSelect={handleSignalSelect}
            onSignalAddToWaveform={handleSignalAddToWaveform}
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
              <SourceCodeWindow
                key={activeTabData.id}
                instance={activeTabData.instance || null}
              />
            ) : (
              <WaveformWindow
                key={activeTabData.id}
                signals={activeTabData?.signals || []}
                groups={activeTabData?.groups || createDefaultGroups()}
                selectedGroup={activeTabData?.selectedGroup || 'group_1'}
                columnWidths={activeTabData?.columnWidths}
                timeConfig={activeTabData?.timeConfig}
                onSignalRemove={handleSignalRemove}
                onGroupsUpdate={(groups) => handleGroupsUpdate(activeTabData.id, groups)}
                onSelectedGroupUpdate={(selectedGroup) => handleSelectedGroupUpdate(activeTabData.id, selectedGroup)}
                onSignalsProcessed={(processedIds) => handleSignalsProcessed(activeTabData.id, processedIds)}
                onColumnWidthsChange={(widths) => handleColumnWidthsChange(activeTabData.id, widths)}
              />
            )}
          </TabPanel>
        </div>
      </div>

      {/* Splitter between main content and messages */}
      <Splitter direction="vertical" onDrag={handleMessageResize} />

      {/* Bottom Panel - Messages */}
      <div 
        className="bottom-panel"
        style={{ height: messageHeight, minHeight: 60, maxHeight: 250 }}
      >
        <MessageWindow messages={messages} />
      </div>

      {/* Connection Dialog */}
      {showConnectionDialog && (
        <ConnectionDialog
          onConnect={handleConnect}
          onClose={() => setShowConnectionDialog(false)}
        />
      )}
    </div>
  )
}

export default App
