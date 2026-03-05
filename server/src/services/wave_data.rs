//! 波形数据处理和 LoD (Level of Detail) 生成模块
//!
//! 本模块实现了基于 min/max bucket 算法的 LOD 金字塔生成，
//! 以及 chunk 化的波形数据存储和传输格式。
//!
//! # 数据格式说明
//!
//! ## Transition 值存储
//!
//! 值使用 `Vec<u8>` 存储，支持任意位宽：
//! - **数值信号** (wire/reg/logic)：紧凑的二进制字节，MSB在前
//!   - 例如：32位值 0xDEADBEEF → `[0xDE, 0xAD, 0xBE, 0xEF]`
//!   - 例如：4位值 "1010" → `[0x0A]`
//! - **字符串信号** (string)：null-terminated ASCII
//!   - 例如："Hello" → `[0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x00]`
//!
//! ## Chunk 二进制格式
//!
//! 服务器返回的波形数据是自定义二进制格式：
//!
//! ```
//! +------------------+
//! |   ChunkHeader    | 32 bytes
//! |   (文件头)       |
//! +------------------+
//! | SignalBlockHeader| 17 bytes × 信号数
//! |   (信号块表)     |
//! +------------------+
//! | Compressed Data  |
//! |   (压缩数据区)   |
//! +------------------+
//! ```
//!
//! 详见 API.md 文档。

use crate::error::{Result, ServerError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;

/// 四态逻辑值（Verilog 四态逻辑）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogicState {
    /// 逻辑 0
    Zero = 0,
    /// 逻辑 1
    One = 1,
    /// 未知 X
    X = 2,
    /// 高阻 Z
    Z = 3,
}

impl LogicState {
    /// 从字符解析四态值
    pub fn from_char(c: char) -> Option<Self> {
        match c {
            '0' => Some(Self::Zero),
            '1' => Some(Self::One),
            'x' | 'X' => Some(Self::X),
            'z' | 'Z' => Some(Self::Z),
            _ => None,
        }
    }

    /// 转换为字符
    pub fn to_char(self) -> char {
        match self {
            Self::Zero => '0',
            Self::One => '1',
            Self::X => 'X',
            Self::Z => 'Z',
        }
    }
}

/// 四态逻辑值（支持任意位宽）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FourStateValue {
    /// 每 2bit 表示一个逻辑状态
    /// 00=0, 01=1, 10=X, 11=Z
    pub data: Vec<u8>,
    /// 位宽
    pub width: u16,
}

impl FourStateValue {
    /// 创建新的四态值
    pub fn new(width: u16) -> Self {
        let bytes = ((width as usize * 2 + 7) / 8).max(1);
        Self {
            data: vec![0u8; bytes],
            width,
        }
    }

    /// 从二进制字符串创建（支持 X/Z）
    /// 
    /// # Examples
    /// ```
    /// let v = FourStateValue::from_string("10X1");
    /// // bit 3: 1, bit 2: 0, bit 1: X, bit 0: 1
    /// ```
    pub fn from_string(s: &str) -> Self {
        let s = s.trim().trim_start_matches('b');
        let width = s.len() as u16;
        let mut value = Self::new(width);

        for (i, c) in s.chars().enumerate() {
            if let Some(state) = LogicState::from_char(c) {
                let bit_pos = (width as usize).saturating_sub(1 + i);
                value.set_bit(bit_pos, state);
            }
        }

        value
    }

    /// 设置指定位的值
    pub fn set_bit(&mut self, bit: usize, state: LogicState) {
        if bit >= self.width as usize {
            return;
        }

        let byte_idx = bit / 4;
        let bit_idx = (bit % 4) * 2;

        if byte_idx < self.data.len() {
            // 清除原来的 2bit
            self.data[byte_idx] &= !(0b11 << bit_idx);
            // 设置新的 2bit
            self.data[byte_idx] |= (state as u8) << bit_idx;
        }
    }

    /// 获取指定位的值
    pub fn get_bit(&self, bit: usize) -> LogicState {
        if bit >= self.width as usize {
            return LogicState::X;
        }

        let byte_idx = bit / 4;
        let bit_idx = (bit % 4) * 2;

        if byte_idx < self.data.len() {
            let state_val = (self.data[byte_idx] >> bit_idx) & 0b11;
            match state_val {
                0 => LogicState::Zero,
                1 => LogicState::One,
                2 => LogicState::X,
                3 => LogicState::Z,
                _ => LogicState::X,
            }
        } else {
            LogicState::X
        }
    }

    /// 转换为字符串表示
    pub fn to_string(&self) -> String {
        let mut result = String::with_capacity(self.width as usize);
        for i in (0..self.width as usize).rev() {
            result.push(self.get_bit(i).to_char());
        }
        result
    }

    /// 检查是否包含 X 或 Z
    pub fn has_xz(&self) -> bool {
        for i in 0..self.width as usize {
            match self.get_bit(i) {
                LogicState::X | LogicState::Z => return true,
                _ => continue,
            }
        }
        false
    }
}

