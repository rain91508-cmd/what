//! FST Reader Backend - Optimized implementations for different LoD levels

use crate::error::{Result, ServerError};
use crate::services::wave_data::{SignalWaveData, Transition, SignalValueType, SignalValue};
use crate::services::LodLevel;
use fst_reader::{FstReader, FstHierarchyEntry, FstSignalHandle, FstFilter, FstSignalValue};
use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;

/// 信号信息
#[derive(Debug, Clone)]
struct SignalInfo {
    name: String,
    handle: FstSignalHandle,
    width: u32,
}

/// 使用 fst-reader 批量读取多个信号数据（主入口）
/// 
/// 根据 LoD 选择不同的实现策略：
/// - LoD = 0: 使用 read_signals 读取所有 transitions
/// - LoD <= 10: 使用流式处理，边读取边计算 bucket first/last
/// - LoD > 10: 对每个 bucket 单独调用 read_range_boundary_values
/// 
/// # 参数
/// - `wave_path`: FST 文件路径
/// - `signal_names`: 信号名称列表
/// - `lod`: LoD 级别
/// - `time_start`: 开始时间
/// - `num_buckets`: bucket 数量（用于计算 time_end）
pub async fn read_signals_data_fst_reader_batch(
    wave_path: &PathBuf,
    signal_names: &[String],
    lod: LodLevel,
    time_start: u64,
    num_buckets: usize,
) -> Result<Vec<SignalWaveData>> {
    let lod_level = lod.0;
    let bucket_size = 2u64.pow(lod_level);
    let aligned_start = (time_start / bucket_size) * bucket_size;
    let time_end = aligned_start + num_buckets as u64 * bucket_size;
    
    if lod_level == 0 {
        // LoD 0: 读取所有 transitions
        read_signals_data_fst_reader_batch_lod0(wave_path, signal_names, time_start, time_end).await
    } else if lod_level <= 10 {
        // LoD 1-10: 流式处理，边读取边计算 bucket first/last
        read_signals_data_fst_reader_batch_lod_low(wave_path, signal_names, lod, time_start, time_end, num_buckets).await
    } else {
        // LoD > 10: 对每个 bucket 单独调用 read_range_boundary_values
        read_signals_data_fst_reader_batch_lod_high(wave_path, signal_names, lod, time_start, time_end, num_buckets).await
    }
}

/// LoD = 0: 读取所有 transitions
async fn read_signals_data_fst_reader_batch_lod0(
    wave_path: &PathBuf,
    signal_names: &[String],
    time_start: u64,
    time_end: u64,
) -> Result<Vec<SignalWaveData>> {
    let path = wave_path.clone();
    let signal_names: Vec<String> = signal_names.to_vec();
    
    tokio::task::spawn_blocking(move || {
        let file = File::open(&path)
            .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;
        let buf_reader = BufReader::new(file);
        let mut reader = FstReader::open(buf_reader)
            .map_err(|e| ServerError::Internal(format!("无法读取 FST 文件: {:?}", e)))?;

        // 查找所有信号
        let signal_infos = find_signals(&mut reader, &signal_names)?;
        
        if signal_infos.is_empty() {
            return Ok(Vec::new());
        }

        let handles: Vec<FstSignalHandle> = signal_infos.iter()
            .map(|info| info.handle.clone())
            .collect();

        // 读取 pre-start values
        let pre_start_filter = FstFilter {
            start: 0,
            end: Some(time_start),
            include: Some(handles.clone()),
        };
        let pre_start_values = reader.read_pre_start_values(&pre_start_filter)
            .map_err(|e| ServerError::Internal(format!("读取 pre-start 值失败: {:?}", e)))?;

        // 读取所有 transitions
        let mut all_transitions: HashMap<FstSignalHandle, Vec<(u64, String)>> = HashMap::new();
        for info in &signal_infos {
            all_transitions.insert(info.handle.clone(), Vec::new());
        }

        let signals_filter = FstFilter {
            start: time_start,
            end: Some(time_end),
            include: Some(handles.clone()),
        };

        reader.read_signals(&signals_filter, |time, handle, value| {
            if let Some(transitions) = all_transitions.get_mut(&handle) {
                let value_str = match value {
                    FstSignalValue::String(b) => String::from_utf8_lossy(b).to_string(),
                    FstSignalValue::Real(v) => format!("{}", v),
                };
                transitions.push((time, value_str));
            }
        }).map_err(|e| ServerError::Internal(format!("读取信号数据失败: {:?}", e)))?;

        // 构建结果
        let mut result_map: HashMap<String, SignalWaveData> = HashMap::new();
        
        for info in &signal_infos {
            let mut signal_data = SignalWaveData::new(
                info.handle.get_index() as u32,
                info.width as u16,
                SignalValueType::Numeric,
            );

            // 添加 start value
            let start_value = pre_start_values.string_values.iter()
                .find(|v| v.handle == info.handle)
                .map(|v| String::from_utf8_lossy(&v.value).to_string())
                .or_else(|| {
                    pre_start_values.real_values.iter()
                        .find(|v| v.handle == info.handle)
                        .map(|v| format!("{}", v.value))
                })
                .unwrap_or_else(|| "X".to_string());

            signal_data.add_transition(Transition {
                time: u64::MAX, // 特殊时间戳表示 start value
                value: SignalValue::Numeric(start_value),
            });

            // 添加所有 transitions（使用相对于 time_start 的时间）
            if let Some(transitions) = all_transitions.get(&info.handle) {
                for (time, value) in transitions.iter() {
                    let relative_time = time - time_start;
                    signal_data.add_transition(Transition {
                        time: relative_time,
                        value: SignalValue::Numeric(value.clone()),
                    });
                }
            }

            result_map.insert(info.name.clone(), signal_data);
        }

        // 按原始请求顺序返回
        let ordered_results: Vec<SignalWaveData> = signal_names.iter()
            .filter_map(|name| result_map.get(name).cloned())
            .collect();

        Ok(ordered_results)
    })
    .await
    .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))?
}

