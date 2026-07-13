//! 硬件设计分析器数据服务器
//!
//! 这是一个基于 Axum 框架的高性能 HTTP 服务器，用于提供硬件设计数据服务。
//!
//! # 架构
//!
//! 服务器采用分层架构:
//!
//! - **handlers**: HTTP 请求处理器，负责解析请求和构建响应
//! - **services**: 业务逻辑层，实现核心功能 (知识库管理、波形数据处理)
//! - **middleware**: 中间件层，提供认证、日志等功能
//! - **state**: 服务器状态管理，包含配置和缓存
//!
//! # 主要功能
//!
//! - 知识库 (KDB) 文件管理
//! - FST 波形数据读取和 LoD 处理
//! - HTTP Range 请求支持
//! - 多级缓存 (内存 LRU + OPFS 准备)
//! - CORS、认证、限流等中间件
//!
//! # 示例
//!
//! ```no_run
//! use what_server::{ServerConfig, ServerState, create_router};
//! use axum::serve;
//! use tokio::net::TcpListener;
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = ServerConfig::parse();
//!     let state = ServerState::new(config.clone());
//!     let app = create_router(state);
//!
//!     let listener = TcpListener::bind(&config.bind_address()).await?;
//!     serve(listener, app).await?;
//!     Ok(())
//! }
//! ```

pub mod config;
pub mod error;
pub mod handlers;
pub mod middleware;
pub mod services;
pub mod state;
pub mod utils;

// 对比测试模块
pub mod compare_test;
pub mod compare_test_lod20;

// 重新导出常用类型
pub use config::ServerConfig;
pub use error::{Result, ServerError, success, SuccessResponse};
pub use handlers::{create_router, handler_404};
pub use services::{KdbService, WaveService, FstBackend};
pub use state::{ServerState, ServerStats, TimeRange, WaveMetadata};

// 重新导出 handlers 中的具体处理器
pub use handlers::{
    list_kdbs, get_kdb_info, get_kdb_file,
    list_waves, list_wave_signals, get_signal_info, get_wave_data,
    get_stats, get_config, health_check,
};

/// 服务器版本
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// 服务器名称
pub const SERVER_NAME: &str = "WHAT-Server";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version() {
        assert!(!VERSION.is_empty());
    }

    #[test]
    fn test_server_name() {
        assert_eq!(SERVER_NAME, "WHAT-Server");
    }
}