/// 四态 min 计算
/// 
/// 规则：
/// - 0 vs 1: min=0, max=1
/// - 任何值 vs X: 结果=X
/// - 任何值 vs Z: 结果=Z
pub fn four_state_min(a: &FourStateValue, b: &FourStateValue) -> FourStateValue {
    let width = a.width.max(b.width);
    let mut result = FourStateValue::new(width);

    for i in 0..width as usize {
        let bit_a = if i < a.width as usize { a.get_bit(i) } else { LogicState::Zero };
        let bit_b = if i < b.width as usize { b.get_bit(i) } else { LogicState::Zero };

        let min_bit = match (bit_a, bit_b) {
            // 0 和 1 比较
            (LogicState::Zero, LogicState::One) => LogicState::Zero,
            (LogicState::One, LogicState::Zero) => LogicState::Zero,
            // 任何值与 X 比较
            (LogicState::X, _) | (_, LogicState::X) => LogicState::X,
            // 任何值与 Z 比较
            (LogicState::Z, _) | (_, LogicState::Z) => LogicState::Z,
            // 相等
            _ => bit_a,
        };

        result.set_bit(i, min_bit);
    }

    result
}

/// 四态 max 计算
pub fn four_state_max(a: &FourStateValue, b: &FourStateValue) -> FourStateValue {
    let width = a.width.max(b.width);
    let mut result = FourStateValue::new(width);

    for i in 0..width as usize {
        let bit_a = if i < a.width as usize { a.get_bit(i) } else { LogicState::Zero };
        let bit_b = if i < b.width as usize { b.get_bit(i) } else { LogicState::Zero };

        let max_bit = match (bit_a, bit_b) {
            // 0 和 1 比较
            (LogicState::Zero, LogicState::One) => LogicState::One,
            (LogicState::One, LogicState::Zero) => LogicState::One,
            // 任何值与 X 比较
            (LogicState::X, _) | (_, LogicState::X) => LogicState::X,
            // 任何值与 Z 比较
            (LogicState::Z, _) | (_, LogicState::Z) => LogicState::Z,
            // 相等
            _ => bit_a,
        };

        result.set_bit(i, max_bit);
    }

    result
}

/// 比较两个字节数组的大小（按字典序）
///
/// 用于 LoD min/max 计算（仅用于纯二进制值，不含 X/Z）
pub fn compare_bytes(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
    let len = a.len().min(b.len());
    for i in 0..len {
        match a[i].cmp(&b[i]) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    a.len().cmp(&b.len())
}

/// 获取两个字节数组中的较小值
pub fn min_bytes(a: &[u8], b: &[u8]) -> Vec<u8> {
    match compare_bytes(a, b) {
        std::cmp::Ordering::Less | std::cmp::Ordering::Equal => a.to_vec(),
        std::cmp::Ordering::Greater => b.to_vec(),
    }
}

/// 获取两个字节数组中的较大值
pub fn max_bytes(a: &[u8], b: &[u8]) -> Vec<u8> {
    match compare_bytes(a, b) {
        std::cmp::Ordering::Less => b.to_vec(),
        std::cmp::Ordering::Equal | std::cmp::Ordering::Greater => a.to_vec(),
    }
}

/// 信号值类型（仿 FST VarType）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SignalValueType {
    /// 数值类型（wire/reg/logic/integer）
    /// 存储格式：ASCII 字符串，如 "0", "1", "b1010", "bX1Z0"
    #[default]
    Numeric = 0,
    
    /// 字符串类型（string）
    /// 存储格式：null-terminated ASCII
    String = 1,
    
    /// 实数类型（real）
    /// 存储格式：IEEE 754 f64
    Real = 2,
    
    /// 二进制压缩类型（优化传输，纯 0/1 无 X/Z）
    /// 存储格式：紧凑二进制
    BinaryCompressed = 3,
}

impl SignalValueType {
    /// 从 u8 解析
    pub fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::String,
            2 => Self::Real,
            3 => Self::BinaryCompressed,
            _ => Self::Numeric,
        }
    }
}

/// 信号值（仿 FST 格式）
#[derive(Debug, Clone, PartialEq)]
pub enum SignalValue {
    /// 数值类型（四态字符串）
    /// 
    /// # 格式
    /// - 1bit: "0", "1", "X", "Z"
    /// - n-bit: "b1010", "bX1Z0", "bZZZZ"
    Numeric(String),
    
    /// 字符串类型（null-terminated）
    String(String),
    
    /// 实数类型
    Real(f64),
    
    /// 二进制压缩（用于高效传输纯 0/1 信号）
    Binary {
        width: u16,
        data: Vec<u8>,
    },
}

impl SignalValue {
    /// 从 FST 原始值解析
    pub fn from_fst(value: &[u8], value_type: SignalValueType) -> Self {
        match value_type {
            SignalValueType::String => {
                // null-terminated 字符串
                let s = parse_null_terminated_string(value);
                Self::String(s)
            }
            SignalValueType::Real => {
                // IEEE 754 f64
                if value.len() >= 8 {
                    let f = f64::from_le_bytes(value[..8].try_into().unwrap());
                    Self::Real(f)
                } else {
                    Self::Real(0.0)
                }
            }
            SignalValueType::BinaryCompressed => {
                // 二进制压缩类型需要额外元数据
                Self::Numeric(String::from_utf8_lossy(value).to_string())
            }
            _ => {
                // 数值类型（包括 wire/reg/integer）
                let s = String::from_utf8_lossy(value).trim().to_string();
                Self::Numeric(s)
            }
        }
    }
    
    /// 转换为四态值（用于 LoD 计算）
    pub fn to_four_state(&self) -> Option<FourStateValue> {
        match self {
            Self::Numeric(s) => Some(FourStateValue::from_string(s)),
            _ => None,
        }
    }
    
