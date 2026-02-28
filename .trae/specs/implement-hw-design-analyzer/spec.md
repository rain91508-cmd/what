# 硬件设计分析工具功能规格说明书

## 1. 概述

### 1.1 项目背景

开发一个轻量级硬件设计分析工具，采用服务器-Web客户端架构，重点实现wHDL（代码追踪分析）和wSignal（波形查看）两大核心模块。

### 1.2 目标用户

* 数字电路设计工程师

* 验证工程师

* FPGA开发人员

### 1.3 核心价值

* 提供轻量级的硬件设计调试解决方案

* 支持远程访问和协作

* 降低硬件设计验证门槛

### 1.4 开发环境要求

**Requirement: ENV-001 服务器端环境**
服务器端和设计解释器仅支持Linux环境运行。

| 组件    | 支持环境                              |
| ----- | --------------------------------- |
| 数据服务器 | Linux (Ubuntu 22.04+)、WSL         |
| 设计解释器 | Linux (Ubuntu 22.04+)、WSL         |
| 开发环境  | WSL (Windows Subsystem for Linux) |

**Requirement: ENV-002 客户端环境**
Web客户端支持跨平台运行。

| 组件     | 支持环境                                                    |
| ------ | ------------------------------------------------------- |
| Web客户端 | Chrome 90+, Firefox 88+, Edge 90+ (Windows/Linux/macOS) |

***

## 2. 系统架构

### 2.1 整体架构

**架构设计原则：**

* **客户端重计算**：知识库查询、波形渲染在客户端完成

* **服务端轻量**：仅提供源文件存储和波形数据服务

* **数据分层**：热数据（内存LRU缓存）、温数据（OPFS/IndexedDB本地存储）、冷数据（服务端）

* **LoD传输**：波形数据按需分块传输，支持细节层次（Level of Detail）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Web Browser Client                                 │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        Application Layer                              │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │  │
│  │  │    wHDL      │  │   wSignal    │  │    Knowledge Manager     │  │  │
│  │  │   Module     │  │    Module    │  │  ┌────────────────────┐  │  │  │
│  │  │              │  │              │  │  │ Signal Manager     │  │  │  │
│  │  │ - Code View  │  │ - Wave Render│  │  │ - Signal Groups    │  │  │  │
│  │  │ - Trace D/L  │  │ - Cursor/Zoom│  │  │ - Bus Operations   │  │  │  │
│  │  │ - Bookmarks  │  │ - Search     │  │  │ - Value Formatting │  │  │  │
│  │  └──────────────┘  └──────────────┘  │  └────────────────────┘  │  │  │
│  │                                      └──────────────────────────┘  │  │
│  ├──────────────────────────────────────────────────────────────────────┤  │
│  │                      Client Data Layer (Hot + Warm)                   │  │
│  │                                                                      │  │
│  │  ┌─────────────────────────┐    ┌─────────────────────────────────┐  │  │
│  │  │   Memory Cache (Hot)    │    │   OPFS Local Storage (Warm)     │  │  │
│  │  │  ┌───────────────────┐  │    │  ┌───────────────────────────┐  │  │  │
│  │  │  │ LRU Wave Cache    │  │    │  │ Waveform Cache Files      │  │  │  │
│  │  │  │ - Time ranges     │  │    │  │ - FST chunks              │  │  │  │
│  │  │  │ - Signal values   │  │    │  │ - Decompressed blocks     │  │  │  │
│  │  │  │ - Pre-fetch buffer│  │    │  │ - LOD pyramid data        │  │  │  │
│  │  │  └───────────────────┘  │    │  └───────────────────────────┘  │  │  │
│  │  │  ┌───────────────────┐  │    │                                 │  │  │
│  │  │  │ Query Engine      │  │    │  IndexedDB (Warm)               │  │  │
│  │  │  │ - Driver/Load     │  │    │  ┌───────────────────────────┐  │  │  │
│  │  │  │ - Hierarchy nav   │  │    │  │ Knowledge Base (.kdb)     │  │  │  │
│  │  │  │ - Code search     │  │    │  │ - Design metadata         │  │  │  │
│  │  │  └───────────────────┘  │    │  │ - Signal index            │  │  │  │
│  │  └─────────────────────────┘    │  │ - Source file cache       │  │  │  │
│  │                                 │  └───────────────────────────┘  │  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                         │
│                           HTTP/1.1 with Range Requests                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Data Server (Linux/WSL)                              │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        Service Layer (Rust + Axum)                    │  │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │  │
│  │  │  Source File     │  │  Waveform Data   │  │   API Service    │  │  │
│  │  │  Service         │  │  Service         │  │                  │  │  │
│  │  │                  │  │  (wavefst)       │  │  - HTTP Range    │  │  │
│  │  │  - File storage  │  │                  │  │  - Auth/Rate     │  │  │
│  │  │  - Version ctrl  │  │  - FST only      │  │  - CORS          │  │  │
│  │  │  - Access log    │  │  - LOD chunks    │  │                  │  │  │
│  │  └──────────────────┘  └──────────────────┘  └──────────────────┘  │  │
│  ├──────────────────────────────────────────────────────────────────────┤  │
│  │                        Data Layer                                     │  │
│  │  ┌──────────────────┐  ┌──────────────────┐                         │  │
│  │  │  Source Files    │  │  Waveform Files  │                         │  │
│  │  │  (.v/.sv)        │  │  (.fst only)     │                         │  │
│  │  └──────────────────┘  └──────────────────┘                         │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Design Interpreter (Build Time)                         │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  Surelog Parser → UHDM → KnowledgeBase Builder → .kdb Generator      │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 组件说明

| 层级                     | 组件                    | 技术栈                             | 职责                         |
| ---------------------- | --------------------- | ------------------------------- | -------------------------- |
| **Client App**         | wHDL Module           | TypeScript + React              | 代码查看、Driver/Load追踪、书签管理    |
| **Client App**         | wSignal Module        | TypeScript + React + WebGL/regl | 波形渲染、游标/标记、信号管理            |
| **Client App**         | Knowledge Manager     | TypeScript                      | 知识库加载、本地查询引擎、信号管理          |
| **Client Data (Hot)**  | LRU Wave Cache        | JavaScript (In-Memory)          | 波形数据内存缓存、预取策略              |
| **Client Data (Hot)**  | Query Engine          | JavaScript                      | Driver/Load追踪、层次遍历、代码搜索    |
| **Client Data (Warm)** | OPFS Storage          | Origin Private File System API  | 波形缓存文件持久化                  |
| **Client Data (Warm)** | IndexedDB             | IndexedDB API                   | 知识库、设计元数据、信号索引             |
| **Server**             | Source File Service   | Rust (Axum)                     | 源文件存储、版本控制、访问日志            |
| **Server**             | Waveform Data Service | Rust (wavefst)                  | FST格式支持、LoD分块、HTTP Range查询 |
| **Server**             | API Service           | Rust (Axum)                     | HTTP Range支持、认证、限流、CORS    |
| **Build**              | Design Interpreter    | C++ (Surelog)                   | Verilog/SV解析、知识库生成         |

### 2.3 客户端数据存储策略

**数据存储分配：**

| 数据类型                | 存储位置         | 原因               |
| ------------------- | ------------ | ---------------- |
| 波形缓存文件 (FST chunks) | OPFS         | 大文件、需要流式访问、二进制数据 |
| 知识库 (.kdb)          | IndexedDB    | 结构化数据、需要索引查询、元数据 |
| 设计元数据               | IndexedDB    | 信号索引、模块信息、层次关系   |
| 源文件缓存               | IndexedDB    | 文本数据、代码搜索、快速访问   |
| 当前视图波形              | Memory (LRU) | 热数据、快速渲染、临时缓存    |

**OPFS vs IndexedDB 选择依据：**

* **OPFS**: 适合大文件、流式读写、二进制数据（波形文件）

* **IndexedDB**: 适合结构化数据、索引查询、事务支持（知识库元数据）

### 2.4 数据分层架构

**三层数据架构：**

| 层级             | 数据类型                       | 存储位置           | 访问延迟  | 容量        |
| -------------- | -------------------------- | -------------- | ----- | --------- |
| **Hot (热数据)**  | 当前视图波形、查询结果                | 内存 (LRU Cache) | <1ms  | 100-500MB |
| **Warm (温数据)** | 波形缓存块(OPFS)、知识库(IndexedDB) | 本地磁盘           | <10ms | 10-50GB   |
| **Cold (冷数据)** | 源文件、完整FST文件                | 服务端存储          | >10ms | 无限制       |

