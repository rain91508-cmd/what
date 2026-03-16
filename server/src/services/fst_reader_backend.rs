//! FST Reader Backend - Optimized implementations for different LoD levels

use crate::error::{Result, ServerError};
use crate::services::wave_data::{SignalWaveData, Transition, SignalValueType, SignalValue};
use crate::services::LodLevel;
use crate::services::fst_reader_cache::FstReaderCache;
use fst_reader::{FstReader, FstHierarchyEntry, FstSignalHandle, FstFilter, FstSignalValue};
use std::collections::HashMap;
use std::io::BufReader;
use std::path::PathBuf;
use std::fs::File;

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
/// - `cache`: FST Reader 缓存
/// - `wave_path`: FST 文件路径
/// - `signal_names`: 信号名称列表
/// - `lod`: LoD 级别
/// - `time_start`: 开始时间
/// - `num_buckets`: bucket 数量（用于计算 time_end）
pub async fn read_signals_data_fst_reader_batch(
    cache: &FstReaderCache,
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
        read_signals_data_fst_reader_batch_lod0(cache, wave_path, signal_names, time_start, time_end).await
    } else {
        // LoD > 0: 统一使用 lod_low 流式处理
        read_signals_data_fst_reader_batch_lod_low(cache, wave_path, signal_names, lod, time_start, time_end, num_buckets).await
    }
}

/// LoD = 0: 读取所有 transitions
async fn read_signals_data_fst_reader_batch_lod0(
    cache: &FstReaderCache,
    wave_path: &PathBuf,
    signal_names: &[String],
    time_start: u64,
    time_end: u64,
) -> Result<Vec<SignalWaveData>> {
    let path = wave_path.clone();
    let signal_names: Vec<String> = signal_names.to_vec();
    let path_str = path.to_string_lossy().to_string();
    
    // 从缓存获取 reader
    let reader_arc = cache.get_or_create(&path_str).await?;
    
    tokio::task::spawn_blocking(move || {
        // 获取 reader 的锁
        let rt = tokio::runtime::Handle::current();
        let mut reader = rt.block_on(reader_arc.lock());

        // 查找所有信号
        let signal_infos = find_signals(&mut *reader, &signal_names)?;
        
        if signal_infos.is_empty() {
            return Ok(Vec::new());
        }

        let handles: Vec<FstSignalHandle> = signal_infos.iter()
            .map(|info| info.handle.clone())
            .collect();

        // 读取所有 transitions
        let filter = FstFilter {
            start: time_start,
            end: Some(time_end),
            include: Some(handles.clone()),
        };

        let mut result_map: HashMap<FstSignalHandle, SignalWaveData> = HashMap::new();
        
        for info in &signal_infos {
            result_map.insert(
                info.handle.clone(),
                SignalWaveData::new(
                    info.handle.get_index() as u32,
                    info.width as u16,
                    SignalValueType::Numeric,
                ),
            );
        }

        reader.read_signals(&filter, |time, handle, value| {
            if let Some(signal_data) = result_map.get_mut(&handle) {
                let value_str = match value {
                    FstSignalValue::String(b) => String::from_utf8_lossy(b).to_string(),
                    FstSignalValue::Real(v) => format!("{}", v),
                };
                signal_data.add_transition(Transition {
                    time,
                    value: SignalValue::Numeric(value_str),
                });
            }
        }).map_err(|e| ServerError::Internal(format!("读取信号数据失败: {:?}", e)))?;

        // 按原始请求顺序返回
        let ordered_results: Vec<SignalWaveData> = signal_names.iter()
            .filter_map(|name| {
                signal_infos.iter()
                    .find(|info| info.name == *name)
                    .and_then(|info| result_map.get(&info.handle).cloned())
            })
            .collect();

        Ok(ordered_results)
    })
    .await
    .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))?
}

