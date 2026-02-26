# 任务列表

## 阶段一：基础设施搭建

- [x] Task 1: 项目初始化与构建系统配置
  - [x] SubTask 1.1: 创建项目目录结构
  - [x] SubTask 1.2: 配置CMake构建系统（解释器）
  - [x] SubTask 1.3: 配置前端构建系统（npm/webpack）
  - [x] SubTask 1.4: 设置开发环境依赖

- [x] Task 2: 设计解释器集成
  - [x] SubTask 2.1: 集成Surelog解析器库
  - [x] SubTask 2.2: 实现知识库数据结构定义（Protocol Buffers）
  - [x] SubTask 2.3: 实现Verilog/SystemVerilog解析接口
  - [x] SubTask 2.4: 实现知识库生成器
  - [x] SubTask 2.5: 实现知识库序列化与压缩
  - [x] SubTask 2.6: 实现信号位宽提取（MSB/LSB）

- [ ] Task 3: 数据服务器基础框架（Rust + Axum）
  - [ ] SubTask 3.1: 创建Rust项目结构（Cargo workspace）
  - [ ] SubTask 3.2: 集成Axum Web框架
  - [ ] SubTask 3.3: 实现命令行参数解析
  - [ ] SubTask 3.4: 实现基础HTTP路由
  - [ ] SubTask 3.5: 实现HTTP Range请求支持

## 阶段二：波形数据处理

- [ ] Task 4: 波形文件读取模块（FST only）
  - [ ] SubTask 4.1: 集成wavefst库（Rust FST解析）
  - [ ] SubTask 4.2: 实现FST文件索引构建
  - [ ] SubTask 4.3: 实现信号元数据查询
  - [ ] SubTask 4.4: 实现时间范围数据提取

- [ ] Task 5: LoD多分辨率数据处理
  - [ ] SubTask 5.1: 实现LoD层级定义（10ps - 1s，共12级）
  - [ ] SubTask 5.2: 实现降采样算法（min/max bucket）
  - [ ] SubTask 5.3: 实现LoD数据预计算和存储
  - [ ] SubTask 5.4: 实现动态LoD选择接口

- [ ] Task 6: 波形数据服务API
  - [ ] SubTask 6.1: 实现波形信息查询API
  - [ ] SubTask 6.2: 实现信号列表查询API
  - [ ] SubTask 6.3: 实现波形数据HTTP Range查询API
  - [ ] SubTask 6.4: 实现单点信号值查询API
  - [ ] SubTask 6.5: 实现源文件服务API

## 阶段三：Web客户端基础

- [ ] Task 7: 客户端框架搭建
  - [ ] SubTask 7.1: 创建React + TypeScript项目结构
  - [ ] SubTask 7.2: 实现整体布局组件
  - [ ] SubTask 7.3: 实现服务器连接管理
  - [ ] SubTask 7.4: 实现知识库元信息获取

- [ ] Task 8: WASM层实现（FST解码）
  - [ ] SubTask 8.1: 创建Rust/WASM项目
  - [ ] SubTask 8.2: 集成wavefst到WASM
  - [ ] SubTask 8.3: 实现FST block解压
  - [ ] SubTask 8.4: 实现时间窗口裁剪
  - [ ] SubTask 8.5: 实现多分辨率降采样（LoD）
  - [ ] SubTask 8.6: 实现TypedArray输出接口

- [ ] Task 9: 客户端数据存储
  - [ ] SubTask 9.1: 实现IndexedDB存储适配器（知识库、元数据）
  - [ ] SubTask 9.2: 实现OPFS存储适配器（波形chunks）
  - [ ] SubTask 9.3: 实现知识库断点续传下载（HTTP Range）
  - [ ] SubTask 9.4: 实现知识库版本检测与增量更新
  - [ ] SubTask 9.5: 实现波形数据流式写入OPFS
  - [ ] SubTask 9.6: 实现本地存储管理（清理旧文件）

