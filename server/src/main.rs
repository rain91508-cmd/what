use clap::Parser;
use hwda_server::{
    create_router,
    ServerConfig, ServerState,
};
use tower_http::{
    cors::{Any, CorsLayer},
    limit::RequestBodyLimitLayer,
    trace::TraceLayer,
    services::ServeDir,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// 服务器主入口
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 解析命令行参数
    let config = ServerConfig::parse();

    // 验证配置
    config.validate()?;

    // 初始化日志
    init_logging(&config);

    // 创建服务器状态
    let state = ServerState::new(config.clone());

    // 如果配置了启动时清除缓存，执行清除
    if config.clear_cache_on_startup {
        tracing::info!("启动时清除所有缓存...");
        state.clear_all_caches();
        tracing::info!("所有缓存已清除");
    }

    // 记录启动信息
    tracing::info!("========================================");
    tracing::info!("  硬件设计分析器数据服务器 (HWDA Server)");
    tracing::info!("========================================");
    tracing::info!("");
    tracing::info!("【服务器配置】");
    tracing::info!("  绑定地址：{}", config.bind_address());
    tracing::info!("  日志级别：{}", config.log_level);
    tracing::info!("  CORS 启用：{}", config.enable_cors);
    tracing::info!("  FST 后端：{}", config.fst_backend);
    tracing::info!("");
    tracing::info!("【数据目录】");
    tracing::info!("  知识库目录：{:?}", config.kdb_dir);
    tracing::info!("  波形文件目录：{:?}", config.wave_dir);
    
    // 检查目录是否存在
    if config.kdb_dir.exists() {
        let kdb_count = std::fs::read_dir(&config.kdb_dir)
            .map(|entries| entries.filter(|e| {
                e.as_ref().map(|entry| {
                    entry.path().extension().map(|ext| ext == "kdb").unwrap_or(false)
                }).unwrap_or(false)
            }).count())
            .unwrap_or(0);
        tracing::info!("    - 发现 {} 个 KDB 文件", kdb_count);
    } else {
        tracing::warn!("    - 知识库目录不存在！");
    }
    
    if config.wave_dir.exists() {
        let wave_count = std::fs::read_dir(&config.wave_dir)
            .map(|entries| entries.filter(|e| {
                e.as_ref().map(|entry| {
                    entry.path().extension().map(|ext| ext == "fst").unwrap_or(false)
                }).unwrap_or(false)
            }).count())
            .unwrap_or(0);
        tracing::info!("    - 发现 {} 个 FST 文件", wave_count);
    } else {
        tracing::warn!("    - 波形文件目录不存在！");
    }
    
    // 如果配置了 web 目录，记录信息
    if let Some(ref web_dir) = config.web_dir {
        tracing::info!("  Web 客户端目录：{:?}", web_dir);
        if web_dir.exists() {
            tracing::info!("    - 目录存在");
        } else {
            tracing::warn!("    - 目录不存在！");
        }
    }
    
    tracing::info!("");
    tracing::info!("【缓存配置】");
    tracing::info!("  缓存容量：{} MB", config.cache_capacity_mb);
    tracing::info!("  数据块大小：{} KB", config.chunk_size_kb);
    tracing::info!("");
    tracing::info!("========================================");

    // 创建 CORS 层
    let cors = if config.enable_cors {
        CorsLayer::new()
            .allow_origin(Any) // 生产环境应该限制具体域名
            .allow_methods(Any)
            .allow_headers(Any)
            .expose_headers([
                axum::http::header::CONTENT_LENGTH,
                axum::http::header::CONTENT_RANGE,
                axum::http::header::ACCEPT_RANGES,
            ])
    } else {
        CorsLayer::new() // 使用默认的 CORS 配置
    };

    // 构建 API 路由
    let api_router = create_router(state.clone());
    
    // 构建完整路由（包含静态文件服务）
    let app = if let Some(ref web_dir) = config.web_dir {
        // 如果配置了 web 目录，添加静态文件服务
        // API 路由优先，未匹配的路径尝试从静态文件服务
        api_router
            .fallback_service(ServeDir::new(web_dir))
            .layer(cors)
            .layer(TraceLayer::new_for_http())
            .layer(RequestBodyLimitLayer::new(
                (config.cache_capacity_bytes() / 10) as usize,
            ))
            .with_state(state)
    } else {
        // 没有配置 web 目录，只提供 API 服务
        api_router
            .layer(cors)
            .layer(TraceLayer::new_for_http())
            .layer(RequestBodyLimitLayer::new(
                (config.cache_capacity_bytes() / 10) as usize,
            ))
            .with_state(state)
    };

    // 启动服务器
    let listener = tokio::net::TcpListener::bind(&config.bind_address()).await?;
    tracing::info!("服务器监听：{}", config.bind_address());

    axum::serve(listener, app).await?;

    Ok(())
}

/// 初始化日志系统
fn init_logging(config: &ServerConfig) {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| format!("{}=info,tower_http=debug", config.log_level).into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn test_health_check() {
        let config = ServerConfig::default();
        let state = ServerState::new(config);
        let app = create_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["status"], "success");
        assert!(json["data"]["status"].is_string());
    }

    #[tokio::test]
    async fn test_404() {
        let config = ServerConfig::default();
        let state = ServerState::new(config);
        let app = create_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/nonexistent")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