    /// 检查是否为纯 0/1（无 X/Z）
    pub fn is_pure_binary(&self) -> bool {
        match self {
            Self::Numeric(s) => !s.chars().any(|c| c == 'X' || c == 'x' || c == 'Z' || c == 'z'),
            Self::Binary { .. } => true,
            _ => false,
        }
    }
    
    /// 获取字符串表示
    pub fn to_string(&self) -> String {
        match self {
            Self::Numeric(s) => s.clone(),
            Self::String(s) => s.clone(),
            Self::Real(f) => f.to_string(),
            Self::Binary { width, data } => {
                // 将二进制数据转换为字符串
                let mut result = String::with_capacity(*width as usize + 1);
                result.push('b');
                for i in (0..*width as usize).rev() {
                    let byte_idx = i / 8;
                    let bit_idx = i % 8;
                    if byte_idx < data.len() {
                        let bit = (data[byte_idx] >> bit_idx) & 1;
                        result.push(if bit == 1 { '1' } else { '0' });
                    } else {
                        result.push('0');
                    }
                }
                result
            }
        }
    }
}

/// 解析 null-terminated 字符串
fn parse_null_terminated_string(value: &[u8]) -> String {
    let nul_pos = value.iter().position(|&b| b == 0).unwrap_or(value.len());
    String::from_utf8_lossy(&value[..nul_pos]).to_string()
}

/// 压缩算法类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CompressionAlgorithm {
    /// 无压缩
    #[default]
    None = 0,
    /// Zstd 压缩
    Zstd = 1,
    /// Lz4 压缩
    Lz4 = 2,
}

impl CompressionAlgorithm {
    /// 从 u8 解析压缩算法
    pub fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Zstd,
            2 => Self::Lz4,
            _ => Self::None,
        }
    }

    /// 获取压缩算法名称
    pub fn name(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Zstd => "zstd",
            Self::Lz4 => "lz4",
        }
    }

    /// 压缩数据
    pub fn compress(&self, data: &[u8]) -> Result<Vec<u8>> {
        match self {
            Self::None => Ok(data.to_vec()),
            Self::Zstd => {
                let compressed = zstd::encode_all(data, 3)
                    .map_err(|e| ServerError::Internal(format!("Zstd compression failed: {}", e)))?;
                Ok(compressed)
            }
            Self::Lz4 => {
                let mut encoder = lz4::EncoderBuilder::new()
                    .build(Vec::new())
                    .map_err(|e| ServerError::Internal(format!("Lz4 encoder creation failed: {}", e)))?;
                encoder.write_all(data)
                    .map_err(|e| ServerError::Internal(format!("Lz4 compression failed: {}", e)))?;
                let (compressed, result) = encoder.finish();
                result.map_err(|e| ServerError::Internal(format!("Lz4 compression finish failed: {}", e)))?;
                Ok(compressed)
            }
        }
    }

    /// 解压数据
    pub fn decompress(&self, data: &[u8]) -> Result<Vec<u8>> {
        match self {
            Self::None => Ok(data.to_vec()),
            Self::Zstd => {
                let decompressed = zstd::decode_all(data)
                    .map_err(|e| ServerError::Internal(format!("Zstd decompression failed: {}", e)))?;
                Ok(decompressed)
            }
            Self::Lz4 => {
                let mut decoder = lz4::Decoder::new(data)
                    .map_err(|e| ServerError::Internal(format!("Lz4 decoder creation failed: {}", e)))?;
                let mut decompressed = Vec::new();
                std::io::copy(&mut decoder, &mut decompressed)
                    .map_err(|e| ServerError::Internal(format!("Lz4 decompression failed: {}", e)))?;
                Ok(decompressed)
            }
        }
    }
}

/// 波形数据转换点（支持任意位宽和四态逻辑）
#[derive(Debug, Clone, PartialEq)]
pub struct Transition {
    /// 时间戳
    pub time: u64,
    /// 值（仿 FST 格式）
    pub value: SignalValue,
}

impl Transition {
    /// 从 FST 原始数据创建转换点
    /// 
    /// # Arguments
    /// * `time` - 时间戳
    /// * `fst_value` - FST 原始值字节
    /// * `value_type` - 值类型
    pub fn from_fst(time: u64, fst_value: &[u8], value_type: SignalValueType) -> Self {
        let value = SignalValue::from_fst(fst_value, value_type);
        Self { time, value }
    }

    /// 从数值字符串创建（支持四态 X/Z）
    /// 
    /// # Examples
    /// ```
    /// let t = Transition::from_numeric(100, "b1010");
    /// let t = Transition::from_numeric(200, "bX1Z0");
    /// ```
    pub fn from_numeric(time: u64, value_str: &str) -> Self {
        Self {
            time,
            value: SignalValue::Numeric(value_str.to_string()),
        }
    }

    /// 从字符串创建
    pub fn from_string(time: u64, s: &str) -> Self {
        Self {
            time,
            value: SignalValue::String(s.to_string()),
        }
    }

    /// 从实数创建
    pub fn from_real(time: u64, f: f64) -> Self {
        Self {
            time,
            value: SignalValue::Real(f),
        }
    }

