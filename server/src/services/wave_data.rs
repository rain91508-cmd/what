//! 波形数据处理和 LoD (Level of Detail) 生成模块
//!
//! 本模块实现了基于 min/max bucket 算法的 LOD 金字塔生成，
//! 以及 chunk 化的波形数据存储和传输格式。

use crate::error::{Result, ServerError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;

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

/// 波形数据转换点
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transition {
    /// 时间戳（皮秒）
    pub time: u64,
    /// 值（以字节数组存储，支持任意位宽）
    pub value: u64, // 简化：最多支持64位
}

/// 单个信号的波形数据
#[derive(Debug, Clone)]
pub struct SignalWaveData {
    /// 信号句柄
    pub handle: u32,
    /// 信号位宽
    pub width: u16,
    /// 转换点列表（已按时间排序）
    pub transitions: Vec<Transition>,
}

impl SignalWaveData {
    /// 创建新的信号波形数据
    pub fn new(handle: u32, width: u16) -> Self {
        Self {
            handle,
            width,
            transitions: Vec::new(),
        }
    }

    /// 添加转换点
    pub fn add_transition(&mut self, time: u64, value: u64) {
        self.transitions.push(Transition { time, value });
    }

    /// 获取指定时间点的值（使用二分查找）
    pub fn value_at(&self, time: u64) -> Option<u64> {
        if self.transitions.is_empty() {
            return None;
        }

        // 二分查找最后一个 <= time 的转换点
        let idx = self
            .transitions
            .binary_search_by_key(&time, |t| t.time)
            .unwrap_or_else(|i| i.saturating_sub(1));

        self.transitions.get(idx).map(|t| t.value)
    }
}

/// LoD 层级定义
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LodLevel(pub u32);

impl LodLevel {
    /// 最大 LoD 层级
    pub const MAX_LEVEL: u32 = 11;

    /// 创建 LoD 层级（自动限制在有效范围内）
    pub fn new(level: u32) -> Self {
        Self(level.min(Self::MAX_LEVEL))
    }

    /// 获取 bucket 大小（2^level）
    pub fn bucket_size(&self) -> usize {
        1usize << self.0
    }

    /// 获取时间窗口倍数
    pub fn time_window_multiplier(&self) -> u64 {
        1u64 << self.0
    }

    /// 判断是否为有效层级
    pub fn is_valid(&self) -> bool {
        self.0 <= Self::MAX_LEVEL
    }
}

/// LoD 配置
#[derive(Debug, Clone)]
pub struct LodConfig {
    /// 基础时间窗口（皮秒）
    pub base_window_ps: u64,
    /// LoD 层级数量
    pub levels: u32,
    /// 每个 chunk 的最大转换点数
    pub max_transitions_per_chunk: usize,
    /// 是否启用压缩
    pub enable_compression: bool,
}

impl Default for LodConfig {
    fn default() -> Self {
        Self {
            base_window_ps: 1_000, // 1ns = 1000ps
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

    /// 使用 min/max bucket 算法生成单个 LoD 层级
    ///
    /// 算法说明：
    /// 1. 将时间轴分成大小为 2^level 的 bucket
    /// 2. 每个 bucket 记录该时间段内的 min 和 max 值
    /// 3. 保留边沿信息，确保波形特征不丢失
    pub fn generate_level(
        &self,
        source: &SignalWaveData,
        level: LodLevel,
    ) -> SignalWaveData {
        if level.0 == 0 || source.transitions.is_empty() {
            return source.clone();
        }

        let bucket_size = level.bucket_size();
        let mut result = SignalWaveData::new(source.handle, source.width);

        let mut bucket_min = source.transitions[0].value;
        let mut bucket_max = source.transitions[0].value;
        let mut bucket_start_time = source.transitions[0].time;
        let mut last_value = source.transitions[0].value;
        let mut bucket_idx = 0usize;

        for (i, trans) in source.transitions.iter().enumerate() {
            let current_bucket = i / bucket_size;

            if current_bucket > bucket_idx {
                // 输出上一个 bucket 的 min/max
                if bucket_min != last_value {
                    result.add_transition(bucket_start_time, bucket_min);
                }
                if bucket_max != bucket_min && bucket_max != last_value {
                    result.add_transition(bucket_start_time, bucket_max);
                }

                // 开始新 bucket
                bucket_idx = current_bucket;
                bucket_start_time = trans.time;
                bucket_min = trans.value;
                bucket_max = trans.value;
            } else {
                // 更新当前 bucket 的 min/max
                bucket_min = bucket_min.min(trans.value);
                bucket_max = bucket_max.max(trans.value);
            }

            last_value = trans.value;
        }

        // 输出最后一个 bucket
        if bucket_idx < (source.transitions.len() + bucket_size - 1) / bucket_size {
            if bucket_min != last_value {
                result.add_transition(bucket_start_time, bucket_min);
            }
            if bucket_max != bucket_min {
                result.add_transition(bucket_start_time, bucket_max);
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

            // 值数组（u64 数组，简化处理）
            let value_array: Vec<u8> = filtered
                .iter()
                .flat_map(|t| t.value.to_le_bytes())
                .collect();

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
            for j in 0..block_header.transition_count as usize {
                let time_offset = j * 8;
                let value_offset = j * 8;
                
                // 确保不越界
                if time_offset + 8 > time_bytes.len() || value_offset + 8 > value_bytes.len() {
                    break;
                }
                
                let time = u64::from_le_bytes(time_bytes[time_offset..time_offset + 8].try_into().unwrap());
                let value = u64::from_le_bytes(value_bytes[value_offset..value_offset + 8].try_into().unwrap());
                transitions.push(Transition { time, value });
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
        let total_duration = end_time - start_time;

        // 计算每个 chunk 的时间窗口
        let chunk_duration = self.config.base_window_ps * self.config.max_transitions_per_chunk as u64;
        let num_chunks = ((total_duration + chunk_duration - 1) / chunk_duration).max(1) as u32;

        let mut chunks = Vec::new();

        for chunk_id in 0..num_chunks {
            let chunk_start = start_time + chunk_id as u64 * chunk_duration;
            let chunk_end = (chunk_start + chunk_duration).min(end_time);

            // 为每个 LoD 层级生成 chunk
            for level in 0..=self.config.levels {
                let lod_level = LodLevel(level);

                // 生成该 LoD 层级的数据
                let lod_data = self.generator.generate_level(signal, lod_level);

                // 序列化为 chunk
                let chunk_data = ChunkSerializer::serialize(
                    chunk_id,
                    level as u16,
                    &[&lod_data],
                    (chunk_start, chunk_end),
                )?;

                chunks.push((chunk_id, level as u16, chunk_data));
            }
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
        assert_eq!(LodLevel(1).bucket_size(), 2);
        assert_eq!(LodLevel(5).bucket_size(), 32);
        assert_eq!(LodLevel(10).bucket_size(), 1024);
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
