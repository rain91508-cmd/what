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

    // 记录启动信息（使用 println 确保在控制台可见）
    println!("");
    println!("========================================");
    println!("  硬件设计分析器数据服务器 (HWDA Server)");
    println!("========================================");
    println!("");
    println!("【服务器配置】");
    println!("  绑定地址：{}", config.bind_address());
    println!("  日志级别：{}", config.log_level);
    println!("  详细调试：{}", if config.verbose { "启用" } else { "禁用" });
    println!("  CORS 启用：{}", config.enable_cors);
    println!("  FST 后端：{}", config.fst_backend);
    
    // 同时记录到 tracing
    tracing::info!("========================================");
    tracing::info!("  硬件设计分析器数据服务器 (HWDA Server)");
    tracing::info!("========================================");
    tracing::info!("");
    tracing::info!("【服务器配置】");
    tracing::info!("  绑定地址：{}", config.bind_address());
    tracing::info!("  日志级别：{}", config.log_level);
    tracing::info!("  详细调试：{}", if config.verbose { "启用" } else { "禁用" });
    tracing::info!("  CORS 启用：{}", config.enable_cors);
    tracing::info!("  FST 后端：{}", config.fst_backend);
    println!("");
    println!("【数据目录】");
    println!("  知识库目录：{:?}", config.kdb_dir);
    println!("  波形文件目录：{:?}", config.wave_dir);
    
    // 检查目录是否存在
    if config.kdb_dir.exists() {
        let kdb_count = std::fs::read_dir(&config.kdb_dir)
            .map(|entries| entries.filter(|e| {
                e.as_ref().map(|entry| {
                    entry.path().extension().map(|ext| ext == "kdb").unwrap_or(false)
                }).unwrap_or(false)
            }).count())
            .unwrap_or(0);
        println!("    - 发现 {} 个 KDB 文件", kdb_count);
    } else {
        println!("    - 知识库目录不存在！");
    }
    
    if config.wave_dir.exists() {
        let wave_count = std::fs::read_dir(&config.wave_dir)
            .map(|entries| entries.filter(|e| {
                e.as_ref().map(|entry| {
                    entry.path().extension().map(|ext| ext == "fst").unwrap_or(false)
                }).unwrap_or(false)
            }).count())
            .unwrap_or(0);
        println!("    - 发现 {} 个 FST 文件", wave_count);
    } else {
        println!("    - 波形文件目录不存在！");
    }
    
    // 如果配置了 web 目录，记录信息
    if let Some(ref web_dir) = config.web_dir {
        println!("  Web 客户端目录：{:?}", web_dir);
        if web_dir.exists() {
            println!("    - 目录存在");
        } else {
            println!("    - 目录不存在！");
        }
    }
    
    println!("");
    println!("【缓存配置】");
    println!("  缓存容量：{} MB", config.cache_capacity_mb);
    println!("  数据块大小：{} KB", config.chunk_size_kb);
    println!("");
    println!("========================================");
    println!("  服务器启动中...");
    println!("========================================");
    println!("");

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

    // 如果启用对比测试模式，不启动服务器，直接运行测试
    if config.compare_test {
        println!("\n========================================");
        println!("  对比测试模式：fst-reader vs fstapi");
        println!("========================================\n");
        
        // 运行对比测试，完成后立即退出
        hwda_server::compare_test::run_compare_test(&config).await;
        println!("\n========================================");
        println!("  对比测试完成，退出程序");
        println!("========================================");
        return Ok(());
    }

    // 如果启用 LoD 20 测试模式
    if config.lod20_test {
        println!("\n========================================");
        println!("  LoD 20 专项测试模式");
        println!("========================================\n");
        
        // 运行 LoD 20 测试，完成后立即退出
        hwda_server::compare_test_lod20::run_lod20_test(&config).await;
        println!("\n========================================");
        println!("  LoD 20 测试完成，退出程序");
        println!("========================================");
        return Ok(());
    }

    // 启动服务器
    let listener = tokio::net::TcpListener::bind(&config.bind_address()).await?;
    tracing::info!("服务器监听：{}", config.bind_address());

    axum::serve(listener, app).await?;

    Ok(())
}

/// 初始化日志系统
fn init_logging(config: &ServerConfig) {
    // 根据 log_level 和 verbose 选项设置日志过滤器
    let filter = if config.log_level == "debug" && config.verbose {
        // verbose 模式：显示所有 debug 信息
        format!("{}=debug,tower_http=debug", env!("CARGO_PKG_NAME"))
    } else {
        // 普通模式：只显示 info 及以上级别
        format!("{}=info,tower_http=info", env!("CARGO_PKG_NAME"))
    };
    
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| filter.into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
}