    /// 从 u64 创建转换点（兼容原有代码，纯二进制）
    pub fn from_u64(time: u64, value: u64, width: u16) -> Self {
        let bytes = ((width + 7) / 8).max(1) as usize;
        let mut data = vec![0u8; bytes];
        
        // 小端序存储
        for i in 0..bytes {
            data[i] = ((value >> (i * 8)) & 0xFF) as u8;
        }
        
        Self {
            time,
            value: SignalValue::Binary { width, data },
        }
    }

    /// 将值转换为 u64（仅当位宽 ≤ 64 且纯二进制时有效）
    pub fn to_u64(&self) -> Option<u64> {
        match &self.value {
            SignalValue::Numeric(s) => {
                // 尝试解析为 u64
                if s.starts_with('b') {
                    u64::from_str_radix(&s[1..], 2).ok()
                } else {
                    s.parse::<u64>().ok()
                }
            }
            SignalValue::Binary { data, .. } => {
                let mut result = 0u64;
                for (i, &byte) in data.iter().enumerate().take(8) {
                    result |= (byte as u64) << (i * 8);
                }
                Some(result)
            }
            _ => None,
        }
    }

    /// 获取值的字符串表示
    pub fn value_to_string(&self) -> String {
        self.value.to_string()
    }
}

/// 单个信号的波形数据
#[derive(Debug, Clone)]
pub struct SignalWaveData {
    /// 信号句柄
    pub handle: u32,
    /// 信号位宽
    pub width: u16,
    /// 值类型
    pub value_type: SignalValueType,
    /// 转换点列表（已按时间排序）
    pub transitions: Vec<Transition>,
}

impl SignalWaveData {
    /// 创建新的信号波形数据
    pub fn new(handle: u32, width: u16, value_type: SignalValueType) -> Self {
        Self {
            handle,
            width,
            value_type,
            transitions: Vec::new(),
        }
    }

    /// 添加转换点
    pub fn add_transition(&mut self, transition: Transition) {
        self.transitions.push(transition);
    }

    /// 获取指定时间点的值（使用二分查找）
    pub fn value_at(&self, time: u64) -> Option<&Transition> {
        if self.transitions.is_empty() {
            return None;
        }

        // 二分查找最后一个 <= time 的转换点
        let idx = self
            .transitions
            .binary_search_by_key(&time, |t| t.time)
            .unwrap_or_else(|i| i.saturating_sub(1));

        self.transitions.get(idx)
    }

    /// 检查是否包含 X/Z
    pub fn has_xz(&self) -> bool {
        self.transitions.iter().any(|t| {
            if let SignalValue::Numeric(s) = &t.value {
                s.chars().any(|c| c == 'X' || c == 'x' || c == 'Z' || c == 'z')
            } else {
                false
            }
        })
    }
}

/// LoD 层级定义
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LodLevel(pub u32);

impl LodLevel {
    /// 最大 LoD 层级
    pub const MAX_LEVEL: u32 = 12;

    /// 创建 LoD 层级（自动限制在有效范围内）
    pub fn new(level: u32) -> Self {
        Self(level.min(Self::MAX_LEVEL))
    }

    /// 获取 bucket 大小（16^level 个转换点）
    ///
    /// LoD 0: 1 (原始数据)
    /// LoD 1: 16 (每16个点合并)
    /// LoD 2: 256 (每256个点合并)
    /// LoD n: 16^n
    pub fn bucket_size(&self) -> usize {
        16usize.pow(self.0)
    }

    /// 判断是否为有效层级
    pub fn is_valid(&self) -> bool {
        self.0 <= Self::MAX_LEVEL
    }
}

/// LoD 配置
///
/// 注意：LoD 是基于数据点数量的降采样，与时间窗口无关。
/// 每个 LoD 层级使用 bucket_size = 16^level 个转换点进行 min/max 降采样。
#[derive(Debug, Clone)]
pub struct LodConfig {
    /// LoD 层级数量 (0 表示原始数据，1+ 表示降采样层级)
    pub levels: u32,
    /// 每个 chunk 的最大转换点数
    pub max_transitions_per_chunk: usize,
    /// 是否启用压缩
    pub enable_compression: bool,
}

impl Default for LodConfig {
    fn default() -> Self {
        Self {
            levels: 6,
            max_transitions_per_chunk: 10_000,
            enable_compression: true,
        }
    }
}

/// LoD 金字塔生成器
pub struct LodPyramidGenerator {
    config: LodConfig,
}

impl LodPyramidGenerator {
    /// 创建新的 LoD 金字塔生成器
    pub fn new(config: LodConfig) -> Self {
        Self { config }
    }

    /// 生成单个 LoD 层级
    ///
    /// 根据值类型选择不同的降采样策略：
    /// - Numeric：使用四态 min/max
    /// - String/Real：采样第一个值
    /// - BinaryCompressed：数值 min/max
    pub fn generate_level(
        &self,
        source: &SignalWaveData,
        level: LodLevel,
    ) -> SignalWaveData {
        if level.0 == 0 || source.transitions.is_empty() {
            return source.clone();
        }

        match source.value_type {
            SignalValueType::Numeric => self.generate_numeric_level(source, level),
            SignalValueType::String | SignalValueType::Real => {
                self.generate_sample_level(source, level)
            }
            SignalValueType::BinaryCompressed => self.generate_binary_level(source, level),
        }
    }