/// LoD 1-10: 使用 read_signals_in_range 读取所有 transitions，然后分配到 bucket
pub async fn read_signals_data_fst_reader_batch_lod_low(
    cache: &FstReaderCache,
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
    let path_str = path.to_string_lossy().to_string();
    
    // 从缓存获取 reader
    let reader_arc = cache.get_or_create(&path_str).await?;
    
    tokio::task::spawn_blocking(move || {
        // 获取 reader 的锁
        let rt = tokio::runtime::Handle::current();
        let mut reader = rt.block_on(reader_arc.lock());

        // 查找所有信号
        let signal_infos = find_signals(&mut *reader, &signal_names)?;
        
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
        // 记录每个 bucket 是否有多个 transitions
        let mut bucket_has_multiple: HashMap<FstSignalHandle, Vec<bool>> = HashMap::new();
        
        for info in &signal_infos {
            bucket_first.insert(info.handle.clone(), vec![None; num_buckets]);
            bucket_last.insert(info.handle.clone(), vec![None; num_buckets]);
            bucket_has_multiple.insert(info.handle.clone(), vec![false; num_buckets]);
        }

        // 使用 read_signals_in_range 一次性读取整个范围的 transitions
        // 统一规则：bucket 范围是 [aligned_start + bucket_idx * bucket_size, aligned_start + (bucket_idx + 1) * bucket_size - 1]
        // 最后一个 bucket 的 end 是 time_end - 1，所以 filter 的 end 应该是 time_end - 1
        let range_filter = FstFilter {
            start: aligned_start,
            end: Some(time_end.saturating_sub(1)),
            include: Some(handles.clone()),
        };

        reader.read_signals_in_range(&range_filter, |time, handle, value| {
            // 计算 bucket index
            let bucket_idx = ((time - aligned_start) / bucket_size) as usize;
            // bucket index 必须在有效范围内 [0, num_buckets-1]
            if bucket_idx < num_buckets {
                let value_str = match value {
                    FstSignalValue::String(b) => String::from_utf8_lossy(b).to_string(),
                    FstSignalValue::Real(v) => format!("{}", v),
                };
                
                // 更新 first（如果还没有值）
                if let Some(first_vec) = bucket_first.get_mut(&handle) {
                    if first_vec[bucket_idx].is_none() {
                        first_vec[bucket_idx] = Some(value_str.clone());
                    } else {
                        // first 已经存在，说明有多个 transitions
                        if let Some(multiple_vec) = bucket_has_multiple.get_mut(&handle) {
                            multiple_vec[bucket_idx] = true;
                        }
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
            if let (Some(first_vec), Some(last_vec), Some(multiple_vec)) = 
                (bucket_first.get(&info.handle), bucket_last.get(&info.handle), bucket_has_multiple.get(&info.handle)) {
                for bucket_idx in 0..num_buckets {
                    if let Some(first_val) = &first_vec[bucket_idx] {
                        // first
                        signal_data.add_transition(Transition {
                            time: bucket_idx as u64,
                            value: SignalValue::Numeric(first_val.clone()),
                        });
                        
                        // last（只要有多个 transitions 就输出，不管值是否相同）
                        if multiple_vec[bucket_idx] {
                            if let Some(last_val) = &last_vec[bucket_idx] {
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

/// LoD > 10: 对每个 bucket 单独调用 read_range_boundary_values
pub async fn read_signals_data_fst_reader_batch_lod_high(
    cache: &FstReaderCache,
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
    let path_str = path.to_string_lossy().to_string();
    
    // 从缓存获取 reader
    let reader_arc = cache.get_or_create(&path_str).await?;
    
    tokio::task::spawn_blocking(move || {
        // 获取 reader 的锁
        let rt = tokio::runtime::Handle::current();
        let mut reader = rt.block_on(reader_arc.lock());

        // 查找所有信号
        let signal_infos = find_signals(&mut *reader, &signal_names)?;
        
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
                        
                        // last（如果不同于 first）
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

/// 使用 fst-reader 批量读取多个 tiles（多 tile 版本）
/// 
/// 特点：
/// - 第一个 tile 使用 read_pre_start_values 获取 start value
/// - 后续 tile 使用前一个 tile 的 last value 作为 start value
/// - 信号 handle/mask 对所有 tile 公用
/// 
/// # 参数
/// - `wave_path`: FST 文件路径
/// - `signal_names`: 信号名称列表
/// - `lod`: LoD 级别
/// - `start_time`: 第一个 tile 的开始时间
/// - `tile_span`: 每个 tile 的时间跨度
/// - `num_tiles`: tile 数量
pub async fn read_signals_data_fst_reader_tiles(
    wave_path: &PathBuf,
    signal_names: &[String],
    lod: LodLevel,
    start_time: u64,
    tile_span: u64,
    num_tiles: usize,
) -> Result<Vec<Vec<SignalWaveData>>> {
    let lod_level = lod.0;
    let bucket_size = 2u64.pow(lod_level);
    // num_buckets 计算改为向上取整，和 wave_data.rs 保持一致
    let num_buckets = ((tile_span + bucket_size - 1) / bucket_size) as usize;
    
    if lod_level == 0 {
        // LoD 0: 每个 tile 读取所有 transitions
        read_signals_data_fst_reader_tiles_lod0(wave_path, signal_names, start_time, tile_span, num_tiles).await
    } else if lod_level <= 10 {
        // LoD 1-10: 使用 read_signals_in_range
        read_signals_data_fst_reader_tiles_lod_low(wave_path, signal_names, lod, start_time, tile_span, num_buckets, num_tiles).await
    } else {
        // LoD > 10: 对每个 bucket 调用 read_range_boundary_values
        read_signals_data_fst_reader_tiles_lod_high(wave_path, signal_names, lod, start_time, tile_span, num_buckets, num_tiles).await
    }
}

/// LoD 0: 多 tile 版本
async fn read_signals_data_fst_reader_tiles_lod0(
    wave_path: &PathBuf,
    signal_names: &[String],
    start_time: u64,
    tile_span: u64,
    num_tiles: usize,
) -> Result<Vec<Vec<SignalWaveData>>> {
    let path = wave_path.clone();
    let signal_names: Vec<String> = signal_names.to_vec();
    
    tokio::task::spawn_blocking(move || {
        let file = File::open(&path)
            .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;
        let buf_reader = BufReader::new(file);
        let mut reader = FstReader::open(buf_reader)
            .map_err(|e| ServerError::Internal(format!("无法读取 FST 文件: {:?}", e)))?;

        // 查找所有信号（所有 tile 公用）
        let signal_infos = find_signals(&mut reader, &signal_names)?;
        
        if signal_infos.is_empty() {
            return Ok(vec![Vec::new(); num_tiles]);
        }

        let handles: Vec<FstSignalHandle> = signal_infos.iter()
            .map(|info| info.handle.clone())
            .collect();

        // 创建信号信息映射（所有 tile 公用）
        let signal_info_map: HashMap<FstSignalHandle, &SignalInfo> = signal_infos.iter()
            .map(|info| (info.handle.clone(), info))
            .collect();

        let mut tiles_result: Vec<Vec<SignalWaveData>> = Vec::with_capacity(num_tiles);
        
        // 处理每个 tile
        for tile_idx in 0..num_tiles {
            let tile_start = start_time + tile_span * tile_idx as u64;
            let tile_end = tile_start + tile_span;

            // 读取 pre-start values
            let pre_start_filter = FstFilter {
                start: 0,
                end: Some(tile_start),
                include: Some(handles.clone()),
            };
            let pre_start_values = reader.read_pre_start_values(&pre_start_filter)
                .map_err(|e| ServerError::Internal(format!("读取 pre-start 值失败: {:?}", e)))?;

            // 读取该 tile 的所有 transitions
            let filter = FstFilter {
                start: tile_start,
                end: Some(tile_end),
                include: Some(handles.clone()),
            };

            let mut result_map: HashMap<FstSignalHandle, SignalWaveData> = HashMap::new();
            
            for info in &signal_infos {
                result_map.insert(
                    info.handle.clone(),
                    SignalWaveData::new(
                        info.handle.get_index() as u32,
                        info.width as u16,
                        SignalValueType::Numeric,
                    ),
                );
            }

            // 添加 pre-start values
            for info in &signal_infos {
                if let Some(signal_data) = result_map.get_mut(&info.handle) {
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
                }
            }

            // 使用 read_signals_in_range 替代 read_signals，确保能正确读取 filter 范围内的数据
            reader.read_signals_in_range(&filter, |time, handle, value| {
                if let Some(signal_data) = result_map.get_mut(&handle) {
                    let value_str = match value {
                        FstSignalValue::String(b) => String::from_utf8_lossy(b).to_string(),
                        FstSignalValue::Real(v) => format!("{}", v),
                    };
                    signal_data.add_transition(Transition {
                        time,
                        value: SignalValue::Numeric(value_str),
                    });
                }
            }).map_err(|e| ServerError::Internal(format!("读取信号数据失败: {:?}", e)))?;

            // 按原始请求顺序组织结果
            let tile_signals: Vec<SignalWaveData> = signal_names.iter()
                .filter_map(|name| {
                    signal_infos.iter()
                        .find(|info| info.name == *name)
                        .and_then(|info| result_map.get(&info.handle).cloned())
                })
                .collect();

            tiles_result.push(tile_signals);
        }

        Ok(tiles_result)
    })
    .await
    .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))?
}

/// LoD 1-10: 多 tile 版本，使用 read_signals_in_range
/// 特点：第一个 tile 使用 read_pre_start_values，后续 tile 使用前一个 tile 的 last value
async fn read_signals_data_fst_reader_tiles_lod_low(
    wave_path: &PathBuf,
    signal_names: &[String],
    lod: LodLevel,
    start_time: u64,
    tile_span: u64,
    num_buckets: usize,
    num_tiles: usize,
) -> Result<Vec<Vec<SignalWaveData>>> {
    let path = wave_path.clone();
    let signal_names: Vec<String> = signal_names.to_vec();
    let lod_level = lod.0;
    
    tokio::task::spawn_blocking(move || {
        let file = File::open(&path)
            .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;
        let buf_reader = BufReader::new(file);
        let mut reader = FstReader::open(buf_reader)
            .map_err(|e| ServerError::Internal(format!("无法读取 FST 文件: {:?}", e)))?;

        // 查找所有信号（所有 tile 公用）
        let signal_infos = find_signals(&mut reader, &signal_names)?;
        
        if signal_infos.is_empty() {
            return Ok(vec![Vec::new(); num_tiles]);
        }

        let handles: Vec<FstSignalHandle> = signal_infos.iter()
            .map(|info| info.handle.clone())
            .collect();

        // 创建信号信息映射（所有 tile 公用）
        let signal_info_map: HashMap<FstSignalHandle, &SignalInfo> = signal_infos.iter()
            .map(|info| (info.handle.clone(), info))
            .collect();

        let bucket_size = 2u64.pow(lod_level);
        let mut tiles_result: Vec<Vec<SignalWaveData>> = Vec::with_capacity(num_tiles);
        
        // 存储每个信号的 last value（用于下一个 tile 的 start value）
        let mut last_values: HashMap<FstSignalHandle, String> = HashMap::new();

        // 处理每个 tile
        for tile_idx in 0..num_tiles {
            let tile_start = start_time + tile_span * tile_idx as u64;
            let aligned_start = (tile_start / bucket_size) * bucket_size;
            let tile_end = aligned_start + num_buckets as u64 * bucket_size;

            // 获取 start values
            let start_values: HashMap<FstSignalHandle, String> = if tile_idx == 0 {
                // 第一个 tile：使用 read_pre_start_values
                // 注意：对于 Tile 0，我们需要读取波形的第一个值
                // 由于波形可能不是从时间 0 开始的，我们需要读取整个 tile 范围内的 pre-start 值
                let pre_start_filter = FstFilter {
                    start: 0,
                    end: Some(tile_start + tile_span),
                    include: Some(handles.clone()),
                };
                
                let pre_start_values = reader.read_pre_start_values(&pre_start_filter)
                    .map_err(|e| ServerError::Internal(format!("读取 pre-start 值失败: {:?}", e)))?;
                
                // 如果 pre_start 没有值，则使用默认值 "0"
                let pre_start_values = if pre_start_values.string_values.is_empty() && pre_start_values.real_values.is_empty() {
                    // 使用默认值 "0" 作为 start value
                    let mut string_values = Vec::new();
                    for info in &signal_infos {
                        string_values.push(fst_reader::PreStartSignalValue {
                            handle: info.handle.clone(),
                            value: "0".as_bytes().to_vec(),
                            time: u64::MAX, // 使用特殊时间戳表示 pre-start
                        });
                    }
                    fst_reader::PreStartValues { string_values, real_values: Vec::new() }
                } else {
                    pre_start_values
                };
                
                signal_infos.iter()
                    .map(|info| {
                        let value = pre_start_values.string_values.iter()
                            .find(|v| v.handle == info.handle)
                            .map(|v| {
                                let s = String::from_utf8_lossy(&v.value).to_string();
                                // 如果值为 "X"，则使用 "0" 作为默认值
                                if s == "X" { "0".to_string() } else { s }
                            })
                            .or_else(|| {
                                pre_start_values.real_values.iter()
                                    .find(|v| v.handle == info.handle)
                                    .map(|v| format!("{}", v.value))
                            })
                            .unwrap_or_else(|| "0".to_string()); // 使用 "0" 作为默认值
                        (info.handle.clone(), value)
                    })
                    .collect()
            } else {
                // 后续 tile：使用前一个 tile 的 last value
                last_values.clone()
            };

            // 初始化 bucket 状态
            let mut bucket_first: HashMap<FstSignalHandle, Vec<Option<String>>> = HashMap::new();
            let mut bucket_last: HashMap<FstSignalHandle, Vec<Option<String>>> = HashMap::new();
            
            for info in &signal_infos {
                bucket_first.insert(info.handle.clone(), vec![None; num_buckets]);
                bucket_last.insert(info.handle.clone(), vec![None; num_buckets]);
            }

            // 使用 read_signals_in_range 读取该 tile 的所有 transitions
            let range_filter = FstFilter {
                start: aligned_start,
                end: Some(tile_end.saturating_sub(1)),
                include: Some(handles.clone()),
            };

            reader.read_signals_in_range(&range_filter, |time, handle, value| {
                let bucket_idx = ((time - aligned_start) / bucket_size) as usize;
                if bucket_idx < num_buckets {
                    let value_str = match value {
                        FstSignalValue::String(b) => String::from_utf8_lossy(b).to_string(),
                        FstSignalValue::Real(v) => format!("{}", v),
                    };
                    
                    if let Some(first_vec) = bucket_first.get_mut(&handle) {
                        if first_vec[bucket_idx].is_none() {
                            first_vec[bucket_idx] = Some(value_str.clone());
                        }
                    }
                    
                    if let Some(last_vec) = bucket_last.get_mut(&handle) {
                        last_vec[bucket_idx] = Some(value_str);
                    }
                }
            }).map_err(|e| ServerError::Internal(format!("读取信号数据失败: {:?}", e)))?;

            // 构建该 tile 的结果
            let mut tile_signals: Vec<SignalWaveData> = Vec::with_capacity(signal_names.len());
            
            // 更新 last_values 用于下一个 tile
            last_values.clear();

            for info in &signal_infos {
                let mut signal_data = SignalWaveData::new(
                    info.handle.get_index() as u32,
                    info.width as u16,
                    SignalValueType::Numeric,
                );

                // 添加 start value
                let start_value = start_values.get(&info.handle)
                    .cloned()
                    .unwrap_or_else(|| "X".to_string());

                // 先克隆一份用于 last_value_for_next_tile
                let mut last_value_for_next_tile = start_value.clone();

                signal_data.add_transition(Transition {
                    time: u64::MAX, // 特殊时间戳表示 start value
                    value: SignalValue::Numeric(start_value),
                });

                // 添加每个 bucket 的 first/last
                // 注意：时间戳使用相对于 tile 的 bucket 索引（从 0 开始）
                
                if let (Some(first_vec), Some(last_vec)) = (bucket_first.get(&info.handle), bucket_last.get(&info.handle)) {
                    for bucket_idx in 0..num_buckets {
                        if let Some(first_val) = &first_vec[bucket_idx] {
                            // first - 使用相对于 tile 的 bucket 索引（从 0 开始）
                            signal_data.add_transition(Transition {
                                time: bucket_idx as u64,
                                value: SignalValue::Numeric(first_val.clone()),
                            });
                            last_value_for_next_tile = first_val.clone();
                            
                            // last（如果不同于 first）
                            if let Some(last_val) = &last_vec[bucket_idx] {
                                if last_val != first_val {
                                    signal_data.add_transition(Transition {
                                        time: bucket_idx as u64,
                                        value: SignalValue::Numeric(last_val.clone()),
                                    });
                                    last_value_for_next_tile = last_val.clone();
                                }
                            }
                        }
                    }
                }

                // 保存 last value 用于下一个 tile
                // 如果 last_value_for_next_tile 是 "X"，则使用 "0" 作为默认值
                let last_value_for_next_tile = if last_value_for_next_tile == "X" {
                    "0".to_string()
                } else {
                    last_value_for_next_tile
                };
                last_values.insert(info.handle.clone(), last_value_for_next_tile);

                tile_signals.push(signal_data);
            }

            tiles_result.push(tile_signals);
        }

        Ok(tiles_result)
    })
    .await
    .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))?
}

/// LoD > 10: 多 tile 版本，使用 read_range_boundary_values
/// 特点：第一个 tile 使用 read_pre_start_values，后续 tile 使用前一个 tile 的 last value
async fn read_signals_data_fst_reader_tiles_lod_high(
    wave_path: &PathBuf,
    signal_names: &[String],
    lod: LodLevel,
    start_time: u64,
    tile_span: u64,
    num_buckets: usize,
    num_tiles: usize,
) -> Result<Vec<Vec<SignalWaveData>>> {
    let path = wave_path.clone();
    let signal_names: Vec<String> = signal_names.to_vec();
    let lod_level = lod.0;
    
    tokio::task::spawn_blocking(move || {
        let file = File::open(&path)
            .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;
        let buf_reader = BufReader::new(file);
        let mut reader = FstReader::open(buf_reader)
            .map_err(|e| ServerError::Internal(format!("无法读取 FST 文件: {:?}", e)))?;

        // 查找所有信号（所有 tile 公用）
        let signal_infos = find_signals(&mut reader, &signal_names)?;
        
        if signal_infos.is_empty() {
            return Ok(vec![Vec::new(); num_tiles]);
        }

        let handles: Vec<FstSignalHandle> = signal_infos.iter()
            .map(|info| info.handle.clone())
            .collect();

        // 创建信号信息映射（所有 tile 公用）
        let signal_info_map: HashMap<FstSignalHandle, &SignalInfo> = signal_infos.iter()
            .map(|info| (info.handle.clone(), info))
            .collect();

        let bucket_size = 2u64.pow(lod_level);
        let mut tiles_result: Vec<Vec<SignalWaveData>> = Vec::with_capacity(num_tiles);
        
        // 存储每个信号的 last value（用于下一个 tile 的 start value）
        let mut last_values: HashMap<FstSignalHandle, String> = HashMap::new();

        // 处理每个 tile
        for tile_idx in 0..num_tiles {
            let tile_start = start_time + tile_span * tile_idx as u64;
            let aligned_start = (tile_start / bucket_size) * bucket_size;
            let tile_end = aligned_start + num_buckets as u64 * bucket_size;

            // 获取 start values
            let start_values: HashMap<FstSignalHandle, String> = if tile_idx == 0 {
                // 第一个 tile：使用 read_pre_start_values
                let pre_start_filter = FstFilter {
                    start: 0,
                    end: Some(tile_start),
                    include: Some(handles.clone()),
                };
                let pre_start_values = reader.read_pre_start_values(&pre_start_filter)
                    .map_err(|e| ServerError::Internal(format!("读取 pre-start 值失败: {:?}", e)))?;
                
                signal_infos.iter()
                    .map(|info| {
                        let value = pre_start_values.string_values.iter()
                            .find(|v| v.handle == info.handle)
                            .map(|v| String::from_utf8_lossy(&v.value).to_string())
                            .or_else(|| {
                                pre_start_values.real_values.iter()
                                    .find(|v| v.handle == info.handle)
                                    .map(|v| format!("{}", v.value))
                            })
                            .unwrap_or_else(|| "X".to_string());
                        (info.handle.clone(), value)
                    })
                    .collect()
            } else {
                // 后续 tile：使用前一个 tile 的 last value
                last_values.clone()
            };

            // 初始化 bucket 状态
            let mut bucket_first: HashMap<FstSignalHandle, Vec<Option<(u64, String)>>> = HashMap::new();
            let mut bucket_last: HashMap<FstSignalHandle, Vec<Option<(u64, String)>>> = HashMap::new();
            // 记录每个 bucket 是否有多个 transitions（根据 first 和 last 的时间戳判断）
            let mut bucket_has_multiple: HashMap<FstSignalHandle, Vec<bool>> = HashMap::new();
            
            for info in &signal_infos {
                bucket_first.insert(info.handle.clone(), vec![None; num_buckets]);
                bucket_last.insert(info.handle.clone(), vec![None; num_buckets]);
                bucket_has_multiple.insert(info.handle.clone(), vec![false; num_buckets]);
            }

            // 对每个 bucket 调用 read_range_boundary_values
            for bucket_idx in 0..num_buckets {
                let bucket_start = aligned_start + bucket_idx as u64 * bucket_size;
                let bucket_end = bucket_start + bucket_size;

                let filter_end = if bucket_idx == num_buckets - 1 {
                    tile_end
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

                // 更新 bucket first（保存时间戳和值）
                if let Some(first) = &boundary_values.first {
                    for val in &first.string_values {
                        if let Some(first_vec) = bucket_first.get_mut(&val.handle) {
                            // 将绝对时间戳转换为相对于 tile 的 bucket 索引
                            let relative_bucket_idx = (val.time.saturating_sub(aligned_start)) / bucket_size;
                            first_vec[bucket_idx] = Some((relative_bucket_idx, String::from_utf8_lossy(&val.value).to_string()));
                        }
                    }
                }

                // 更新 bucket last（保存时间戳和值）
                if let Some(last) = &boundary_values.last {
                    for val in &last.string_values {
                        if let Some(last_vec) = bucket_last.get_mut(&val.handle) {
                            // 将绝对时间戳转换为相对于 tile 的 bucket 索引
                            let relative_bucket_idx = (val.time.saturating_sub(aligned_start)) / bucket_size;
                            last_vec[bucket_idx] = Some((relative_bucket_idx, String::from_utf8_lossy(&val.value).to_string()));
                        }
                    }
                }
                
                // 判断每个信号在该 bucket 中是否有多个 transitions（根据 first 和 last 的时间戳）
                if let (Some(first), Some(last)) = (&boundary_values.first, &boundary_values.last) {
                    for first_val in &first.string_values {
                        if let Some(last_val) = last.string_values.iter().find(|v| v.handle == first_val.handle) {
                            // 如果 first 和 last 的时间戳不同，说明有多个 transitions
                            if first_val.time != last_val.time {
                                if let Some(multiple_vec) = bucket_has_multiple.get_mut(&first_val.handle) {
                                    multiple_vec[bucket_idx] = true;
                                }
                            }
                        }
                    }
                }
            }

            // 构建该 tile 的结果
            let mut tile_signals: Vec<SignalWaveData> = Vec::with_capacity(signal_names.len());
            
            // 更新 last_values 用于下一个 tile
            last_values.clear();

            for info in &signal_infos {
                let mut signal_data = SignalWaveData::new(
                    info.handle.get_index() as u32,
                    info.width as u16,
                    SignalValueType::Numeric,
                );

                // 添加 start value
                let start_value = start_values.get(&info.handle)
                    .cloned()
                    .unwrap_or_else(|| "X".to_string());

                // 先克隆一份用于 last_value_for_next_tile
                let mut last_value_for_next_tile = start_value.clone();

                signal_data.add_transition(Transition {
                    time: u64::MAX, // 特殊时间戳表示 start value
                    value: SignalValue::Numeric(start_value),
                });

                // 添加每个 bucket 的 first/last
                // 注意：时间戳使用相对于 tile 的 bucket 索引（从 0 开始）
                // 使用 bucket_idx 作为时间戳，而不是从 read_range_boundary_values 返回的时间戳
                // 这样可以确保与 lod_low 的输出一致
                
                if let (Some(first_vec), Some(last_vec), Some(multiple_vec)) = 
                    (bucket_first.get(&info.handle), bucket_last.get(&info.handle), bucket_has_multiple.get(&info.handle)) {
                    for bucket_idx in 0..num_buckets {
                        if let Some((_, first_val)) = &first_vec[bucket_idx] {
                            // first - 使用 bucket_idx 作为时间戳（和 lod_low 一致）
                            signal_data.add_transition(Transition {
                                time: bucket_idx as u64,
                                value: SignalValue::Numeric(first_val.clone()),
                            });
                            last_value_for_next_tile = first_val.clone();
                            
                            // last（只要有多个 transitions 就输出，不管值是否相同）
                            if multiple_vec[bucket_idx] {
                                if let Some((_, last_val)) = &last_vec[bucket_idx] {
                                    signal_data.add_transition(Transition {
                                        time: bucket_idx as u64,
                                        value: SignalValue::Numeric(last_val.clone()),
                                    });
                                    last_value_for_next_tile = last_val.clone();
                                }
                            }
                        }
                    }
                }

                // 保存 last value 用于下一个 tile
                // 如果 last_value_for_next_tile 是 "X"，则使用 "0" 作为默认值
                let last_value_for_next_tile = if last_value_for_next_tile == "X" {
                    "0".to_string()
                } else {
                    last_value_for_next_tile
                };
                last_values.insert(info.handle.clone(), last_value_for_next_tile);

                tile_signals.push(signal_data);
            }

            tiles_result.push(tile_signals);
        }

        Ok(tiles_result)
    })
    .await
    .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))?
}

/// 在 FST 文件中查找信号
fn find_signals(
    reader: &mut FstReader<BufReader<File>>,
    signal_names: &[String],
) -> Result<Vec<SignalInfo>> {
    let mut signal_infos: Vec<SignalInfo> = Vec::new();

    reader.read_hierarchy(|entry| {
        if let FstHierarchyEntry::Var { 
            name, 
            handle, 
            length,
            ..
        } = entry {
            // 检查是否匹配请求的信号名（支持部分匹配，因为 FST 中的名称可能没有完整路径）
            if let Some(matched_name) = signal_names.iter().find(|req| {
                // 完全匹配或部分匹配（FST 名称是请求名称的后缀）
                name == **req || req.ends_with(&name.to_string())
            }) {
                signal_infos.push(SignalInfo {
                    name: matched_name.clone(), // 保存原始请求的完整路径
                    handle: FstSignalHandle::from_index(handle.get_index()),
                    width: length,
                });
            }
        }
    }).map_err(|e| ServerError::Internal(format!("读取层次结构失败: {:?}", e)))?;

    Ok(signal_infos)
}
