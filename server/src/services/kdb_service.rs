use crate::error::{Result, ServerError};
use crate::state::{ServerState, TimeRange};
use crate::services::compute_file_hash;
use std::path::PathBuf;
use tokio::fs;
use tracing::{debug, info, warn};

/// 知识库文件魔数 - 标准格式 (KDB\0)
const KDB_MAGIC: &[u8] = b"KDB\x00";
/// 知识库文件魔数 - interpreter 格式 (KDWC: KDB Web Compressed)
/// 注意：interpreter 使用小端序存储，所以文件中实际是 "CWDK"
const KDB_MAGIC_INTERPRETER: &[u8] = b"CWDK";

/// 知识库文件最小大小 (魔数 + 版本信息)
const KDB_MIN_SIZE: u64 = 16;

/// 知识库服务
/// 负责管理知识库文件的读取和元数据查询
pub struct KdbService {
    state: ServerState,
    kdb_dir: PathBuf,
}

/// 知识库文件基本信息
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct KdbFileInfo {
    /// 知识库名称
    pub name: String,
    /// 文件大小 (字节)
    pub file_size: u64,
    /// 是否为有效的 KDB 文件
    pub is_valid: bool,
    /// 文件修改时间 (Unix timestamp)
    pub modified_time: u64,
    /// SHA256 校验和 (用于缓存验证)
    pub checksum: String,
}

/// 知识库元数据信息
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct KdbInfo {
    /// 设计名称
    pub design_name: String,
    /// 版本号
    pub version: String,
    /// 信号数量
    pub signal_count: u32,
    /// 模块数量
    pub module_count: u32,
    /// 文件大小 (字节)
    pub file_size: u64,
    /// SHA256 校验和
    pub checksum: String,
}

impl KdbService {
    /// 创建新的知识库服务
    pub fn new(state: ServerState) -> Self {
        let kdb_dir = state.config.kdb_dir.clone();
        Self { state, kdb_dir }
    }

