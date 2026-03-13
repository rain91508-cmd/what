use crate::config::ServerConfig;
use crate::services::fst_reader_cache::FstReaderCache;
use moka::future::Cache;
use std::sync::Arc;
use tokio::sync::RwLock;

/// 服务器共享状态
/// 使用 Arc 在多个线程间共享，使用 RwLock 保证线程安全
#[derive(Clone)]
pub struct ServerState {
    /// 服务器配置
    pub config: Arc<ServerConfig>,

    /// 知识库元数据缓存
    /// 缓存 key: 知识库名称，value: 元数据 JSON
    pub kdb_metadata_cache: KdbMetadataCache,

    /// 波形文件元数据缓存
    /// 缓存 key: 波形文件路径，value: 元数据
    pub wave_metadata_cache: WaveMetadataCache,

    /// 波形数据块缓存 (LRU)
    /// 缓存 key: (waveform_name, signal_name, lod, time_range)
    pub wave_chunk_cache: WaveChunkCache,

    /// 源文件内容缓存
    /// 缓存 key: 文件路径，value: 文件内容
    pub source_cache: SourceCache,

    /// FST Reader 缓存
    /// 缓存 key: 文件路径，value: 缓存的 FST Reader
    pub fst_reader_cache: FstReaderCache,

    /// 访问统计信息
    pub stats: Arc<ServerStats>,
}

/// 知识库元数据缓存类型
pub type KdbMetadataCache = Cache<String, serde_json::Value>;

/// 波形文件元数据缓存类型
pub type WaveMetadataCache = Cache<String, WaveMetadata>;

/// 波形数据块缓存类型
pub type WaveChunkCache = Cache<String, Arc<Vec<u8>>>;

/// 源文件缓存类型
pub type SourceCache = Cache<String, Arc<String>>;

/// 波形元数据结构
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WaveMetadata {
    /// 波形名称
    pub name: String,
    /// 文件名
    pub file: String,
    /// 时间范围
    pub time_range: TimeRange,
    /// 信号数量
    pub signal_count: u32,
    /// 可用的 LoD 层级
    pub lod_levels: Vec<u32>,
    /// 文件大小 (字节)
    pub file_size: u64,
}

/// 时间范围结构
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TimeRange {
    /// 起始时间 (皮秒)
    pub start: i64,
    /// 结束时间 (皮秒)
    pub end: i64,
    /// 时间单位
    pub unit: String,
}

impl TimeRange {
    pub fn new(start: i64, end: i64) -> Self {
        Self {
            start,
            end,
            unit: "ps".to_string(),
        }
    }

    /// 计算时间范围跨度 (皮秒)
    pub fn span(&self) -> i64 {
        self.end - self.start
    }

    /// 检查时间是否有效
    pub fn is_valid(&self) -> bool {
        self.start >= 0 && self.end > self.start
    }
}

/// 服务器统计信息
#[derive(Debug, Default)]
pub struct ServerStats {
    /// 总请求数
    pub total_requests: RwLock<u64>,
    /// 知识库请求数
    pub kdb_requests: RwLock<u64>,
    /// 波形请求数
    pub wave_requests: RwLock<u64>,
    /// 缓存命中数
    pub cache_hits: RwLock<u64>,
    /// 缓存未命中数
    pub cache_misses: RwLock<u64>,
    /// 错误数
    pub errors: RwLock<u64>,
}

impl ServerStats {
    /// 记录请求
    pub async fn record_request(&self, request_type: RequestType) {
        *self.total_requests.write().await += 1;
        match request_type {
            RequestType::Kdb => *self.kdb_requests.write().await += 1,
            RequestType::Wave => *self.wave_requests.write().await += 1,
        }
    }

    /// 记录缓存命中
    pub async fn record_cache_hit(&self) {
        *self.cache_hits.write().await += 1;
    }

    /// 记录缓存未命中
    pub async fn record_cache_miss(&self) {
        *self.cache_misses.write().await += 1;
    }

    /// 记录错误
    pub async fn record_error(&self) {
        *self.errors.write().await += 1;
    }

