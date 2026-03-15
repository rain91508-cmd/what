//! fst-reader 后端的 Pattern Search 实现

use crate::error::{Result, ServerError};
use crate::services::pattern_search::{
    Match, PatternSearchRequest, PatternSearchResponse, PatternType, SearchDirection,
    value_matches, format_fst_value, get_pattern_radix, Radix,
};
use crate::services::fst_reader_cache::FstReaderCache;
use fst_reader::{FstFilter, FstReader, FstSignalHandle, FstHierarchyEntry, FstSignalValue};
use std::collections::HashMap;
use std::io::BufReader;
use std::fs::File;
use std::path::PathBuf;

/// 信号信息
#[derive(Debug, Clone)]
struct SignalInfo {
    name: String,
    handle: FstSignalHandle,
    width: u32,
}

/// 使用 fst-reader 进行 pattern search
pub async fn pattern_search_fst_reader(
    cache: &FstReaderCache,
    wave_path: &PathBuf,
    signal_names: &[String],
    request: &PatternSearchRequest,
    waveform_name: String,
) -> Result<PatternSearchResponse> {
    let path = wave_path.clone();
    let signals = signal_names.to_vec();
    let req = request.clone();
    let path_str = path.to_string_lossy().to_string();
    let reader_arc = cache.get_or_create(&path_str).await?;
    
    tokio::task::spawn_blocking(move || {
        let rt = tokio::runtime::Handle::current();
        let mut reader = rt.block_on(reader_arc.lock());
        
        // 查找信号
        let signal_infos = find_signals(&mut *reader, &signals)?;
        
        if signal_infos.is_empty() {
            return Err(ServerError::SignalNotFound(signals.join(", ")));
        }
        
        // 获取第一个信号的宽度用于 Value 和 Transition 模式
        let signal_width = signal_infos[0].width;
        
        let handles: Vec<FstSignalHandle> = signal_infos.iter()
            .map(|info| info.handle.clone())
            .collect();
        
        // 获取时间范围
        let start_time = req.time_range.as_ref().and_then(|r| r.start).unwrap_or(0);
        let end_time = req.time_range.as_ref().and_then(|r| r.end)
            .unwrap_or(u64::MAX);
        
        // 根据搜索方向确定实际搜索范围
        let (search_start, search_end) = match req.direction {
            SearchDirection::Forward => {
                (req.start_time, end_time)
            }
            SearchDirection::Backward => {
                (start_time, req.start_time)
            }
        };
        
        // 读取信号数据
        let mut matches: Vec<Match> = Vec::new();
        let mut prev_values: HashMap<String, String> = HashMap::new();
        let mut current_values: HashMap<String, String> = HashMap::new();
        
        // 先读取 start_time 之前的值作为初始值
        if req.start_time > 0 {
            let pre_start_filter = FstFilter {
                start: 0,
                end: Some(req.start_time),
                include: Some(handles.clone()),
            };
            
            if let Ok(pre_start_values) = reader.read_pre_start_values(&pre_start_filter) {
                for value in &pre_start_values.string_values {
                    for info in &signal_infos {
                        if info.handle == value.handle {
                            let val_str = String::from_utf8_lossy(&value.value).to_string();
                            prev_values.insert(info.name.clone(), val_str.clone());
                            current_values.insert(info.name.clone(), val_str);
                            break;
                        }
                    }
                }
            }
        }
        
        // 读取时间范围内的 transitions
        let mut all_events: Vec<(u64, String, String)> = Vec::new();
        
        let filter = FstFilter {
            start: search_start,
            end: Some(search_end),
            include: Some(handles.clone()),
        };
        
        reader.read_signals_in_range(&filter, |time, handle, value| {
            for info in &signal_infos {
                if info.handle == handle {
                    let val_str = match value {
                        FstSignalValue::String(b) => String::from_utf8_lossy(b).to_string(),
                        FstSignalValue::Real(v) => format!("{}", v),
                    };
                    all_events.push((time, info.name.clone(), val_str));
                    break;
                }
            }
        }).map_err(|e| ServerError::Internal(format!("读取信号数据失败: {}", e)))?;
        
        // 按时间排序
        all_events.sort_by_key(|(time, _, _)| *time);
        
        // 根据方向处理
        match req.direction {
            SearchDirection::Forward => {
                for (time, signal_name, value) in all_events {
                    if time < req.start_time {
                        prev_values.insert(signal_name.clone(), value.clone());
                        current_values.insert(signal_name.clone(), value);
                        continue;
                    }
                    
                    let prev = prev_values.get(&signal_name);
                    if value_matches(&req.pattern, &value, prev.map(|v| v.as_str()), signal_width) {
                        current_values.insert(signal_name.clone(), value.clone());
                        
                        let mut match_values = HashMap::new();
                        let mut all_match = true;
                        
                        for info in &signal_infos {
                            let val = current_values.get(&info.name).cloned()
                                .unwrap_or_else(|| "0".to_string());
                            match_values.insert(info.name.clone(), val);
                            
                            if matches!(req.pattern, PatternType::Value { .. }) {
                                let signal_prev = prev_values.get(&info.name).map(|v| v.as_str());
                                if !value_matches(&req.pattern, &match_values[&info.name], signal_prev, info.width) {
                                    all_match = false;
                                }
                            }
                        }
                        
                        if all_match || signal_infos.len() == 1 {
                            matches.push(Match {
                                time,
                                signal_values: match_values,
                            });
                            
                            if matches.len() >= req.max_results {
                                break;
                            }
                        }
                    }
                    
                    prev_values.insert(signal_name, value);
                }
            }
            
            SearchDirection::Backward => {
                all_events.reverse();
                
                for (time, signal_name, value) in all_events {
                    if time > req.start_time {
                        continue;
                    }
                    
                    let prev = prev_values.get(&signal_name);
                    if value_matches(&req.pattern, &value, prev.map(|v| v.as_str()), signal_width) {
                        current_values.insert(signal_name.clone(), value.clone());
                        
                        let mut match_values = HashMap::new();
                        let mut all_match = true;
                        
                        for info in &signal_infos {
                            let val = current_values.get(&info.name).cloned()
                                .unwrap_or_else(|| "0".to_string());
                            match_values.insert(info.name.clone(), val);
                            
                            if matches!(req.pattern, PatternType::Value { .. }) {
                                let signal_prev = prev_values.get(&info.name).map(|v| v.as_str());
                                if !value_matches(&req.pattern, &match_values[&info.name], signal_prev, info.width) {
                                    all_match = false;
                                }
                            }
                        }
                        
                        if all_match || signal_infos.len() == 1 {
                            matches.push(Match {
                                time,
                                signal_values: match_values,
                            });
                            
                            if matches.len() >= req.max_results {
                                break;
                            }
                        }
                    }
                    
                    prev_values.insert(signal_name, value);
                }
                
                matches.reverse();
            }
        }
        
        let search_completed = matches.len() < req.max_results;
        
        // 格式化所有匹配结果中的信号值
        let radix = get_pattern_radix(&req.pattern);
        let signal_info_map: HashMap<_, _> = signal_infos.iter()
            .map(|info| (info.name.clone(), info.width))
            .collect();
        
        let formatted_matches: Result<Vec<_>> = matches.into_iter()
            .map(|mut m| {
                let mut formatted_signal_values = HashMap::new();
                for (name, raw_value) in m.signal_values {
                    let width = signal_info_map.get(&name).copied().unwrap_or(1);
                    let formatted_value = format_fst_value(&raw_value, radix, width)?;
                    formatted_signal_values.insert(name, formatted_value);
                }
                Ok(Match {
                    time: m.time,
                    signal_values: formatted_signal_values,
                })
            })
            .collect();
        
        let formatted_matches = formatted_matches?;
        
        Ok(PatternSearchResponse {
            waveform: waveform_name,
            signals: signal_infos.iter().map(|info| info.name.clone()).collect(),
            pattern: req.pattern.clone(),
            direction: req.direction,
            total_matches: formatted_matches.len(),
            matches: formatted_matches,
            search_completed,
        })
    }).await.map_err(|e| ServerError::Internal(format!("Task failed: {}", e)))?
}

/// 查找信号
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
    }).map_err(|e| ServerError::Internal(format!("读取层次结构失败: {}", e)))?;

    Ok(signal_infos)
}
