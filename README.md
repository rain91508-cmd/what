# WHAT - Web-based HDL Analysis Toolkit

WHAT 是一款基于 Web 的 HDL（硬件描述语言）代码和波形分析工具，支持 Verilog/SystemVerilog 设计的源代码查看、设计层次浏览和仿真波形分析。

## 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户工作流程                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Verilog/SV 源文件                                             │
│        │                                                        │
│        ↓                                                        │
│   ┌─────────────┐                                               │
│   │ Interpreter │  → 生成 KDB 文件（知识数据库）                  │
│   └─────────────┘                                               │
│        │                                                        │
│        ↓                                                        │
│   ┌─────────────┐     ┌─────────────┐                          │
│   │   Server    │ ←→  │ Web Client  │                          │
│   │   (后端)    │     │  (浏览器)    │                          │
│   └─────────────┘     └─────────────┘                          │
│        │                     │                                  │
│        ↓                     ↓                                  │
│   KDB 文件              用户界面                                 │
│   波形文件 (FST)        - 代码查看器                             │
│                        - 波形查看器                              │
│                        - 设计浏览器                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 系统组成

| 组件 | 目录 | 功能 |
|------|------|------|
| Interpreter | `interpreter/` | 解析 Verilog/SV 源码，生成 KDB 知识数据库 |
| Server | `server/` | 提供 HTTP API，服务 KDB 和波形文件 |
| Web Client | `web-client/` | 浏览器前端界面，代码和波形查看 |

## 快速开始

### 环境要求

- **Node.js** 18+ (用于 Web Client)
- **Rust** (用于 Server)
- **CMake** + **C++ 编译器** (用于 Interpreter)
- **Surelog** (用于 Interpreter，解析 SystemVerilog)

### 启动步骤

1. **启动 Server**
   ```bash
   cd server
   cargo run --release -- --kdb-dir /path/to/kdb --wave-dir /path/to/waves --port 8080
   ```

2. **启动 Web Client**
   ```bash
   cd web-client
   npm install
   npm run dev
   ```

3. **访问界面**
   
   打开浏览器访问 `http://localhost:3000`

## 使用指南

### 4.1 Interpreter（解释器）

Interpreter 用于解析 Verilog/SystemVerilog 源代码，生成 KDB（Knowledge Database）文件。KDB 文件包含：
- 模块定义和实例化层次
- 信号声明和连接关系
- Driver/Load 追踪信息

#### 4.1.1 环境要求

- **Ubuntu 22.04+** 或 **WSL2 (Ubuntu)**
- **CMake** 3.20+
- **GCC/G++** 11+ 或 **Clang** 14+
- **Protocol Buffers** (protobuf)
- **zstd** (可选，用于压缩)

#### 4.1.2 安装依赖

在 Ubuntu/WSL 下安装编译依赖：

```bash
# 更新包列表
sudo apt-get update

# 安装基础编译工具
sudo apt-get install -y build-essential cmake git

# 安装 Protocol Buffers
sudo apt-get install -y protobuf-compiler libprotobuf-dev

# 安装 zstd（可选，用于压缩）
sudo apt-get install -y libzstd-dev

# 安装其他依赖
sudo apt-get install -y python3 python3-pip pkg-config
```

#### 4.1.3 编译

```bash
# 进入项目目录
cd /path/to/webhwd

# 运行编译脚本
./build.sh

# 编译完成后，可执行文件位于：
# - interpreter: build_new/interpreter/hwda_interpreter
# - viewer: build_new/interpreter/kdb_viewer
```

编译选项：
- 编译过程会自动下载和编译 Surelog（SystemVerilog 解析器）
- 首次编译可能需要 10-20 分钟（取决于机器性能）
- 编译结果会缓存，后续编译会更快

#### 4.1.4 基本使用

**解析 Verilog 文件生成 KDB：**

```bash
# 基本用法
./build_new/interpreter/hwda_interpreter design.v --output design.kdb

# 指定顶层模块
./build_new/interpreter/hwda_interpreter design.v --output design.kdb -top top_module

# 添加包含路径
./build_new/interpreter/hwda_interpreter design.v --output design.kdb +incdir+./include

# 使用 verbose 模式查看详细日志
./build_new/interpreter/hwda_interpreter design.v --output design.kdb --verbose
```

**常用选项：**

