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
    /// 值匹配模式（支持通配符 * 和 ?）
    Value {
        /// 通配符模式字符串，* 匹配任意多个字符，? 匹配单个字符
        value: String,
        /// 数值进制，用于将信号值转换为字符串
        #[serde(default = "default_radix")]
        radix: Radix,
    },
    /// 边沿检测模式
    Edge {
        #[serde(rename = "edge_type")]
        edge_type: EdgeType,
    },
    /// 转换模式（支持通配符 * 和 ?）
    Transition {
        /// 起始值通配符模式
        #[serde(rename = "from_value")]
        from_value: String,
        /// 目标值通配符模式
        #[serde(rename = "to_value")]
        to_value: String,
        /// 数值进制
        #[serde(default = "default_radix")]
        radix: Radix,
    },
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
    Decimal,
}

impl Radix {
    /// 将数值转换为固定宽度的字符串（无前缀，补零）
    /// 
    /// # 参数
    /// - `value`: 要转换的数值
    /// - `signal_width`: 信号位宽（用于计算固定宽度）
    /// 
    /// # 返回
    /// 固定宽度的字符串，不区分大小写
    pub fn format_value(&self, value: u64, signal_width: u32) -> String {
        match self {
            Radix::Binary => {
                // 二进制：固定宽度为 signal_width
                format!("{:0width$b}", value, width = signal_width as usize)
            }
            Radix::Hex => {
                // 十六进制：固定宽度为 ceil(signal_width / 4)
                let hex_width = ((signal_width + 3) / 4) as usize;
                format!("{:0width$X}", value, width = hex_width)
            }
            Radix::Octal => {
                // 八进制：固定宽度为 ceil(signal_width / 3)
                let oct_width = ((signal_width + 2) / 3) as usize;
                format!("{:0width$o}", value, width = oct_width)
            }
            Radix::Decimal => {
                // 十进制：根据信号最大值确定宽度
                let max_value = (1u64 << signal_width) - 1;
                let dec_width = max_value.to_string().len();
                format!("{:0width$}", value, width = dec_width)
            }
        }
    }

