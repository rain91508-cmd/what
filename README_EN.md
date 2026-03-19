# WHAT - Web-based HDL Analysis Toolkit

[中文](README.md) | [English](README_EN.md) | [日本語](README_JA.md) | [Français](README_FR.md) | [Deutsch](README_DE.md) | [Русский](README_RU.md)

WHAT is a web-based HDL (Hardware Description Language) code and waveform analysis tool.

## Project Motivation

The original motivation for this project was to test the capabilities of AI-assisted programming. As a hardware engineer, I often need to view both source code and simulation waveforms simultaneously for debugging and analysis. However, there is a lack of open-source tools on the market that can tightly integrate source code and waveforms. Commercial tools are expensive and inflexible, while existing open-source solutions are often fragmented and cannot form a complete workflow.

Therefore, I conceived the idea of using AI to develop an analysis tool that fits my usage habits. Surprisingly, the main code of this project was entirely written by AI—from architectural design to specific implementation, from interface layout to functional logic. The main feature development took about 2 weeks, and subsequent bug fixes and functional architecture optimization took another 2 weeks. Such development efficiency is unimaginable in traditional programming models, fully demonstrating the leap in AI programming efficiency.

Special thanks to:
- **Trae IDE** for providing an excellent development environment and free AI computing power support
- **Doubao-seed-2.0**, **Kimi K2.5**, **GLM-5** and other large models for providing powerful code generation capabilities

## Features

### Source Code Analysis
- **Verilog/SystemVerilog Support**: Complete syntax highlighting and code folding
- **Design Hierarchy Browsing**: Visual display of module instantiation hierarchy
- **Smart Code Navigation**: Support for definition jumping, driver tracing, and load tracing
- **Bookmark Function**: Quickly mark and jump to key code locations
- **Navigation History**: Support for forward/backward browsing of code locations

### Waveform Analysis
- **FST Waveform File Support**: High-performance reading of large waveform files
- **Multi-signal Display**: Support for signal grouping management and custom column widths
- **Flexible Zoom and Pan**: Mouse wheel zoom, drag pan, full-screen fit
- **Cursor Operation**: Click to set cursor position, precisely view signal values
- **Value Search Function**: Support for binary, hexadecimal, octal and other format pattern searches
- **Search History**: Save search history for quick repeated searches

### Integration Features
- **Source-Waveform Linkage**: Double-click a signal in the code to view its driver source
- **Design Browser**: Quickly add signals to the waveform window from the module hierarchy tree
- **Session Management**: Save and restore complete working states
- **Multi-tab Support**: Open multiple source code and waveform windows simultaneously

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     User Workflow                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Verilog/SV Source Files                                       │
│        │                                                        │
│        ↓                                                        │
│   ┌─────────────┐                                               │
│   │ Interpreter │  → Generate KDB file (Knowledge Database)     │
│   └─────────────┘                                               │
│        │                                                        │
│        ↓                                                        │
│   ┌─────────────┐     ┌─────────────┐                          │
│   │   Server    │ ←→  │ Web Client  │                          │
│   │  (Backend)  │     │  (Browser)  │                          │
│   └─────────────┘     └─────────────┘                          │
│        │                     │                                  │
│        ↓                     ↓                                  │
│   KDB Files             User Interface                          │
│   Waveform Files (FST)  - Code Viewer                           │
│                         - Waveform Viewer                       │
│                         - Design Browser                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## System Components

| Component | Directory | Function |
|-----------|-----------|----------|
| Interpreter | `interpreter/` | Parse Verilog/SV source code, generate KDB knowledge database |
| Server | `server/` | Provide HTTP API, serve KDB and waveform files |
| Web Client | `web-client/` | Browser frontend interface, code and waveform viewing |

## Quick Start

### Requirements

- **Node.js** 18+ (for Web Client)
- **Rust** (for Server)
- **CMake** + **C++ Compiler** (for Interpreter)
- **Surelog** (for Interpreter, parsing SystemVerilog)

### Startup Steps

1. **Start Server**
   ```bash
   cd server
   cargo run --release -- --kdb-dir /path/to/kdb --wave-dir /path/to/waves --port 8080
   ```

2. **Start Web Client**
   ```bash
   cd web-client
   npm install
   npm run dev
   ```

3. **Access Interface**
   
   Open browser and visit `http://localhost:3000`

## User Guide

### 4.1 Interpreter

