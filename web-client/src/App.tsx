// ============================================
// HWDA Web Client - Main Application
// ============================================
//
// Layout (per spec.md):
// ┌─────────────────────────────────────────────────────────────┐
// │  Menu Bar  │  Tool Bar                                       │
// ├────────────┬────────────────────────────────────────────────┤
// │            │                                                │
// │  Design    │              Source Code Window                │
// │  Browser   │              (wHDL)                            │
// │            │                                                │
// │  (Signal   ├────────────────────────────────────────────────┤
// │   List)    │              Waveform Window                   │
// │            │              (wSignal)                         │
// │            │                                                │
// ├────────────┴────────────────────────────────────────────────┤
// │  Message / Console Window                                   │
// └─────────────────────────────────────────────────────────────┘

import { useState, useEffect } from 'react'
import './App.css'

// Core services
import { indexedDBManager } from './core/storage/indexedDB'
import { opfsManager } from './core/storage/opfs'
// import { wasmManager } from './wasm'
import { apiService } from './services/api'

// Modules
// import { knowledgeManager } from './modules/knowledge'
// import { wHDL } from './modules/wHDL'
import { wSignal } from './modules/wSignal'

// Components
import { MenuBar } from './components/MenuBar'
import { ToolBar } from './components/ToolBar'
import { DesignBrowser } from './components/DesignBrowser'
import { SourceCodeWindow } from './components/SourceCodeWindow'
import { WaveformWindow } from './components/WaveformWindow'
import { MessageWindow } from './components/MessageWindow'
import { ConnectionDialog } from './components/ConnectionDialog'

function App() {
  const [initialized, setInitialized] = useState(false)
  const [connected, setConnected] = useState(false)
  const [showConnectionDialog, setShowConnectionDialog] = useState(false)
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [messages, setMessages] = useState<string[]>([])

  // Initialize application
  useEffect(() => {
    const init = async () => {
      try {
        // Initialize storage layers
        await indexedDBManager.initialize()
        if (opfsManager.isSupported()) {
          await opfsManager.initialize()
        }

        // Initialize WASM
        // await wasmManager.initialize()

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
          // Parse and initialize knowledge base
          // This would deserialize the protobuf data
          addMessage('Knowledge base downloaded successfully')
        }
      } catch (error) {
        addMessage(`Failed to download knowledge base: ${error}`)
      }
    } else {
      addMessage(`Failed to connect to ${host}:${port}`)
    }
  }

  const handleFileSelect = (filePath: string) => {
    setActiveFile(filePath)
    addMessage(`Opened file: ${filePath}`)
  }

  const handleSignalSelect = (signalPath: string) => {
    // Add signal to waveform view
    addMessage(`Added signal to waveform: ${signalPath}`)
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
        {/* Left Panel - Design Browser */}
        <div className="left-panel">
          <DesignBrowser
            onFileSelect={handleFileSelect}
            onSignalSelect={handleSignalSelect}
          />
        </div>

        {/* Right Panel - Source Code & Waveform */}
        <div className="right-panel">
          {/* Source Code Window */}
          <div className="source-code-container">
            <SourceCodeWindow
              filePath={activeFile}
            />
          </div>

          {/* Waveform Window */}
          <div className="waveform-container">
            <WaveformWindow />
          </div>
        </div>
      </div>

      {/* Bottom Panel - Messages */}
      <div className="bottom-panel">
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
