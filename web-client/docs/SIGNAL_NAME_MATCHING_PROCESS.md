# 信号名字匹配过程文档

## 概述

本文档描述web-client中本地信号名与服务器端信号名的匹配过程。由于KDB（知识库）中的信号层次结构与波形文件(FST)中的信号名可能不同，需要进行智能匹配。

## 命名约定

- **本地信号名（Local Signal Name）**: KDB中存储的完整层次信号名
  - 示例: `tb_top.u_dut.moduleA.submodule.signal[7:0]`
  
- **服务器信号名（Server Signal Name）**: FST波形文件中的信号名
  - 示例: `work@tb_top.u_dut.moduleA.submodule.signal [7:0]`

- **本地前缀（Local Prefix）**: 从本地信号名中去掉的部分
  - 示例: `tb_top.u_dut.`

- **服务器前缀（Server Prefix）**: 服务器信号名中额外的部分
  - 示例: `work@`

- **共享名（Shared Name）**: 去掉前缀后的共同部分
  - 示例: `moduleA.submodule.signal[7:0]`

## 匹配流程

### 1. 前缀匹配（首次添加信号时完成）

前缀匹配是独立的过程，无论信号是单bit还是多bit都会进行。

```
用户选择信号: "tb_top.u_dut.moduleA.signal[7:0]" (或多bit信号)
         ↓
Step 1: 逐级去掉本地前缀，构建正则表达式
        - 尝试1: "tb_top.u_dut.moduleA.signal[7:0]$"
        - 尝试2: "u_dut.moduleA.signal[7:0]$"
        - 尝试3: "moduleA.signal[7:0]$"
        - 尝试4: "signal[7:0]$"
         ↓
Step 2: 使用服务器的name_regex API查询
        GET /api/wave/{waveform_name}/signals?name_regex={pattern}
        注意: 不使用limit，获取所有匹配
         ↓
Step 3: 分析匹配结果
        情况A: 无匹配 → 继续去掉更多前缀
        情况B: 单匹配 → 自动确定前缀
        情况C: 多匹配 → 弹窗让用户选择
         ↓
Step 4: 确定前缀映射
        本地前缀: "tb_top.u_dut."
        服务器前缀: "work@" (从匹配结果中提取)
        共享名: "moduleA.signal[7:0]"
         ↓
Step 5: 保存配置
        - 保存到本地存储 (localStorage)
        - 后续信号使用相同前缀映射
```

**注意**: 如果首次添加的是**单bit信号**（不含`[`），此时**不检测空格**，`spaceBeforeBracket`保持默认值。

### 2. 空格匹配（延迟到多bit信号时完成）

空格匹配是独立的过程，只有当信号是多bit时才会进行。

```
场景A: 首次添加的信号是多bit
─────────────────────────────
用户选择信号: "tb_top.u_dut.moduleA.signal[7:0]"
         ↓
Step 1: 前缀匹配（如上流程）
         ↓
Step 2: 检测空格（因为信号包含'['）
        尝试1: "work@moduleA.signal[7:0]" (无空格)
        尝试2: "work@moduleA.signal [7:0]" (有空格)
         ↓
Step 3: 保存空格配置
        spaceBeforeBracket: true/false


场景B: 首次添加的是单bit，后续添加多bit
────────────────────────────────────────
用户选择信号1: "tb_top.u_dut.moduleA.clk" (单bit)
         ↓
前缀匹配完成，保存:
  - localPrefix: "tb_top.u_dut."
  - serverPrefix: "work@"
  - spaceBeforeBracket: 保持默认值 (未检测)
         ↓
用户选择信号2: "tb_top.u_dut.moduleA.data[7:0]" (多bit)
         ↓
Step 1: 使用已有前缀构建服务器名字
        "work@moduleA.data[7:0]"
         ↓
Step 2: 检测空格（因为信号包含'['）
        尝试1: "work@moduleA.data[7:0]" → 未找到
        尝试2: "work@moduleA.data [7:0]" → 找到!
         ↓
Step 3: 更新空格配置
        spaceBeforeBracket: true
        更新WASM provider设置
```

### 3. 后续信号匹配（自动）