Interpreter is used to parse Verilog/SystemVerilog source code and generate KDB (Knowledge Database) files. KDB files contain:
- Module definitions and instantiation hierarchy
- Signal declarations and connection relationships
- Driver/Load tracing information

#### 4.1.1 Requirements

- **Ubuntu 22.04+** or **WSL2 (Ubuntu)**
- **CMake** 3.20+
- **GCC/G++** 11+ or **Clang** 14+
- **Protocol Buffers** (protobuf)
- **zstd** (optional, for compression)

#### 4.1.2 Install Dependencies

Install compilation dependencies on Ubuntu/WSL:

```bash
# Update package list
sudo apt-get update

# Install basic compilation tools
sudo apt-get install -y build-essential cmake git

# Install Protocol Buffers
sudo apt-get install -y protobuf-compiler libprotobuf-dev

# Install zstd (optional, for compression)
sudo apt-get install -y libzstd-dev

# Install other dependencies
sudo apt-get install -y python3 python3-pip pkg-config
```

#### 4.1.3 Compilation

**Step 1: Clone Repository**
```bash
cd /path/to/your/workspace
git clone <repository-url>
cd webhwd
```

**Step 2: Install Dependencies**
```bash
# Update package list
sudo apt-get update

# Install basic compilation tools
sudo apt-get install -y build-essential cmake git

# Install Protocol Buffers
sudo apt-get install -y protobuf-compiler libprotobuf-dev

# Install zstd (optional, for compression)
sudo apt-get install -y libzstd-dev
```

**Step 3: Compile Project**
```bash
# Run compilation script
./build.sh
```

Compilation notes:
- The compilation script will automatically download and compile Surelog (SystemVerilog parser)
- First compilation may take 10-20 minutes (depending on machine performance)
- Compilation results are cached, subsequent compilations will be faster
- After compilation, executables are located at:
  - `build_new/interpreter/hwda_interpreter`
  - `build_new/interpreter/kdb_viewer`

**Step 4: Verify Installation**
```bash
# Check if interpreter is available
./build_new/interpreter/hwda_interpreter --help

# Check if kdb_viewer is available
./build_new/interpreter/kdb_viewer --help
```

#### 4.1.4 Basic Usage

**Parse Verilog file to generate KDB:**

```bash
# Basic usage
./build_new/interpreter/hwda_interpreter design.v --output design.kdb

# Specify top module
./build_new/interpreter/hwda_interpreter design.v --output design.kdb -top top_module

# Add include path
./build_new/interpreter/hwda_interpreter design.v --output design.kdb +incdir+./include

# Use verbose mode to view detailed logs
./build_new/interpreter/hwda_interpreter design.v --output design.kdb --verbose
```

**Common Options:**

| Option | Description |
|--------|-------------|
| `-o, --output <path>` | Specify output KDB file path (default: design.kdb) |
| `-top <module>` | Specify top module |
| `+incdir+<dir>` | Add include path |
| `-y <path>` | Add library directory |
| `-v <file>` | Add library file |
| `-D<name>=<value>` | Define macro |
| `-z, --compress` | Enable compression (enabled by default) |
| `-Z, --no-compress` | Disable compression |
| `-V, --verbose` | Show detailed debug information |
| `-h, --help` | Show help information |

#### 4.1.5 View KDB Files

Use kdb_viewer tool to view generated KDB file contents:

```bash
# View KDB file information
./build_new/interpreter/kdb_viewer design.kdb

# List all modules
./build_new/interpreter/kdb_viewer design.kdb --modules

# List all signals
./build_new/interpreter/kdb_viewer design.kdb --signals

# View specific signal driver information
./build_new/interpreter/kdb_viewer design.kdb --driver work@top.signal_name

# Output in JSON format
./build_new/interpreter/kdb_viewer design.kdb --json
```

#### 4.1.6 KDB File Format

KDB (Knowledge Database) is a custom binary format containing:

- **Module Information**: Module definitions, instantiation hierarchy, parameters
- **Signal Information**: Signal declarations, bit widths, types (wire/reg/parameter, etc.)
- **Connection Relationships**: Signal driver and load information
- **Source Code Locations**: File names, line numbers for jumping to source code

KDB files use Protocol Buffers serialization and optionally use zstd compression.

#### 4.1.7 Usage Example

```bash
# Parse Verilog file to generate KDB
./build_new/interpreter/hwda_interpreter tests/simple.v --output tests/simple.kdb

# View generated KDB file information
./build_new/interpreter/kdb_viewer tests/simple.kdb

# View specific signal driver information
./build_new/interpreter/kdb_viewer tests/simple.kdb --driver work@top.sum
```