    /// 获取所有可用的知识库列表
    /// 返回所有 KDB 文件（包括无效的），包含完整的元数据用于缓存验证
    pub async fn list_kdbs(&self) -> Result<Vec<KdbFileInfo>> {
        let mut kdbs = Vec::new();

        let mut entries = fs::read_dir(&self.kdb_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("kdb") {
                if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                    // 验证是否是有效的 KDB 文件
                    match self.validate_kdb_file(&path).await {
                        Ok(true) => {
                            let metadata = fs::metadata(&path).await?;
                            // 获取文件修改时间
                            let modified_time = metadata
                                .modified()
                                .ok()
                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|d| d.as_secs())
                                .unwrap_or(0);
                            // 计算校验和
                            let checksum = compute_file_hash(&path).await.unwrap_or_default();
                            kdbs.push(KdbFileInfo {
                                name: name.to_string(),
                                file_size: metadata.len(),
                                is_valid: true,
                                modified_time,
                                checksum,
                            });
                        }
                        Ok(false) => {
                            warn!("发现无效的 KDB 文件：{:?}", path);
                            kdbs.push(KdbFileInfo {
                                name: name.to_string(),
                                file_size: 0,
                                is_valid: false,
                                modified_time: 0,
                                checksum: String::new(),
                            });
                        }
                        Err(e) => {
                            warn!("验证 KDB 文件失败 {:?}: {}", path, e);
                        }
                    }
                }
            }
        }

        debug!("找到 {} 个知识库文件", kdbs.len());
        Ok(kdbs)
    }

    /// 验证文件是否为有效的 KDB 文件
    /// 检查文件魔数和最小大小
    /// 支持标准格式 (KDB\0) 和 interpreter 格式 (KDWC)
    pub async fn validate_kdb_file(&self, path: &PathBuf) -> Result<bool> {
        let metadata = fs::metadata(path).await?;

        // 检查文件大小
        if metadata.len() < KDB_MIN_SIZE {
            return Ok(false);
        }

        // 读取文件头检查魔数
        let file_content = fs::read(path).await?;
        if file_content.len() < 4 {
            return Ok(false);
        }

        // 检查魔数 - 支持两种格式
        let magic_match = &file_content[0..4] == KDB_MAGIC
            || &file_content[0..4] == KDB_MAGIC_INTERPRETER;

        Ok(magic_match)
    }

    /// 检查指定名称的知识库是否是有效的 KDB 文件
    pub async fn is_valid_kdb(&self, kdb_name: &str) -> Result<bool> {
        let kdb_path = self.get_kdb_path(kdb_name)?;
        self.validate_kdb_file(&kdb_path).await
    }

    /// 获取知识库元信息
    /// 注意：不使用缓存，每次都从文件系统读取最新数据
    /// 这样可以确保文件更新后获取到最新信息
    pub async fn get_kdb_info(&self, kdb_name: &str) -> Result<KdbInfo> {
        // 从文件系统读取（不使用缓存，确保数据新鲜）
        let kdb_path = self.get_kdb_path(kdb_name)?;
        let metadata = fs::metadata(&kdb_path).await?;

        // 获取文件修改时间
        let modified_time = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        // 计算校验和
        let checksum = compute_file_hash(&kdb_path).await?;

        let info = KdbInfo {
            design_name: kdb_name.to_string(),
            version: "1.0.0".to_string(),
            signal_count: 0, // TODO: 从文件解析
            module_count: 0, // TODO: 从文件解析
            file_size: metadata.len(),
            checksum: checksum.clone(),
        };

        info!("获取知识库元信息：{} ({} bytes, modified={}, checksum={})", 
            kdb_name, metadata.len(), modified_time, &checksum[..8.min(checksum.len())]);
        Ok(info)
    }

    /// 获取知识库文件路径
    fn get_kdb_path(&self, kdb_name: &str) -> Result<PathBuf> {
        let kdb_path = self.kdb_dir.join(format!("{}.kdb", kdb_name));

        if !kdb_path.exists() {
            return Err(ServerError::KdbNotFound(format!(
                "知识库 '{}' 不存在",
                kdb_name
            )));
        }

        Ok(kdb_path)
    }

    /// 读取知识库文件 (支持 HTTP Range)
    pub async fn read_kdb_file(
        &self,
        kdb_name: &str,
        range: Option<(u64, Option<u64>)>,
    ) -> Result<(Vec<u8>, u64, Option<u64>)> {
        let kdb_path = self.get_kdb_path(kdb_name)?;
        let file_size = fs::metadata(&kdb_path).await?.len();

        // 计算实际读取范围
        let (start, end) = match range {
            Some((start, Some(end))) => {
                // 指定了起始和结束
                if start >= file_size {
                    return Err(ServerError::RangeNotSupported(format!(
                        "起始位置 {} 超出文件大小 {}",
                        start, file_size
                    )));
                }
                (start, end.min(file_size - 1))
            }
            Some((start, None)) => {
                // 只指定了起始位置 (从 start 到文件末尾)
                if start >= file_size {
                    return Err(ServerError::RangeNotSupported(format!(
                        "起始位置 {} 超出文件大小 {}",
                        start, file_size
                    )));
                }
                (start, file_size - 1)
            }
            None => {
                // 读取整个文件
                (0, file_size - 1)
            }
        };

        // 读取文件
        let content = fs::read(&kdb_path).await?;
        let range_content = content[start as usize..=end as usize].to_vec();

        debug!(
            "读取知识库：{} ({}-{} / {} bytes)",
            kdb_name,
            start,
            end,
            file_size
        );

        Ok((range_content, file_size, Some(end - start + 1)))
    }

    /// 检查知识库是否存在
    pub fn kdb_exists(&self, kdb_name: &str) -> bool {
        self.kdb_dir.join(format!("{}.kdb", kdb_name)).exists()
    }
}

// compute_file_hash 已移到 mod.rs 作为公共服务

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ServerConfig;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_list_kdbs_empty() {
        let temp_dir = TempDir::new().unwrap();
        let config = ServerConfig {
            kdb_dir: temp_dir.path().to_path_buf(),
            ..Default::default()
        };
        let state = ServerState::new(config);
        let service = KdbService::new(state);

        let kdbs = service.list_kdbs().await.unwrap();
        assert!(kdbs.is_empty());
    }

    #[test]
    fn test_kdb_info_serialization() {
        let info = KdbInfo {
            design_name: "test".to_string(),
            version: "1.0.0".to_string(),
            signal_count: 1000,
            module_count: 50,
            file_size: 1024 * 1024,
            checksum: "sha256:abc123".to_string(),
        };

        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("test"));
    }
}
