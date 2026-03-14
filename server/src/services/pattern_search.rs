//! Pattern Search 功能实现
//!
//! 支持两种后端：fst-reader 和 fstapi

use crate::error::{Result, ServerError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 搜索方向
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchDirection {
    Forward,  // 向后搜索（时间增加方向）
    Backward, // 向前搜索（时间减少方向）
}

/// 模式类型
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PatternType {
    /// 值匹配模式
    Value {
        value: String,
        #[serde(default = "default_mask")]
        mask: String,
        #[serde(default = "default_radix")]
        radix: Radix,
    },
    /// 边沿检测模式
    Edge {
        #[serde(rename = "edge_type")]
        edge_type: EdgeType,
    },
    /// 转换模式
    Transition {
        #[serde(rename = "from_value")]
        from_value: String,
        #[serde(rename = "to_value")]
        to_value: String,
        #[serde(default = "default_radix")]
        radix: Radix,
    },
}

fn default_mask() -> String {
    "F".to_string()
}

fn default_radix() -> Radix {
    Radix::Binary
}

/// 数值进制
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Radix {
    Binary,
    Hex,
    Octal,
}

impl Radix {
    /// 将字符串解析为数值
    pub fn parse(&self, value: &str) -> Result<u64> {
        match self {
            Radix::Binary => u64::from_str_radix(value, 2)
                .map_err(|e| ServerError::InvalidRequest(format!("Invalid binary value: {}", e))),
            Radix::Hex => u64::from_str_radix(value, 16)
                .map_err(|e| ServerError::InvalidRequest(format!("Invalid hex value: {}", e))),
            Radix::Octal => u64::from_str_radix(value, 8)
                .map_err(|e| ServerError::InvalidRequest(format!("Invalid octal value: {}", e))),
        }
    }
}

/// 边沿类型
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeType {
    Rising,  // 上升沿
    Falling, // 下降沿
    Any,     // 任意边沿
}

/// Pattern Search 请求
#[derive(Debug, Clone, Deserialize)]
pub struct PatternSearchRequest {
    pub start_time: u64,
    pub direction: SearchDirection,
    pub pattern: PatternType,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
    #[serde(default)]
    pub time_range: Option<TimeRange>,
}

fn default_max_results() -> usize {
    1
}

/// 时间范围
#[derive(Debug, Clone, Deserialize)]
pub struct TimeRange {
    #[serde(default)]
    pub start: Option<u64>,
    #[serde(default)]
    pub end: Option<u64>,
}

/// 匹配结果
#[derive(Debug, Clone, Serialize)]
pub struct Match {
    pub time: u64,
    pub signal_values: HashMap<String, String>,
}

/// Pattern Search 响应
#[derive(Debug, Clone, Serialize)]
pub struct PatternSearchResponse {
    pub waveform: String,
    pub signals: Vec<String>,
    pub pattern: PatternType,
    pub direction: SearchDirection,
    pub matches: Vec<Match>,
    pub total_matches: usize,
    pub search_completed: bool,
}

/// 检查值是否匹配模式
pub fn value_matches(pattern: &PatternType, value: &str, prev_value: Option<&str>) -> bool {
    match pattern {
        PatternType::Value { value: target, mask, radix } => {
            // 解析目标值和掩码
            let target_val = match radix.parse(target) {
                Ok(v) => v,
                Err(_) => return false,
            };
            
            let mask_val = match radix.parse(mask) {
                Ok(v) => v,
                Err(_) => u64::MAX, // 默认全匹配
            };
            
            // 解析当前值
            let current_val = match radix.parse(value) {
                Ok(v) => v,
                Err(_) => return false,
            };
            
            // 应用掩码后比较
            (current_val & mask_val) == (target_val & mask_val)
        }
        
        PatternType::Edge { edge_type } => {
            // 需要前一个值才能判断边沿
            if let Some(prev) = prev_value {
                let prev_val = prev.parse::<u64>().unwrap_or(0);
                let curr_val = value.parse::<u64>().unwrap_or(0);
                
                match edge_type {
                    EdgeType::Rising => prev_val == 0 && curr_val == 1,
                    EdgeType::Falling => prev_val == 1 && curr_val == 0,
                    EdgeType::Any => prev_val != curr_val,
                }
            } else {
                false
            }
        }
        
        PatternType::Transition { from_value, to_value, radix } => {
            // 需要前一个值
            if let Some(prev) = prev_value {
                let from_val = match radix.parse(from_value) {
                    Ok(v) => v,
                    Err(_) => return false,
                };
                
                let to_val = match radix.parse(to_value) {
                    Ok(v) => v,
                    Err(_) => return false,
                };
                
                let prev_val = match radix.parse(prev) {
                    Ok(v) => v,
                    Err(_) => return false,
                };
                
                let curr_val = match radix.parse(value) {
                    Ok(v) => v,
                    Err(_) => return false,
                };
                
                prev_val == from_val && curr_val == to_val
            } else {
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_value_matches_binary() {
        let pattern = PatternType::Value {
            value: "1010".to_string(),
            mask: "F".to_string(),
            radix: Radix::Binary,
        };
        
        assert!(value_matches(&pattern, "1010", None));
        assert!(!value_matches(&pattern, "1011", None));
    }

    #[test]
    fn test_value_matches_hex() {
        let pattern = PatternType::Value {
            value: "A5".to_string(),
            mask: "FF".to_string(),
            radix: Radix::Hex,
        };
        
        assert!(value_matches(&pattern, "A5", None));
        assert!(!value_matches(&pattern, "A6", None));
    }

    #[test]
    fn test_edge_rising() {
        let pattern = PatternType::Edge {
            edge_type: EdgeType::Rising,
        };
        
        assert!(value_matches(&pattern, "1", Some("0")));
        assert!(!value_matches(&pattern, "1", Some("1")));
        assert!(!value_matches(&pattern, "1", None));
    }

    #[test]
    fn test_transition() {
        let pattern = PatternType::Transition {
            from_value: "0".to_string(),
            to_value: "1".to_string(),
            radix: Radix::Binary,
        };
        
        assert!(value_matches(&pattern, "1", Some("0")));
        assert!(!value_matches(&pattern, "1", Some("1")));
    }
}