- [ ] Task 10: 知识库本地查询引擎
  - [ ] SubTask 10.1: 实现知识库反序列化与解压
  - [ ] SubTask 10.2: 实现本地索引构建（信号、模块、连接关系）
  - [ ] SubTask 10.3: 实现模块查询接口
  - [ ] SubTask 10.4: 实现信号查询接口
  - [ ] SubTask 10.5: 实现层次遍历接口
  - [ ] SubTask 10.6: 实现Driver追踪查询
  - [ ] SubTask 10.7: 实现Load追踪查询
  - [ ] SubTask 10.8: 实现连接性分析查询
  - [ ] SubTask 10.9: 实现代码搜索功能

- [ ] Task 11: 设计浏览器组件
  - [ ] SubTask 11.1: 实现层次树组件（基于本地查询）
  - [ ] SubTask 11.2: 实现信号列表组件（基于本地查询）
  - [ ] SubTask 11.3: 实现信号搜索功能（基于本地索引）
  - [ ] SubTask 11.4: 实现拖放交互支持

## 阶段四：wHDL模块实现

- [ ] Task 12: 源代码编辑器组件
  - [ ] SubTask 12.1: 集成Monaco Editor或CodeMirror
  - [ ] SubTask 12.2: 实现Verilog/SystemVerilog语法高亮
  - [ ] SubTask 12.3: 实现代码折叠功能
  - [ ] SubTask 12.4: 实现行号和标记显示

- [ ] Task 13: 代码导航功能
  - [ ] SubTask 13.1: 实现跳转到定义
  - [ ] SubTask 13.2: 实现查找作用域功能
  - [ ] SubTask 13.3: 实现查找字符串功能
  - [ ] SubTask 13.4: 实现跳转到指定行

- [ ] Task 14: Driver/Load追踪（基于本地查询引擎）
  - [ ] SubTask 14.1: 实现Trace Driver功能（本地查询）
  - [ ] SubTask 14.2: 实现Trace Load功能（本地查询）
  - [ ] SubTask 14.3: 实现Trace Connectivity功能（本地查询）
  - [ ] SubTask 14.4: 实现追踪结果导航
  - [ ] SubTask 14.5: 实现驱动/负载标记显示

- [ ] Task 15: Active Annotation功能
  - [ ] SubTask 15.1: 实现信号值注释显示
  - [ ] SubTask 15.2: 实现时间点导航
  - [ ] SubTask 15.3: 实现边沿搜索功能
  - [ ] SubTask 15.4: 实现Active Trace功能

- [ ] Task 16: 书签功能
  - [ ] SubTask 16.1: 实现书签设置/取消
  - [ ] SubTask 16.2: 实现书签列表管理
  - [ ] SubTask 16.3: 实现书签导航

## 阶段五：wSignal模块实现

- [ ] Task 17: 波形渲染引擎（WebGL + regl）
  - [ ] SubTask 17.1: 集成regl WebGL库
  - [ ] SubTask 17.2: 实现GPU buffer管理
  - [ ] SubTask 17.3: 实现draw batching
  - [ ] SubTask 17.4: 实现shader渲染（0/1/X/Z状态）
  - [ ] SubTask 17.5: 实现单比特信号波形绘制
  - [ ] SubTask 17.6: 实现总线信号波形绘制
  - [ ] SubTask 17.7: 实现zoom/pan变换
  - [ ] SubTask 17.8: 实现虚拟滚动优化

- [ ] Task 18: 波形交互功能
  - [ ] SubTask 18.1: 实现波形缩放功能
  - [ ] SubTask 18.2: 实现波形平移功能
  - [ ] SubTask 18.3: 实现游标功能
  - [ ] SubTask 18.4: 实现标记功能
  - [ ] SubTask 18.5: 实现时间差测量

- [ ] Task 19: 信号管理功能
  - [ ] SubTask 19.1: 实现信号添加/删除
  - [ ] SubTask 19.2: 实现信号组管理
  - [ ] SubTask 19.3: 实现信号排序
  - [ ] SubTask 19.4: 实现信号属性修改
  - [ ] SubTask 19.5: 实现信号配置保存/恢复

