use crate::error::{Result, ServerError};
use crate::state::{ServerState, TimeRange, WaveMetadata};
use std::path::PathBuf;
use tokio::fs;
use tracing::{debug, info};

/// 波形数据服务
/// 负责管理 FST 波形文件的读取和 LoD 数据查询
pub struct WaveService {
    state: ServerState,
    wave_dir: PathBuf,
}

/// 波形信号元信息
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct WaveSignalInfo {
    /// 波形名称
    pub waveform_name: String,
    /// 信号完整路径
    pub signal_name: String,
    /// 时间范围
    pub time_range: TimeRange,
    /// 跳变数量
    pub transition_count: u64,
    /// 可用的 LoD 层级
    pub lod_levels: Vec<u32>,
    /// 信号位宽
    pub bit_width: u32,
    /// 信号类型
    pub signal_type: String,
}

/// LoD 层级配置
pub const LOD_LEVELS: [u32; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/// LoD 时间精度 (皮秒)
pub fn lod_precision(lod: u32) -> i64 {
    match lod {
        0 => 10,           // 10ps
        1 => 100,          // 100ps
        2 => 1_000,        // 1ns
        3 => 10_000,       // 10ns
        4 => 100_000,      // 100ns
        5 => 1_000_000,    // 1us
        6 => 10_000_000,   // 10us
        7 => 100_000_000,  // 100us
        8 => 1_000_000_000,    // 1ms
        9 => 10_000_000_000,   // 10ms
        10 => 100_000_000_000, // 100ms
        11 => 1_000_000_000_000, // 1s
        _ => 10,
    }
}

impl WaveService {
    /// 创建新的波形数据服务
    pub fn new(state: ServerState) -> Self {
        let wave_dir = state.config.wave_dir.clone();
        Self { state, wave_dir }
    }

    /// 获取所有可用的波形文件列表
    pub async fn list_waves(&self) -> Result<Vec<WaveMetadata>> {
        let mut waves = Vec::new();

        let mut entries = fs::read_dir(&self.wave_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("fst") {
                if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                    let metadata = fs::metadata(&path).await?;
                    // TODO: 解析 FST 文件获取真实信息
                    waves.push(WaveMetadata {
                        name: name.to_string(),
                        file: format!("{}.fst", name),
                        time_range: TimeRange::new(0, 1_000_000_000), // TODO: 从文件解析
                        signal_count: 0,                               // TODO: 从文件解析
                        lod_levels: LOD_LEVELS.to_vec(),
                        file_size: metadata.len(),
                    });
                }
            }
        }

        debug!("找到 {} 个波形文件", waves.len());
        Ok(waves)
    }

    /// 获取波形中指定信号的元信息
    pub async fn get_signal_info(
        &self,
        waveform_name: &str,
        signal_name: &str,
    ) -> Result<WaveSignalInfo> {
        // 验证波形文件存在
        self.get_wave_path(waveform_name)?;

        // TODO: 实际实现中需要从 FST 文件解析信号信息
        // 这里使用占位实现

        Ok(WaveSignalInfo {
            waveform_name: waveform_name.to_string(),
            signal_name: signal_name.to_string(),
            time_range: TimeRange::new(0, 1_000_000_000),
            transition_count: 0, // TODO: 从文件解析
            lod_levels: LOD_LEVELS.to_vec(),
            bit_width: 1, // TODO: 从文件解析
            signal_type: "wire".to_string(), // TODO: 从文件解析
        })
    }

    /// 获取波形中所有信号列表
    pub async fn list_signals(&self, waveform_name: &str) -> Result<Vec<String>> {
        // 验证波形文件存在
        self.get_wave_path(waveform_name)?;

        // TODO: 实际实现中需要从 FST 文件解析信号列表
        // 这里返回空列表作为占位
        Ok(Vec::new())
    }

    /// 获取波形数据 (支持 HTTP Range 和 LoD)
    pub async fn get_wave_data(
        &self,
        waveform_name: &str,
        signal_name: &str,
        lod: u32,
        start_time: i64,
        end_time: i64,
        range: Option<(u64, Option<u64>)>,
    ) -> Result<(Vec<u8>, u64, Option<u64>)> {
        // 验证 LoD 层级
        if lod > 11 {
            return Err(ServerError::InvalidLod(lod));
        }

        // 验证时间范围
        if start_time < 0 || end_time < start_time {
            return Err(ServerError::InvalidTimeRange(format!(
                "无效的时间范围：{} - {}",
                start_time, end_time
            )));
        }

        // 验证波形文件存在
        let wave_path = self.get_wave_path(waveform_name)?;

        // 尝试从缓存获取
        let cache_key = ServerState::make_wave_chunk_key(
            waveform_name,
            signal_name,
            lod,
            start_time,
            end_time,
        );

        if let Some(cached) = self.state.wave_chunk_cache.get(&cache_key).await {
            debug!("波形数据缓存命中：{} (LoD {})", signal_name, lod);
            self.state.stats.record_cache_hit().await;
            let data = (*cached).clone();
            let len = data.len() as u64;
            return Ok((data, len, Some(len)));
        }

        self.state.stats.record_cache_miss().await;

        // TODO: 实际实现中需要：
        // 1. 使用 wavefst 库读取 FST 文件
        // 2. 根据 LoD 层级进行降采样
        // 3. 裁剪时间范围 [start_time, end_time]
        // 4. 序列化为二进制格式
        // 这里使用占位实现

        // 读取 FST 文件
        let file_content = fs::read(&wave_path).await?;
        let file_size = file_content.len() as u64;

        // 计算 Range 范围
        let (start, end) = match range {
            Some((start, Some(end))) => (start, end.min(file_size - 1)),
            Some((start, None)) => (start, file_size - 1),
            None => (0, file_size - 1),
        };

        let data = file_content[start as usize..=end as usize].to_vec();

        // 缓存数据
        self.state
            .wave_chunk_cache
            .insert(cache_key, Arc::new(data.clone()))
            .await;

        debug!(
            "读取波形数据：{}.{} (LoD {}, {}-{} ps)",
            waveform_name, signal_name, lod, start_time, end_time
        );

        Ok((data, file_size, Some(end - start + 1)))
    }

    /// 获取波形文件路径
    fn get_wave_path(&self, waveform_name: &str) -> Result<PathBuf> {
        let wave_path = self.wave_dir.join(format!("{}.fst", waveform_name));

        if !wave_path.exists() {
            return Err(ServerError::WaveformNotFound(format!(
                "波形文件 '{}.fst' 不存在",
                waveform_name
            )));
        }

        Ok(wave_path)
    }

    /// 检查波形文件是否存在
    pub fn wave_exists(&self, waveform_name: &str) -> bool {
        self.wave_dir.join(format!("{}.fst", waveform_name)).exists()
    }

    /// 根据缩放级别自动选择 LoD
    pub fn select_lod(&self, pixels_per_ps: f64) -> u32 {
        // 根据像素密度选择合适的 LoD 层级
        // 这是一个简化实现，实际应该更复杂
        if pixels_per_ps > 0.1 {
            0 // 最高精度
        } else if pixels_per_ps > 0.01 {
            2
        } else if pixels_per_ps > 0.001 {
            4
        } else if pixels_per_ps > 0.0001 {
            6
        } else {
            8 // 最低精度
        }
    }
}

use std::sync::Arc;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ServerConfig;
    use tempfile::TempDir;

    #[test]
    fn test_lod_precision() {
        assert_eq!(lod_precision(0), 10);
        assert_eq!(lod_precision(2), 1_000);
        assert_eq!(lod_precision(5), 1_000_000);
        assert_eq!(lod_precision(11), 1_000_000_000_000);
    }

    #[tokio::test]
    async fn test_list_waves_empty() {
        let temp_dir = TempDir::new().unwrap();
        let config = ServerConfig {
            wave_dir: temp_dir.path().to_path_buf(),
            ..Default::default()
        };
        let state = ServerState::new(config);
        let service = WaveService::new(state);

        let waves = service.list_waves().await.unwrap();
        assert!(waves.is_empty());
    }

    #[test]
    fn test_select_lod() {
        let config = ServerConfig::default();
        let state = ServerState::new(config);
        let service = WaveService::new(state);

        assert_eq!(service.select_lod(1.0), 0);
        assert_eq!(service.select_lod(0.05), 2);
        assert_eq!(service.select_lod(0.00001), 8);
    }
}
