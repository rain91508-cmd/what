# Server Prefix 实现检查清单

## 概述

本文档记录添加 `server_prefix` 支持到波形信号名匹配系统的实施检查清单。采用方案A（最小改动），保持现有的 `signal_prefix` 作为 local prefix，新增 `server_prefix` 字段。

## 实施前准备

- [ ] 备份当前代码
- [ ] 确保 WASM 编译环境可用
- [ ] 准备测试波形文件（包含不同前缀的信号）

## 第一阶段：Rust/WASM 层修改

### 1.1 修改 `waveform_provider.rs`

- [ ] **添加 `server_prefix` 字段到 `WaveformDataProvider` 结构体**
  ```rust
  pub struct WaveformDataProvider {
      // ... 现有字段
      signal_prefix: String,  // local prefix (保持原名)
      server_prefix: String,  // 新增: server prefix
      // ...
  }
  ```

- [ ] **修改 `new()` 构造函数**
  - [ ] 添加 `server_prefix: String` 参数
  - [ ] 初始化 `server_prefix` 字段

- [ ] **添加 `server_prefix` getter/setter**
  ```rust
  #[wasm_bindgen(getter)]
  pub fn server_prefix(&self) -> String
  
  #[wasm_bindgen(setter)]
  pub fn set_server_prefix(&mut self, prefix: String)
  ```

- [ ] **修改 `build_server_signal_name()` 方法**
  - [ ] 步骤1: 移除 local prefix (`signal_prefix`)
  - [ ] 步骤2: 得到 shared name
  - [ ] 步骤3: 添加 server prefix (`server_prefix`)
  - [ ] 步骤4: 处理空格 (`space_before_bracket`)
  - [ ] 步骤5: 返回最终 server name

- [ ] **更新 `local_to_server_name()` 方法**（如需要）

### 1.2 重新编译 WASM

- [ ] 运行 `cargo build --target wasm32-unknown-unknown --release`
- [ ] 运行 `wasm-bindgen` 生成新的 JS 绑定
- [ ] 验证生成的 `.js` 和 `.wasm` 文件包含新接口

## 第二阶段：TypeScript 接口层修改

### 2.1 修改 `waveformProviderInterface.ts`

- [ ] **更新 `ProviderConfig` 接口**
  ```typescript
  interface ProviderConfig {
    serverUrl: string;
    waveformName: string;
    signalPrefix: string;      // local prefix
    serverPrefix: string;      // 新增: server prefix
    spaceBeforeBracket: boolean;
    timeStamp: number;
    enableOpfs?: boolean;
    enableMemoryCache?: boolean;
  }
  ```

- [ ] **更新 `WaveformProviderInterface` 接口**
  - [ ] 添加 `setServerPrefix(prefix: string): void;`
  - [ ] 添加 `serverPrefix` 只读属性（可选）

### 2.2 修改 `waveformProviderFactory.ts`

- [ ] 更新 `createWaveformProvider()` 函数，传递 `serverPrefix`

## 第三阶段：Context 层修改

### 3.1 修改 `WaveformProviderContext.tsx`

- [ ] **更新 `WaveformProviderProviderProps` 接口**
  ```typescript
  interface WaveformProviderProviderProps {
    // ... 现有属性
    signalPrefix?: string;      // local prefix
    serverPrefix?: string;      // 新增: server prefix
    // ...
  }
  ```

- [ ] **更新 `WaveformProviderProvider` 组件**
  - [ ] 添加 `serverPrefix` 参数解构
  - [ ] 在 `useEffect` 依赖数组中添加 `serverPrefix`
  - [ ] 在 provider 更新逻辑中添加 `setServerPrefix()` 调用
  - [ ] 在创建 provider 时传递 `serverPrefix`

## 第四阶段：App.tsx 修改（主要工作量）

### 4.1 状态管理

