# 多信号二分法查找 First/Last Value 原理与实现

## 1. 问题背景

对于大规模波形数据（如 LoD > 15），每个 bucket 覆盖的时间范围很大（如 2^16 = 65536 时间单位）。如果顺序读取全部数据，内存和性能开销太大。

需要一种高效的方法来：
1. 只读取必要的数据
2. 支持多信号同时处理

## 2. 核心原理

### 2.1 单信号二分法查找最小有记录区间

**目标**：找到包含 transition 的最小时间区间

**算法**：
```
初始：search_start, search_end
while (end - start > MIN_SEARCH_SPAN) {
    mid = (start + end) / 2
    
    // 检查 [mid, search_end] 或 [search_start, mid] 是否有 transition
    if has_transition {
        // 有数据，缩小范围
        start = mid  // 向前搜索
        或
        end = mid   // 向后搜索
    } else {
        // 无数据，扩大范围
        end = mid   // 向前搜索
        或
        start = mid  // 向后搜索
    }
}
```

**时间复杂度**：O(log n)，其中 n 为 transitions 数量

### 2.2 多信号合并搜索区间

**目标**：合并所有信号的搜索区间，减少 FST 读取次数

**算法**：
```
1. 为每个信号找到最小搜索区间 [start_i, end_i]
2. 合并所有区间边界点
3. 按时间排序
4. 从最远的边界开始搜索
```

**示例**：
```
信号 A: [100, 200]
信号 B: [150, 250]
信号 C: [180, 300]

合并后边界点: [100, 150, 180, 200, 250, 300]
排序后: [100, 150, 180, 200, 250, 300] (升序)

搜索顺序: 300 → 250 → 200 → 180 → 150 → 100
```

### 2.3 使用 fstapi 高效实现

**关键 API**：
- `set_time_range_limit(start, end)`: 限制读取时间范围
- `for_each_block(callback)`: 迭代读取数据
- `reset_time_range_limit()`: 重置时间范围限制

**实现步骤**：
```
for each bucket [bucket_start, bucket_end] {
    // 1. 设置时间范围
    reader.set_time_range_limit(bucket_start, bucket_end);
    
    // 2. 迭代读取
    reader.for_each_block(|time, handle, value, _| {
        // 只记录第一个和最后一个值
        if !first_values.contains_key(&handle) {
            first_values.insert(handle, value);
        }
        last_values.insert(handle, value);
    });
    
    // 3. 重置时间范围
    reader.reset_time_range_limit();
}
```

## 3. 代码实现

### 3.1 单信号二分法

```rust
pub fn find_min_region_binary(
    signal_data: &SignalWaveData,
    search_start: u64,
    search_end: u64,
    direction: SearchDirection,
) -> Option<(u64, u64)> {
    const MIN_SEARCH_SPAN: u64 = 1000;
    
    if signal_data.transitions.is_empty() {
        return None;
    }

    let mut start = search_start;
    let mut end = search_end;
    let mut last_found_region: Option<(u64, u64)> = None;

    while end - start > MIN_SEARCH_SPAN {
        let mid = (start + end) / 2;

        let has_transition = match direction {
            SearchDirection::Forward => {
                signal_data.transitions.iter()
                    .any(|t| t.time >= mid && t.time <= search_end)
            }
            SearchDirection::Backward => {
                signal_data.transitions.iter()
                    .any(|t| t.time >= search_start && t.time <= mid)
            }
        };

        if has_transition {
            last_found_region = Some((start, end));
            match direction {
                SearchDirection::Forward => start = mid,
                SearchDirection::Backward => end = mid,
            }
        } else {
            match direction {
                SearchDirection::Forward => end = mid,
                SearchDirection::Backward => start = mid,
            }
        }
    }

    last_found_region
}
```

### 3.2 多信号合并搜索

```rust
pub fn search_boundary_values_optimized(
    signal_data_map: &HashMap<Handle, &SignalWaveData>,
    time: u64,
    direction: SearchDirection,
    wave_end: u64,
    widths: &HashMap<Handle, u16>,
) -> HashMap<Handle, Option<SignalValue>> {
    // Step 1: 为每个信号找到最小搜索区间
    let mut search_regions: Vec<SearchRegion> = Vec::new();
    
    for (handle, signal_data) in signal_data_map {
        let (search_start, search_end) = match direction {
            SearchDirection::Forward => (0, time),
            SearchDirection::Backward => (time, wave_end),
        };

        if let Some((start, end)) = find_min_region_binary(
            signal_data, search_start, search_end, direction
        ) {
            search_regions.push(SearchRegion { handle, start, end });
        }
    }

    // Step 2: 合并排序区间边界
    let mut boundaries: Vec<(u64, Handle, bool)> = Vec::new();
    for region in &search_regions {
        boundaries.push((region.start, region.handle, true));
        boundaries.push((region.end, region.handle, false));
    }
    boundaries.sort_by(|a, b| match direction {
        SearchDirection::Forward => b.0.cmp(&a.0),
        SearchDirection::Backward => a.0.cmp(&b.0),
    });

    // Step 3: 多信号一起搜索
    // ... (详见代码)
}
```