    /// 数值类型的四态 min/max 降采样
    fn generate_numeric_level(
        &self,
        source: &SignalWaveData,
        level: LodLevel,
    ) -> SignalWaveData {
        let bucket_size = level.bucket_size();
        let mut result = SignalWaveData::new(source.handle, source.width, source.value_type);

        // 获取第一个转换点的四态值
        let first_fs = source.transitions[0]
            .value
            .to_four_state()
            .unwrap_or_else(|| FourStateValue::new(source.width));
        let mut bucket_min = first_fs.clone();
        let mut bucket_max = first_fs.clone();
        let mut bucket_start_time = source.transitions[0].time;
        let mut last_value = source.transitions[0].value.clone();
        let mut bucket_idx = 0usize;

        for (i, trans) in source.transitions.iter().enumerate() {
            let current_bucket = i / bucket_size;

            // 获取当前转换点的四态值
            let trans_fs = trans
                .value
                .to_four_state()
                .unwrap_or_else(|| FourStateValue::new(source.width));

            if current_bucket > bucket_idx {
                // 输出上一个 bucket 的 min/max
                let min_str = bucket_min.to_string();
                let max_str = bucket_max.to_string();

                // 始终输出 min（修复：移除了 != last_value 的错误去重）
                result.add_transition(Transition::from_numeric(bucket_start_time, &min_str));
                // 输出 max（如果与 min 不同）
                if max_str != min_str {
                    result.add_transition(Transition::from_numeric(bucket_start_time, &max_str));
                }

                // 开始新 bucket
                bucket_idx = current_bucket;
                bucket_start_time = trans.time;
                bucket_min = trans_fs.clone();
                bucket_max = trans_fs.clone();
            } else {
                // 更新当前 bucket 的 min/max（四态比较）
                bucket_min = four_state_min(&bucket_min, &trans_fs);
                bucket_max = four_state_max(&bucket_max, &trans_fs);
            }

            last_value = trans.value.clone();
        }

        // 输出最后一个 bucket
        if bucket_idx < (source.transitions.len() + bucket_size - 1) / bucket_size {
            let min_str = bucket_min.to_string();
            let max_str = bucket_max.to_string();

            // 始终输出 min（修复：移除了 != last_value 的错误去重）
            result.add_transition(Transition::from_numeric(bucket_start_time, &min_str));
            // 输出 max（如果与 min 不同）
            if max_str != min_str {
                result.add_transition(Transition::from_numeric(bucket_start_time, &max_str));
            }
        }

        result
    }

    /// 字符串/实数类型的采样降采样
    fn generate_sample_level(
        &self,
        source: &SignalWaveData,
        level: LodLevel,
    ) -> SignalWaveData {
        let bucket_size = level.bucket_size();
        let mut result = SignalWaveData::new(source.handle, source.width, source.value_type);

        for (i, trans) in source.transitions.iter().enumerate().step_by(bucket_size) {
            result.add_transition(trans.clone());
        }

        result
    }

    /// 二进制压缩类型的数值 min/max
    fn generate_binary_level(
        &self,
        source: &SignalWaveData,
        level: LodLevel,
    ) -> SignalWaveData {
        // 二进制压缩类型使用字节数组比较
        let bucket_size = level.bucket_size();
        let mut result = SignalWaveData::new(source.handle, source.width, source.value_type);

        if source.transitions.is_empty() {
            return result;
        }

        // 获取第一个值
        let first_value = match &source.transitions[0].value {
            SignalValue::Binary { data, .. } => data.clone(),
            _ => vec![0],
        };

        let mut bucket_min = first_value.clone();
        let mut bucket_max = first_value.clone();
        let mut bucket_start_time = source.transitions[0].time;
        let mut last_value = first_value.clone();
        let mut bucket_idx = 0usize;

        for (i, trans) in source.transitions.iter().enumerate() {
            let current_bucket = i / bucket_size;

            let trans_value = match &trans.value {
                SignalValue::Binary { data, .. } => data.clone(),
                _ => vec![0],
            };

            if current_bucket > bucket_idx {
                // 输出上一个 bucket 的 min/max
                if bucket_min != last_value {
                    result.add_transition(Transition {
                        time: bucket_start_time,
                        value: SignalValue::Binary {
                            width: source.width,
                            data: bucket_min.clone(),
                        },
                    });
                }
                if bucket_max != bucket_min && bucket_max != last_value {
                    result.add_transition(Transition {
                        time: bucket_start_time,
                        value: SignalValue::Binary {
                            width: source.width,
                            data: bucket_max.clone(),
                        },
                    });
                }

                // 开始新 bucket
                bucket_idx = current_bucket;
                bucket_start_time = trans.time;
                bucket_min = trans_value.clone();
                bucket_max = trans_value.clone();
            } else {
                // 更新当前 bucket 的 min/max（字节数组比较）
                bucket_min = min_bytes(&bucket_min, &trans_value);
                bucket_max = max_bytes(&bucket_max, &trans_value);
            }

            last_value = trans_value.clone();
        }

        // 输出最后一个 bucket
        if bucket_idx < (source.transitions.len() + bucket_size - 1) / bucket_size {
            if bucket_min != last_value {
                result.add_transition(Transition {
                    time: bucket_start_time,
                    value: SignalValue::Binary {
                        width: source.width,
                        data: bucket_min.clone(),
                    },
                });
            }
            if bucket_max != bucket_min {
                result.add_transition(Transition {
                    time: bucket_start_time,
                    value: SignalValue::Binary {
                        width: source.width,
                        data: bucket_max.clone(),
                    },
                });
            }
        }

        result
    }

