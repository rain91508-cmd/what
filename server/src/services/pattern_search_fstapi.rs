//! fstapi 后端的 Pattern Search 实现

use crate::error::{Result, ServerError};
use crate::services::pattern_search::{
    Match, PatternSearchRequest, PatternSearchResponse, PatternType, SearchDirection,
    value_matches,
};
use std::collections::HashMap;
use std::path::PathBuf;

/// 使用 fstapi 进行 pattern search
pub async fn pattern_search_fstapi(
    wave_path: &PathBuf,
    signal_names: &[String],
    request: &PatternSearchRequest,
    waveform_name: String,
) -> Result<PatternSearchResponse> {
    let path = wave_path.clone();
    let signals = signal_names.to_vec();
    let req = request.clone();
    
    tokio::task::spawn_blocking(move || {
        let mut reader = fstapi::Reader::open(&path.to_string_lossy())
            .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;
        
        // 查找信号
        let mut signal_handles: Vec<(String, fstapi::Handle)> = Vec::new();
        
        for var_result in reader.vars() {
            let (name, var) = var_result
                .map_err(|e| ServerError::Internal(format!("读取变量失败: {}", e)))?;
            
            if signals.contains(&name) {
                signal_handles.push((name, var.handle()));
            }
        }
        
        if signal_handles.is_empty() {
            return Err(ServerError::SignalNotFound(signals.join(", ")));
        }
        
        // 设置信号 mask
        for (_, handle) in &signal_handles {
            reader.set_mask(*handle);
        }
        
        // 获取时间范围
        let start_time = req.time_range.as_ref().and_then(|r| r.start).unwrap_or(0);
        let end_time = req.time_range.as_ref().and_then(|r| r.end)
            .unwrap_or(reader.end_time());
        
        // 根据搜索方向确定时间范围
        let (search_start, search_end) = match req.direction {
            SearchDirection::Forward => {
                (req.start_time, end_time)
            }
            SearchDirection::Backward => {
                (start_time, req.start_time)
            }
        };
        
        // 设置时间范围
        reader.set_time_range_limit(search_start, search_end);
        
        // 收集所有 transitions
        let mut all_transitions: Vec<(u64, String, String)> = Vec::new(); // (time, signal_name, value)
        let mut prev_values: HashMap<String, String> = HashMap::new();
        let mut current_values: HashMap<String, String> = HashMap::new();
        
        // 先读取 start_time 之前的值作为初始值
        if req.start_time > 0 {
            let mut pre_reader = fstapi::Reader::open(&path.to_string_lossy())
                .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;
            
            for (_, handle) in &signal_handles {
                pre_reader.set_mask(*handle);
            }
            
            pre_reader.set_time_range_limit(0, req.start_time);
            
            let mut temp_values: HashMap<String, String> = HashMap::new();
            
            pre_reader.for_each_block(|time, h, value, _var_len| {
                for (name, handle) in &signal_handles {
                    if h == *handle {
                        temp_values.insert(name.clone(), value.to_string());
                        break;
                    }
                }
            }).ok();
            
            prev_values = temp_values.clone();
            current_values = temp_values;
        }
        
        // 读取搜索范围内的 transitions
        reader.for_each_block(|time, h, value, _var_len| {
            for (name, handle) in &signal_handles {
                if h == *handle {
                    all_transitions.push((time, name.clone(), value.to_string()));
                    break;
                }
            }
        }).map_err(|e| ServerError::Internal(format!("读取波形数据失败: {}", e)))?;
        
        // 按时间排序
        all_transitions.sort_by_key(|(time, _, _)| *time);
        
        // 搜索匹配
        let mut matches: Vec<Match> = Vec::new();
        
        match req.direction {
            SearchDirection::Forward => {
                // 向前搜索
                for (time, signal_name, value) in all_transitions {
                    if time < req.start_time {
                        prev_values.insert(signal_name.clone(), value.clone());
                        current_values.insert(signal_name.clone(), value);
                        continue;
                    }
                    
                    // 检查是否匹配
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
            }
            
            SearchDirection::Backward => {
                // 向后搜索
                all_transitions.reverse();
                
                for (time, signal_name, value) in all_transitions {
                    if time > req.start_time {
                        continue;
                    }
                    
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
