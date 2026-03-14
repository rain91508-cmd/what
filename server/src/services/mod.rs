pub mod kdb_service;
pub mod wave_service;
pub mod wave_data;
pub mod fst_backend;
pub mod fst_reader_backend;
pub mod fst_reader_cache;
pub mod pattern_search;
pub mod pattern_search_fst_reader;
pub mod pattern_search_fstapi;

pub use kdb_service::KdbService;
pub use wave_service::{WaveService, FstBackend};
pub use wave_data::{LodLevel, LodConfig, SignalWaveData, Transition, ChunkSerializer, CompressionAlgorithm};
pub use fst_backend::{FstReader, create_reader_backend, FstFileInfo};
pub use fst_reader_backend::read_signals_data_fst_reader_batch;

use std::path::PathBuf;
use tokio::fs;
use sha2::{Sha256, Digest};
use crate::error::Result;

/// 计算文件的 SHA256 校验和
/// 用于检测文件是否发生变化
pub async fn compute_file_hash(path: &PathBuf) -> Result<String> {
    let content = fs::read(path).await?;
    let mut hasher = Sha256::new();
    hasher.update(&content);
    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}