**数据流设计原则：**

| 原则          | 描述                      | 实现方式                      |
| ----------- | ----------------------- | ------------------------- |
| **知识库本地化**  | 客户端获取完整知识库后，所有查询操作在本地完成 | IndexedDB持久化存储，启动时加载到内存索引 |
| **波形按需获取**  | 波形数据不预加载，按需从服务器获取LoD分块  | HTTP Range请求，OPFS本地缓存     |
| **LoD细节层次** | 根据缩放级别传输不同精度的波形数据       | 服务端预计算多分辨率数据，客户端动态请求      |
| **二进制传输**   | 波形数据使用二进制格式传输           | FST原生格式，HTTP Range分块      |
| **预取策略**    | 预测用户行为，提前加载可能访问的数据      | 基于时间局部性的预取算法              |

***

## 3. wHDL模块规格

### 3.1 功能概述

wHDL是一个源代码查看和分析器，基于知识库(KDB)显示设计层次结构和源代码，支持信号连接性信息（驱动和负载）的快速识别。

### 3.2 核心功能需求

#### 3.2.1 代码浏览功能

**Requirement: TR-001 语法高亮显示**
系统应为Verilog和SystemVerilog代码提供语法高亮显示功能。

| 属性    | 规格                                                                  |
| ----- | ------------------------------------------------------------------- |
| 关键字高亮 | module, endmodule, always, assign, wire, reg, input, output, inout等 |
| 注释高亮  | 单行注释(//)和多行注释(/\* \*/)                                              |
| 字符串高亮 | 双引号内的字符串                                                            |
| 数字高亮  | 二进制、八进制、十进制、十六进制数字                                                  |
| 操作符高亮 | 逻辑运算符、位运算符、算术运算符                                                    |

**Scenario: 用户打开Verilog文件**

* **WHEN** 用户在设计浏览器中双击模块实例

* **THEN** 系统在源代码窗口显示对应源代码

* **AND** 所有语法元素以不同颜色高亮显示

**Requirement: TR-002 代码折叠功能**
系统应支持代码块的折叠和展开。

| 折叠类型         | 触发方式            |
| ------------ | --------------- |
| 模块折叠         | 点击module行前的折叠标记 |
| always块折叠    | 点击always行前的折叠标记 |
| begin-end块折叠 | 点击begin行前的折叠标记  |
| 注释块折叠        | 点击注释块前的折叠标记     |

**Requirement: TR-003 代码导航功能**
系统应提供多种代码导航方式。

| 导航功能    | 操作方式                              | 快捷键 |
| ------- | --------------------------------- | --- |
| 跳转到定义   | 双击模块名                             | -   |
| 跳转到调用   | 右键菜单                              | -   |
| 查找作用域   | 菜单 Source -> Find Scope           | S   |
| 查找字符串   | 菜单 Source -> Find String          | /   |
| 查找信号/实例 | 菜单 Source -> Find Signal/Instance | -   |
| 跳转到指定行  | 菜单 Source -> Go To -> Line        | -   |

#### 3.2.2 设计层次结构浏览

**Requirement: TR-004 设计层次树**
系统应提供设计层次结构的树形视图。

| 功能     | 描述                |
| ------ | ----------------- |
| 层次展开   | 点击实例名前的"+"符号展开子层次 |
| 层次折叠   | 点击实例名前的"-"符号折叠层次  |
| 实例定位   | 点击实例名在源代码窗口定位     |
| 层次路径显示 | 显示完整的层次路径         |

**Scenario: 用户浏览设计层次**

* **WHEN** 用户在设计浏览器中点击实例名前的"+"符号

* **THEN** 系统展开该实例的子层次结构

* **AND** 显示所有子实例

#### 3.2.3 Driver/Load追踪

**Requirement: TR-005 信号驱动追踪**
系统应支持追踪信号的驱动源。

| 功能           | 描述             |
| ------------ | -------------- |
| Trace Driver | 追踪选中信号的所有驱动源   |
| 驱动标记         | 在源代码行号旁显示左半圆标记 |
| 层次穿越         | 支持跨层次追踪驱动      |
| 多驱动显示        | 在消息窗口显示所有驱动列表  |

**Scenario: 用户追踪信号驱动**

* **WHEN** 用户选中信号并执行Trace Driver命令

* **THEN** 系统跳转到驱动该信号的源代码位置

* **AND** 在行号旁显示驱动标记

* **AND** 在消息窗口显示驱动列表

**Requirement: TR-006 信号负载追踪**
系统应支持追踪信号的负载。

| 功能         | 描述             |
| ---------- | -------------- |
| Trace Load | 追踪选中信号的所有负载    |
| 负载标记       | 在源代码行号旁显示右半圆标记 |
| 层次穿越       | 支持跨层次追踪负载      |
| 多负载显示      | 在消息窗口显示所有负载列表  |

**Requirement: TR-007 连接性追踪**
系统应支持同时追踪驱动和负载。

| 功能                 | 描述                 |
| ------------------ | ------------------ |
| Trace Connectivity | 同时追踪驱动和负载          |
| 结果显示               | 在OneTrace标签页显示追踪结果 |
| 导航功能               | 支持在追踪结果中导航         |

#### 3.2.4 Active Annotation

**Requirement: TR-008 信号值注释**
系统应在源代码中显示信号值注释。

| 功能     | 描述                 |
| ------ | ------------------ |
| 值显示    | 在信号名下方显示当前时间点的值    |
| 时间导航   | 支持跳转到值变化的时间点       |
| 边沿搜索   | 支持搜索上升沿/下降沿        |
| X/Z值显示 | 正确显示未初始化(X)和高阻态(Z) |

**Scenario: 用户启用Active Annotation**

* **WHEN** 用户加载波形文件并启用Active Annotation

* **THEN** 系统在源代码中每个信号下方显示当前值

* **AND** 工具栏显示当前时间

**Requirement: TR-009 活动驱动追踪**
系统应支持追踪特定时间点的活动驱动。

| 功能           | 描述            |
| ------------ | ------------- |
| Active Trace | 追踪当前时间点的活动驱动源 |
| 值来源分析        | 分析信号值的来源      |
| 跨层次追踪        | 支持跨层次追踪活动驱动   |

#### 3.2.5 书签功能

**Requirement: TR-010 书签管理**
系统应支持源代码书签功能。

| 功能   | 描述         |
| ---- | ---------- |
| 设置书签 | 在指定行设置书签标记 |
| 取消书签 | 取消已设置的书签   |
| 书签列表 | 显示所有书签列表   |
| 书签导航 | 跳转到指定书签位置  |

### 3.3 语言支持

**Requirement: TR-011 Verilog支持**
系统应完全支持Verilog-2001标准。

| 支持内容  | 描述                                |
| ----- | --------------------------------- |
| 模块定义  | module/endmodule                  |
| 端口声明  | input, output, inout              |
| 数据类型  | wire, reg, integer, real, time    |
| 语句块   | always, initial, assign           |
| 结构化语句 | if-else, case, for, while, repeat |
| 实例化   | 模块实例化、参数传递                        |

**Requirement: TR-012 SystemVerilog支持**
系统应支持SystemVerilog-2012标准的核心特性。

| 支持内容   | 描述                                  |
| ------ | ----------------------------------- |
| 增强数据类型 | logic, bit, byte, int, enum, struct |
| 接口     | interface/endinterface              |
| 类      | class/endclass                      |
| 断言     | assert, cover, assume               |
| 包      | package/endpackage                  |
| 程序块    | program/endprogram                  |

***

## 4. wSignal模块规格

### 4.1 功能概述

wSignal是波形查看和分析工具，用于显示和分析仿真结果，支持信号波形的可视化、测量和比较。

### 4.2 核心功能需求

#### 4.2.1 信号管理

**Requirement: WV-001 信号添加**
系统应支持多种方式添加信号到波形窗口。

| 添加方式           | 描述             |
| -------------- | -------------- |
| 拖放添加           | 从信号列表拖放信号到波形窗口 |
| Get Signals对话框 | 通过信号选择对话框添加信号  |
| 搜索添加           | 通过信号名搜索添加信号    |
| 层次浏览添加         | 通过层次结构浏览添加信号   |

**Scenario: 用户添加信号到波形窗口**

* **WHEN** 用户从信号列表拖放信号到波形窗口

* **THEN** 系统在目标位置显示该信号的波形

* **AND** 在信号窗格显示信号名称

**Requirement: WV-002 信号组管理**
系统应支持信号分组管理。

| 功能     | 描述        |
| ------ | --------- |
| 创建组    | 创建新的信号组   |
| 重命名组   | 修改组名称     |
| 删除组    | 删除信号组     |
| 组折叠/展开 | 折叠或展开组内信号 |
| 嵌套组    | 支持组的层次结构  |

**Requirement: WV-003 信号属性修改**
系统应支持修改信号显示属性。

| 属性   | 可修改项                   |
| ---- | ---------------------- |
| 显示格式 | 二进制、八进制、十进制、十六进制、ASCII |
| 信号高度 | 调整信号波形高度               |
| 信号间距 | 调整信号之间的间距              |
| 信号颜色 | 修改信号波形颜色               |
| 线型   | 实线、虚线等                 |

**Requirement: WV-004 信号排序**
系统应支持调整信号显示顺序。

| 操作   | 描述           |
| ---- | ------------ |
| 拖拽移动 | 拖拽信号到新位置     |
| 剪切粘贴 | 剪切信号并粘贴到新位置  |
| 多选操作 | 支持选择多个信号同时移动 |

#### 4.2.2 波形显示

**Requirement: WV-005 波形渲染**
系统应正确渲染各种信号类型的波形。

| 信号类型  | 波形表示              |
| ----- | ----------------- |
| 单比特信号 | 0/1/X/Z状态，跳变沿清晰显示 |
| 多比特总线 | 总线值显示，支持展开查看各比特   |
| 实数信号  | 模拟波形显示            |
| 枚举类型  | 显示枚举值名称           |

**Requirement: WV-006 波形缩放**
系统应支持多种缩放方式。

| 缩放方式 | 操作          | 快捷键 |
| ---- | ----------- | --- |
| 放大   | 点击放大按钮或选择区域 | Z   |
| 缩小   | 点击缩小按钮      | z   |
| 全部显示 | 显示全部时间范围    | f   |
| 区域缩放 | 选择时间区域进行缩放  | -   |
| 上一视图 | 返回上一缩放状态    | l   |

**Requirement: WV-007 波形平移**
系统应支持波形视图的平移操作。

| 平移方式 | 操作      | 快捷键 |
| ---- | ------- | --- |
| 左移   | 滚动条或方向键 | ←   |
| 右移   | 滚动条或方向键 | →   |
| 上移   | 滚动条或方向键 | ↑   |
| 下移   | 滚动条或方向键 | ↓   |

#### 4.2.3 游标和标记

**Requirement: WV-008 游标功能**
系统应提供波形游标功能。

| 功能   | 描述             |
| ---- | -------------- |
| 主游标  | 黄色虚线，左键点击设置位置  |
| 时间显示 | 在工具栏显示游标当前时间   |
| 值显示  | 在值窗格显示游标位置的信号值 |
| 时间跳转 | 支持跳转到指定时间点     |

**Requirement: WV-009 标记功能**
系统应提供波形标记功能。

| 功能    | 描述               |
| ----- | ---------------- |
| 标记设置  | 中键点击设置标记位置（白色虚线） |
| 时间差显示 | 显示游标与标记的时间差      |
| 标记标签  | 支持为标记添加标签名称      |
| 标签管理  | 支持管理和导航标记标签      |

**Scenario: 用户测量时间差**

* **WHEN** 用户设置游标和标记位置

* **THEN** 系统在工具栏显示两个位置的时间

* **AND** 显示时间差值

**Requirement: WV-010 网格功能**
系统应支持波形网格显示。

| 功能   | 描述           |
| ---- | ------------ |
| 网格开关 | 开启/关闭网格显示    |
| 网格类型 | 上升沿、下降沿、任意边沿 |
| 网格计数 | 显示网格编号       |

#### 4.2.4 信号值搜索

**Requirement: WV-011 值变化搜索**
系统应支持搜索信号值变化。

| 搜索类型  | 描述                |
| ----- | ----------------- |
| 任意变化  | 搜索任意值变化           |
| 上升沿   | 搜索0→1跳变           |
| 下降沿   | 搜索1→0跳变           |
| 总线值   | 搜索特定总线值           |
| 值到值跳变 | 搜索value1→value2跳变 |

**Scenario: 用户搜索上升沿**

* **WHEN** 用户选择信号并执行上升沿搜索

* **THEN** 游标跳转到下一个上升沿位置

* **AND** 在值窗格显示该时间点的值

**Requirement: WV-012 搜索约束**
系统应支持设置搜索约束条件。

| 约束类型 | 描述           |
| ---- | ------------ |
| 时间范围 | 限定搜索的时间范围    |
| 稳定时间 | 搜索值稳定特定时长的位置 |
| 组合条件 | 支持多个条件的组合搜索  |

#### 4.2.5 总线操作

**Requirement: WV-013 总线创建**
系统应支持从现有信号创建总线。

| 功能   | 描述          |
| ---- | ----------- |
| 总线创建 | 选择多个信号创建总线  |
| 位序设置 | 设置MSB/LSB顺序 |
| 总线命名 | 为创建的总线指定名称  |
| 总线展开 | 展开总线查看各比特信号 |

**Scenario: 用户创建总线**

* **WHEN** 用户选择多个信号并执行Create Bus命令

* **THEN** 系统打开总线创建对话框

* **AND** 用户可设置总线名称和位序

* **AND** 创建的总线显示在波形窗口

**Requirement: WV-014 别名功能**
系统应支持为总线值添加别名。

| 功能     | 描述           |
| ------ | ------------ |
| 加载别名文件 | 从文件加载值到别名的映射 |
| 别名显示   | 用别名替代数值显示    |
| 颜色标记   | 为不同别名值设置不同颜色 |

#### 4.2.6 注释功能

**Requirement: WV-015 波形注释**
系统应支持在波形中添加注释。

| 功能    | 描述          |
| ----- | ----------- |
| 添加注释框 | 在波形中添加文本注释框 |
| 注释定位  | 注释框可拖动定位    |
| 注释编辑  | 编辑注释文本内容    |
| 注释样式  | 支持不同样式的注释框  |

#### 4.2.7 窗口管理

**Requirement: WV-016 窗口分割**
系统应支持波形窗口分割。

| 功能   | 描述         |
| ---- | ---------- |
| 水平分割 | 将窗口分为上下两部分 |
| 独立滚动 | 各部分可独立滚动   |
| 取消分割 | 恢复单一窗口     |

**Requirement: WV-017 时间压缩**
系统应支持压缩特定时间范围。

| 功能     | 描述          |
| ------ | ----------- |
| 设置压缩范围 | 指定要压缩的时间范围  |
| 压缩显示   | 在波形中压缩显示该范围 |
| 取消压缩   | 移除时间压缩      |

#### 4.2.8 信号保存与恢复

**Requirement: WV-018 信号配置保存**
系统应支持保存和恢复信号配置。

| 功能     | 描述           |
| ------ | ------------ |
| 保存信号列表 | 保存当前显示的信号列表  |
| 保存属性   | 保存信号颜色、高度等属性 |
| 恢复信号配置 | 从文件恢复信号配置    |

***

## 5. 设计解释器规格

### 5.1 功能概述

设计解释器负责将Verilog/SystemVerilog源代码转换为内部知识库，供nTrace和nWave模块使用。

### 5.2 技术方案

**Requirement: IN-001 解析器选择**
系统应采用成熟的开源SystemVerilog解析器。

| 方案   | 描述                                                   |
| ---- | ---------------------------------------------------- |
| 推荐方案 | Surelog (<https://github.com/chipsalliance/Surelog>) |
| 备选方案 | Verilator, Icarus Verilog                            |
| 语言   | C/C++                                                |

**Requirement: IN-002 知识库内容**
知识库应包含以下信息：

| 信息类型 | 内容描述                              |
| ---- | ----------------------------------- |
| 信号信息 | 名称、完整路径、位宽、类型、方向、驱动关系、声明位置 |
| 模块信息 | 模块定义/实例、父模块、子模块、定义位置、源文件ID   |
| 层次关系 | 模块父子关系、实例与定义的关联                   |
| 代码原文 | 源代码文本、文件路径、行号                     |

**Module 结构设计原则：**

| 字段 | Definition | Instance | 说明 |
|------|------------|----------|------|
| `name` | `VpiDefName()` (e.g., "work@dut") | `VpiName()` (e.g., "u_dut") | 区分定义和实例 |
| `is_instance` | `false` | `true` | 标识模块类型 |
| `def_module_id` | `0` | 指向 Definition 的 ID | 实例关联到其定义 |
| `definition` | 定义的位置范围 | 实例的位置（通常只有 start_line） | 源代码定位 |
| `full_name` | **已移除**，通过 parent 链动态构建 | **已移除**，通过 parent 链动态构建 | 减少冗余存储 |

**Requirement: IN-003 知识库存储格式**
知识库应采用高效的二进制压缩格式。

| 要求   | 描述                             |
| ---- | ------------------------------ |
| 格式   | Protocol Buffers 或 FlatBuffers |
| 压缩   | 支持gzip/zstd压缩                  |
| 索引   | 支持快速随机访问                       |
| 增量更新 | 支持增量更新知识库                      |

### 5.3 知识库数据结构

**Requirement: IN-004 知识库数据结构定义**
知识库应采用Protocol Buffers定义数据结构，使用zstd压缩存储。

```protobuf
// 知识库数据结构定义
syntax = "proto3";

package hwda.kdb;

// 知识库头部信息
message KDBHeader {
  string version = 1;
  string project_name = 2;
  string created_at = 3;
}

// 源文件信息
message SourceFile {
  uint32 id = 1;
  string path = 2;
  string content = 3;
}

// 源代码位置
message SourceLocation {
  uint32 file_id = 1;
  uint32 line = 2;
}

// 模块定义位置（文件范围）
message ModuleSourceLocation {
  uint32 file_id = 1;
  uint32 start_line = 2;
  uint32 end_line = 3;
}

// 信号类型
enum SignalType {
  SIGNAL_TYPE_UNKNOWN = 0;
  SIGNAL_TYPE_WIRE = 1;
  SIGNAL_TYPE_REG = 2;
  SIGNAL_TYPE_LOGIC = 3;
  SIGNAL_TYPE_BIT = 4;
  SIGNAL_TYPE_INTEGER = 5;
  SIGNAL_TYPE_REAL = 6;
  SIGNAL_TYPE_PARAMETER = 7;
  SIGNAL_TYPE_LOCALPARAM = 8;
}

// 端口方向
enum PortDirection {
  PORT_DIR_UNKNOWN = 0;
  PORT_DIR_INPUT = 1;
  PORT_DIR_OUTPUT = 2;
  PORT_DIR_INOUT = 3;
}

// 信号定义
message Signal {
  uint64 id = 1;
  string name = 2;
  string full_name = 3;  // 完整层次路径
  SignalType type = 4;
  uint32 msb = 5;
  uint32 lsb = 6;
  uint32 parent_module_id = 7;
  SourceLocation declaration = 8;
  repeated uint64 driver_signal_ids = 9;
  PortDirection direction = 10;
  repeated SourceLocation driver_lines = 11;
}

// 模块定义
message Module {
  uint32 id = 1;
  string name = 2;  // Instance: VpiName(), Definition: VpiDefName()
  uint32 parent_module_id = 3;
  ModuleSourceLocation definition = 4;
  repeated Signal signals = 5;
  bool is_instance = 6;
  repeated uint32 child_module_ids = 7;
  uint32 def_module_id = 8;  // Definition module ID for instances (0 if definition)
}

// 设计层次
message DesignHierarchy {
  uint32 top_module_id = 1;
  repeated uint32 module_ids = 2;
}

// 知识库
message KnowledgeBase {
  KDBHeader header = 1;
  repeated SourceFile files = 2;
  repeated Module modules = 3;
  repeated DesignHierarchy hierarchies = 4;
}
```

### 5.4 位宽提取实现

**Requirement: IN-005 信号位宽提取**
设计解释器应正确提取信号的位宽信息（MSB/LSB）。

| 提取场景   | 实现方法                  | 说明                      |
| ------ | --------------------- | ----------------------- |
| 直接位宽声明 | `logic [7:0] a`       | 从port的Typespec获取range信息 |
| 参数化位宽  | `logic [WIDTH-1:0] a` | 使用ExprEval在模块上下文中计算表达式  |
| 标量信号   | `logic a`             | MSB=LSB=0               |
| 数组信号   | `logic [7:0] a [3:0]` | 支持packed和unpacked range |

**实现细节：**

1. **UHDM数据结构路径**：`port -> Typespec() -> Actual_typespec() -> logic_typespec -> Ranges()`
2. **表达式计算**：使用`UHDM::ExprEval::reduceExpr()`在模块实例上下文中计算参数表达式
3. **上下文传递**：将模块实例指针作为`inst`参数传递给`reduceExpr`，以解析参数值

**示例代码：**

```cpp
// 从port提取位宽
if (auto* port = obj->Cast<UHDM::port>()) {
    if (auto* ref_typespec = port->Typespec()) {
        if (auto* actual_typespec = ref_typespec->Actual_typespec()) {
            if (auto* logic_typespec = actual_typespec->Cast<UHDM::logic_typespec>()) {
                auto ranges = logic_typespec->Ranges();
                if (ranges && !ranges->empty()) {
                    auto* range = ranges->at(0);
                    // 使用上下文计算表达式
                    UHDM::ExprEval eval;
                    bool invalidValue = false;
                    UHDM::expr* reducedLeft = eval.reduceExpr(
                        range->Left_expr(), invalidValue, module_inst, nullptr);
                    uint64_t msb = eval.getValue(reducedLeft);
                }
            }
        }
    }
}
```

### 5.5 知识库构建流程

**Requirement: IN-006 知识库构建流程**
设计解释器应实现完整的知识库构建流程。

```
Verilog Source Files
        │
        ▼
┌───────────────────┐
│   Surelog Parser  │  ← 解析Verilog/SystemVerilog
│  (with elaboration)│  ← 参数展开、层次展开
└───────────────────┘
        │
        ▼
┌───────────────────┐
│   UHDM Database   │  ← 统一硬件数据模型
│  (uhdmTopModules) │  ← 展开后的模块实例
└───────────────────┘
        │
        ▼
┌───────────────────┐
│  VpiListener遍历  │  ← 遍历UHDM对象树
│  (KdbBuildListener)│
└───────────────────┘
        │
        ▼
┌───────────────────┐
│  KnowledgeBase    │  ← 提取模块、信号、连接关系
│   Builder         │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Protocol Buffers  │  ← 序列化
│   Serialization   │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│    zstd Compress  │  ← 压缩
└───────────────────┘
        │
        ▼
    .kdb File
```

### 5.6 实现组件

**Requirement: IN-007 核心组件列表**
设计解释器包含以下核心组件：

| 组件                   | 文件                        | 职责                  |
| -------------------- | ------------------------- | ------------------- |
| SurelogParser        | `surelog_parser.cpp`      | Surelog解析器封装，配置解析选项 |
| KdbBuildListener     | `kdb_build_listener.cpp`  | UHDM遍历监听器，提取设计信息    |
| BitWidthExtractor    | `bit_width_extractor.cpp` | 信号位宽提取，支持参数化位宽      |
| KnowledgeBaseBuilder | `kdb_builder.cpp`         | 知识库构建器，管理KDB数据结构    |
| KdbSerializer        | `kdb_serializer.cpp`      | 知识库序列化/反序列化         |
| KdbViewer            | `kdb_viewer.cpp`          | 知识库查看工具（CLI）        |

**Requirement: IN-008 Surelog解析配置**
Surelog解析器应配置以下选项：

| 配置项                   | 值  | 说明                  |
| --------------------- | -- | ------------------- |
| setParse(true)        | 启用 | 启用语法解析              |
| setElaborate(true)    | 启用 | 启用设计展开（elaboration） |
| setElabUhdm(true)     | 启用 | 生成展开后的UHDM          |
| setDebugUhdm(false)   | 禁用 | 禁用UHDM调试输出          |
| setCacheAllowed(true) | 启用 | 启用解析缓存              |

**Requirement: IN-009 命令行接口**
设计解释器应提供命令行接口：

```bash
# 基本用法
hwda_interpreter <verilog_files...> --output <output.kdb>

# 示例
hwda_interpreter tests/simple.v --output design.kdb

# 查看知识库
kdb_viewer design.kdb --json
```

***

## 6. 数据服务器规格

### 6.1 功能概述

数据服务器负责管理源文件和FST波形数据，通过HTTP Range协议向客户端提供数据服务。

### 6.2 技术栈

**Requirement: SV-001 服务端技术栈**
数据服务器应采用Rust + Axum技术栈。

| 组件    | 技术选择           | 说明                  |
| ----- | -------------- | ------------------- |
| Web框架 | Axum           | 高性能异步HTTP框架         |
| 波形解析  | wavefst        | Rust FST格式解析库       |
| 波形格式  | FST only       | 仅支持FST格式（GTKWave格式） |
| 传输协议  | HTTP/1.1 Range | 支持断点续传和分块下载         |

### 6.3 启动配置

**Requirement: SV-002 启动参数**
服务器应支持以下启动参数：

| 参数         | 描述      | 示例                 |
| ---------- | ------- | ------------------ |
| --kdb-dir  | 知识库文件目录 | --kdb-dir ./kdb    |
| --wave-dir | 波形文件目录  | --wave-dir ./waves |
| --port     | 服务端口    | --port 8080        |
| --host     | 绑定地址    | --host 0.0.0.0     |

### 6.4 LoD（Level of Detail）层级

**Requirement: SV-003 LoD层级定义**
服务端应支持多分辨率波形数据，LoD层级从10ps到1s。

| LoD级别  | 时间精度  | 适用场景        | 数据量      |
| ------ | ----- | ----------- | -------- |
| LoD 0  | 10ps  | 最高精度，查看单个跳变 | 100%     |
| LoD 1  | 100ps | 高精度查看       | \~50%    |
| LoD 2  | 1ns   | 正常缩放查看      | \~25%    |
| LoD 3  | 10ns  | 缩小查看整体趋势    | \~10%    |
| LoD 4  | 100ns | 概览模式        | \~5%     |
| LoD 5  | 1us   | 长时间范围概览     | \~1%     |
| LoD 6  | 10us  | 超长时间概览      | \~0.5%   |
| LoD 7  | 100us | 极长时间概览      | \~0.1%   |
| LoD 8  | 1ms   | 毫秒级概览       | \~0.05%  |
| LoD 9  | 10ms  | 十毫秒级概览      | \~0.01%  |
| LoD 10 | 100ms | 百毫秒级概览      | \~0.005% |
| LoD 11 | 1s    | 秒级概览        | \~0.001% |

**LoD数据生成：**

* 构建时预计算各LoD层级数据

* 使用降采样算法（min/max bucket）保持波形特征

* 存储为FST格式或自定义二进制格式

### 6.4.1 OPFS 数据结构规范（Warm层）

**Requirement: SV-003-1 OPFS目录结构**

客户端OPFS中的波形数据应采用以下生产级目录结构：

```
/opfs/waves/
└── <wave_id>/
    ├── meta.json              # 波形元数据（<10KB）
    ├── signals.bin            # 信号表（紧凑二进制）
    ├── level_0/               # LoD 0 - 原始精度
    │   ├── chunk_000000.bin   # 时间分块数据
    │   ├── chunk_000001.bin
    │   └── ...
    ├── level_1/               # LoD 1 - 2x降采样
    │   ├── chunk_000000.bin
    │   └── ...
    ├── level_2/               # LoD 2 - 4x降采样
    │   └── ...
    └── level_N/               # 最高LoD层级
```

**设计原则：**

* **永远不要在浏览器里"现算全量波形"** - 采用chunk + multi-resolution (LOD) + 按需加载

* **时间分块** - 每个chunk覆盖固定时间窗口，实现O(1)定位

* **预生成LOD** - LOD必须在server端或后台worker预生成，避免zoom out卡顿

**Requirement: SV-003-2 meta.json 结构**

```json
{
  "version": 1,
  "wave_id": "hdl-example",
  "time_begin": 0,
  "time_end": 1000000000,
  "time_unit": "ps",
  "levels": 6,
  "base_chunk_ns": 1000,
  "signal_count": 45,
  "chunk_size_bytes": 65536,
  "signals_meta_offset": 1024
}
```

**作用：**

* Viewer快速初始化

* LOD层级选择

* 时间到chunk的映射

**Requirement: SV-003-3 signals.bin 结构**

紧凑二进制信号表，采用SoA（Structure of Arrays）布局：

```rust
struct SignalEntry {
    handle: u32,        // 信号句柄
    width: u16,         // 位宽
    name_offset: u32,   // 名称在字符串池中的偏移
    flags: u16,         // 标志位（类型、方向等）
}

// 文件布局：
// [Header: count, string_pool_offset]
// [SignalEntry...]
// [StringPool: null-terminated names]
```

**Requirement: SV-003-4 chunk 内部数据布局**

**推荐格式：SoA（Structure of Arrays）**

```
chunk_000000.bin:
├── Header (32 bytes)
│   ├── magic: u32 = 0x57415645 ('WAVE')
│   ├── version: u16 = 1
│   ├── level: u16          // LoD层级
│   ├── chunk_id: u32       // chunk序号
│   ├── time_start: u64     // 起始时间
│   ├── time_end: u64       // 结束时间
│   └── signal_count: u32   // 信号数量
│
├── Signal Block Table
│   └── [SignalBlockHeader...] (17 bytes each)
│       ├── signal_handle: u32
│       ├── time_array_offset: u32
│       ├── value_array_offset: u32
│       ├── transition_count: u32
│       └── compression: u8  // 0=none, 1=zstd, 2=lz4
│
└── Signal Data Blocks (压缩后的数据)
    └── Per Signal:
        ├── [compressed timestamp array]  // 压缩后的时间戳数组
        └── [compressed value array]      // 压缩后的值数组
```

**为什么用SoA而不是AoS：**

* ✅ GPU友好 - WebGL/Shader可以直接使用

* ✅ SIMD友好 - 便于批量处理

* ✅ 压缩效率高 - 同类数据连续存储

**压缩算法：**

| 算法   | ID | 特点         | 适用场景       |
| ---- | -- | ---------- | ---------- |
| None | 0  | 无压缩，直接透传   | 小数据量、低延迟要求 |
| Zstd | 1  | 高压缩比，速度中等  | 大数据量、带宽受限  |
| Lz4  | 2  | 超快压缩，压缩比较低 | 实时性要求高     |

**客户端自动解压：**

* 根据 SignalBlockHeader.compression 字段自动选择解压算法

* 解压后恢复为原始 SoA 格式供 WebGL 使用

**Requirement: SV-003-5 LOD金字塔生成算法**

**核心算法：min/max bucket（业界标准）**

```rust
// 伪代码
fn generate_lod_level(input: &WaveData, level: u32) -> WaveData {
    let bucket_size = 1 << level;  // 2^level
    let mut output = WaveData::new();
    
    for signal in input.signals {
        let mut bucket_min = signal.values[0];
        let mut bucket_max = signal.values[0];
        let mut bucket_time_min = signal.times[0];
        
        for (i, (time, value)) in signal.iter().enumerate() {
            if i % bucket_size == 0 && i > 0 {
                // 输出上一个bucket的min/max
                output.push_transition(signal.handle, bucket_time_min, bucket_min);
                output.push_transition(signal.handle, bucket_time_min, bucket_max);
                bucket_min = value;
                bucket_max = value;
                bucket_time_min = time;
            } else {
                bucket_min = bucket_min.min(value);
                bucket_max = bucket_max.max(value);
            }
        }
        // 输出最后一个bucket
        output.push_transition(signal.handle, bucket_time_min, bucket_min);
        output.push_transition(signal.handle, bucket_time_min, bucket_max);
    }
    output
}
```

**为什么不用简单抽样：**

* ❌ 简单抽样会丢失窄脉冲（glitch）和边沿

* ✅ min/max bucket保证边沿不丢，zoom out时波形真实

**Requirement: SV-003-6 LOD参数建议（实战值）**

如果没有实测数据，使用以下默认值：

| 参数                    | 推荐值        | 说明          |
| --------------------- | ---------- | ----------- |
| base window (L0)      | 1-10 μs    | 最精细层级的时间窗口  |
| levels                | 6-10       | LOD金字塔层数    |
| chunk size            | 64KB-512KB | 单个chunk文件大小 |
| max points per screen | 50k        | 单屏最大绘制点数    |
| OPFS cache size       | 1-5GB      | 本地缓存上限      |

**判断是否合理的指标：**

* 单屏draw < 50k points

* 单chunk < 1MB

* OPFS命中率 > 90%

**Requirement: SV-003-7 数据流架构**

```
Server FST File
    │
    ▼ (Server-side preprocessing)
┌─────────────────┐
│  LOD Generator  │  ← 预计算多分辨率金字塔
│  (Rust/WASM)    │
└─────────────────┘
    │
    ▼ (HTTP Range Request)
Client OPFS Storage
    │
    ▼ (WASM decode)
┌─────────────────┐
│  WASM Decoder   │  ← 解压、格式转换
└─────────────────┘
    │
    ▼ (TypedArray)
┌─────────────────┐
│  WebGL Buffer   │  ← 上传GPU
└─────────────────┘
    │
    ▼
WebGL Rendering
```

**关键原则：**

* ❗OPFS → WASM 一次大块读取（不要碎片读取）

* ❗LOD必须预生成（server端或后台worker）

* ❗永远只拉"刚好够画一屏"的那一层

### 6.5 API接口定义

**Requirement: SV-004 知识库API**

```
GET /api/kdb
  描述: 获取完整知识库文件
  响应: 二进制知识库数据（.kdb文件）
  支持Range: 否（必须一次性获取完整知识库）
  说明: 知识库包含设计层次、信号信息、连接关系、源代码等所有元数据

GET /api/kdb/info
  描述: 获取知识库元信息
  响应:
  {
    "design_name": "top",
    "version": "1.0.0",
    "signal_count": 100000,
    "module_count": 500,
    "file_size": 10485760,
    "checksum": "sha256:abc123..."
  }
```

**Requirement: SV-005 波形数据API（HTTP Range + 压缩）**

```
GET /api/wave/:waveform_name/signals/:signal_name/data?lod=<level>&start=<time>&end=<time>&compress=<algo>
  描述: 获取指定波形中指定信号的波形数据
  参数:
    - waveform_name: 波形文件名（不含扩展名）
    - signal_name: 信号完整路径（URL编码）
    - lod: LoD层级 (0-11, 默认: 0)
    - start: 起始时间（ps, 默认: 0）
    - end: 结束时间（ps, 默认: 波形结束时间）
    - compress: 压缩算法 (none, zstd, lz4, 默认: none)
  响应: 
    - Content-Type: application/octet-stream
    - 二进制波形数据（Chunk格式，见6.4.1节）
  支持Range: 是（用于断点续传）
  数据格式: 
    - ChunkHeader (32 bytes) + SignalBlockHeader(s) + 压缩后的时间/值数组
    - 采用SoA (Structure of Arrays) 布局
    - 支持自动解压（根据SignalBlockHeader.compression字段）

  示例:
    # 获取原始精度数据，无压缩
    GET /api/wave/hdl-example/signals/fejkon_fc_debug.clk/data?lod=0&start=0&end=1000000
    
    # 获取LoD 2数据，使用zstd压缩
    GET /api/wave/hdl-example/signals/fejkon_fc_debug.clk/data?lod=2&start=0&end=1000000&compress=zstd
    
    # 获取数据并使用HTTP Range（断点续传）
    GET /api/wave/hdl-example/signals/fejkon_fc_debug.clk/data?lod=0&start=0&end=1000000
    Range: bytes=0-1023

GET /api/wave/list
  描述: 获取所有可用波形文件列表
  响应:
  [
    {
      "name": "tb_top",
      "file": "tb_top.fst",
      "time_range": {"start": 0, "end": 1000000000, "unit": "ps"},
      "signal_count": 5000
    }
  ]

GET /api/wave/:waveform_name/info/:signal_name
  描述: 获取指定波形中指定信号的元信息
  响应:
  {
    "waveform_name": "tb_top",
    "signal_name": "top.clk",
    "time_range": {"start": 0, "end": 1000000000, "unit": "ps"},
    "transition_count": 1000000,
    "lod_levels": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  }

GET /api/wave/:waveform_name/signals?name_regex=<pattern>&handle_from=<n>&handle_to=<n>&limit=<n>&offset=<n>
  描述: 获取指定波形中可用信号列表（支持过滤和分页）
  参数:
    - name_regex: 信号名称正则表达式过滤（可选）
    - handle_from: 起始handle（包含，可选）
    - handle_to: 结束handle（包含，可选）
    - limit: 最大返回数量（可选，默认无限制）
    - offset: 跳过前N个信号（可选，默认0）
  响应: 
    {
      "status": "success",
      "data": {
        "waveform_name": "riscv2",
        "signal_count": 2,
        "signals": [
          {
            "name": "tb_top.u_dut.u_cluster0.mem_arvalid",
            "handle": 1,
            "signal_type": "VcdWire",
            "width": 1
          }
        ]
      }
    }
  
  示例:
    # 获取所有信号
    GET /api/wave/riscv2/signals
    
    # 正则过滤包含"clk"的信号
    GET /api/wave/riscv/signals?name_regex=.*clk.*&limit=10
    
    # 按handle范围过滤
    GET /api/wave/riscv/signals?handle_from=100&handle_to=200
    
    # 分页获取
    GET /api/wave/riscv/signals?limit=50&offset=100
```

**Requirement: SV-006 HTTP Range支持**

服务端必须支持HTTP/1.1 Range请求头：

```
Request:
  GET /api/wave/top.clk?lod=2 HTTP/1.1
  Range: bytes=0-65535

Response:
  HTTP/1.1 206 Partial Content
  Content-Type: application/octet-stream
  Content-Range: bytes 0-65535/1048576
  
  [binary waveform data]
```

**Range请求优势：**

* 支持断点续传

* 支持分块并行下载

* 客户端可以精确控制下载范围

* 与OPFS文件系统配合，实现流式写入

**Requirement: SV-006-1 Server启动选项**

Server支持以下命令行参数：

```
hwda-server [OPTIONS]

Options:
  -k, --kdb-dir <DIR>         知识库目录 [default: ./kdb]
  -w, --wave-dir <DIR>        波形文件目录 [default: ./waves]
      --web-dir <DIR>         Web客户端静态文件目录（可选）
  -p, --port <PORT>           监听端口 [default: 8080]
  -l, --log-level <LEVEL>     日志级别 [default: info]
      --fst-backend <BACKEND> FST读取后端 [default: fstapi]
                                可选值: fstapi, wavefst
      --enable-cors           启用CORS [default: true]
      --cors-origin <ORIGIN>  CORS来源 [default: *]
      --enable-auth           启用认证 [default: false]
      --auth-token <TOKEN>    认证令牌
      --rate-limit <N>        速率限制(请求/秒) [default: 100]
  -h, --help                  打印帮助信息

Examples:
  # 使用默认配置启动
  hwda-server

  # 指定波形目录和端口
  hwda-server --wave-dir ./my_waves --port 9000

  # 使用wavefst后端（纯Rust实现）
  hwda-server --fst-backend wavefst

  # 同时提供Web客户端静态文件服务
  hwda-server --kdb-dir ./kdb --wave-dir ./waves --web-dir ./web-client/dist --port 8080

  # 完整配置
  hwda-server --kdb-dir ./kdb --wave-dir ./waves --web-dir ./web-client/dist \
              --port 8080 --fst-backend fstapi --log-level debug --enable-cors
```

**后端选择建议：**

| 后端      | 特点                 | 适用场景          |
| ------- | ------------------ | ------------- |
| fstapi  | GTKWave C API，功能完整 | 生产环境，复杂FST文件  |
| wavefst | 纯Rust实现，轻量         | 简单FST文件，避免C依赖 |

**静态文件服务：**

当指定 `--web-dir` 时，Server 会自动提供静态文件服务：

* API 路由 (`/api/*`) 优先处理

* 未匹配的路径回退到静态文件服务

* 适合部署时同时提供 API 和 Web 客户端

### 6.6 性能要求

**Requirement: SV-007 服务性能**
服务器应满足以下性能指标：

| 指标   | 要求              |
| ---- | --------------- |
| 响应延迟 | P99 < 50ms      |
| 吞吐量  | >100MB/s        |
| 并发连接 | >1000           |
| 波形查询 | <10ms (LoD 0-5) |

***

## 7. Web客户端规格

### 7.1 波形渲染架构

**Requirement: CL-001 渲染技术栈**
客户端波形渲染应采用WebGL + regl技术栈。

| 层级         | 技术         | 职责                                         |
| ---------- | ---------- | ------------------------------------------ |
| **WASM层**  | Rust/WASM  | FST解码、时间裁剪、降采样、数据解压                        |
| **JS层**    | TypeScript | 调度管理、缓存管理、viewport逻辑、UI                    |
| **WebGL层** | regl       | GPU buffer管理、draw batching、shader、zoom/pan |

**WASM层职责（参考hint2.md）：**

* FST block解压

* 时间窗口裁剪

* 多分辨率降采样（LoD/decimation）

* 数据压缩/展开

* 输出：TypedArray (Float32Array / Uint32Array)

**JS层职责：**

* cache管理

* viewport逻辑

* WebGL调用调度

* UI交互

**WebGL/regl层职责：**

* GPU buffer管理

* draw batching

* shader渲染

* zoom/pan变换

### 7.2 界面设计

**Requirement: CL-002 整体布局**
客户端界面应采用专业的硬件调试工具布局设计。

```
┌─────────────────────────────────────────────────────────────┐
│  Menu Bar  │  Tool Bar                                       │
├────────────┬────────────────────────────────────────────────┤
│            │                                                │
│  Design    │              Source Code Window                │
│  Browser   │              (wHDL)                            │
│            │                                                │
│  (Signal   ├────────────────────────────────────────────────┤
│   List)    │              Waveform Window                   │
│            │              (wSignal)                         │
│            │                                                │
├────────────┴────────────────────────────────────────────────┤
│  Message / Console Window                                   │
└─────────────────────────────────────────────────────────────┘
```

**Requirement: CL-003 窗口组件**
客户端应包含以下主要窗口组件：

| 组件    | 功能              |
| ----- | --------------- |
| 设计浏览器 | 显示设计层次结构、信号列表   |
| 源代码窗口 | 显示源代码、语法高亮、代码追踪 |
| 波形窗口  | 显示波形、游标、标记      |
| 值窗格   | 显示当前游标位置的信号值    |
| 消息窗口  | 显示操作结果、追踪结果     |

### 7.3 服务器连接

**Requirement: CL-004 连接配置**
客户端应支持配置服务器连接。

| 功能    | 描述              |
| ----- | --------------- |
| 服务器地址 | 支持输入服务器IP/域名和端口 |
| 连接状态  | 显示当前连接状态        |
| 重连机制  | 支持断线自动重连        |

**Scenario: 用户连接服务器**

* **WHEN** 用户输入服务器地址并点击连接

* **THEN** 客户端建立与服务器的HTTP连接

* **AND** 自动获取知识库数据

* **AND** 在设计浏览器显示设计层次

### 7.4 数据获取策略

**Requirement: CL-005 知识库获取与存储**
客户端应在连接时获取完整知识库，存储到IndexedDB。

| 策略   | 描述                     |
| ---- | ---------------------- |
| 获取时机 | 建立连接后立即获取              |
| 获取方式 | 一次性获取完整知识库             |
| 断点续传 | 支持大文件的断点续传（HTTP Range） |
| 本地存储 | IndexedDB存储知识库元数据      |
| 增量更新 | 支持检测知识库版本变化，仅下载变更部分    |

**Requirement: CL-006 波形数据获取**
客户端应按需获取波形数据，使用HTTP Range请求。

| 策略           | 描述               |
| ------------ | ---------------- |
| LoD动态选择      | 根据缩放级别自动选择LoD层级  |
| HTTP Range请求 | 使用Range头分块获取波形数据 |
| OPFS缓存       | 波形数据块缓存到OPFS本地文件 |
| 流式写入         | 支持边下载边写入OPFS     |

**波形数据请求流程：**

```
Client                                          Server
  │                                               │
  │──── HTTP GET /api/wave/top.clk?lod=2 ────────>│
  │     Range: bytes=0-65535                      │
  │                                               │
  │<─── HTTP 206 Partial Content ─────────────────│
  │     Content-Range: bytes 0-65535/1048576      │
  │                                               │
  │ [Stream to OPFS file]                         │
  │                                               │
  │ [Update memory LRU cache]                     │
  │                                               │
  │ [Render waveform with WebGL/regl]             │
```

### 7.5 性能优化

**Requirement: CL-007 波形数据缓存**
客户端应实现多级波形数据缓存机制。

**三级缓存架构：**

| 缓存级别       | 存储介质            | 容量       | 淘汰策略       | 用途          |
| ---------- | --------------- | -------- | ---------- | ----------- |
| L1 Cache   | JavaScript Heap | 50-100MB | LRU        | 当前视图数据、热点信号 |
| L2 Cache   | OPFS            | 1-5GB    | LRU + 时间过期 | 波形数据块持久化    |
| L3 Storage | 服务端             | 无限制      | 按需加载       | 完整FST文件     |

**缓存键设计：**

```
cache_key = hash(signal_full_path + time_range_start + time_range_end + lod_level)
```

**预取策略：**

| 预取类型   | 触发条件    | 预取数据       |
| ------ | ------- | ---------- |
| 时间方向预取 | 用户平移视图  | 平移方向相邻时间块  |
| 信号关联预取 | 查看总线信号  | 总线各比特信号    |
| 热点预取   | 信号被频繁访问 | 全时间范围低精度数据 |

**Requirement: CL-008 响应性能**
客户端应满足以下性能指标：

| 指标   | 要求                    |
| ---- | --------------------- |
| 波形渲染 | 1000个信号同时显示帧率 > 30fps |
| 缩放响应 | 缩放操作响应时间 < 50ms       |
| 平移响应 | 平移操作响应时间 < 16ms       |
| 内存占用 | 峰值内存 < 2GB            |

***

## 8. 系统交互流程

### 8.1 初始化流程

```
Client                          Server
  │                               │
  │──── HTTP GET /api/kdb/info ──>│
  │                               │
  │<─── KDB Metadata ─────────────│
  │                               │
  │ [Check IndexedDB for cached KDB]
  │                               │
  │ [IF KDB not cached or old]    │
  │                               │
  │──── HTTP GET /api/kdb ───────>│
  │     Range: bytes=0-65535      │
  │                               │
  │<─── HTTP 206 Partial Content ─│
  │                               │
  │ [Continue Range requests]     │
  │                               │
  │ [Store KDB to IndexedDB]      │
  │                               │
  │ [Load KDB to Memory]          │
  │                               │
  │ [Build Local Index]           │
  │                               │
  │ [Display Design Hierarchy]    │
  │                               │
```

### 8.2 波形查看流程

```
Client                          Server
  │                               │
  │ [User adds signal to view]    │
  │                               │
  │ [Check OPFS cache]            │
  │                               │
  │ [IF not cached]               │
  │                               │
  │──── HTTP GET /api/wave/... ──>│
  │     Range: bytes=0-65535      │
  │                               │
  │<─── HTTP 206 Partial Content ─│
  │                               │
  │ [Stream to OPFS]              │
  │                               │
  │ [Update LRU cache]            │
  │                               │
  │ [Render with WebGL/regl]      │
  │                               │
```

### 8.3 信号追踪流程（本地完成）

```
Client                          Server
  │                               │
  │ [User selects signal]         │
  │                               │
  │ [Query IndexedDB for Drivers] │
  │                               │
  │ [Query IndexedDB for Loads]   │
  │                               │
  │ [Navigate in Source Code]     │
  │                               │
  │ [No Server Request Needed]    │
  │                               │
```

***

## 9. 数据格式规范

### 9.1 知识库格式

**Requirement: DF-001 知识库文件格式**
知识库文件应采用以下格式：

| 属性    | 规格               |
| ----- | ---------------- |
| 文件扩展名 | .kdb             |
| 序列化格式 | Protocol Buffers |
| 压缩算法  | zstd             |
| 版本标识  | 文件头包含版本号         |

### 9.2 波形数据格式

**Requirement: DF-002 FST格式**
波形数据采用FST格式（GTKWave原生格式），通过HTTP Range传输。

| 属性    | 规格                      |
| ----- | ----------------------- |
| 格式    | FST (Fast Signal Trace) |
| 压缩    | FST内部支持多种压缩算法           |
| 传输    | HTTP Range分块传输          |
| 客户端解析 | WASM层使用wavefst库解析       |

**FST格式优势：**

* 原生支持多信号、多时间范围查询

* 高效的压缩比

* 随机访问性能优秀

* 业界标准格式（GTKWave）

### 9.3 API响应格式

**Requirement: DF-003 API响应格式**
API响应应采用统一的JSON格式，适用于所有JSON格式的API响应。

**使用场景：**

* 知识库元信息查询 (`GET /api/kdb/info`)

* 波形文件列表查询 (`GET /api/wave/list`)

* 波形信号元信息查询 (`GET /api/wave/:waveform_name/info/:signal_name`)

* 波形信号列表查询 (`GET /api/wave/:waveform_name/signals`)

* 所有其他返回JSON数据的API

**成功响应格式：**

```json
{
  "status": "success",
  "data": { ... },
  "error": null
}
```

**错误响应格式：**

```json
{
  "status": "error",
  "data": null,
  "error": {
    "code": "SIGNAL_NOT_FOUND",
    "message": "Signal 'top.invalid' not found"
  }
}
```

**错误码定义：**

| 错误码                   | 描述         | 适用场景             |
| --------------------- | ---------- | ---------------- |
| KDB\_NOT\_FOUND       | 知识库不存在     | 知识库API请求时知识库文件缺失 |
| KDB\_CORRUPTED        | 知识库损坏      | 知识库文件校验失败        |
| WAVEFORM\_NOT\_FOUND  | 波形文件不存在    | 请求的波形文件不存在       |
| SIGNAL\_NOT\_FOUND    | 信号不存在      | 请求的信号在波形中不存在     |
| INVALID\_LOD          | 无效的LoD层级   | LoD参数超出0-11范围    |
| INVALID\_TIME\_RANGE  | 无效的时间范围    | 起始时间大于结束时间       |
| RANGE\_NOT\_SUPPORTED | 不支持Range请求 | 知识库API使用了Range头  |
| INTERNAL\_ERROR       | 内部服务器错误    | 服务器内部异常          |

***

## 10. 验收标准

### 10.1 功能验收

| 模块      | 验收项               | 验收标准                  |
| ------- | ----------------- | --------------------- |
| 知识库存储   | IndexedDB存储       | 知识库可正确存储到IndexedDB    |
| 知识库存储   | 版本检测              | 可检测知识库版本变化，避免重复下载     |
| 知识库存储   | 断点续传              | 大文件下载支持HTTP Range断点续传 |
| 知识库查询   | 本地查询              | 所有知识库查询在本地完成，无需网络请求   |
| 知识库查询   | Driver追踪          | 本地正确查询信号驱动源           |
| 知识库查询   | Load追踪            | 本地正确查询信号负载            |
| 知识库查询   | 层次遍历              | 本地正确遍历设计层次结构          |
| 波形存储    | OPFS缓存            | 波形数据正确缓存到OPFS         |
| 波形存储    | HTTP Range        | 支持Range请求分块下载         |
| 波形渲染    | WebGL/regl        | 使用WebGL/regl渲染波形      |
| wHDL    | 语法高亮              | Verilog/SV关键字正确高亮     |
| wHDL    | 代码导航              | 双击模块名跳转到定义            |
| wHDL    | Driver追踪          | 正确显示信号驱动源             |
| wHDL    | Load追踪            | 正确显示信号负载              |
| wHDL    | Active Annotation | 正确显示信号值               |
| wSignal | 信号添加              | 支持拖放添加信号              |
| wSignal | 波形显示              | 正确显示0/1/X/Z状态         |
| wSignal | 游标/标记             | 正确测量时间差               |
| wSignal | 缩放/平移             | 流畅的缩放平移操作             |
| wSignal | 总线创建              | 正确创建和显示总线             |

### 10.2 性能验收

| 指标        | 验收标准                      |
| --------- | ------------------------- |
| 知识库下载     | 支持HTTP Range断点续传，网络中断后可恢复 |
| 知识库本地加载   | < 5秒 (10万信号设计)            |
| 本地查询响应    | < 10ms (Driver/Load追踪)    |
| 波形Range请求 | < 50ms (64KB-1MB块)        |
| 波形首次渲染    | < 1秒 (1000信号)             |
| 缩放响应      | < 50ms                    |
| 内存占用      | < 2GB                     |

### 10.3 兼容性验收

| 环境    | 验收标准                              |
| ----- | --------------------------------- |
| 浏览器   | Chrome 90+, Firefox 88+, Edge 90+ |
| 操作系统  | Windows 10+, Linux, macOS         |
| 波形文件  | FST格式正确读取                         |
| 存储API | OPFS和IndexedDB至少支持一种              |

***

## 11. 附录

### 11.1 术语表

| 术语                | 定义                                  |
| ----------------- | ----------------------------------- |
| KDB               | Knowledge Database，知识库              |
| Driver            | 信号的驱动源                              |
| Load              | 信号的负载                               |
| Active Annotation | 活动注释，在源代码中显示信号值                     |
| Scope             | 作用域，设计层次中的命名空间                      |
| wHDL              | Web-based HDL code viewer，代码查看与分析模块 |
| wSignal           | Web-based Signal viewer，波形查看与分析模块   |
| LoD               | Level of Detail，细节层次                |
| OPFS              | Origin Private File System，源私有文件系统  |
| FST               | Fast Signal Trace，GTKWave波形格式       |
| WASM              | WebAssembly，客户端高性能计算                |
| regl              | WebGL的函数式封装库                        |

### 11.2 wavefst库使用说明

**Requirement: REF-001 wavefst库集成**
服务端使用wavefst库读取FST格式波形文件。

**wavefst特性：**

* 现代Rust实现的FST读写库

* 零拷贝迭代，直接从解码缓冲区流式传输值变化

* 支持多种压缩格式：zlib、LZ4、FastLZ

* 可选特性：async、SIMD、serde

**基本使用示例：**

```rust
use wavefst::{ReaderBuilder, SignalValue};

// 读取FST文件
fn read_fst(path: &str) -> wavefst::Result<()> {
    let file = std::fs::File::open(path)?;
    let mut reader = ReaderBuilder::new(file).build()?;

    // 遍历所有值变化块
    while let Some(mut block) = reader.next_value_changes()? {
        while let Some(event) = block.next() {
            let event = event?;
            println!("t={} handle={} value={:?}", 
                event.timestamp, event.handle, event.value);
        }
    }
    Ok(())
}
```

**Feature Flags配置：**

| Feature  | 默认 | 说明               |
| -------- | -- | ---------------- |
| gzip     | ✅  | 启用zlib/deflate支持 |
| lz4      | ✅  | 支持LZ4压缩的层次块和值变化链 |
| fastlz   | ❌  | FastLZ解压/压缩      |
| parallel | ❌  | 使用Rayon并行解码链负载   |
| serde    | ❌  | 可序列化的层次/值变化快照    |
| mmap     | ✅  | 内存映射读取后端         |
| async    | ❌  | 基于tokio的异步包装器    |
| simd     | ✅  | SSE2加速ASCII向量打包  |

**Cargo.toml配置：**

```toml
[dependencies]
wavefst = { version = "0.1", features = ["gzip", "lz4", "mmap", "simd"] }
```

### 11.3 参考资料

1. IEEE Standard for Verilog Hardware Description Language (IEEE 1364-2005)
2. IEEE Standard for SystemVerilog (IEEE 1800-2017)
3. Surelog: <https://github.com/chipsalliance/Surelog>
4. GTKWave FST Format: <https://sourceforge.net/projects/gtkwave/>
5. wavefst: <https://docs.rs/wavefst/latest/wavefst/>
6. Axum Web Framework: <https://github.com/tokio-rs/axum>
7. regl WebGL Library: <http://regl.party/>
8. WebAssembly: <https://webassembly.org/>
9. OPFS API: <https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API>

