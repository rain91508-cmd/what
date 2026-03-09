//! FST 读取后端抽象层
//! 
//! 支持两种后端：
//! - fstapi: 使用 C 语言绑定的 fstapi 库
//! - fst-reader: 使用纯 Rust 实现的 fst-reader 库

use crate::error::{Result, ServerError};
use crate::services::wave_data::{SignalWaveData, Transition, SignalValueType};
use std::path::PathBuf;

/// FST 读取后端 trait (新的抽象接口)
#[async_trait::async_trait]
pub trait FstReader: Send + Sync {
    /// 读取信号数据
    async fn read_signal_data(
        &self,
        wave_path: &PathBuf,
        signal_name: &str,
        lod: crate::services::wave_data::LodLevel,
        time_start: u64,
        time_end: u64,
    ) -> Result<SignalWaveData>;
    
    /// 获取文件信息
    async fn get_file_info(&self, wave_path: &PathBuf) -> Result<FstFileInfo>;
}

/// FST 文件信息
#[derive(Debug, Clone)]
pub struct FstFileInfo {
    pub start_time: u64,
    pub end_time: u64,
    pub signal_count: usize,
}

/// fstapi 后端实现
pub struct FstApiBackend;

#[async_trait::async_trait]
impl FstReader for FstApiBackend {
    async fn read_signal_data(
        &self,
        wave_path: &PathBuf,
        signal_name: &str,
        lod: crate::services::wave_data::LodLevel,
        time_start: u64,
        time_end: u64,
    ) -> Result<SignalWaveData> {
        let path_str = wave_path.to_string_lossy().to_string();
        let signal_name = signal_name.to_string();
        let lod_level = lod.0;

        tokio::task::spawn_blocking(move || {
            use crate::services::wave_data::LodPyramidGenerator;
            use crate::services::wave_data::LodConfig;
            
            let mut reader = fstapi::Reader::open(&path_str)
                .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;

            // 查找信号
            let mut signal_handle = None;
            let mut signal_width = 1u16;

            for var_result in reader.vars() {
                let (name, var) = var_result
                    .map_err(|e| ServerError::Internal(format!("读取变量失败: {}", e)))?;

                if name == signal_name {
                    signal_handle = Some(var.handle());
                    signal_width = var.length() as u16;
                    break;
                }
            }

            let handle = signal_handle.ok_or_else(|| {
                ServerError::SignalNotFound(signal_name.clone())
            })?;

            // 读取信号波形数据
            let handle_idx: u32 = handle.into();
            let mut signal_data = SignalWaveData::new(handle_idx, signal_width, SignalValueType::Numeric);
            
            // 设置 mask 只读取目标信号
            reader.set_mask(handle);
            
            // 读取完整数据
            let mut full_signal_data = SignalWaveData::new(handle_idx, signal_width, SignalValueType::Numeric);
            reader.for_each_block(|time, h, value, _var_len| {
                if h == handle {
                    let transition = Transition::from_fst(time, value, SignalValueType::Numeric);
                    full_signal_data.add_transition(transition);
                }
            }).map_err(|e| ServerError::Internal(format!("读取完整波形数据失败: {:?}", e)))?;

            // 读取时间范围内的数据
            reader.set_time_range_limit(time_start, time_end);
            reader.for_each_block(|time, h, value, _var_len| {
                if h == handle {
                    let transition = Transition::from_fst(time, value, SignalValueType::Numeric);
                    signal_data.add_transition(transition);
                }
            }).map_err(|e| ServerError::Internal(format!("读取波形数据失败: {:?}", e)))?;

            // 如果时间范围内没有数据，使用完整数据的边界值
            if signal_data.transitions.is_empty() {
                if let Some(boundary_trans) = full_signal_data.value_at(time_start) {
                    signal_data.add_transition(Transition {
                        time: time_start,
                        value: boundary_trans.value.clone(),
                    });
                }
            }

            // 生成 LoD 数据
            let config = LodConfig::default();
            let lod_data = LodPyramidGenerator::new(config).generate_level(&signal_data, lod);

            Ok::<_, ServerError>(lod_data)
        })
        .await
        .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))?
    }
    
    async fn get_file_info(&self, wave_path: &PathBuf) -> Result<FstFileInfo> {
        let path_str = wave_path.to_string_lossy().to_string();
        
        tokio::task::spawn_blocking(move || {
            let mut reader = fstapi::Reader::open(&path_str)
                .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;
            
            // 获取时间范围
            let start_time = reader.start_time();
            let end_time = reader.end_time();
            
            // 统计信号数量
            let mut signal_count = 0;
            for _ in reader.vars() {
                signal_count += 1;
            }
            
            Ok(FstFileInfo {
                start_time,
                end_time,
                signal_count,
            })
        })
        .await
        .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))?
    }
}

