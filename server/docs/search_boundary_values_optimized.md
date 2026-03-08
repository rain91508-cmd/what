# search_boundary_values_optimized 详细原理说明

## 1. 函数概述

```rust
pub fn search_boundary_values_optimized(
    signal_data_map: &HashMap<Handle, &SignalWaveData>,
    time: u64,
    direction: SearchDirection,
    wave_end: u64,
    widths: &HashMap<Handle, u16>,
) -> HashMap<Handle, Option<SignalValue>>
```

**功能**：为多个信号同时搜索边界值（Start Value 或 End Value）

**核心优化**：
1. 二分法快速定位最小搜索区间
2. 多信号合并搜索，减少遍历次数
3. 从最远边界开始搜索，优先找到确定值

## 2. 详细步骤

### Step 1: 为每个信号找到最小有 transition 的区间

**目标**：确定每个信号需要搜索的时间范围

**算法**：`find_min_region_binary`

```rust
for (handle, signal_data) in signal_data_map {
    let (search_start, search_end) = match direction {
        SearchDirection::Forward => (0, time),      // 向前搜索：[0, time]
        SearchDirection::Backward => (time, wave_end), // 向后搜索：[time, wave_end]
    };

    if let Some((start, end)) = find_min_region_binary(
        signal_data, search_start, search_end, direction
    ) {
        search_regions.push(SearchRegion { handle, start, end });
    }
}
```

**示例**：
```
信号 A: transitions = [100, 200, 300, 400, 500]
搜索时间: 350
方向: Forward

初始范围: [0, 350]

迭代 1: mid = 175
  检查 [175, 350]: 有 transition (200, 300)
  缩小范围: [175, 350]

迭代 2: mid = 262
  检查 [262, 350]: 有 transition (300)
  缩小范围: [262, 350]

迭代 3: mid = 306
  检查 [306, 350]: 无 transition
  扩大范围: [262, 306]

...继续直到范围 < MIN_SEARCH_SPAN

最终结果: [290, 310]
```

### Step 2: 合并排序区间边界

**目标**：收集所有边界点，按距离目标远近排序

```rust
// 收集所有边界点
let mut boundaries: Vec<(u64, Handle, bool)> = Vec::new();
for region in &search_regions {
    boundaries.push((region.start, region.handle, true));   // is_start = true
    boundaries.push((region.end, region.handle, false));    // is_start = false
}

// 按时间排序
boundaries.sort_by(|a, b| {
    match direction {
        SearchDirection::Forward => b.0.cmp(&a.0),  // 降序：从最远开始
        SearchDirection::Backward => a.0.cmp(&b.0), // 升序：从最远开始
    }
});
```

**示例**：
```
信号 A: [290, 310]
信号 B: [280, 320]
信号 C: [300, 340]

边界点收集：
  (290, A, true), (310, A, false)
  (280, B, true), (320, B, false)
  (300, C, true), (340, C, false)

Forward 方向排序（降序）：
  [340, 320, 310, 300, 290, 280]

Backward 方向排序（升序）：
  [280, 290, 300, 310, 320, 340]
```

**为什么从最远开始？**
- Forward：从大到小搜索，先找到离目标最近的值
- Backward：从小到大搜索，先找到离目标最近的值

### Step 3: 多信号一起搜索

**目标**：在合并后的区间内，为所有信号搜索边界值

```rust
let mut found_values: HashMap<Handle, SignalValue> = HashMap::new();
let mut pending_handles: HashSet<Handle> = search_regions.iter()
    .map(|r| r.handle)
    .collect();

// 按边界点顺序搜索
for (boundary_time, _, is_start) in &boundaries {
    if pending_handles.is_empty() {
        break;  // 所有信号都已找到
    }

    // 找到当前边界涉及的信号
    let current_handles: Vec<Handle> = pending_handles.iter()
        .filter(|h| {
            search_regions.iter()
                .any(|r| &r.handle == *h && *boundary_time >= r.start && *boundary_time <= r.end)
        })
        .cloned()
        .collect();

    // 在信号数据中搜索
    for handle in &current_handles {
        if let Some(signal_data) = signal_data_map.get(handle) {
            let value = match direction {
                SearchDirection::Forward => {
                    // 查找 <= time 的最后一个值
                    signal_data.value_at(time).map(|t| t.value.clone())
                }
                SearchDirection::Backward => {
                    // 查找 > time 的第一个值
                    signal_data.transitions.iter()
                        .find(|t| t.time > time)
                        .map(|t| t.value.clone())
                }
            };

            if let Some(v) = value {
                found_values.insert(*handle, v);
                pending_handles.remove(handle);
            }
        }
    }
}
```