```
用户选择信号: "tb_top.u_dut.moduleB.clk"
         ↓
Step 1: 检查已有前缀配置
        本地前缀: "tb_top.u_dut." ✓
        服务器前缀: "work@" ✓
         ↓
Step 2: 构建服务器信号名
        去掉本地前缀: "moduleB.clk"
        添加服务器前缀: "work@moduleB.clk"
        处理空格（如果需要）: "work@moduleB.clk"
         ↓
Step 3: 精确查询验证
        GET /api/wave/{waveform_name}/signals?name_regex=^work@moduleB.clk$
         ↓
Step 4: 结果处理
        找到 → 正常添加信号
        未找到 → 提示用户重新匹配（可能前缀已改变）
```

### 4. 空格检测更新流程

```
已有配置: localPrefix="tb_top.u_dut.", serverPrefix="work@", spaceBeforeBracket=false

用户选择多bit信号: "tb_top.u_dut.moduleC.bus[15:0]"
         ↓
Step 1: 使用已有前缀构建名字
        "work@moduleC.bus[15:0]"
         ↓
Step 2: 查询服务器
        未找到!
         ↓
Step 3: 尝试带空格的版本
        "work@moduleC.bus [15:0]"
         ↓
Step 4: 查询服务器
        找到!
         ↓
Step 5: 更新空格配置
        spaceBeforeBracket: true (从false更新为true)
        更新WASM provider
        添加信号成功
```

## 数据结构

### 前缀映射配置

```typescript
interface SignalNameMapping {
  // 本地前缀（从KDB信号名中去掉的部分）
  localPrefix: string;
  
  // 服务器前缀（添加到服务器信号名的部分）
  serverPrefix: string;
  
  // 是否在位宽前加空格
  // 例如: "signal[7:0]" → "signal [7:0]"
  spaceBeforeBracket: boolean;
  
  // 波形文件名（每个波形独立配置）
  waveformName: string;
}

// 存储在localStorage中的配置
const SIGNAL_NAME_MAPPINGS_KEY = 'hwda_signal_name_mappings';

interface SignalNameMappingsStorage {
  [waveformName: string]: SignalNameMapping;
}
```

## 关键函数

### 1. 构建服务器信号名

```typescript
function buildServerSignalName(
  localFullName: string,
  mapping: SignalNameMapping
): string {
  // 1. 去掉本地前缀
  let sharedName = localFullName;
  if (localFullName.startsWith(mapping.localPrefix)) {
    sharedName = localFullName.slice(mapping.localPrefix.length);
  }
  
  // 2. 处理位宽空格
  if (mapping.spaceBeforeBracket) {
    sharedName = sharedName.replace(/\[/g, ' [');
  }
  
  // 3. 添加服务器前缀
  return mapping.serverPrefix + sharedName;
}
```

### 2. 提取服务器前缀

```typescript
function extractServerPrefix(
  serverFullName: string,
  sharedName: string
): string {
  // 服务器全名: "work@moduleA.signal [7:0]"
  // 共享名: "moduleA.signal [7:0]"
  // 服务器前缀: "work@"
  
  if (serverFullName.endsWith(sharedName)) {
    return serverFullName.slice(0, -sharedName.length);
  }
  return '';
}
```

### 3. 逐级前缀移除匹配

```typescript
async function findSignalWithPrefixRemoval(
  waveformName: string,
  localFullName: string
): Promise<{
  found: boolean;
  localPrefix?: string;
  serverPrefix?: string;
  spaceBeforeBracket?: boolean;
  matchedServerName?: string;
  allMatches?: string[]; // 多个匹配时返回所有选项
}> {
  const parts = localFullName.split('.');
  
  // 逐级去掉前缀
  for (let i = 0; i < parts.length; i++) {
    const sharedName = parts.slice(i).join('.');
    const localPrefix = parts.slice(0, i).join('.') + (i > 0 ? '.' : '');
    
    // 构建正则: 只匹配行结束
    const regex = `${escapeRegex(sharedName)}$`;
    
    // 查询服务器（获取所有匹配）
    const response = await apiService.getWaveformSignals(waveformName, {
      nameRegex: regex
      // 不使用limit，获取所有匹配
    });
    
    if (response.status === 'success' && response.data?.signals?.length > 0) {
      const matches = response.data.signals;
      
      if (matches.length === 1) {
        // 单匹配: 自动确定前缀
        const serverFullName = matches[0].name;
        const serverPrefix = extractServerPrefix(serverFullName, sharedName);
        
        return {
          found: true,
          localPrefix,
          serverPrefix,
          spaceBeforeBracket: serverFullName.includes(' ['),
          matchedServerName: serverFullName
        };
      } else {
        // 多匹配: 需要用户选择
        return {
          found: true,
          localPrefix,
          allMatches: matches.map(s => s.name),
          // 其他字段等用户选择后确定
        };
      }
    }
  }
  
  return { found: false };
}
```