/// LoD 1-10: 使用 read_signals_in_range 读取所有 transitions，然后分配到 bucket
async fn read_signals_data_fst_reader_batch_lod_low(
    wave_path: &PathBuf,
    signal_names: &[String],
    lod: LodLevel,
    time_start: u64,
    time_end: u64,
    num_buckets: usize,
) -> Result<Vec<SignalWaveData>> {
    let path = wave_path.clone();
    let signal_names: Vec<String> = signal_names.to_vec();
    let lod_level = lod.0;
    
    tokio::task::spawn_blocking(move || {
        let file = File::open(&path)
            .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;
        let buf_reader = BufReader::new(file);
        let mut reader = FstReader::open(buf_reader)
            .map_err(|e| ServerError::Internal(format!("无法读取 FST 文件: {:?}", e)))?;

        // 查找所有信号
        let signal_infos = find_signals(&mut reader, &signal_names)?;
        
        if signal_infos.is_empty() {
            return Ok(Vec::new());
        }

        let handles: Vec<FstSignalHandle> = signal_infos.iter()
            .map(|info| info.handle.clone())
            .collect();

        // 计算 bucket 参数
        let bucket_size = 2u64.pow(lod_level);
        let aligned_start = (time_start / bucket_size) * bucket_size;

        // 读取 pre-start values
        let pre_start_filter = FstFilter {
            start: 0,
            end: Some(time_start),
            include: Some(handles.clone()),
        };
        let pre_start_values = reader.read_pre_start_values(&pre_start_filter)
            .map_err(|e| ServerError::Internal(format!("读取 pre-start 值失败: {:?}", e)))?;

        // 初始化 bucket 状态
        let mut bucket_first: HashMap<FstSignalHandle, Vec<Option<String>>> = HashMap::new();
        let mut bucket_last: HashMap<FstSignalHandle, Vec<Option<String>>> = HashMap::new();
        
        for info in &signal_infos {
            bucket_first.insert(info.handle.clone(), vec![None; num_buckets]);
            bucket_last.insert(info.handle.clone(), vec![None; num_buckets]);
        }

        // 使用 read_signals_in_range 一次性读取整个范围的 transitions
        let range_filter = FstFilter {
            start: aligned_start,
            end: Some(time_end),
            include: Some(handles.clone()),
        };

        reader.read_signals_in_range(&range_filter, |time, handle, value| {
            // 计算 bucket index
            let bucket_idx = ((time - aligned_start) / bucket_size) as usize;
            if bucket_idx < num_buckets {
                let value_str = match value {
                    FstSignalValue::String(b) => String::from_utf8_lossy(b).to_string(),
                    FstSignalValue::Real(v) => format!("{}", v),
                };
                
                // 更新 first（如果还没有值）
                if let Some(first_vec) = bucket_first.get_mut(&handle) {
                    if first_vec[bucket_idx].is_none() {
                        first_vec[bucket_idx] = Some(value_str.clone());
                    }
                }
                
                // 更新 last（总是更新）
                if let Some(last_vec) = bucket_last.get_mut(&handle) {
                    last_vec[bucket_idx] = Some(value_str);
                }
            }
        }).map_err(|e| ServerError::Internal(format!("读取信号数据失败: {:?}", e)))?;

        // 构建结果
        let mut result_map: HashMap<String, SignalWaveData> = HashMap::new();
        
        for info in &signal_infos {
            let mut signal_data = SignalWaveData::new(
                info.handle.get_index() as u32,
                info.width as u16,
                SignalValueType::Numeric,
            );

            // 获取 start value
            let start_value = pre_start_values.string_values.iter()
                .find(|v| v.handle == info.handle)
                .map(|v| String::from_utf8_lossy(&v.value).to_string())
                .or_else(|| {
                    pre_start_values.real_values.iter()
                        .find(|v| v.handle == info.handle)
                        .map(|v| format!("{}", v.value))
                })
                .unwrap_or_else(|| "X".to_string());

            // 添加 start value（使用特殊时间戳 u64::MAX）
            signal_data.add_transition(Transition {
                time: u64::MAX,
                value: SignalValue::Numeric(start_value.clone()),
            });

            // 添加每个 bucket 的 first/last（时间戳 = bucket index）
            // 注意：只添加有实际数据的 bucket，不添加空 bucket
            if let (Some(first_vec), Some(last_vec)) = (bucket_first.get(&info.handle), bucket_last.get(&info.handle)) {
                for bucket_idx in 0..num_buckets {
                    // 只处理有数据的 bucket
                    if let Some(first) = &first_vec[bucket_idx] {
                        // first
                        signal_data.add_transition(Transition {
                            time: bucket_idx as u64,
                            value: SignalValue::Numeric(first.clone()),
                        });
                        
                        // last（如果和 first 不同）
                        if let Some(last) = &last_vec[bucket_idx] {
                            if last != first {
                                signal_data.add_transition(Transition {
                                    time: bucket_idx as u64,
                                    value: SignalValue::Numeric(last.clone()),
                                });
                            }
                        }
                    }
                }
            }

            result_map.insert(info.name.clone(), signal_data);
        }

        // 按原始请求顺序返回
        let ordered_results: Vec<SignalWaveData> = signal_names.iter()
            .filter_map(|name| result_map.get(name).cloned())
            .collect();

        Ok(ordered_results)
    })
    .await
    .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))?
}