    /// 将字符串解析为数值（不区分大小写）
    pub fn parse(&self, value: &str) -> Result<u64> {
        let value = value.to_uppercase();
        match self {
            Radix::Binary => u64::from_str_radix(&value, 2)
                .map_err(|e| ServerError::InvalidRequest(format!("Invalid binary value: {}", e))),
            Radix::Hex => u64::from_str_radix(&value, 16)
                .map_err(|e| ServerError::InvalidRequest(format!("Invalid hex value: {}", e))),
            Radix::Octal => u64::from_str_radix(&value, 8)
                .map_err(|e| ServerError::InvalidRequest(format!("Invalid octal value: {}", e))),
            Radix::Decimal => value.parse::<u64>()
                .map_err(|e| ServerError::InvalidRequest(format!("Invalid decimal value: {}", e))),
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

/// 通配符匹配函数
/// 
/// 支持 * 匹配任意多个字符（包括0个），? 匹配单个字符
/// 不区分大小写
/// 
/// # 示例
/// - `wildcard_match("101?", "1010")` → true
/// - `wildcard_match("101?", "1011")` → true
/// - `wildcard_match("1*0", "100")` → true
/// - `wildcard_match("1*0", "10")` → true
/// - `wildcard_match("A?", "a5")` → true（不区分大小写）
pub fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern = pattern.to_uppercase();
    let text = text.to_uppercase();
    let pattern_chars: Vec<char> = pattern.chars().collect();
    let text_chars: Vec<char> = text.chars().collect();
    
    wildcard_match_internal(&pattern_chars, &text_chars, 0, 0)
}

fn wildcard_match_internal(
    pattern: &[char],
    text: &[char],
    p_idx: usize,
    t_idx: usize,
) -> bool {
    // 如果 pattern 和 text 都处理完了，匹配成功
    if p_idx == pattern.len() && t_idx == text.len() {
        return true;
    }
    
    // 如果 pattern 处理完了但 text 还有剩余，匹配失败
    if p_idx == pattern.len() {
        return false;
    }
    
    // 如果 text 处理完了但 pattern 还有剩余
    if t_idx == text.len() {
        // 只有当 pattern 剩余的都是 * 时才匹配成功
        return pattern[p_idx..].iter().all(|&c| c == '*');
    }
    
    match pattern[p_idx] {
        '*' => {
            // * 可以匹配0个或多个字符
            // 尝试匹配0个字符（跳过 *）或匹配1个字符（跳过 text 的当前字符）
            wildcard_match_internal(pattern, text, p_idx + 1, t_idx) ||
            wildcard_match_internal(pattern, text, p_idx, t_idx + 1)
        }
        '?' => {
            // ? 匹配任意单个字符
            wildcard_match_internal(pattern, text, p_idx + 1, t_idx + 1)
        }
        c => {
            // 普通字符必须精确匹配
            if c == text[t_idx] {
                wildcard_match_internal(pattern, text, p_idx + 1, t_idx + 1)
            } else {
                false
            }
        }
    }
}

/// 检查值是否匹配模式
/// 
/// # 参数
/// - `pattern`: 匹配模式
/// - `value`: 当前信号值（字符串形式，如 "1010" 或 "A5"）
/// - `prev_value`: 前一个信号值（用于 Edge 和 Transition 模式）
/// - `signal_width`: 信号位宽（用于格式化）
pub fn value_matches(
    pattern: &PatternType,
    value: &str,
    prev_value: Option<&str>,
    signal_width: u32,
) -> bool {
    match pattern {
        PatternType::Value { value: pattern_str, radix } => {
            // 将当前值解析并格式化为指定进制的字符串
            let value_u64 = match parse_value_string(value) {
                Ok(v) => v,
                Err(_) => return false,
            };
            let formatted_value = radix.format_value(value_u64, signal_width);
            
            // 使用通配符匹配
            wildcard_match(pattern_str, &formatted_value)
        }
        
        PatternType::Edge { edge_type } => {
            // 需要前一个值才能判断边沿
            if let Some(prev) = prev_value {
                let prev_val = parse_value_string(prev).unwrap_or(0);
                let curr_val = parse_value_string(value).unwrap_or(0);
                
                // 对于多bit信号，检查是否有任意位发生变化
                match edge_type {
                    EdgeType::Rising => {
                        // 检查是否有位从 0 变为 1
                        (prev_val ^ curr_val) & curr_val != 0
                    }
                    EdgeType::Falling => {
                        // 检查是否有位从 1 变为 0
                        (prev_val ^ curr_val) & prev_val != 0
                    }
                    EdgeType::Any => prev_val != curr_val,
                }
            } else {
                false
            }
        }
        
        PatternType::Transition { from_value, to_value, radix } => {
            // 需要前一个值
            if let Some(prev) = prev_value {
                let prev_val = match parse_value_string(prev) {
                    Ok(v) => v,
                    Err(_) => return false,
                };
                let curr_val = match parse_value_string(value) {
                    Ok(v) => v,
                    Err(_) => return false,
                };
                
                // 格式化前值和当前值
                let formatted_prev = radix.format_value(prev_val, signal_width);
                let formatted_curr = radix.format_value(curr_val, signal_width);
                
                // 使用通配符匹配 from_value 和 to_value
                wildcard_match(from_value, &formatted_prev) &&
                wildcard_match(to_value, &formatted_curr)
            } else {
                false
            }
        }
    }
}

/// 解析信号值字符串（支持二进制、十六进制、八进制、十进制）
fn parse_value_string(value: &str) -> Result<u64> {
    let value = value.trim();
    
    // 尝试不同的进制
    if value.starts_with("0b") || value.starts_with("0B") {
        // 二进制
        u64::from_str_radix(&value[2..], 2)
            .map_err(|e| ServerError::InvalidRequest(format!("Invalid binary value: {}", e)))
    } else if value.starts_with("0x") || value.starts_with("0X") {
        // 十六进制
        u64::from_str_radix(&value[2..], 16)
            .map_err(|e| ServerError::InvalidRequest(format!("Invalid hex value: {}", e)))
    } else if value.starts_with("0o") || value.starts_with("0O") {
        // 八进制
        u64::from_str_radix(&value[2..], 8)
            .map_err(|e| ServerError::InvalidRequest(format!("Invalid octal value: {}", e)))
    } else {
        // 尝试十进制
        value.parse::<u64>()
            .map_err(|e| ServerError::InvalidRequest(format!("Invalid decimal value: {}", e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wildcard_match() {
        // 基本匹配
        assert!(wildcard_match("1010", "1010"));
        assert!(!wildcard_match("1010", "1011"));
        
        // ? 匹配单个字符
        assert!(wildcard_match("101?", "1010"));
        assert!(wildcard_match("101?", "1011"));
        assert!(!wildcard_match("101?", "101"));
        assert!(!wildcard_match("101?", "10101"));
        
        // * 匹配任意多个字符
        assert!(wildcard_match("1*0", "10"));
        assert!(wildcard_match("1*0", "100"));
        assert!(wildcard_match("1*0", "1010"));
        assert!(!wildcard_match("1*0", "11"));
        
        // 不区分大小写
        assert!(wildcard_match("A?", "a5"));
        assert!(wildcard_match("a?", "A5"));
        
        // 复杂模式
        assert!(wildcard_match("1*?0", "1010"));
        assert!(wildcard_match("1*?0", "10010"));
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("???", "abc"));
    }

    #[test]
    fn test_radix_format_binary() {
        let radix = Radix::Binary;
        assert_eq!(radix.format_value(0b1010, 8), "00001010");
        assert_eq!(radix.format_value(0b1111, 4), "1111");
        assert_eq!(radix.format_value(0, 8), "00000000");
    }

    #[test]
    fn test_radix_format_hex() {
        let radix = Radix::Hex;
        assert_eq!(radix.format_value(0xA5, 8), "A5");
        assert_eq!(radix.format_value(0x0A, 8), "0A");
        assert_eq!(radix.format_value(0x1A5, 16), "01A5");
    }

    #[test]
    fn test_value_matches_with_wildcard() {
        let pattern = PatternType::Value {
            value: "1010????".to_string(),
            radix: Radix::Binary,
        };
        
        // 8bit 信号，匹配高4位是 1010 的值
        assert!(value_matches(&pattern, "160", None, 8)); // 160 = 0b10100000
        assert!(value_matches(&pattern, "175", None, 8)); // 175 = 0b10101111
        assert!(!value_matches(&pattern, "127", None, 8)); // 127 = 0b01111111
    }

    #[test]
    fn test_transition_with_wildcard() {
        let pattern = PatternType::Transition {
            from_value: "0*".to_string(),
            to_value: "1*".to_string(),
            radix: Radix::Hex,
        };
        
        // 8bit 信号，从 0x 开头转换到 1x 开头
        assert!(value_matches(&pattern, "16", Some("05"), 8)); // 0x05 -> 0x16
        assert!(!value_matches(&pattern, "05", Some("16"), 8)); // 0x16 -> 0x05
    }
}
