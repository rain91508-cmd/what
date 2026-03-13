//! FST Reader Cache - 缓存 FST 文件 reader 避免重复打开

use crate::error::{Result, ServerError};
use fst_reader::FstReader;
use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

/// FST Reader 包装器
pub struct CachedFstReader {
    reader: Mutex<FstReader<BufReader<File>>>,
}

impl CachedFstReader {
    pub fn new(path: &PathBuf) -> Result<Self> {
        let file = File::open(path)
            .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;
        let buf_reader = BufReader::new(file);
        let reader = FstReader::open(buf_reader)
            .map_err(|e| ServerError::Internal(format!("无法读取 FST 文件: {:?}", e)))?;
        
        Ok(Self {
            reader: Mutex::new(reader),
        })
    }

    pub async fn lock(&self) -> tokio::sync::MutexGuard<'_, FstReader<BufReader<File>>> {
        self.reader.lock().await
    }
}

/// FST Reader 缓存
use moka::future::Cache;
use std::time::Duration;

#[derive(Clone)]
pub struct FstReaderCache {
    cache: Cache<String, Arc<CachedFstReader>>,
}

impl FstReaderCache {
    pub fn new(max_capacity: u64) -> Self {
        Self {
            cache: Cache::builder()
                .max_capacity(max_capacity)
                .time_to_live(Duration::from_secs(300)) // 5分钟过期
                .build(),
        }
    }

    /// 获取或创建 FST Reader
    pub async fn get_or_create(&self, path: &str) -> Result<Arc<CachedFstReader>> {
        // 尝试从缓存获取，如果不存在则创建
        let path_owned = path.to_string();
        let reader = self
            .cache
            .get_with(path_owned.clone(), async move {
                let path_buf = PathBuf::from(path_owned);
                match CachedFstReader::new(&path_buf) {
                    Ok(reader) => Arc::new(reader),
                    Err(e) => {
                        // 如果创建失败，返回一个占位值（实际使用时会再次尝试）
                        panic!("Failed to create FstReader: {:?}", e);
                    }
                }
            })
            .await;

        Ok(reader)
    }

    /// 使缓存失效
    pub async fn invalidate(&self, path: &str) {
        self.cache.invalidate(path).await;
    }
}

/// 全局 FST Reader 缓存实例
static FST_READER_CACHE: std::sync::OnceLock<FstReaderCache> = std::sync::OnceLock::new();

/// 获取全局 FST Reader 缓存
pub fn get_fst_reader_cache() -> &'static FstReaderCache {
    FST_READER_CACHE.get_or_init(|| FstReaderCache::new(10))
}
