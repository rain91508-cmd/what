# HWDA Web Client

Hardware Design Analyzer Web Client - A high-performance web-based waveform and code viewer.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Web Client                               │
├─────────────────────────────────────────────────────────────────┤
│  UI Layer (React + TypeScript)                                  │
│  ├── MenuBar, ToolBar                                           │
│  ├── DesignBrowser (Hierarchy Tree)                             │
│  ├── SourceCodeWindow (wHDL)                                    │
│  ├── WaveformWindow (wSignal)                                   │
│  └── MessageWindow                                              │
├─────────────────────────────────────────────────────────────────┤
│  Module Layer                                                   │
│  ├── wHDL: Code viewer, syntax highlighting, navigation         │
│  ├── wSignal: Waveform viewer, signal management                │
│  └── KnowledgeManager: Local query engine                       │
├─────────────────────────────────────────────────────────────────┤
│  Core Layer                                                     │
│  ├── Storage                                                    │
│  │   ├── IndexedDB: Knowledge base, metadata                    │
│  │   └── OPFS: Waveform chunks, LOD pyramid                     │
│  ├── Cache                                                      │
│  │   └── LRUCache: Frame-level render cache                     │
│  └── Render                                                     │
│      └── WaveformRenderer: WebGL/regl rendering                 │
├─────────────────────────────────────────────────────────────────┤
│  WASM Layer                                                     │
│  ├── FST block decompression                                    │
│  ├── Time window clipping                                       │
│  ├── LOD (Level of Detail) generation                           │
│  └── Value formatting                                           │
├─────────────────────────────────────────────────────────────────┤
│  Services                                                       │
│  └── API: HTTP/1.1 Range requests, server communication         │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
Server (FST/WDB files)
    ↓ HTTP Range Request
OPFS (Warm Storage)
    ↓ WASM decode
WASM (Data Processing)
    ↓ TypedArray
Memory Cache (Hot Layer)
    ↓ WebGL buffer
GPU Rendering
```

## Three-Layer Storage Architecture

1. **Hot Layer (Memory)** - Frame-level render cache
   - GPU-ready data (Float32Array)
   - LRU eviction
   - ~100MB limit

2. **Warm Layer (OPFS)** - Waveform chunks
   - Decompressed blocks
   - LOD pyramid (12 levels)
   - Persistent across sessions

3. **Cold Layer (Server)** - Original files
   - FST/WDB format
   - Range request support
   - Downloaded on demand

## Project Structure

```
web-client/
├── src/
│   ├── components/          # React UI components
│   │   ├── MenuBar.tsx
│   │   ├── ToolBar.tsx
│   │   ├── DesignBrowser.tsx
│   │   ├── SourceCodeWindow.tsx
│   │   ├── WaveformWindow.tsx
│   │   ├── MessageWindow.tsx
│   │   └── ConnectionDialog.tsx
│   ├── modules/             # Core modules
│   │   ├── wHDL/           # Code viewer
│   │   ├── wSignal/        # Waveform viewer
│   │   └── knowledge/      # Knowledge manager
│   ├── core/               # Core infrastructure
│   │   ├── storage/        # IndexedDB & OPFS
│   │   ├── cache/          # LRU cache
│   │   └── render/         # WebGL renderer
│   ├── wasm/               # WASM integration
│   ├── services/           # API services
│   ├── types/              # TypeScript types
│   ├── App.tsx             # Main application
│   ├── main.tsx            # Entry point
│   └── index.css           # Global styles
├── package.json
├── tsconfig.json
├── vite.config.ts
└── index.html
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
cd web-client
npm install
```

### Development

```bash
npm run dev
```

The development server will start at `http://localhost:3000`.

### Build

```bash
npm run build
```

### Type Check

```bash
npm run typecheck
```

### Lint

```bash
npm run lint
```

## Key Features

### wHDL (Code Viewer)
- Syntax highlighting for Verilog/SystemVerilog
- Code folding (module, always, begin-end blocks)
- Code navigation (go to definition, find scope)
- Driver/Load tracing with visual indicators
- Active Annotation (signal value overlay)
- Bookmark management

### wSignal (Waveform Viewer)
- Signal management (add/remove/reorder)
- Signal groups and bus operations
- WebGL-based rendering with regl
- Cursor and marker functionality
- Zoom and pan operations
- Value searching
- Window splitting

### Knowledge Manager
- Local query engine for design data
- Signal queries with filters
- Module and instance queries
- Design hierarchy navigation
- Driver/Load tracing queries
- Value formatting (binary, octal, decimal, hex, ASCII)

## Technical Highlights

### Performance Optimizations
- **LoD (Level of Detail)**: 12 levels of downsampling for smooth zoom
- **Three-layer storage**: Hot (memory), Warm (OPFS), Cold (server)
- **WebGL rendering**: GPU-accelerated waveform drawing
- **WASM processing**: Fast FST decoding and data processing
- **LRU cache**: Efficient memory management

### Data Formats
- **Chunk format**: SoA (Structure of Arrays) for GPU efficiency
- **LOD generation**: Min/max bucket algorithm (preserves edges)
- **Value encoding**: Binary format for compact storage

## Browser Compatibility

- Chrome 90+
- Firefox 90+
- Safari 15+
- Edge 90+

Requires support for:
- WebGL 2.0
- OPFS (Origin Private File System)
- WebAssembly
- IndexedDB

## License

MIT