- [ ] Task 20: 值搜索功能
  - [ ] SubTask 20.1: 实现任意变化搜索
  - [ ] SubTask 20.2: 实现上升沿/下降沿搜索
  - [ ] SubTask 20.3: 实现总线值搜索
  - [ ] SubTask 20.4: 实现搜索约束功能

- [ ] Task 21: 总线操作功能
  - [ ] SubTask 21.1: 实现总线创建功能
  - [ ] SubTask 21.2: 实现总线展开/折叠
  - [ ] SubTask 21.3: 实现别名功能

- [ ] Task 22: 辅助功能
  - [ ] SubTask 22.1: 实现网格显示功能
  - [ ] SubTask 22.2: 实现注释功能
  - [ ] SubTask 22.3: 实现窗口分割功能
  - [ ] SubTask 22.4: 实现时间压缩功能

## 阶段六：集成与优化

- [ ] Task 23: 客户端数据缓存
  - [ ] SubTask 23.1: 实现L1内存缓存 (LRU策略, 50-100MB)
  - [ ] SubTask 23.2: 实现L2 OPFS本地存储 (1-5GB)
  - [ ] SubTask 23.3: 实现三级缓存一致性管理
  - [ ] SubTask 23.4: 实现智能预取策略 (时间方向/信号关联/热点)
  - [ ] SubTask 23.5: 实现缓存版本控制和失效机制

- [ ] Task 24: 服务端性能优化
  - [ ] SubTask 24.1: 实现源文件存储服务
  - [ ] SubTask 24.2: 实现LoD多分辨率数据预计算优化
  - [ ] SubTask 24.3: 实现FST格式优化读取
  - [ ] SubTask 24.4: 实现API认证和限流
  - [ ] SubTask 24.5: 实现服务性能监控

- [ ] Task 25: 客户端性能优化
  - [ ] SubTask 25.1: WebGL渲染性能优化
  - [ ] SubTask 25.2: 内存使用优化 (<2GB峰值)
  - [ ] SubTask 25.3: 首屏加载优化 (<3秒)
  - [ ] SubTask 25.4: 大数据集流畅度优化 (10万+信号)

- [ ] Task 26: 测试与文档
  - [ ] SubTask 26.1: 编写单元测试 (覆盖率>80%)
  - [ ] SubTask 26.2: 编写集成测试 (端到端场景)
  - [ ] SubTask 26.3: 编写性能基准测试
  - [ ] SubTask 26.4: 编写用户文档和API文档

---

# 任务依赖关系

- Task 2 依赖 Task 1
- Task 3 依赖 Task 1
- Task 4 依赖 Task 3
- Task 5 依赖 Task 4
- Task 6 依赖 Task 3, Task 5
- Task 7 依赖 Task 1
- Task 8 依赖 Task 4
- Task 9 依赖 Task 7
- Task 10 依赖 Task 9
- Task 11 依赖 Task 10
- Task 12 依赖 Task 10
- Task 13 依赖 Task 12
- Task 14 依赖 Task 12, Task 10
- Task 15 依赖 Task 12, Task 6
- Task 16 依赖 Task 12
- Task 17 依赖 Task 8
- Task 18 依赖 Task 17
- Task 19 依赖 Task 17, Task 11
- Task 20 依赖 Task 17, Task 6
- Task 21 依赖 Task 17
- Task 22 依赖 Task 17
- Task 23 依赖 Task 6, Task 9
- Task 24 依赖 Task 6
- Task 25 依赖 Task 17, Task 23
- Task 26 依赖 Task 1-25

# 可并行执行的任务

以下任务可以并行执行：
- Task 2, Task 3, Task 7（阶段一完成后）
- Task 4, Task 8（Task 3完成后可并行）
- Task 9, Task 10（Task 7完成后可部分并行）
- Task 11, Task 12（Task 10完成后）
- Task 13, Task 14, Task 15, Task 16（Task 12完成后）
- Task 17, Task 18, Task 19, Task 20, Task 21, Task 22（Task 8和Task 11完成后可并行）
- Task 23, Task 24（可并行开发，分别对应客户端和服务端）
- Task 25 依赖 Task 17和Task 23，但可与 Task 24 部分并行
