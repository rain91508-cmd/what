//! fst-reader 后端的 Pattern Search 实现

use crate::error::{Result, ServerError};
use crate::services::pattern_search::{
    Match, PatternSearchRequest, PatternSearchResponse, PatternType, SearchDirection,
    value_matches,
};
use fst_reader::{FstFilter, FstReader, FstSignalHandle};
use std::collections::HashMap;
use std::path::PathBuf;

/// 使用 fst-reader 进行 pattern search
pub async fn pattern_search_fst_reader(
    wave_path: &PathBuf,
    signal_names: &[String],
    request: &PatternSearchRequest,
    waveform_name: String,
) -> Result<PatternSearchResponse> {
    let path = wave_path.clone();
    let signals = signal_names.to_vec();
    let req = request.clone();
    
    tokio::task::spawn_blocking(move || {
        let mut reader = FstReader::open(&path)
            .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;
        
        // 查找信号 handles
        let mut signal_handles: Vec<(String, FstSignalHandle)> = Vec::new();
        let hierarchy = reader.hierarchy();
        
        for entry in hierarchy.entries() {
            if let fst_reader::FstHierarchyEntry::Var(var) = entry {
                if signals.contains(&var.name) {
                    signal_handles.push((var.name.clone(), var.handle));
                }
            }
        }
        
        if signal_handles.is_empty() {
            return Err(ServerError::SignalNotFound(signals.join(", ")));
        }
        
        // 获取时间范围
        let header = reader.header();
        let start_time = req.time_range.as_ref().and_then(|r| r.start).unwrap_or(0);
        let end_time = req.time_range.as_ref().and_then(|r| r.end)
            .unwrap_or(header.end_time);
        
        // 根据搜索方向确定实际搜索范围
        let (search_start, search_end) = match req.direction {
            SearchDirection::Forward => {
                (req.start_time, end_time)
            }
            SearchDirection::Backward => {
                (start_time, req.start_time)
            }
        };
        
        // 创建信号 mask
        let mut filter_signals = fst_reader::BitMask::new(header.max_handle as usize);
        for (_, handle) in &signal_handles {
            let idx = handle.get_index();
            if idx < header.max_handle as usize {
                filter_signals.set(idx, true);
            }
        }
        
        let filter = FstFilter {
            start_time: search_start,
            end_time: search_end,
            signals: filter_signals,
        };
        
        // 读取信号数据
        let mut matches: Vec<Match> = Vec::new();
        let mut prev_values: HashMap<String, String> = HashMap::new();
        let mut current_values: HashMap<String, String> = HashMap::new();
        
        // 先读取 start_time 之前的值作为初始值
        let pre_start_filter = FstFilter {
            start_time: 0,
            end_time: req.start_time,
            signals: filter.signals.clone(),
        };
        
        if let Ok(pre_start_values) = reader.read_pre_start_values(&pre_start_filter) {
            for (idx, value) in pre_start_values.iter() {
                for (name, handle) in &signal_handles {
                    if handle.get_index() == *idx {
                        prev_values.insert(name.clone(), value.to_string());
                        current_values.insert(name.clone(), value.to_string());
                        break;
                    }
                }
            }
        }
        
        // 读取时间范围内的 transitions
        let mut signal_data: HashMap<String, Vec<(u64, String)>> = HashMap::new();
        
        reader.read_signals_in_range(&filter, &mut |time, handle, value| {
            let idx = handle.get_index();
            for (name, h) in &signal_handles {
                if h.get_index() == idx {
                    signal_data.entry(name.clone())
                        .or_insert_with(Vec::new)
                        .push((time, value.to_string()));
                    break;
                }
            }
        }).map_err(|e| ServerError::Internal(format!("读取信号数据失败: {}", e)))?;
        
        // 根据搜索方向处理数据
        let mut all_events: Vec<(u64, String, String)> = Vec::new(); // (time, signal_name, value)
        
        for (name, transitions) in &signal_data {
            for (time, value) in transitions {
                all_events.push((*time, name.clone(), value.clone()));
            }
        }
        
        // 按时间排序
        all_events.sort_by_key(|(time, _, _)| *time);
        
        // 根据方向处理
        match req.direction {
            SearchDirection::Forward => {
                // 向前搜索：从 start_time 开始往后找
                for (time, signal_name, value) in all_events {
                    if time < req.start_time {
                        // 更新 prev_values
                        prev_values.insert(signal_name.clone(), value.clone());
                        current_values.insert(signal_name.clone(), value);
                        continue;
                    }
                    
                    // 检查是否匹配模式
                    let prev = prev_values.get(&signal_name);
                    if value_matches(&req.pattern, &value, prev.map(|v| v.as_str())) {
                        // 更新当前值
                        current_values.insert(signal_name.clone(), value.clone());
                        
                        // 检查所有信号是否都满足条件（对于多信号搜索）
                        let mut match_values = HashMap::new();
                        let mut all_match = true;
                        
                        for (name, _) in &signal_handles {
                            let val = current_values.get(name).cloned()
                                .unwrap_or_else(|| "0".to_string());
                            match_values.insert(name.clone(), val);
                            
                            // 对于 Value 模式，检查每个信号是否都匹配
                            if matches!(req.pattern, PatternType::Value { .. }) {
                                let signal_prev = prev_values.get(name).map(|v| v.as_str());
                                if !value_matches(&req.pattern, &match_values[name], signal_prev) {
                                    all_match = false;
                                }
                            }
                        }
                        
                        if all_match || signal_handles.len() == 1 {
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
                // 向后搜索：从 start_time 开始往前找
                all_events.reverse(); // 反向遍历
                
                for (time, signal_name, value) in all_events {
                    if time > req.start_time {
                        continue;
                    }
                    
                    // 检查是否匹配模式
                    let prev = prev_values.get(&signal_name);
                    if value_matches(&req.pattern, &value, prev.map(|v| v.as_str())) {
                        current_values.insert(signal_name.clone(), value.clone());
                        
                        let mut match_values = HashMap::new();
                        let mut all_match = true;
                        
                        for (name, _) in &signal_handles {
                            let val = current_values.get(name).cloned()
                                .unwrap_or_else(|| "0".to_string());
                            match_values.insert(name.clone(), val);
                            
                            if matches!(req.pattern, PatternType::Value { .. }) {
                                let signal_prev = prev_values.get(name).map(|v| v.as_str());
                                if !value_matches(&req.pattern, &match_values[name], signal_prev) {
                                    all_match = false;
                                }
                            }
                        }
                        
                        if all_match || signal_handles.len() == 1 {
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
                
                // 恢复正序
                matches.reverse();
            }
        }
        
        let search_completed = matches.len() < req.max_results;
        
        Ok(PatternSearchResponse {
            waveform: waveform_name,
            signals: signal_handles.iter().map(|(n, _)| n.clone()).collect(),
            pattern: req.pattern.clone(),
            direction: req.direction,
            total_matches: matches.len(),
            matches,
            search_completed,
        })
    }).await.map_err(|e| ServerError::Internal(format!("Task failed: {}", e)))?
}