    /// 获取统计信息
    pub async fn get_stats(&self) -> StatsSnapshot {
        StatsSnapshot {
            total_requests: *self.total_requests.read().await,
            kdb_requests: *self.kdb_requests.read().await,
            wave_requests: *self.wave_requests.read().await,
            cache_hits: *self.cache_hits.read().await,
            cache_misses: *self.cache_misses.read().await,
            errors: *self.errors.read().await,
        }
    }
}

/// 请求类型枚举
#[derive(Debug, Clone, Copy)]
pub enum RequestType {
    Kdb,
    Wave,
}

/// 统计信息快照
#[derive(Debug, serde::Serialize)]
pub struct StatsSnapshot {
    pub total_requests: u64,
    pub kdb_requests: u64,
    pub wave_requests: u64,
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub errors: u64,
}

impl ServerState {
    /// 创建新的服务器状态
    pub fn new(config: ServerConfig) -> Self {
        let cache_capacity = config.cache_capacity_bytes();

        // 创建缓存
        // KDB 元数据缓存：较小，因为元数据不大
        let kdb_metadata_cache = Cache::new(100);

        // 波形元数据缓存：中等大小
        let wave_metadata_cache = Cache::new(1000);

        // 波形数据块缓存：较大，存储实际的波形数据
        let wave_chunk_cache = Cache::new(cache_capacity / 2);

        // 源文件缓存：中等大小
        let source_cache = Cache::new(cache_capacity / 4);

        // FST Reader 缓存：缓存打开的 FST 文件 reader
        let fst_reader_cache = FstReaderCache::new(10);

        Self {
            config: Arc::new(config),
            kdb_metadata_cache,
            wave_metadata_cache,
            wave_chunk_cache,
            source_cache,
            fst_reader_cache,
            stats: Arc::new(ServerStats::default()),
        }
    }

    /// 清除所有缓存
    pub fn clear_all_caches(&self) {
        self.kdb_metadata_cache.invalidate_all();
        self.wave_metadata_cache.invalidate_all();
        self.wave_chunk_cache.invalidate_all();
        self.source_cache.invalidate_all();
        // FST Reader 缓存不需要显式清除，它有 TTL
    }

    /// 清除波形数据块缓存
    pub fn clear_wave_chunk_cache(&self) {
        self.wave_chunk_cache.invalidate_all();
    }

    /// 清除波形元数据缓存
    pub fn clear_wave_metadata_cache(&self) {
        self.wave_metadata_cache.invalidate_all();
    }

    /// 生成波形数据块的缓存键
    pub fn make_wave_chunk_key(
        waveform_name: &str,
        signal_name: &str,
        lod: u32,
        start_time: i64,
        end_time: i64,
    ) -> String {
        format!(
            "{}:{}:{}:{}:{}",
            waveform_name, signal_name, lod, start_time, end_time
        )
    }

    /// 生成波形元数据的缓存键
    pub fn make_wave_metadata_key(waveform_name: &str) -> String {
        waveform_name.to_string()
    }

    /// 生成知识库元数据的缓存键
    pub fn make_kdb_metadata_key(kdb_name: &str) -> String {
        kdb_name.to_string()
    }
}

impl std::fmt::Debug for ServerState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerState")
            .field("config", &self.config)
            .field("kdb_metadata_cache", &"Cache<...>")
            .field("wave_metadata_cache", &"Cache<...>")
            .field("wave_chunk_cache", &"Cache<...>")
            .field("source_cache", &"Cache<...>")
            .field("stats", &self.stats)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_time_range() {
        let tr = TimeRange::new(0, 1000);
        assert!(tr.is_valid());
        assert_eq!(tr.span(), 1000);
    }

    #[test]
    fn test_invalid_time_range() {
        let tr = TimeRange::new(1000, 0);
        assert!(!tr.is_valid());
    }

    #[test]
    fn test_cache_key_generation() {
        let key = ServerState::make_wave_chunk_key("wave1", "sig1", 2, 0, 1000);
        assert_eq!(key, "wave1:sig1:2:0:1000");
    }
}