/// fst-reader 后端实现
pub struct FstReaderBackend;

#[async_trait::async_trait]
impl FstReader for FstReaderBackend {
    async fn read_signal_data(
        &self,
        wave_path: &PathBuf,
        signal_name: &str,
        lod: crate::services::wave_data::LodLevel,
        time_start: u64,
        time_end: u64,
    ) -> Result<SignalWaveData> {
        use fst_reader::{FstReader, FstHierarchyEntry, FstSignalHandle};
        use std::fs::File;
        use std::io::BufReader;
        
        let path = wave_path.clone();
        let signal_name = signal_name.to_string();
        let lod_level = lod.0;

        tokio::task::spawn_blocking(move || {
            let file = File::open(&path)
                .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;
            let buf_reader = BufReader::new(file);
            let mut reader = FstReader::open(buf_reader)
                .map_err(|e| ServerError::Internal(format!("无法读取 FST 文件: {:?}", e)))?;

            // 查找信号
            let mut target_handle: Option<FstSignalHandle> = None;
            let mut signal_width = 1u32;
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
                        
                        if full_path == signal_name || 
                           signal_name.ends_with(&full_path) ||
                           full_path.ends_with(&signal_name) {
                            target_handle = Some(FstSignalHandle::from_index(handle.get_index()));
                            signal_width = length.to_owned();
                        }
                    }
                    _ => {}
                }
            }).map_err(|e| ServerError::Internal(format!("读取层次结构失败: {:?}", e)))?;

            let handle = target_handle.ok_or_else(|| {
                ServerError::SignalNotFound(signal_name.clone())
            })?;

            // Calculate bucket size and align start
            let bucket_size = if lod_level == 0 { 1 } else { 256u64 << (lod_level - 1) };
            let aligned_start = (time_start / bucket_size) * bucket_size;

            // Use read_pre_start_values to get start value
            let pre_start_filter = fst_reader::FstFilter {
                start: 0,
                end: Some(time_start),
                include: Some(vec![handle.clone()]),
            };
            
            let pre_start_values = reader.read_pre_start_values(&pre_start_filter)
                .map_err(|e| ServerError::Internal(format!("读取 pre-start 值失败: {:?}", e)))?;
            
            // Get start value
            let _start_value = pre_start_values.string_values.iter()
                .find(|v| v.handle == handle)
                .map(|v| String::from_utf8_lossy(&v.value).to_string())
                .or_else(|| {
                    pre_start_values.real_values.iter()
                        .find(|v| v.handle == handle)
                        .map(|v| format!("{}", v.value))
                })
                .unwrap_or_else(|| "X".to_string());

            // Use read_range_boundary_values to get first/last
            let boundary_filter = fst_reader::FstFilter {
                start: aligned_start,
                end: Some(time_end),
                include: Some(vec![handle.clone()]),
            };
            
            let boundary_values = reader.read_range_boundary_values(&boundary_filter)
                .map_err(|e| ServerError::Internal(format!("读取边界值失败: {:?}", e)))?;
            
            // Collect all transitions from boundary values
            let mut all_transitions: Vec<(u64, String)> = Vec::new();
            
            if let Some(first) = &boundary_values.first {
                for val in &first.string_values {
                    if val.handle == handle {
                        all_transitions.push((val.time, String::from_utf8_lossy(&val.value).to_string()));
                    }
                }
            }
            
            if let Some(last) = &boundary_values.last {
                for val in &last.string_values {
                    if val.handle == handle && !all_transitions.iter().any(|(t, _)| *t == val.time) {
                        all_transitions.push((val.time, String::from_utf8_lossy(&val.value).to_string()));
                    }
                }
            }
            
            // Sort transitions by time
            all_transitions.sort_by_key(|(time, _)| *time);

            // Build result SignalWaveData with LoD transitions
            let mut result = SignalWaveData::new(
                handle.get_index() as u32, 
                signal_width as u16, 
                SignalValueType::Numeric
            );

            // Generate LoD transitions using First/Last Bucket algorithm
            let mut current_bucket_idx: Option<usize> = None;
            let mut bucket_first: Option<String> = None;
            let mut bucket_last: Option<String> = None;
            let mut bucket_has_multiple = false;

            for (time, value) in all_transitions.iter() {
                // For LoD 0, use actual time; for LoD 1+, use bucket index
                let (trans_idx, should_output) = if lod_level == 0 {
                    (*time, *time >= aligned_start && *time <= time_end)
                } else {
                    let idx = ((*time - aligned_start) / bucket_size) as usize;
                    (idx as u64, *time >= aligned_start && *time < time_end)
                };

                if !should_output {
                    continue;
                }

                match current_bucket_idx {
                    None => {
                        current_bucket_idx = Some(trans_idx as usize);
                        bucket_first = Some(value.clone());
                        bucket_last = Some(value.clone());
                        bucket_has_multiple = false;
                    }
                    Some(idx) if trans_idx as usize > idx => {
                        // Output current bucket
                        result.add_transition(Transition {
                            time: idx as u64,
                            value: crate::services::wave_data::SignalValue::Numeric(bucket_first.clone().unwrap()),
                        });
                        
                        if bucket_has_multiple {
                            result.add_transition(Transition {
                                time: idx as u64,
                                value: crate::services::wave_data::SignalValue::Numeric(bucket_last.clone().unwrap()),
                            });
                        }

                        // Start new bucket
                        current_bucket_idx = Some(trans_idx as usize);
                        bucket_first = Some(value.clone());
                        bucket_last = Some(value.clone());
                        bucket_has_multiple = false;
                    }
                    Some(_) => {
                        bucket_last = Some(value.clone());
                        bucket_has_multiple = true;
                    }
                }
            }

            // Output last bucket
            if let Some(idx) = current_bucket_idx {
                result.add_transition(Transition {
                    time: idx as u64,
                    value: crate::services::wave_data::SignalValue::Numeric(bucket_first.clone().unwrap()),
                });
                
                if bucket_has_multiple {
                    result.add_transition(Transition {
                        time: idx as u64,
                        value: crate::services::wave_data::SignalValue::Numeric(bucket_last.clone().unwrap()),
                    });
                }
            }

            Ok::<_, ServerError>(result)
        })
        .await
        .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))?
    }
    
    async fn get_file_info(&self, wave_path: &PathBuf) -> Result<FstFileInfo> {
        use fst_reader::{FstReader, FstHierarchyEntry};
        use std::fs::File;
        use std::io::BufReader;
        
        let path = wave_path.clone();
        
        tokio::task::spawn_blocking(move || {
            let file = File::open(&path)
                .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;
            let buf_reader = BufReader::new(file);
            let mut reader = FstReader::open(buf_reader)
                .map_err(|e| ServerError::Internal(format!("无法读取 FST 文件: {:?}", e)))?;
            
            let header = reader.get_header();
            let start_time = header.start_time;
            let end_time = header.end_time;
            
            // 统计信号数量
            let mut signal_count = 0;
            reader.read_hierarchy(|entry| {
                if let FstHierarchyEntry::Var { .. } = entry {
                    signal_count += 1;
                }
            }).ok();
            
            Ok(FstFileInfo {
                start_time,
                end_time,
                signal_count,
            })
        })
        .await
        .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))?
    }
}

/// 创建 FST 后端实例
pub fn create_reader_backend(backend_type: &str) -> Box<dyn FstReader> {
    match backend_type {
        "fst-reader" => Box::new(FstReaderBackend),
        _ => Box::new(FstApiBackend),  // 默认使用 fstapi
    }
}
