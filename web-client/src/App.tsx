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
import { TabPanel } from './components/TabPanel'
import { SourceCodeWindow } from './components/SourceCodeWindow'
import { WaveformWindow } from './components/WaveformWindow'
import { MessageWindow } from './components/MessageWindow'
import { ConnectionDialog } from './components/ConnectionDialog'
import { Splitter } from './components/ResizablePanel'

// Types
import type { Instance, Signal } from './types'

function App() {
  const [initialized, setInitialized] = useState(false)
  const [connected, setConnected] = useState(false)
  const [showConnectionDialog, setShowConnectionDialog] = useState(false)
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(null)
  const [selectedSignals, setSelectedSignals] = useState<Signal[]>([])
  const [activeTab, setActiveTab] = useState<'source' | 'waveform'>('waveform')
  const [messages, setMessages] = useState<string[]>([])
  
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
    setSelectedInstance(instance)
    addMessage(`Selected instance: ${instance.fullPath}`)
  }

  const handleSignalSelect = (_signal: Signal) => {
    // Just select the signal, don't add to waveform
    // This is called on single click
  }

  const handleSignalAddToWaveform = (signal: Signal) => {
    // Add signal to waveform view - allow duplicates
    setSelectedSignals(prev => [...prev, signal])
    addMessage(`Added signal to waveform: ${signal.name}`)
  }

  const handleSignalRemove = (signal: Signal) => {
    // Remove only the specific signal instance (using both handle and fullPath for uniqueness)
    const index = selectedSignals.findIndex(s => s.handle === signal.handle && s.fullPath === signal.fullPath)
    if (index !== -1) {
      setSelectedSignals(prev => prev.filter((_, i) => i !== index))
      addMessage(`Removed signal from waveform: ${signal.name}`)
    }
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
        onZoomIn={() => wSignal.zoomIn()}
        onZoomOut={() => wSignal.zoomOut()}
        onZoomFit={() => wSignal.zoomToFit()}
        onSearch={() => {}}
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
            onTabChange={(tabId) => setActiveTab(tabId as 'source' | 'waveform')}
            tabs={[
              { id: 'source', label: 'Source' },
              { id: 'waveform', label: 'Waveform' },
            ]}
          >
            {activeTab === 'source' && (
              <SourceCodeWindow
                instance={selectedInstance}
              />
            )}
            {activeTab === 'waveform' && (
              <WaveformWindow
                signals={selectedSignals}
                onSignalRemove={handleSignalRemove}
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