/// LoD > 10: 对每个 bucket 单独调用 read_range_boundary_values
async fn read_signals_data_fst_reader_batch_lod_high(
    wave_path: &PathBuf,
    signal_names: &[String],
    lod: LodLevel,
    time_start: u64,
    time_end: u64,
    num_buckets: usize,
) -> Result<Vec<SignalWaveData>> {
    let path = wave_path.clone();
    let signal_names: Vec<String> = signal_names.to_vec();
    let lod_level = lod.0;
    
    tokio::task::spawn_blocking(move || {
        let file = File::open(&path)
            .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;
        let buf_reader = BufReader::new(file);
        let mut reader = FstReader::open(buf_reader)
            .map_err(|e| ServerError::Internal(format!("无法读取 FST 文件: {:?}", e)))?;

        // 查找所有信号
        let signal_infos = find_signals(&mut reader, &signal_names)?;
        
        if signal_infos.is_empty() {
            return Ok(Vec::new());
        }

        let handles: Vec<FstSignalHandle> = signal_infos.iter()
            .map(|info| info.handle.clone())
            .collect();

        // 计算 bucket 参数
        let bucket_size = 2u64.pow(lod_level);
        let aligned_start = (time_start / bucket_size) * bucket_size;

        // 读取 pre-start values
        let pre_start_filter = FstFilter {
            start: 0,
            end: Some(time_start),
            include: Some(handles.clone()),
        };
        let pre_start_values = reader.read_pre_start_values(&pre_start_filter)
            .map_err(|e| ServerError::Internal(format!("读取 pre-start 值失败: {:?}", e)))?;

        // 初始化 bucket 状态
        let mut bucket_first: HashMap<FstSignalHandle, Vec<Option<String>>> = HashMap::new();
        let mut bucket_last: HashMap<FstSignalHandle, Vec<Option<String>>> = HashMap::new();
        
        for info in &signal_infos {
            bucket_first.insert(info.handle.clone(), vec![None; num_buckets]);
            bucket_last.insert(info.handle.clone(), vec![None; num_buckets]);
        }

        // 对每个 bucket 单独调用 read_range_boundary_values
        // 注意：read_range_boundary_values 是两端包含 [start, end]
        // 但为了和 lod_low 保持一致（左闭右开），我们将 end 设为 bucket_end - 1
        for bucket_idx in 0..num_buckets {
            let bucket_start = aligned_start + bucket_idx as u64 * bucket_size;
            let bucket_end = bucket_start + bucket_size;

            // 最后一个 bucket 包含到 time_end，其他 bucket 不包含右边界
            let filter_end = if bucket_idx == num_buckets - 1 {
                time_end
            } else {
                bucket_end - 1
            };

            let boundary_filter = FstFilter {
                start: bucket_start,
                end: Some(filter_end),
                include: Some(handles.clone()),
            };

            let boundary_values = reader.read_range_boundary_values(&boundary_filter)
                .map_err(|e| ServerError::Internal(format!("读取 bucket {} 边界值失败: {:?}", bucket_idx, e)))?;

            // 更新 bucket first
            if let Some(first) = &boundary_values.first {
                for val in &first.string_values {
                    if let Some(first_vec) = bucket_first.get_mut(&val.handle) {
                        first_vec[bucket_idx] = Some(String::from_utf8_lossy(&val.value).to_string());
                    }
                }
            }

            // 更新 bucket last
            if let Some(last) = &boundary_values.last {
                for val in &last.string_values {
                    if let Some(last_vec) = bucket_last.get_mut(&val.handle) {
                        last_vec[bucket_idx] = Some(String::from_utf8_lossy(&val.value).to_string());
                    }
                }
            }
        }

        // 构建结果
        let mut result_map: HashMap<String, SignalWaveData> = HashMap::new();
        
        for info in &signal_infos {
            let mut signal_data = SignalWaveData::new(
                info.handle.get_index() as u32,
                info.width as u16,
                SignalValueType::Numeric,
            );

            // 添加 start value
            let start_value = pre_start_values.string_values.iter()
                .find(|v| v.handle == info.handle)
                .map(|v| String::from_utf8_lossy(&v.value).to_string())
                .or_else(|| {
                    pre_start_values.real_values.iter()
                        .find(|v| v.handle == info.handle)
                        .map(|v| format!("{}", v.value))
                })
                .unwrap_or_else(|| "X".to_string());

            signal_data.add_transition(Transition {
                time: u64::MAX, // 特殊时间戳表示 start value
                value: SignalValue::Numeric(start_value),
            });

            // 添加每个 bucket 的 first/last（时间戳 = bucket index）
            if let (Some(first_vec), Some(last_vec)) = (bucket_first.get(&info.handle), bucket_last.get(&info.handle)) {
                for bucket_idx in 0..num_buckets {
                    if let Some(first_val) = &first_vec[bucket_idx] {
                        // first
                        signal_data.add_transition(Transition {
                            time: bucket_idx as u64,
                            value: SignalValue::Numeric(first_val.clone()),
                        });
                        
                        // last（如果和 first 不同）
                        if let Some(last_val) = &last_vec[bucket_idx] {
                            if last_val != first_val {
                                signal_data.add_transition(Transition {
                                    time: bucket_idx as u64,
                                    value: SignalValue::Numeric(last_val.clone()),
                                });
                            }
                        }
                    }
                }
            }

            result_map.insert(info.name.clone(), signal_data);
        }

        // 按原始请求顺序返回
        let ordered_results: Vec<SignalWaveData> = signal_names.iter()
            .filter_map(|name| result_map.get(name).cloned())
            .collect();

        Ok(ordered_results)
    })
    .await
    .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))?
}

/// 在 FST 文件中查找指定的信号
fn find_signals(
    reader: &mut FstReader<BufReader<File>>,
    signal_names: &[String],
) -> Result<Vec<SignalInfo>> {
    let mut signal_infos: Vec<SignalInfo> = Vec::new();
    let mut scope_stack: Vec<String> = Vec::new();

    reader.read_hierarchy(|entry| {
        match entry {
            FstHierarchyEntry::Scope { name, .. } => {
                scope_stack.push(name.to_string());
            }
            FstHierarchyEntry::UpScope => {
                scope_stack.pop();
            }
            FstHierarchyEntry::Var { name, handle, length, .. } => {
                let full_path = if scope_stack.is_empty() {
                    name.to_string()
                } else {
                    format!("{}.{}", scope_stack.join("."), name)
                };
                
                if signal_names.iter().any(|req| full_path == *req) {
                    signal_infos.push(SignalInfo {
                        name: full_path,
                        handle: FstSignalHandle::from_index(handle.get_index()),
                        width: length,
                    });
                }
            }
            _ => {}
        }
    }).map_err(|e| ServerError::Internal(format!("读取层次结构失败: {:?}", e)))?;

    Ok(signal_infos)
}