**搜索过程示例（Forward）**：
```
目标时间: 350
边界点顺序: [340, 320, 310, 300, 290, 280]

搜索 340:
  信号 C 的区间 [300, 340] 包含 340
  在信号 C 中查找 <= 350 的最后一个值
  找到: 300
  pending: {A, B}

搜索 320:
  信号 B 的区间 [280, 320] 包含 320
  在信号 B 中查找 <= 350 的最后一个值
  找到: 300
  pending: {A}

搜索 310:
  信号 A 的区间 [290, 310] 包含 310
  在信号 A 中查找 <= 350 的最后一个值
  找到: 300
  pending: {}

结束！
```

### Step 4: 组装结果

```rust
for (handle, _) in signal_data_map {
    if let Some(value) = found_values.get(handle) {
        results.insert(*handle, Some(value.clone()));
    } else {
        // 没有找到，使用默认值 'X'
        let width = widths.get(handle).copied().unwrap_or(1);
        let default_value = if width == 1 {
            SignalValue::Numeric("X".to_string())
        } else {
            SignalValue::Numeric(format!("b{}", "X".repeat(width as usize)))
        };
        results.insert(*handle, Some(default_value));
    }
}
```

## 3. 核心数据结构

### SearchRegion
```rust
struct SearchRegion {
    handle: Handle,    // 信号句柄
    start: u64,        // 搜索区间起始时间
    end: u64,          // 搜索区间结束时间
}
```

### 边界点
```rust
(boundary_time: u64, handle: Handle, is_start: bool)
// is_start: true 表示区间起点，false 表示区间终点
```

## 4. 算法复杂度分析

| 步骤 | 时间复杂度 | 说明 |
|------|-----------|------|
| Step 1 | O(s × log n) | s 个信号，每个二分查找 O(log n) |
| Step 2 | O(s × log s) | 排序 2s 个边界点 |
| Step 3 | O(s × log n) | 每个信号最多搜索一次 |
| **总计** | **O(s × log n)** | 远优于 O(s × n) 的线性搜索 |

## 5. 与传统方法的对比

### 传统方法（逐个信号线性搜索）
```rust
for handle in handles {
    for trans in signal_data.transitions {
        if trans.time <= time {
            result = trans.value;
        }
    }
}
// 时间复杂度: O(s × n)
```

### 优化方法（多信号二分搜索）
```rust
// Step 1: 二分查找确定搜索区间
// Step 2: 合并边界点
// Step 3: 多信号一起搜索
// 时间复杂度: O(s × log n)
```

**性能提升**：
- n = 10000 transitions
- s = 100 signals
- 传统方法: 1,000,000 次操作
- 优化方法: ~1,300 次操作
- **提升约 770 倍**

## 6. 流程图

```
┌─────────────────────────────────────────────────────────────┐
│              search_boundary_values_optimized                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 1: 为每个信号二分查找最小搜索区间                        │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  for each signal:                                       ││
│  │    binary_search([0, time]) or ([time, wave_end])       ││
│  │    -> [start, end]                                      ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 2: 合并排序区间边界                                    │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  collect: (start, handle, true), (end, handle, false)   ││
│  │  sort: by time (desc for Forward, asc for Backward)     ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 3: 多信号一起搜索                                      │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  for each boundary_time in sorted order:                ││
│  │    find signals whose region contains boundary_time     ││
│  │    for each signal:                                     ││
│  │      search value_at(time) or find(|t| t.time > time)   ││
│  │      if found: add to results, remove from pending      ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 4: 组装结果                                            │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  for each signal:                                       ││
│  │    if found: return value                               ││
│  │    else: return default 'X'                             ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## 7. 使用场景

### 场景 1: 搜索 Start Value（Forward）
```rust
let start_values = search_boundary_values_optimized(
    &signal_data_map,
    tile_start,           // 搜索时间点
    SearchDirection::Forward,
    wave_end,
    &widths,
);
// 返回: tile_start 之前的最后一个值
```

### 场景 2: 搜索 End Value（Backward）
```rust
let end_values = search_boundary_values_optimized(
    &signal_data_map,
    tile_end,             // 搜索时间点
    SearchDirection::Backward,
    wave_end,
    &widths,
);
// 返回: tile_end 之后的第一个值
```

## 8. 关键优化点

1. **二分查找**：O(log n) 快速定位搜索区间
2. **区间合并**：多个信号共享搜索过程
3. **边界排序**：从最远开始，优先找到确定值
4. **提前退出**：所有信号找到后立即停止

## 9. 注意事项

1. **MIN_SEARCH_SPAN**：二分查找的最小区间，避免无限循环
2. **默认值**：未找到 transition 时返回 'X'
3. **方向选择**：
   - Forward：查找 <= time 的最后一个值
   - Backward：查找 > time 的第一个值