For detailed usage instructions, please refer to `interpreter/README.md`.

### 4.2 Server

Server provides HTTP API for:
- Serving KDB files
- Serving waveform files (FST format)
- Providing signal search and query interfaces
- Supporting two FST reading backends: fstapi (default) and fst-reader

#### 4.2.1 Requirements

**Windows:**
- **Rust** 1.70+ (installed via rustup)
- **LLVM/Clang** (for fst-reader backend bindgen)
- **vcpkg** (for managing C++ dependencies)

**Ubuntu/WSL:**
- **Rust** 1.70+ 
- **LLVM/Clang** 
- **pkg-config**
- **libzstd-dev** (optional, for compression)

#### 4.2.2 Windows Compilation Steps

1. **Install Rust**
   ```powershell
   # Install via rustup
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   # Or download installer from https://rustup.rs/
   ```

2. **Install LLVM/Clang**
   - Download LLVM from https://github.com/llvm/llvm-project/releases
   - Extract to `C:\Users\<username>\Downloads\clang+llvm-<version>-x86_64-pc-windows-msvc`
   - Set environment variable: `LIBCLANG_PATH=C:\path\to\llvm\bin`

3. **Install vcpkg**
   ```powershell
   git clone https://github.com/Microsoft/vcpkg.git C:\path\to\vcpkg
   cd C:\path\to\vcpkg
   .\bootstrap-vcpkg.bat
   ```

4. **Compile Server**
   ```powershell
   cd server
   $env:VCPKG_ROOT="C:\path\to\vcpkg"
   $env:LIBCLANG_PATH="C:\path\to\llvm\bin"
   cargo build --release
   ```
   
   After compilation, the executable is located at: `target\release\hwda-server.exe`

#### 4.2.3 Ubuntu/WSL Compilation Steps

1. **Install Dependencies**
   ```bash
   sudo apt-get update
   sudo apt-get install -y build-essential pkg-config libzstd-dev
   
   # Install Rust
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source $HOME/.cargo/env
   
   # Install LLVM/Clang
   sudo apt-get install -y llvm libclang-dev
   ```

2. **Compile Server**
   ```bash
   cd server
   cargo build --release
   ```
   
   After compilation, the executable is located at: `target/release/hwda-server`

#### 4.2.4 Basic Usage

**Start Server:**

```bash
# Basic usage (using default fstapi backend)
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --port 8080

# Use fst-reader backend
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --fst-backend fst-reader

# Enable detailed debug logs
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --log-level debug --verbose

# Clear cache on startup
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --clear-cache-on-startup

# Enable Web client static file service
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --web-dir /path/to/web-client/dist
```

**Common Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--kdb-dir <path>` | KDB file directory | `./kdb` |
| `--wave-dir <path>` | Waveform file directory | `./waves` |
| `--port <port>` | Service port | `8080` |
| `--host <host>` | Bind address | `0.0.0.0` |
| `--fst-backend <backend>` | FST reading backend (`fstapi` or `fst-reader`) | `fstapi` |
| `--log-level <level>` | Log level (`trace`, `debug`, `info`, `warn`, `error`) | `info` |
| `--verbose` | Enable detailed debug output (only effective when `log-level=debug`) | `false` |
| `--web-dir <path>` | Web client static file directory | - |
| `--clear-cache-on-startup` | Clear all caches on startup | `false` |
| `--enable-cors` | Enable CORS | `true` |
| `--cache-capacity-mb <size>` | LRU cache capacity (MB) | `512` |

**View Help:**

```bash
./hwda-server --help
```

#### 4.2.5 FST Backend Selection

Server supports two FST reading backends:

1. **fstapi** (default)
   - Uses GTKWave's libfst C library
   - Good compatibility, supports all FST features
   - Requires C++ compilation environment

2. **fst-reader** (pure Rust)
   - Pure Rust implementation, no C++ dependencies
   - Better performance, lower memory usage
   - Enable with `--fst-backend fst-reader`

**Switch Backend Example:**
```bash
# Use fstapi backend (default)
./hwda-server --wave-dir ./waves