- [ ] **添加新的 state**
  ```typescript
  const [currentWaveSignalServerPrefix, setCurrentWaveSignalServerPrefix] = useState<string>('')
  ```

- [ ] **更新相关函数**
  - [ ] `handleLoadWaveform()` - 清空 server prefix
  - [ ] `handleCloseWaveform()` - 清空 server prefix

### 4.2 信号搜索逻辑

- [ ] **修改 `searchSignalOnServer()` 函数**
  - [ ] 添加 `serverPrefix` 参数
  - [ ] 更新函数签名和返回值
  - [ ] 修改内部逻辑使用双 prefix

- [ ] **修改 `tryFindSignalWithPrefixRemoval()` 函数**
  - [ ] 更新返回类型，包含 `serverPrefix`
  - [ ] 从匹配结果中提取 server prefix
  - [ ] 处理多匹配情况下的 server prefix 选择

- [ ] **修改 `handleSignalAddToWaveform()` 函数**
  - [ ] 更新 prefix 检测逻辑
  - [ ] 保存 server prefix 到 state
  - [ ] 传递 server prefix 给 `updateProviderSettings()`

### 4.3 Session 管理

- [ ] **更新 Session 类型定义**
  ```typescript
  waveformSettings: {
    signalPrefix: string;      // local prefix
    serverPrefix: string;      // 新增: server prefix
    spaceBeforeBracket: boolean;
  }
  ```

- [ ] **更新 `saveSession()` 函数**
  - [ ] 保存 `currentWaveSignalServerPrefix`

- [ ] **更新 `loadSession()` 函数**
  - [ ] 恢复 `currentWaveSignalServerPrefix`
  - [ ] 向后兼容：如果旧 session 没有 serverPrefix，默认为空字符串

### 4.4 Provider 传递

- [ ] **更新 `WaveformProviderProvider` 调用**
  ```tsx
  <WaveformProviderProvider
    serverUrl={serverUrl}
    waveformName={currentWaveName || ''}
    signalPrefix={currentWaveSignalPrefix}      // local
    serverPrefix={currentWaveSignalServerPrefix} // 新增
    spaceBeforeBracket={currentWaveSignalSpaceBeforeBracket}
    // ...
  >
  ```

- [ ] **更新 `WaveformWindow` 组件调用**（如需要传递）

## 第五阶段：Worker 层修改

### 5.1 修改 `waveformWorker.ts`

- [ ] **更新消息类型定义**
  ```typescript
  interface InitMessage {
    type: 'init';
    config: {
      serverUrl: string;
      waveformName: string;
      signalPrefix: string;      // local
      serverPrefix: string;      // 新增
      spaceBeforeBracket: boolean;
      // ...
    };
  }
  ```

- [ ] **更新 `setSignalPrefix` 消息处理**
  - [ ] 或添加新的 `setServerPrefix` 消息类型

### 5.2 修改 `workerWaveformProvider.ts`

- [ ] **更新 `WorkerWaveformProvider` 类**
  - [ ] 添加 `setServerPrefix()` 方法实现
  - [ ] 更新构造函数或初始化逻辑

## 第六阶段：Adapter 层修改

### 6.1 修改 `waveformProviderAdapter.ts`

- [ ] **更新 `WaveformProviderAdapter` 类**
  - [ ] 添加 `serverPrefix` getter/setter
  - [ ] 实现 `setServerPrefix()` 方法

## 第七阶段：其他文件修改

### 7.1 修改 `waveformProvider.ts`

- [ ] **更新 `updateProviderSettings()` 函数**
  ```typescript
  export function updateProviderSettings(
    signalPrefix: string,      // local
    serverPrefix: string,      // 新增
    spaceBeforeBracket: boolean
  ): void
  ```

### 7.2 修改 `types/session.ts`（如需要）

- [ ] 更新 Session 类型定义中的 waveformSettings

## 第八阶段：测试验证

### 8.1 单元测试