| 选项 | 说明 |
|------|------|
| `-o, --output <path>` | 指定输出 KDB 文件路径（默认：design.kdb） |
| `-top <module>` | 指定顶层模块 |
| `+incdir+<dir>` | 添加包含路径 |
| `-y <path>` | 添加库目录 |
| `-v <file>` | 添加库文件 |
| `-D<name>=<value>` | 定义宏 |
| `-z, --compress` | 启用压缩（默认启用） |
| `-Z, --no-compress` | 禁用压缩 |
| `-V, --verbose` | 显示详细调试信息 |
| `-h, --help` | 显示帮助信息 |

#### 4.1.5 查看 KDB 文件

使用 kdb_viewer 工具查看生成的 KDB 文件内容：

```bash
# 查看 KDB 文件信息
./build_new/interpreter/kdb_viewer design.kdb

# 列出所有模块
./build_new/interpreter/kdb_viewer design.kdb --modules

# 列出所有信号
./build_new/interpreter/kdb_viewer design.kdb --signals

# 查看特定信号的 driver 信息
./build_new/interpreter/kdb_viewer design.kdb --driver work@top.signal_name

# 以 JSON 格式输出
./build_new/interpreter/kdb_viewer design.kdb --json
```

#### 4.1.6 KDB 文件格式

KDB（Knowledge Database）是自定义的二进制格式，包含：

- **模块信息**：模块定义、实例化层次、参数
- **信号信息**：信号声明、位宽、类型（wire/reg/parameter等）
- **连接关系**：信号的 driver 和 load 信息
- **源代码位置**：文件名、行号，用于跳转到源代码

KDB 文件使用 Protocol Buffers 序列化，可选择使用 zstd 压缩。

#### 4.1.7 完整示例

```bash
# 1. 编译项目
./build.sh

# 2. 解析 Verilog 文件
./build_new/interpreter/hwda_interpreter tests/simple.v --output tests/simple.kdb

# 3. 查看生成的 KDB
./build_new/interpreter/kdb_viewer tests/simple.kdb

# 4. 查看特定信号的 driver
./build_new/interpreter/kdb_viewer tests/simple.kdb --driver work@top.sum
```

详细使用说明请参考 `interpreter/README.md`。

### 4.2 Server（服务器）

Server 提供 HTTP API，用于：
- 服务 KDB 文件
- 服务波形文件（FST 格式）
- 提供信号搜索和查询接口
- 支持两种 FST 读取后端：fstapi（默认）和 fst-reader

#### 4.2.1 环境要求

**Windows:**
- **Rust** 1.70+ (使用 rustup 安装)
- **LLVM/Clang** (用于 fst-reader 后端的 bindgen)
- **vcpkg** (用于管理 C++ 依赖)

**Ubuntu/WSL:**
- **Rust** 1.70+ 
- **LLVM/Clang** 
- **pkg-config**
- **libzstd-dev** (可选，用于压缩)

#### 4.2.2 Windows 编译步骤

1. **安装 Rust**
   ```powershell
   # 使用 rustup 安装
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   # 或从 https://rustup.rs/ 下载安装程序
   ```

2. **安装 LLVM/Clang**
   - 从 https://github.com/llvm/llvm-project/releases 下载 LLVM
   - 解压到 `C:\Users\<username>\Downloads\clang+llvm-<version>-x86_64-pc-windows-msvc`
   - 设置环境变量：`LIBCLANG_PATH=C:\path\to\llvm\bin`

3. **安装 vcpkg**
   ```powershell
   git clone https://github.com/Microsoft/vcpkg.git C:\path\to\vcpkg
   cd C:\path\to\vcpkg
   .\bootstrap-vcpkg.bat
   ```

4. **编译 Server**
   ```powershell
   cd server
   $env:VCPKG_ROOT="C:\path\to\vcpkg"
   $env:LIBCLANG_PATH="C:\path\to\llvm\bin"
   cargo build --release
   ```
   
   编译完成后，可执行文件位于：`target\release\hwda-server.exe`

#### 4.2.3 Ubuntu/WSL 编译步骤

1. **安装依赖**
   ```bash
   sudo apt-get update
   sudo apt-get install -y build-essential pkg-config libzstd-dev
   
   # 安装 Rust
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source $HOME/.cargo/env
   
   # 安装 LLVM/Clang
   sudo apt-get install -y llvm libclang-dev
   ```

2. **编译 Server**
   ```bash
   cd server
   cargo build --release
   ```
   
   编译完成后，可执行文件位于：`target/release/hwda-server`