    /// 生成完整的 LoD 金字塔
    pub fn generate_pyramid(
        &self,
        source: &SignalWaveData,
    ) -> HashMap<LodLevel, SignalWaveData> {
        let mut pyramid = HashMap::new();

        // LoD 0 是原始数据
        pyramid.insert(LodLevel(0), source.clone());

        // 生成更高层级
        for level in 1..=self.config.levels {
            let prev_level = LodLevel(level - 1);
            let prev_data = pyramid.get(&prev_level).unwrap();
            let lod_data = self.generate_level(prev_data, LodLevel(level));
            pyramid.insert(LodLevel(level), lod_data);
        }

        pyramid
    }
}

/// Chunk 文件头（32字节）
#[derive(Debug, Clone, Copy)]
pub struct ChunkHeader {
    /// 魔数 'WAVE' = 0x57415645
    pub magic: u32,
    /// 版本号
    pub version: u16,
    /// LoD 层级
    pub level: u16,
    /// Chunk ID
    pub chunk_id: u32,
    /// 起始时间
    pub time_start: u64,
    /// 结束时间
    pub time_end: u64,
    /// 信号数量
    pub signal_count: u32,
}

impl ChunkHeader {
    pub const MAGIC: u32 = 0x57415645; // 'WAVE'
    pub const VERSION: u16 = 1;
    pub const SIZE: usize = 32;

    pub fn new(level: u16, chunk_id: u32, time_start: u64, time_end: u64, signal_count: u32) -> Self {
        Self {
            magic: Self::MAGIC,
            version: Self::VERSION,
            level,
            chunk_id,
            time_start,
            time_end,
            signal_count,
        }
    }

    /// 序列化为字节数组
    pub fn to_bytes(&self) -> [u8; Self::SIZE] {
        let mut bytes = [0u8; Self::SIZE];
        bytes[0..4].copy_from_slice(&self.magic.to_le_bytes());
        bytes[4..6].copy_from_slice(&self.version.to_le_bytes());
        bytes[6..8].copy_from_slice(&self.level.to_le_bytes());
        bytes[8..12].copy_from_slice(&self.chunk_id.to_le_bytes());
        bytes[12..20].copy_from_slice(&self.time_start.to_le_bytes());
        bytes[20..28].copy_from_slice(&self.time_end.to_le_bytes());
        bytes[28..32].copy_from_slice(&self.signal_count.to_le_bytes());
        bytes
    }

    /// 从字节数组解析
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < Self::SIZE {
            return Err(ServerError::Internal("Invalid chunk header size".to_string()));
        }

        let magic = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        if magic != Self::MAGIC {
            return Err(ServerError::Internal(format!(
                "Invalid chunk magic: expected 0x{:08X}, got 0x{:08X}",
                Self::MAGIC,
                magic
            )));
        }

        Ok(Self {
            magic,
            version: u16::from_le_bytes(bytes[4..6].try_into().unwrap()),
            level: u16::from_le_bytes(bytes[6..8].try_into().unwrap()),
            chunk_id: u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            time_start: u64::from_le_bytes(bytes[12..20].try_into().unwrap()),
            time_end: u64::from_le_bytes(bytes[20..28].try_into().unwrap()),
            signal_count: u32::from_le_bytes(bytes[28..32].try_into().unwrap()),
        })
    }
}

/// 信号块头
#[derive(Debug, Clone)]
pub struct SignalBlockHeader {
    /// 信号句柄
    pub signal_handle: u32,
    /// 时间数组偏移（相对于chunk数据起始）
    pub time_array_offset: u32,
    /// 值数组偏移（相对于chunk数据起始）
    pub value_array_offset: u32,
    /// 转换点数量
    pub transition_count: u32,
    /// 压缩类型（0=无压缩, 1=zstd, 2=lz4）
    pub compression: u8,
}

impl SignalBlockHeader {
    pub const SIZE: usize = 17;

    pub fn to_bytes(&self) -> [u8; Self::SIZE] {
        let mut bytes = [0u8; Self::SIZE];
        bytes[0..4].copy_from_slice(&self.signal_handle.to_le_bytes());
        bytes[4..8].copy_from_slice(&self.time_array_offset.to_le_bytes());
        bytes[8..12].copy_from_slice(&self.value_array_offset.to_le_bytes());
        bytes[12..16].copy_from_slice(&self.transition_count.to_le_bytes());
        bytes[16] = self.compression;
        bytes
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < Self::SIZE {
            return Err(ServerError::Internal("Invalid signal block header size".to_string()));
        }

        Ok(Self {
            signal_handle: u32::from_le_bytes(bytes[0..4].try_into().unwrap()),
            time_array_offset: u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            value_array_offset: u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            transition_count: u32::from_le_bytes(bytes[12..16].try_into().unwrap()),
            compression: bytes[16],
        })
    }
}

/// Chunk 序列化器
pub struct ChunkSerializer;