- [ ] **测试 `build_server_signal_name()` 逻辑**
  - [ ] local prefix + server prefix + 空格
  - [ ] 只有 local prefix（向后兼容）
  - [ ] 复杂层次结构

- [ ] **测试信号搜索逻辑**
  - [ ] 单匹配情况
  - [ ] 多匹配情况
  - [ ] 无匹配情况

### 8.2 集成测试

- [ ] **测试完整流程**
  - [ ] 首次添加单bit信号（只确定 local prefix）
  - [ ] 后续添加多bit信号（确定空格和 server prefix）
  - [ ] 使用保存的 prefix 添加信号

- [ ] **测试 Session 保存/恢复**
  - [ ] 新 session（包含 serverPrefix）
  - [ ] 旧 session（不包含 serverPrefix，向后兼容）

### 8.3 手动测试场景

- [ ] **场景1**: local prefix = "tb_top.", server prefix = "work@"
  - 本地: `tb_top.module.signal[7:0]`
  - 服务器: `work@module.signal [7:0]`

- [ ] **场景2**: local prefix = "", server prefix = ""
  - 本地: `module.signal`
  - 服务器: `module.signal`

- [ ] **场景3**: 多匹配选择
  - 本地: `signal`
  - 服务器: `work@tb.signal`, `work@dut.signal`（需要用户选择）

## 第九阶段：文档更新

- [ ] **更新 `SIGNAL_NAME_MATCHING_PROCESS.md`**
  - [ ] 添加 server prefix 的说明
  - [ ] 更新流程图
  - [ ] 更新数据结构定义

- [ ] **更新 `WASM_INTERFACE_DOCUMENTATION.md`**（如需要）

- [ ] **更新代码注释**
  - [ ] 在关键函数中添加 server prefix 的说明

## 第十阶段：部署准备

- [ ] **构建测试**
  - [ ] `npm run build` 成功
  - [ ] 无 TypeScript 错误
  - [ ] 无 ESLint 警告

- [ ] **WASM 文件检查**
  - [ ] `hwda_wasm.js` 包含新接口
  - [ ] `hwda_wasm_bg.wasm` 已更新

- [ ] **Git 提交**
  - [ ] 提交所有修改
  - [ ] 编写清晰的 commit message

## 回滚计划

如果出现问题，需要回滚：

1. **代码回滚**: `git revert` 或 `git reset`
2. **WASM 回滚**: 恢复备份的 WASM 文件
3. **Session 数据**: 旧 session 应该仍然兼容（serverPrefix 默认为空）

## 附录：关键代码片段

### 修改后的 `build_server_signal_name()`

```rust
fn build_server_signal_name(&self, local_name: &str) -> String {
    // 步骤1: 移除 local prefix
    let shared_name = if self.signal_prefix.is_empty() || !local_name.starts_with(&self.signal_prefix) {
        local_name.to_string()
    } else {
        local_name[self.signal_prefix.len()..].to_string()
    };
    
    // 步骤2: 添加 server prefix
    let mut server_name = format!("{}{}", self.server_prefix, shared_name);
    
    // 步骤3: 处理空格
    if self.space_before_bracket {
        if let Some(bracket_idx) = server_name.find('[') {
            if bracket_idx > 0 && !server_name[..bracket_idx].ends_with(' ') {
                server_name.insert(bracket_idx, ' ');
            }
        }
    }
    
    server_name
}
```

### 修改后的 ProviderConfig

```typescript
interface ProviderConfig {
  serverUrl: string;
  waveformName: string;
  signalPrefix: string;      // local prefix (从KDB名字中去掉的部分)
  serverPrefix: string;      // server prefix (添加到服务器名字的部分)
  spaceBeforeBracket: boolean;
  timeStamp: number;
  enableOpfs?: boolean;
  enableMemoryCache?: boolean;
}
```

---

**创建日期**: 2026-03-12  
**负责人**: _______________  
**预计完成时间**: _______________