# Use fst-reader backend
./hwda-server --wave-dir ./waves --fst-backend fst-reader
```

#### 4.2.6 API Interfaces

Server provides the following main APIs:

- `GET /api/kdb` - List all KDB files
- `GET /api/kdb/{name}/signals` - Get signal list in KDB
- `GET /api/wave` - List all waveform files
- `GET /api/wave/{name}/signals` - Get signal list in waveform file
- `GET /api/wave/{name}/lod/{lod}/tile/{start}/{span}/{count}/signals/{signal_ids}/data` - Get waveform data

For detailed API documentation, please refer to `server/API.md`.

### 4.3 Web Client

#### 4.3.1 Connect to Server

When opening the application for the first time, you need to connect to the Server:

1. Enter the server address and port in the connection dialog
2. Default address is `localhost:8080`
3. Click "Connect" button
4. After successful connection, available KDB file list will be displayed automatically

#### 4.3.2 Load KDB and Waveform Files

**Load KDB File:**
1. Click menu **File → Open KDB**
2. Select KDB file from the list
3. After loading, the module hierarchy will be displayed in the left design browser

**Load Waveform File:**
1. Click menu **File → Open Waveform**
2. Select waveform file (FST format) from the list
3. Or select "Use Mock Data" to use simulated data for testing

#### 4.3.3 Design Browser

The design browser is located in the left panel, displaying the design hierarchy:

- **Module Tree**: Display top-level modules and submodule instances
- **Signal List**: After selecting a module, display all signals of that module
- **Search Function**: Enter signal name or module name in the search box to filter

**Operation Methods:**
- Click module: Display signals of that module in the signal list
- Double-click module: Open the source code of that module
- Double-click signal: Add signal to current waveform window
- Right-click menu: More operation options

#### 4.3.4 Source Code Window

The source code window is used to view Verilog/SystemVerilog code:

**Basic Functions:**
- Syntax highlighting
- Code folding (module, always, begin-end blocks)
- Line number display

**Driver/Load Tracing:**
1. Click signal name in the code
2. Select "Find Drivers" or "Find Loads" in the popup menu
3. Tracing results will be displayed in the message window at the bottom
4. Double-click tracing results to jump to corresponding source code location

**Bookmark Function:**
- Click menu **Navigate → Add Bookmark** to add bookmark
- Bookmarks are displayed in the bookmark panel on the right
- Double-click bookmark to quickly jump to corresponding code location

**Navigation History:**
- Toolbar ← → buttons for forward/backward navigation
- Support cross-file navigation history

**Signal Value Expansion Display:**
- Click the expand icon (▶) on the left side of the code line to expand and display all signal values on that line at the current cursor time
- After expansion, signal name, current value, bit width, and other information are displayed
- Supports multi-radix display (binary, hexadecimal, etc.), automatically inherits display format settings from the waveform window
- Click the expand icon again to collapse the display
- Expansion state is automatically saved and restored when switching tabs

#### 4.3.5 Waveform Window

The waveform window is used to view simulation waveforms:

**Signal Management:**
- Drag signals from design browser to waveform window
- Double-click signals in design browser to add to waveform
- Use signal grouping function to organize signals
- Right-click signals to delete or move

**View Operations:**
- **Zoom**: Mouse wheel or toolbar +/- buttons
- **Pan**: Drag waveform area
- **Full Screen**: Click toolbar "Fit" button
- **Cursor Operation**: Click waveform to set cursor position

**Value Search:**
1. Click toolbar "Search" button
2. Enter value to search (supports binary, hexadecimal, etc.)
3. Search results will be highlighted

**Time Display:**
- Toolbar displays current cursor position time
- Can manually enter time value to jump to specified position

**Multi-window Support:**
- Click "+" button to add new waveform window
- Each window can display different signal combinations
- Support multiple source code windows open simultaneously

#### 4.3.6 Table View

The table view displays signal values in a tabular format for a specific time range, suitable for viewing and analyzing signal states:

**Creating Table View:**
- Click the "+" button in the toolbar and select "Table" to create a new table view
- When creating a table view while a waveform window is active, it automatically inherits:
  - Current waveform window's time range (View Start / View End)
  - All signals from expanded groups
  - Display format (Radix) for each signal
  - Signal prefix settings

**Signal Management:**
- Drag signals from design browser to table view
- Double-click signals in design browser to add to table
- Click the "×" button in column header to delete signal
- Drag column headers to reorder signals

**Time Range Settings:**
- Set time range in the "Start" and "Span" input boxes in the toolbar
- Click "Apply" button to apply new time range and fetch data
- Supports pagination, use "Previous" and "Next" buttons to navigate
- Click "Continue" button to fetch more data (if available)

**Display Format Settings:**
- Click the dropdown arrow in column header to open format selection menu
- Supports Binary (BIN), Octal (OCT), Decimal (DEC), Hexadecimal (HEX) display
- Each signal column can be set independently

**Metadata Filtering:**
- Filter by signal value characteristics: X state, Z state, mixed state, transition, toggle
- Multiple filter conditions are combined with "OR" logic

**Column Filtering:**
- Enter filter conditions in the input box of column header
- Supports hexadecimal value filtering (e.g., `0x1a`)

#### 4.3.7 Message Window

The message window is located at the bottom panel:

- **Driver Tracing Results**: Display signal driver sources
- **System Messages**: Display operation results and error information
- **Double-click Jump**: Double-click tracing results to jump to corresponding code

#### 4.3.8 Session Management

**Save Session:**
1. Click menu **File → Save Session**
2. Enter Session name
3. Saved content includes:
   - Server connection information
   - Currently loaded KDB and waveform files
   - All open source code windows
   - All open waveform windows (including signal lists)
   - All open table views (including signal lists and time ranges)
   - Bookmarks

**Restore Session:**
1. Click menu **File → Restore Session**
2. Select saved Session from the list
3. System will automatically:
   - Connect to server
   - Load KDB and waveform files
   - Restore all windows and bookmarks

**Manage Session:**
- Can delete unwanted Sessions in save/restore dialog
- Support searching saved Sessions
- Session data is stored in browser LocalStorage

#### 4.3.8 Menu Bar

| Menu | Function |
|------|----------|
| **File** | |
| Connect | Connect to server |
| Disconnect | Disconnect from server |
| Open KDB | Open KDB file selection dialog |
| Open Waveform | Open waveform file selection dialog |
| Close KDB | Close current KDB |
| Close Waveform | Close current waveform |
| Save Session | Save current working state |
| Restore Session | Restore saved working state |
| **View** | |
| Zoom In | Zoom in waveform timeline |
| Zoom Out | Zoom out waveform timeline |
| Zoom Full | Fit waveform to window width |
| **Navigate** | |
| History Back | Navigate to previous code location |
| History Forward | Navigate to next code location |
| Add Bookmark | Add bookmark to current location |
| Find Driver | Find driver source of selected signal (need to select signal in code) |
| Find Definition | Find definition of selected instance (need to select instance in code) |
| **Waveform** | |
| Add Signal | Add signal to waveform window (need to double-click signal in Signal Panel) |
| Remove Signal | Remove signal from waveform window |
| OPFS Cache | Toggle OPFS cache switch |
| Memory Cache | Toggle memory cache switch |
| **Help** | |
| KDB Debug Tool | Open KDB debug tool |
| About | Open project GitHub page |

#### 4.3.9 Toolbar

| Button | Function |
|--------|----------|
| 🔍+ | Zoom in waveform |
| 🔍- | Zoom out waveform |
| 🔍↔ | Fit waveform to window |
| 🔍 | Search value |
| ← | Navigate back |
| → | Navigate forward |
| + | Add new tab |
| 📍 | Add bookmark |

## FAQ

### Q: Connection to server failed?

1. Confirm Server is started
2. Check if server address and port are correct
3. Check firewall settings
4. View browser console for error messages

### Q: Waveform loading is slow?

1. When waveform file is large, first load requires download and decompression
2. System will automatically cache loaded data
3. Subsequent access will be faster

### Q: How to save my working state?

Use **File → Save Session** function to save all current windows and settings, then quickly restore via **Restore Session** next time.

### Q: Which browsers are supported?

- Chrome 90+
- Firefox 90+
- Safari 15+
- Edge 90+

Requires WebGL 2.0 and WebAssembly support.

## Known Issues

### Code Quality Issues
- **Code Structure Chaos**: Since mainly generated by AI, code has repetition and organization issues. Some function implementations are overly complex with high coupling between modules. This is an important issue that current AI programming models and toolchains need to continue solving.

### Performance Issues
- **Interpreter Memory Consumption**: For large designs, Interpreter parsing takes a long time and consumes too much memory, may cause OOM (Out of Memory) errors. Recommend processing large designs in batches or increasing system memory.
- **Web Client Rendering Smoothness**: WebGL2 rendering has not been implemented yet, only using Canvas2D for waveform rendering.

### Function Completeness
- **Insufficient Test Coverage**: Many functions lack sufficient testing, may have improper boundary case handling. Welcome community contributions of test cases and bug reports.

## More Resources

- **Web Client Development Docs**: `web-client/README.md`
- **Server Docs**: `server/README.md`
- **API Docs**: `server/docs/API.md`

## License

MIT License