### 3.3 直接使用 fstapi

```rust
pub fn search_bucket_first_last_from_fst(
    reader: &mut fstapi::Reader,
    handles: &[Handle],
    bucket_start: u64,
    bucket_end: u64,
) -> HashMap<Handle, (Option<SignalValue>, Option<SignalValue>)> {
    let mut results: HashMap<Handle, (Option<SignalValue>, Option<SignalValue>)> = 
        handles.iter().map(|h| (*h, (None, None))).collect();
    
    let mut first_values: HashMap<Handle, SignalValue> = HashMap::new();
    let mut last_values: HashMap<Handle, SignalValue> = HashMap::new();
    
    // 设置时间范围限制
    reader.set_time_range_limit(bucket_start, bucket_end);
    
    // 迭代读取数据
    reader.for_each_block(|time, handle, value, _| {
        if handles.contains(&handle) {
            let signal_value = SignalValue::Numeric(
                String::from_utf8_lossy(value).to_string()
            );
            
            // 记录 first（第一个遇到的值）
            if !first_values.contains_key(&handle) {
                first_values.insert(handle, signal_value.clone());
            }
            
            // 更新 last（最后一个遇到的值）
            last_values.insert(handle, signal_value);
        }
    }).ok();
    
    // 重置时间范围限制
    reader.reset_time_range_limit();
    
    // 组装结果
    for handle in handles {
        let first = first_values.get(handle).cloned();
        let last = last_values.get(handle).cloned();
        results.insert(*handle, (first, last));
    }
    
    results
}
```

## 4. 性能优化

### 4.1 减少 FST 读取次数

- **常规方法**：读取整个时间范围的数据
- **优化方法**：只读取 bucket 时间范围内的数据

### 4.2 多信号并行处理

- **常规方法**：逐个信号处理
- **优化方法**：多个信号同时处理，共享一次 FST 读取

### 4.3 时间复杂度

| 操作 | 常规方法 | 优化方法 |
|------|---------|---------|
| 二分查找 | O(n) | O(log n) |
| FST 读取 | O(total_transitions) | O(bucket_transitions) |
| 多信号处理 | O(signals × n) | O(signals + n) |

## 5. 使用场景

- **LoD > 15**：使用优化算法（search_bucket_first_last_from_fst）
- **LoD <= 15**：使用常规算法（generate_level_with_range）

## 6. 注意事项

1. **时间范围限制**：每次搜索后需要重置 `reset_time_range_limit()`
2. **多信号顺序**：需要按时间排序边界点
3. **空 bucket 处理**：如果没有 transition，返回 `(None, None)`

## 7. 流程图

```
┌─────────────────────────────────────────────────────────────┐
│                    多信号 First/Last 搜索流程                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 1: 为每个信号找到最小搜索区间                            │
│  - 使用二分法查找                                            │
│  - 时间复杂度: O(log n)                                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 2: 合并排序区间边界                                    │
│  - 收集所有边界点                                            │
│  - 按时间排序                                                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 3: 多信号一起搜索                                      │
│  - 使用 fstapi 的 set_time_range_limit                       │
│  - 使用 for_each_block 迭代                                  │
│  - 只记录 first 和 last 值                                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 4: 组装结果                                            │
│  - 返回每个信号的 (first, last) 值                           │
└─────────────────────────────────────────────────────────────┘
```

## 8. 示例

### 8.1 单信号二分查找示例

```
信号: tb_top.clk
Transitions: [0, 100, 200, 300, 400, 500, ...]

搜索范围: [0, 1000]
方向: Forward

Step 1: mid = 500
  检查 [500, 1000]: 有 transition (500, 600, ...)
  缩小范围: start = 500

Step 2: mid = 750
  检查 [750, 1000]: 有 transition (800, 900, ...)
  缩小范围: start = 750

...

最终找到最小区间: [800, 850]
```

### 8.2 多信号合并搜索示例

```
信号 A: transitions at [100, 200, 300]
信号 B: transitions at [150, 250, 350]
信号 C: transitions at [200, 300, 400]

搜索时间: 250
方向: Forward

Step 1: 找到最小搜索区间
  信号 A: [100, 200]
  信号 B: [150, 250]
  信号 C: [200, 300]

Step 2: 合并边界点
  边界点: [100, 150, 200, 250, 300]
  排序后: [100, 150, 200, 250, 300]

Step 3: 搜索
  从 300 开始搜索
  在 [200, 300] 范围内找到信号 C 的值
  在 [150, 250] 范围内找到信号 B 的值
  在 [100, 200] 范围内找到信号 A 的值
```

## 9. 参考

- [fstapi 文档](https://github.com/tommythorn/fst)
- [LoD 算法说明](./API.md)