impl ChunkSerializer {
    /// 将信号波形数据序列化为 chunk 格式（SoA: Structure of Arrays）
    /// 
    /// # Arguments
    /// * `chunk_id` - Chunk ID
    /// * `level` - LoD 层级
    /// * `signals` - 信号波形数据列表
    /// * `time_range` - 时间范围 (start, end)
    /// * `compression` - 压缩算法（默认不压缩）
    pub fn serialize(
        chunk_id: u32,
        level: u16,
        signals: &[&SignalWaveData],
        time_range: (u64, u64),
        compression: CompressionAlgorithm,
    ) -> Result<Vec<u8>> {
        let (time_start, time_end) = time_range;
        let signal_count = signals.len() as u32;

        // 创建文件头
        let header = ChunkHeader::new(level, chunk_id, time_start, time_end, signal_count);

        // 计算偏移量
        let header_size = ChunkHeader::SIZE;
        let block_table_size = SignalBlockHeader::SIZE * signals.len();
        let data_start_offset = header_size + block_table_size;

        // 收集所有信号数据
        let mut block_headers = Vec::new();
        let mut time_arrays = Vec::new();
        let mut value_arrays = Vec::new();
        let mut current_offset = data_start_offset as u32;

        for signal in signals {
            // 过滤时间范围内的转换点
            let filtered: Vec<_> = signal
                .transitions
                .iter()
                .filter(|t| t.time >= time_start && t.time <= time_end)
                .cloned()
                .collect();

            let transition_count = filtered.len() as u32;

            // 时间数组（u64 数组）
            let time_array: Vec<u8> = filtered
                .iter()
                .flat_map(|t| t.time.to_le_bytes())
                .collect();

            // 值数组（仿 FST 格式，支持多种类型）
            // 格式：[类型(u8), 长度(u16), 值字节...] × 转换点数量
            let mut value_array = Vec::new();
            for t in &filtered {
                // 写入类型
                let type_byte = match &t.value {
                    SignalValue::Numeric(_) => SignalValueType::Numeric as u8,
                    SignalValue::String(_) => SignalValueType::String as u8,
                    SignalValue::Real(_) => SignalValueType::Real as u8,
                    SignalValue::Binary { .. } => SignalValueType::BinaryCompressed as u8,
                };
                value_array.push(type_byte);
                
                // 写入值
                match &t.value {
                    SignalValue::Numeric(s) | SignalValue::String(s) => {
                        let bytes = s.as_bytes();
                        let value_len = bytes.len() as u16;
                        value_array.extend_from_slice(&value_len.to_le_bytes());
                        value_array.extend_from_slice(bytes);
                    }
                    SignalValue::Real(f) => {
                        let bytes = f.to_le_bytes();
                        let value_len = bytes.len() as u16;
                        value_array.extend_from_slice(&value_len.to_le_bytes());
                        value_array.extend_from_slice(&bytes);
                    }
                    SignalValue::Binary { data, .. } => {
                        let value_len = data.len() as u16;
                        value_array.extend_from_slice(&value_len.to_le_bytes());
                        value_array.extend_from_slice(data);
                    }
                }
            }

            // 压缩数据
            let compressed_time = compression.compress(&time_array)?;
            let compressed_value = compression.compress(&value_array)?;
            
            let time_array_size = compressed_time.len() as u32;
            let value_array_size = compressed_value.len() as u32;

            let block_header = SignalBlockHeader {
                signal_handle: signal.handle,
                time_array_offset: current_offset,
                value_array_offset: current_offset + time_array_size,
                transition_count,
                compression: compression as u8,
            };

            block_headers.push(block_header);
            time_arrays.push(compressed_time);
            value_arrays.push(compressed_value);

            current_offset += time_array_size + value_array_size;
        }

        // 组装最终数据
        let mut result = Vec::new();
        result.extend_from_slice(&header.to_bytes());

        // 写入信号块头表
        for bh in block_headers {
            result.extend_from_slice(&bh.to_bytes());
        }

        // 写入时间数组和值数组
        for (time_arr, value_arr) in time_arrays.iter().zip(value_arrays.iter()) {
            result.extend_from_slice(time_arr);
            result.extend_from_slice(value_arr);
        }

        Ok(result)
    }

    /// 从 chunk 数据反序列化
    pub fn deserialize(data: &[u8]) -> Result<(ChunkHeader, Vec<(SignalBlockHeader, Vec<Transition>)>)> {
        // 解析文件头
        let header = ChunkHeader::from_bytes(data)?;

        let mut signals = Vec::new();
        let header_size = ChunkHeader::SIZE;
        let block_table_size = SignalBlockHeader::SIZE * header.signal_count as usize;

        // 解析每个信号块
        for i in 0..header.signal_count {
            let block_offset = header_size + SignalBlockHeader::SIZE * i as usize;
            let block_header = SignalBlockHeader::from_bytes(&data[block_offset..])?;

            // 读取压缩的时间数组
            let time_array_start = block_header.time_array_offset as usize;
            let time_array_end = block_header.value_array_offset as usize;
            let compressed_time_bytes = &data[time_array_start..time_array_end];

            // 读取压缩的值数组
            let value_array_start = block_header.value_array_offset as usize;
            let value_array_end = value_array_start + block_header.transition_count as usize * 8;
            let compressed_value_bytes = &data[value_array_start..];

            // 解压数据
            let compression = CompressionAlgorithm::from_u8(block_header.compression);
            let time_bytes = compression.decompress(compressed_time_bytes)?;
            let value_bytes = compression.decompress(compressed_value_bytes)?;

            // 重建转换点
            let mut transitions = Vec::new();
            let mut value_offset = 0usize;
            
            for j in 0..block_header.transition_count as usize {
                let time_offset = j * 8;
                
                // 确保不越界（至少需要类型+长度）
                if time_offset + 8 > time_bytes.len() || value_offset + 3 > value_bytes.len() {
                    break;
                }
                
                let time = u64::from_le_bytes(time_bytes[time_offset..time_offset + 8].try_into().unwrap());
                
                // 值数组格式：[类型(u8), 长度(u16), 值字节...]
                let value_type = SignalValueType::from_u8(value_bytes[value_offset]);
                let value_len = u16::from_le_bytes(value_bytes[value_offset + 1..value_offset + 3].try_into().unwrap()) as usize;
                
                if value_offset + 3 + value_len > value_bytes.len() {
                    break;
                }
                
                let value_data = &value_bytes[value_offset + 3..value_offset + 3 + value_len];
                let value = SignalValue::from_fst(value_data, value_type);
                transitions.push(Transition { time, value });
                
                // 移动到下一个值
                value_offset += 3 + value_len;
            }

            signals.push((block_header, transitions));
        }

        Ok((header, signals))
    }
}

