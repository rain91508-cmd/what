use clap::Parser;
use std::path::PathBuf;

/// 硬件设计分析器数据服务器配置
#[derive(Parser, Debug, Clone)]
#[command(author, version, about, long_about = None)]
pub struct ServerConfig {
    /// 知识库文件目录
    #[arg(long, default_value = "./kdb")]
    pub kdb_dir: PathBuf,

    /// 波形文件目录
    #[arg(long, default_value = "./waves")]
    pub wave_dir: PathBuf,

    /// 服务端口
    #[arg(long, default_value = "8080")]
    pub port: u16,

    /// 绑定地址
    #[arg(long, default_value = "0.0.0.0")]
    pub host: String,

    /// 日志级别 (trace, debug, info, warn, error)
    #[arg(long, default_value = "info")]
    pub log_level: String,

    /// 启用 CORS
    #[arg(long, default_value = "true")]
    pub enable_cors: bool,

    /// 允许 CORS 的来源 (使用 * 表示允许所有)
    #[arg(long, default_value = "*")]
    pub cors_origin: String,

    /// 最大并发连接数
    #[arg(long, default_value = "1000")]
    pub max_connections: usize,

    /// LRU 缓存容量 (MB)
    #[arg(long, default_value = "512")]
    pub cache_capacity_mb: usize,

    /// 波形数据块大小 (KB)
    #[arg(long, default_value = "64")]
    pub chunk_size_kb: usize,

    /// 启用认证
    #[arg(long, default_value = "false")]
    pub enable_auth: bool,

    /// 认证令牌 (如果启用认证)
    #[arg(long)]
    pub auth_token: Option<String>,

    /// 速率限制 (每秒请求数)
    #[arg(long, default_value = "100")]
    pub rate_limit: u64,

    /// FST 读取后端 (fstapi, fst-reader)
    #[arg(long, default_value = "fstapi")]
    pub fst_backend: String,

    /// Web 客户端静态文件目录（如果提供，将启用静态文件服务）
    #[arg(long)]
    pub web_dir: Option<PathBuf>,
    
    /// 启动时自动清除所有缓存
    #[arg(long, default_value = "false")]
    pub clear_cache_on_startup: bool,

    /// 启用详细调试输出（仅在 log_level=debug 时生效）
    #[arg(long, default_value = "false")]
    pub verbose: bool,

    /// 启用 fst-reader 与 fstapi 对比测试模式
    #[arg(long, default_value = "false")]
    pub compare_test: bool,
}

impl ServerConfig {
    /// 验证配置的有效性
    pub fn validate(&self) -> crate::error::Result<()> {
        use crate::error::{Result, ServerError};

        // 验证 kdb_dir 是否存在
        if !self.kdb_dir.exists() {
            return Err(ServerError::ConfigError(format!(
                "知识库目录不存在：{:?}",
                self.kdb_dir
            )));
        }

        // 验证 wave_dir 是否存在
        if !self.wave_dir.exists() {
            return Err(ServerError::ConfigError(format!(
                "波形文件目录不存在：{:?}",
                self.wave_dir
            )));
        }

        // 验证端口
        if self.port == 0 {
            return Err(ServerError::ConfigError("端口号不能为 0".to_string()));
        }

        // 验证缓存容量
        if self.cache_capacity_mb == 0 {
            return Err(ServerError::ConfigError("缓存容量不能为 0".to_string()));
        }

        // 验证块大小
        if self.chunk_size_kb == 0 {
            return Err(ServerError::ConfigError("块大小不能为 0".to_string()));
        }

        // 如果启用认证，必须提供 token
        if self.enable_auth && self.auth_token.is_none() {
            return Err(ServerError::ConfigError(
                "启用认证时必须提供 auth-token".to_string(),
            ));
        }

        Ok(())
    }

    /// 获取绑定地址
    pub fn bind_address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    /// 获取缓存容量 (字节)
    pub fn cache_capacity_bytes(&self) -> u64 {
        self.cache_capacity_mb as u64 * 1024 * 1024
    }

    /// 获取块大小 (字节)
    pub fn chunk_size_bytes(&self) -> u64 {
        self.chunk_size_kb as u64 * 1024
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            kdb_dir: PathBuf::from("./kdb"),
            wave_dir: PathBuf::from("./waves"),
            port: 8080,
            host: "0.0.0.0".to_string(),
            log_level: "info".to_string(),
            enable_cors: true,
            cors_origin: "*".to_string(),
            max_connections: 1000,
            cache_capacity_mb: 512,
            chunk_size_kb: 64,
            enable_auth: false,
            auth_token: None,
            rate_limit: 100,
            fst_backend: "fstapi".to_string(),
            web_dir: None,
            clear_cache_on_startup: false,
            verbose: false,
            compare_test: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = ServerConfig::default();
        assert_eq!(config.port, 8080);
        assert_eq!(config.host, "0.0.0.0");
        assert!(config.enable_cors);
        assert!(!config.enable_auth);
    }

    #[test]
    fn test_bind_address() {
        let config = ServerConfig::default();
        assert_eq!(config.bind_address(), "0.0.0.0:8080");
    }

    #[test]
    fn test_cache_capacity_bytes() {
        let config = ServerConfig::default();
        assert_eq!(config.cache_capacity_bytes(), 512 * 1024 * 1024);
    }
}
