use crate::config::ServerConfig;
use crate::services::fst_reader_cache::FstReaderCache;
use crate::services::wave_data::SignalWaveData;
use moka::future::Cache;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Shared server state
/// Shared across threads via Arc; RwLock guarantees thread safety
#[derive(Clone)]
pub struct ServerState {
    /// Server configuration
    pub config: Arc<ServerConfig>,

    /// Signal data cache (LRU)
    /// Cache key: (waveform path, signal name), value: full signal data (LoD 0)
    /// Caches raw signal data read from FST files to avoid repeated reads
    pub signal_data_cache: SignalDataCache,

    /// FST Reader cache
    /// Cache key: file path, value: cached FST Reader
    pub fst_reader_cache: FstReaderCache,

    /// Access statistics
    pub stats: Arc<ServerStats>,
}

/// Signal data cache type
/// Key: (waveform path, signal name), Value: full signal data
pub type SignalDataCache = Cache<(String, String), Arc<SignalWaveData>>;

/// Waveform metadata structure
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WaveMetadata {
    /// Waveform name
    pub name: String,
    /// File name
    pub file: String,
    /// Time range
    pub time_range: TimeRange,
    /// Number of signals
    pub signal_count: u32,
    /// Available LoD levels
    pub lod_levels: Vec<u32>,
    /// File size (bytes)
    pub file_size: u64,
}

/// Time range structure
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TimeRange {
    /// Start time (picoseconds)
    pub start: i64,
    /// End time (picoseconds)
    pub end: i64,
    /// Time unit
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

    /// Compute the time range span (picoseconds)
    pub fn span(&self) -> i64 {
        self.end - self.start
    }

    /// Check whether the time range is valid
    pub fn is_valid(&self) -> bool {
        self.start >= 0 && self.end > self.start
    }
}

/// Server statistics
#[derive(Debug, Default)]
pub struct ServerStats {
    /// Total request count
    pub total_requests: RwLock<u64>,
    /// KDB request count
    pub kdb_requests: RwLock<u64>,
    /// Waveform request count
    pub wave_requests: RwLock<u64>,
    /// Cache hit count
    pub cache_hits: RwLock<u64>,
    /// Cache miss count
    pub cache_misses: RwLock<u64>,
    /// Error count
    pub errors: RwLock<u64>,
}

impl ServerStats {
    /// Record a request
    pub async fn record_request(&self, request_type: RequestType) {
        *self.total_requests.write().await += 1;
        match request_type {
            RequestType::Kdb => *self.kdb_requests.write().await += 1,
            RequestType::Wave => *self.wave_requests.write().await += 1,
        }
    }

    /// Record a cache hit
    pub async fn record_cache_hit(&self) {
        *self.cache_hits.write().await += 1;
    }

    /// Record a cache miss
    pub async fn record_cache_miss(&self) {
        *self.cache_misses.write().await += 1;
    }

    /// Record an error
    pub async fn record_error(&self) {
        *self.errors.write().await += 1;
    }

    /// Get statistics snapshot
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

/// Request type enum
#[derive(Debug, Clone, Copy)]
pub enum RequestType {
    Kdb,
    Wave,
}

/// Statistics snapshot
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
    /// Create a new server state
    pub fn new(config: ServerConfig) -> Self {
        let cache_capacity = config.cache_capacity_bytes();

        // Signal data cache: stores raw signal data read from FST (LoD 0)
        // Uses the configured cache capacity
        let signal_data_cache = Cache::new(cache_capacity);

        // FST Reader cache: caches opened FST file readers
        let fst_reader_cache = FstReaderCache::new(10);

        Self {
            config: Arc::new(config),
            signal_data_cache,
            fst_reader_cache,
            stats: Arc::new(ServerStats::default()),
        }
    }

    /// Clear all caches
    pub fn clear_all_caches(&self) {
        self.signal_data_cache.invalidate_all();
        // FST Reader cache does not need explicit clearing; it has a TTL
    }

    /// Clear the signal data cache
    pub fn clear_signal_data_cache(&self) {
        self.signal_data_cache.invalidate_all();
    }

    /// Build the signal data cache key
    pub fn make_signal_data_key(wave_path: &str, signal_name: &str) -> (String, String) {
        (wave_path.to_string(), signal_name.to_string())
    }
}

impl std::fmt::Debug for ServerState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerState")
            .field("config", &self.config)
            .field("signal_data_cache", &"Cache<...>")
            .field("fst_reader_cache", &"FstReaderCache<...>")
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
    fn test_signal_data_key_generation() {
        let key = ServerState::make_signal_data_key("./waves/test.fst", "top.signal1");
        assert_eq!(key, ("./waves/test.fst".to_string(), "top.signal1".to_string()));
    }
}