## 用户交互流程

### 多匹配选择弹窗

当服务器返回多个匹配信号时，显示选择弹窗：

```
┌─────────────────────────────────────────┐
│  选择服务器信号                          │
├─────────────────────────────────────────┤
│                                         │
│  本地信号: moduleA.signal[7:0]          │
│                                         │
│  找到多个匹配的服务器信号:                │
│                                         │
│  ○ work@tb_top.moduleA.signal [7:0]     │
│  ○ work@tb_top.u_dut.moduleA.signal[7:0]│
│  ○ tb_top.moduleA.signal [7:0]          │
│                                         │
│  [取消]              [确认选择]          │
└─────────────────────────────────────────┘
```

选择后，从选中的服务器信号名中提取服务器前缀。

## 存储与恢复

### 保存配置

```typescript
function saveSignalNameMapping(
  waveformName: string,
  mapping: SignalNameMapping
): void {
  const storage = getSignalNameMappings();
  storage[waveformName] = mapping;
  localStorage.setItem(
    SIGNAL_NAME_MAPPINGS_KEY,
    JSON.stringify(storage)
  );
}
```

### 恢复配置

```typescript
function getSignalNameMapping(
  waveformName: string
): SignalNameMapping | null {
  const storage = getSignalNameMappings();
  return storage[waveformName] || null;
}

function getSignalNameMappings(): SignalNameMappingsStorage {
  const stored = localStorage.getItem(SIGNAL_NAME_MAPPINGS_KEY);
  return stored ? JSON.parse(stored) : {};
}
```

## 错误处理

### 1. 前缀不匹配

当使用保存的前缀无法找到信号时：

```
信号 "tb_top.u_dut.moduleC.signal" 未找到

可能原因：
- 信号不存在于波形文件中
- 前缀配置已过期（波形文件可能已更新）

操作选项：
[重新匹配前缀]  [取消添加]
```

### 2. 波形文件更换

当用户加载新的波形文件时：

```typescript
// 检查是否需要重新匹配
const existingMapping = getSignalNameMapping(newWaveformName);
if (existingMapping) {
  // 验证第一个信号是否匹配
  const testSignal = getFirstSignalFromKDB();
  const serverName = buildServerSignalName(testSignal.fullName, existingMapping);
  const exists = await checkSignalExists(newWaveformName, serverName);
  
  if (!exists) {
    // 提示用户前缀可能已过期
    showPrefixMismatchWarning();
  }
}
```

## 与现有代码的集成

### 扩展现有接口

在 `App.tsx` 中扩展现有的信号搜索逻辑：

```typescript
// 现有接口
interface SignalSearchResult {
  found: boolean;
  matchedName?: string;
  prefix?: string;           // 本地前缀（已存在）
  serverPrefix?: string;     // 服务器前缀（新增）
  spaceBeforeBracket?: boolean;
  allMatches?: string[];     // 多匹配选项（新增）
}
```

### 修改现有函数

1. `searchSignalOnServer`: 支持只匹配行结束的正则
2. `tryFindSignalWithPrefixRemoval`: 返回服务器前缀和多匹配选项
3. `handleSignalAddToWaveform`: 处理多匹配选择弹窗

## 注意事项

1. **性能考虑**: 首次匹配可能需要多次API调用，应显示加载状态
2. **用户体验**: 多匹配情况应提供清晰的信号名对比
3. **向后兼容**: 现有保存的`prefix`字段应解释为`localPrefix`
4. **波形隔离**: 每个波形文件独立存储前缀映射配置
5. **空格处理**: 注意位宽前的空格可能存在于服务器信号名中
6. **空格匹配延迟**: 
   - 单bit信号无法确定`spaceBeforeBracket`，保持默认值
   - 只有多bit信号才能检测并确定空格配置
   - 空格配置可能在后续多bit信号添加时被更新
7. **配置完整性**: 
   - `localPrefix`和`serverPrefix`在首次信号添加时确定
   - `spaceBeforeBracket`可能延迟到第一个多bit信号时才确定

## 未来优化

1. **智能前缀猜测**: 根据KDB和波形文件的命名规律自动猜测前缀
2. **批量匹配**: 一次匹配多个信号，减少API调用
3. **前缀验证**: 定期验证保存的前缀是否仍然有效
4. **用户偏好学习**: 记录用户的选择偏好，优化自动匹配