#### 4.2.4 基本使用

**启动 Server：**

```bash
# 基本用法（使用默认 fstapi 后端）
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --port 8080

# 使用 fst-reader 后端
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --fst-backend fst-reader

# 启用详细调试日志
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --log-level debug --verbose

# 启动时清除缓存
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --clear-cache-on-startup

# 启用 Web 客户端静态文件服务
./hwda-server --kdb-dir /path/to/kdb --wave-dir /path/to/waves --web-dir /path/to/web-client/dist
```

**常用选项：**

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--kdb-dir <path>` | KDB 文件目录 | `./kdb` |
| `--wave-dir <path>` | 波形文件目录 | `./waves` |
| `--port <port>` | 服务端口 | `8080` |
| `--host <host>` | 绑定地址 | `0.0.0.0` |
| `--fst-backend <backend>` | FST 读取后端 (`fstapi` 或 `fst-reader`) | `fstapi` |
| `--log-level <level>` | 日志级别 (`trace`, `debug`, `info`, `warn`, `error`) | `info` |
| `--verbose` | 启用详细调试输出（仅在 `log-level=debug` 时生效） | `false` |
| `--web-dir <path>` | Web 客户端静态文件目录 | - |
| `--clear-cache-on-startup` | 启动时清除所有缓存 | `false` |
| `--enable-cors` | 启用 CORS | `true` |
| `--cache-capacity-mb <size>` | LRU 缓存容量 (MB) | `512` |

**查看帮助：**

```bash
./hwda-server --help
```

#### 4.2.5 FST 后端选择

Server 支持两种 FST 读取后端：

1. **fstapi** (默认)
   - 使用 GTKWave 的 libfst C 库
   - 兼容性好，支持所有 FST 特性
   - 需要 C++ 编译环境

2. **fst-reader** (纯 Rust)
   - 纯 Rust 实现，无需 C++ 依赖
   - 性能更好，内存占用更低
   - 使用 `--fst-backend fst-reader` 启用

**切换后端示例：**
```bash
# 使用 fstapi 后端（默认）
./hwda-server --wave-dir ./waves