/// 波形数据管理器
pub struct WaveDataManager {
    config: LodConfig,
    generator: LodPyramidGenerator,
}

impl WaveDataManager {
    pub fn new(config: LodConfig) -> Self {
        let generator = LodPyramidGenerator::new(config.clone());
        Self { config, generator }
    }

    /// 将信号数据分块并生成 LoD 金字塔
    pub fn chunk_and_generate_lod(
        &self,
        signal: &SignalWaveData,
        time_range: (u64, u64),
    ) -> Result<Vec<(u32, u16, Vec<u8>)>> {
        let (start_time, end_time) = time_range;

        // 为每个 LoD 层级生成 chunk
        // 注意：LoD 是基于数据点数量的降采样，与时间窗口无关
        let mut chunks = Vec::new();
        let chunk_id = 0u32;

        for level in 0..=self.config.levels {
            let lod_level = LodLevel(level);

            // 生成该 LoD 层级的数据
            let lod_data = self.generator.generate_level(signal, lod_level);

            // 序列化为 chunk
            let chunk_data = ChunkSerializer::serialize(
                chunk_id,
                level as u16,
                &[&lod_data],
                (start_time, end_time),
                CompressionAlgorithm::None,
            )?;

            chunks.push((chunk_id, level as u16, chunk_data));
        }

        Ok(chunks)
    }

    /// 根据时间范围和 LoD 层级选择合适的 chunk
    pub fn select_chunks(
        &self,
        chunks: &[(u32, u16, Vec<u8>)],
        time_start: u64,
        time_end: u64,
        lod: LodLevel,
    ) -> Vec<(u32, Vec<u8>)> {
        chunks
            .iter()
            .filter(|(_, level, _)| *level == lod.0 as u16)
            .filter(|(chunk_id, _, data)| {
                // 解析 chunk 头检查时间范围
                if let Ok(header) = ChunkHeader::from_bytes(data) {
                    // 检查时间范围是否有交集
                    header.time_start <= time_end && header.time_end >= time_start
                } else {
                    false
                }
            })
            .map(|(chunk_id, _, data)| (*chunk_id, data.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lod_bucket_size() {
        assert_eq!(LodLevel(0).bucket_size(), 1);
        assert_eq!(LodLevel(1).bucket_size(), 16);
        assert_eq!(LodLevel(2).bucket_size(), 256);
        assert_eq!(LodLevel(3).bucket_size(), 4096);
    }

    #[test]
    fn test_signal_wave_data() {
        let mut signal = SignalWaveData::new(1, 8);
        signal.add_transition(0, 0);
        signal.add_transition(100, 1);
        signal.add_transition(200, 0);
        signal.add_transition(300, 1);

        assert_eq!(signal.value_at(0), Some(0));
        assert_eq!(signal.value_at(50), Some(0));
        assert_eq!(signal.value_at(100), Some(1));
        assert_eq!(signal.value_at(150), Some(1));
        assert_eq!(signal.value_at(250), Some(0));
        assert_eq!(signal.value_at(500), Some(1)); // 最后一个值
    }

    #[test]
    fn test_chunk_header_serialization() {
        let header = ChunkHeader::new(2, 42, 0, 1000000, 10);
        let bytes = header.to_bytes();
        let parsed = ChunkHeader::from_bytes(&bytes).unwrap();

        assert_eq!(parsed.magic, ChunkHeader::MAGIC);
        assert_eq!(parsed.level, 2);
        assert_eq!(parsed.chunk_id, 42);
        assert_eq!(parsed.time_start, 0);
        assert_eq!(parsed.time_end, 1000000);
        assert_eq!(parsed.signal_count, 10);
    }

    #[test]
    fn test_chunk_serialization() {
        let mut signal = SignalWaveData::new(1, 8);
        signal.add_transition(0, 0);
        signal.add_transition(100, 1);
        signal.add_transition(200, 0);
        signal.add_transition(300, 1);

        let chunk_data = ChunkSerializer::serialize(0, 0, &[&signal], (0, 500)).unwrap();
        let (header, signals) = ChunkSerializer::deserialize(&chunk_data).unwrap();

        assert_eq!(header.chunk_id, 0);
        assert_eq!(header.level, 0);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0].1.len(), 4); // 4 transitions
    }
}