# 使用 fst-reader 后端
./hwda-server --wave-dir ./waves --fst-backend fst-reader
```

#### 4.2.6 API 接口

Server 提供以下主要 API：

- `GET /api/kdb` - 列出所有 KDB 文件
- `GET /api/kdb/{name}/signals` - 获取 KDB 中的信号列表
- `GET /api/wave` - 列出所有波形文件
- `GET /api/wave/{name}/signals` - 获取波形文件中的信号列表
- `GET /api/wave/{name}/lod/{lod}/tile/{start}/{span}/{count}/signals/{signal_ids}/data` - 获取波形数据

详细 API 文档请参考 `server/API.md`。

### 4.3 Web Client（Web 客户端）

#### 4.3.1 连接服务器

首次打开应用时，需要连接到 Server：

1. 在弹出的连接对话框中输入服务器地址和端口
2. 默认地址为 `localhost:8080`
3. 点击 "Connect" 按钮
4. 连接成功后，会自动显示可用的 KDB 文件列表

#### 4.3.2 加载 KDB 和波形文件

**加载 KDB 文件：**
1. 点击菜单 **File → Open KDB**
2. 从列表中选择 KDB 文件
3. 加载完成后，左侧设计浏览器会显示模块层次

**加载波形文件：**
1. 点击菜单 **File → Open Waveform**
2. 从列表中选择波形文件（FST 格式）
3. 或者选择 "Use Mock Data" 使用模拟数据进行测试

#### 4.3.3 设计浏览器

设计浏览器位于左侧面板，显示设计的层次结构：

- **模块树**：显示顶层模块和子模块实例
- **信号列表**：选中模块后，显示该模块的所有信号
- **搜索功能**：在搜索框中输入信号名或模块名进行过滤

**操作方式：**
- 单击模块：在信号列表中显示该模块的信号
- 双击模块：打开该模块的源代码
- 双击信号：将信号添加到当前波形窗口
- 右键菜单：更多操作选项

#### 4.3.4 源代码窗口

源代码窗口用于查看 Verilog/SystemVerilog 代码：

**基本功能：**
- 语法高亮显示
- 代码折叠（module、always、begin-end 块）
- 行号显示

**Driver/Load 追踪：**
1. 点击代码中的信号名
2. 在弹出的菜单中选择 "Find Drivers" 或 "Find Loads"
3. 追踪结果会显示在底部的消息窗口
4. 双击追踪结果可跳转到对应的源代码位置

**书签功能：**
- 点击菜单 **View → Add Bookmark** 添加书签
- 书签显示在右侧书签面板
- 双击书签可快速跳转到对应代码位置

**导航历史：**
- 工具栏的 ← → 按钮用于前进/后退导航
- 支持跨文件的导航历史

#### 4.3.5 波形窗口

波形窗口用于查看仿真波形：

**信号管理：**
- 从设计浏览器拖拽信号到波形窗口
- 双击设计浏览器中的信号添加到波形
- 使用信号分组功能组织信号
- 右键信号可删除或移动

**视图操作：**
- **缩放**：鼠标滚轮或工具栏 +/- 按钮
- **平移**：拖拽波形区域
- **全屏显示**：点击工具栏 "Fit" 按钮
- **Cursor 操作**：点击波形设置 Cursor 位置

**值搜索：**
1. 点击工具栏 "Search" 按钮
2. 输入要搜索的值（支持二进制、十六进制等格式）
3. 搜索结果会高亮显示

**时间显示：**
- 工具栏显示当前 Cursor 位置的时间
- 可手动输入时间值跳转到指定位置

**多窗口支持：**
- 点击 "+" 按钮添加新的波形窗口
- 每个窗口可显示不同的信号组合
- 支持多个源代码窗口同时打开

#### 4.3.6 消息窗口

消息窗口位于底部面板：

- **Driver 追踪结果**：显示信号的驱动源
- **系统消息**：显示操作结果和错误信息
- **双击跳转**：双击追踪结果可跳转到对应代码

#### 4.3.7 Session 管理

**保存 Session：**
1. 点击菜单 **File → Save Session**
2. 输入 Session 名称
3. 保存内容包括：
   - 服务器连接信息
   - 当前加载的 KDB 和波形文件
   - 所有打开的源代码窗口
   - 所有打开的波形窗口（包含信号列表）
   - 书签

**恢复 Session：**
1. 点击菜单 **File → Restore Session**
2. 从列表中选择已保存的 Session
3. 系统会自动：
   - 连接服务器
   - 加载 KDB 和波形文件
   - 恢复所有窗口和书签

**管理 Session：**
- 在保存/恢复对话框中可删除不需要的 Session
- 支持搜索已保存的 Session
- Session 数据存储在浏览器 LocalStorage 中

#### 4.3.8 菜单栏

| 菜单 | 功能 |
|------|------|
| **File** | |
| Connect | 连接到服务器 |
| Disconnect | 断开服务器连接 |
| Open KDB | 打开 KDB 文件选择对话框 |
| Open Waveform | 打开波形文件选择对话框 |
| Close KDB | 关闭当前 KDB |
| Close Waveform | 关闭当前波形 |
| Save Session | 保存当前工作状态 |
| Restore Session | 恢复已保存的工作状态 |
| **Edit** | |
| Undo | 撤销 |
| Redo | 重做 |
| **View** | |
| Add Bookmark | 添加书签到当前位置 |
| **Help** | |
| About | 关于信息 |

#### 4.3.9 工具栏

| 按钮 | 功能 |
|------|------|
| 🔍+ | 放大波形 |
| 🔍- | 缩小波形 |
| 🔍↔ | 波形适应窗口 |
| 🔍 | 搜索值 |
| ← | 导航后退 |
| → | 导航前进 |
| + | 添加新标签页 |

## 常见问题

### Q: 连接服务器失败怎么办？

1. 确认 Server 已启动
2. 检查服务器地址和端口是否正确
3. 检查防火墙设置
4. 查看浏览器控制台是否有错误信息

### Q: 波形加载很慢？

1. 波形文件较大时，首次加载需要下载和解压
2. 系统会自动缓存已加载的数据
3. 后续访问会更快

### Q: 如何保存我的工作状态？

使用 **File → Save Session** 功能，可以保存当前所有窗口和设置，下次通过 **Restore Session** 快速恢复。

### Q: 支持哪些浏览器？

- Chrome 90+
- Firefox 90+
- Safari 15+
- Edge 90+

需要支持 WebGL 2.0 和 WebAssembly。

## 更多资源

- **Web Client 开发文档**: `web-client/README.md`
- **Server 文档**: `server/README.md`
- **API 文档**: `server/docs/API.md`

## 许可证

MIT License
