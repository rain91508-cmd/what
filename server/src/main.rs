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
        run_compare_test(&config).await;
        println!("\n========================================");
        println!("  对比测试完成，退出程序");
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

/// 运行 fst-reader 与 fstapi 对比测试
async fn run_compare_test(config: &ServerConfig) {
    use std::path::PathBuf;
    use hwda_server::services::{WaveService, FstBackend, LodLevel};
    
    // 固定使用 riscv2.fst 波形文件
    let wave_name = "riscv2";
    println!("[COMPARE-TEST] 使用波形文件: {}", wave_name);
    
    // 获取信号列表 - 使用 fstapi 获取
    let state = ServerState::new(config.clone());
    let api_service = WaveService::with_backend(state.clone(), FstBackend::FstApi);
    
    let signals = match api_service.list_signals(wave_name).await {
        Ok(s) => s,
        Err(e) => {
            println!("[COMPARE-TEST] 获取信号列表失败 (fstapi): {:?}", e);
            return;
        }
    };
    
    if signals.is_empty() {
        println!("[COMPARE-TEST] 未找到信号");
        return;
    }
    
    // 显示前 10 个信号名称
    println!("[COMPARE-TEST] fstapi 获取的信号列表 (前10个):");
    for (i, sig) in signals.iter().take(10).enumerate() {
        println!("[COMPARE-TEST]   {}. {}", i, sig.name);
    }
    
    // 选取前 2 个信号
    let test_signals: Vec<String> = signals.iter().take(2).map(|s| s.name.clone()).collect();
    println!("[COMPARE-TEST] 测试信号: {:?}", test_signals);
    
    // 获取波形信息 - 使用 fstapi
    let wave_info = match api_service.get_wave_info(wave_name).await {
        Ok(w) => w,
        Err(e) => {
            println!("[COMPARE-TEST] 获取波形信息失败: {:?}", e);
            return;
        }
    };
    
    let end_time = wave_info.end_time;
    println!("[COMPARE-TEST] 波形结束时间: {}", end_time);
    
    // 创建 fst-reader 服务
    let reader_service = WaveService::with_backend(state.clone(), FstBackend::FstReader);
    
    println!("\n[COMPARE-TEST] 开始对比测试...\n");
    
    // 测试不同的 LoD 值，每个 LoD 测试 10 个随机时间段
    let test_cases = vec![
        (0u32, 256usize),   // LoD 0: 原始数据
        (8u32, 256usize),   // LoD 8: bucket_size = 256
        (12u32, 256usize),  // LoD 12: bucket_size = 4096
    ];
    
    // 伪随机数生成器
    let mut rng_state: u64 = 12345;
    let mut next_rand = || {
        rng_state = rng_state.wrapping_mul(1103515245).wrapping_add(12345);
        (rng_state >> 16) as u64
    };
    
    for (lod, num_buckets) in test_cases {
        let bucket_size = 2u64.pow(lod);
        let tile_span = bucket_size * num_buckets as u64;
        
        println!("\n[COMPARE-TEST] ===== LoD={} 测试 (bucket_size={}, tile_span={}) =====", 
            lod, bucket_size, tile_span);
        
        // 测试 10 个随机时间段，在波形范围内平均分布
        for test_idx in 0..10 {
            // 将波形总长度分成 10 个区间，在每个区间内随机选择起点
            let segment_size = end_time / 10;
            let segment_start = test_idx as u64 * segment_size;
            let segment_end = ((test_idx + 1) as u64 * segment_size).min(end_time - tile_span);
            
            // 在该区间内随机选择 start_time
            let start_time = if segment_end > segment_start {
                segment_start + (next_rand() % (segment_end - segment_start))
            } else {
                segment_start
            };
            
            let num_tiles = 1usize;
            
            println!("\n[COMPARE-TEST] LoD={} 测试 {}/10: start={}, span={}, tiles={}", 
                lod, test_idx + 1, start_time, tile_span, num_tiles);
            
            // 使用 fst-reader 读取
            let reader_tiles = match reader_service.get_wave_data_tiles(
                &wave_name, 
                &test_signals, 
                lod, 
                start_time, 
                tile_span, 
                num_tiles,
                hwda_server::services::CompressionAlgorithm::None,
            ).await {
                Ok(d) => d.0,
                Err(e) => {
                    println!("[COMPARE-TEST] fst-reader 读取失败 (LoD={}, test={}): {:?}", lod, test_idx, e);
                    continue;
                }
            };
            
            // 使用 fstapi 读取
            let api_tiles = match api_service.get_wave_data_tiles(
                &wave_name, 
                &test_signals, 
                lod, 
                start_time, 
                tile_span, 
                num_tiles,
                hwda_server::services::CompressionAlgorithm::None,
            ).await {
                Ok(d) => d.0,
                Err(e) => {
                    println!("[COMPARE-TEST] fstapi 读取失败 (LoD={}, test={}): {:?}", lod, test_idx, e);
                    continue;
                }
            };
            
            // 解析并对比数据包
            compare_tile_data(&reader_tiles, &api_tiles, test_idx);
        }
    }
    
    println!("\n[COMPARE-TEST] 所有对比测试完成!");
}

/// 解析并对比 tile 数据包
fn compare_tile_data(reader_data: &[u8], api_data: &[u8], test_idx: usize) -> bool {
    // 首先检查数据包大小
    let size_match = reader_data.len() == api_data.len();
    
    if size_match {
        // 大小匹配，简单输出成功
        println!("[COMPARE-TEST] 测试 {}: ✓ 通过 ({} bytes)", test_idx, reader_data.len());
        return true;
    }
    
    // 大小不匹配，显示详细信息
    println!("\n[COMPARE-TEST] ----- 测试 {}: ✗ 失败 -----", test_idx);
    println!("[COMPARE-TEST] 数据包大小对比:");
    println!("  reader: {} bytes", reader_data.len());
    println!("  api:    {} bytes", api_data.len());
    
    if reader_data.len() < 32 || api_data.len() < 32 {
        println!("[COMPARE-TEST] 数据太短，无法解析");
        return false;
    }
    
    // 解析 ChunkHeader (简化版)
    let reader_magic = u32::from_le_bytes([reader_data[0], reader_data[1], reader_data[2], reader_data[3]]);
    let api_magic = u32::from_le_bytes([api_data[0], api_data[1], api_data[2], api_data[3]]);
    
    println!("[COMPARE-TEST] 魔数对比:");
    println!("  reader: 0x{:08x}", reader_magic);
    println!("  api:    0x{:08x}", api_magic);
    
    // 解析更多 header 字段
    let reader_level = u16::from_le_bytes([reader_data[6], reader_data[7]]);
    let api_level = u16::from_le_bytes([api_data[6], api_data[7]]);
    
    let reader_time_start = u64::from_le_bytes([reader_data[16], reader_data[17], reader_data[18], reader_data[19], reader_data[20], reader_data[21], reader_data[22], reader_data[23]]);
    let api_time_start = u64::from_le_bytes([api_data[16], api_data[17], api_data[18], api_data[19], api_data[20], api_data[21], api_data[22], api_data[23]]);
    
    let reader_time_end = u64::from_le_bytes([reader_data[24], reader_data[25], reader_data[26], reader_data[27], reader_data[28], reader_data[29], reader_data[30], reader_data[31]]);
    let api_time_end = u64::from_le_bytes([api_data[24], api_data[25], api_data[26], api_data[27], api_data[28], api_data[29], api_data[30], api_data[31]]);
    
    println!("[COMPARE-TEST] Header 字段对比:");
    println!("  level: reader={}, api={}", reader_level, api_level);
    println!("  time_start: reader={}, api={}", reader_time_start, api_time_start);
    println!("  time_end: reader={}, api={}", reader_time_end, api_time_end);
    
    // 尝试解析并对比 transition 数据
    compare_detailed_data(reader_data, api_data);
    
    false
}

/// 详细对比数据包内容
fn compare_detailed_data(reader_data: &[u8], api_data: &[u8]) {
    use hwda_server::services::wave_data::ChunkSerializer;
    
    // 尝试反序列化数据包
    let reader_result = ChunkSerializer::deserialize(reader_data);
    let api_result = ChunkSerializer::deserialize(api_data);
    
    match (reader_result, api_result) {
        (Ok((reader_header, reader_signals)), Ok((api_header, api_signals))) => {
            println!("[COMPARE-TEST] Header 对比:");
            println!("  reader: lod={}, signals={}, time_start={}, time_end={}",
                reader_header.level, reader_header.signal_count, reader_header.time_start, reader_header.time_end);
            println!("  api:    lod={}, signals={}, time_start={}, time_end={}",
                api_header.level, api_header.signal_count, api_header.time_start, api_header.time_end);
            
            println!("[COMPARE-TEST] 信号数量对比:");
            println!("  reader: {} 个信号", reader_signals.len());
            println!("  api:    {} 个信号", api_signals.len());
            
            for (i, ((r_header, r_trans), (a_header, a_trans))) in reader_signals.iter().zip(api_signals.iter()).enumerate() {
                println!("[COMPARE-TEST] 信号 {} (handle={}):", i, r_header.signal_handle);
                println!("  reader: {} transitions", r_trans.len());
                println!("  api:    {} transitions", a_trans.len());
                
                // 显示前几个 transition
                let min_len = r_trans.len().min(a_trans.len()).min(5);
                for j in 0..min_len {
                    println!("    transition[{}]: reader(time={}, value={:?}) vs api(time={}, value={:?})",
                        j, r_trans[j].time, r_trans[j].value,
                        a_trans[j].time, a_trans[j].value);
                }
                
                // 显示多余的 transitions
                if r_trans.len() > a_trans.len() {
                    println!("  reader 多余的 transitions:");
                    for j in a_trans.len()..r_trans.len().min(a_trans.len() + 5) {
                        println!("    transition[{}]: time={}, value={:?}",
                            j, r_trans[j].time, r_trans[j].value);
                    }
                }
                if a_trans.len() > r_trans.len() {
                    println!("  api 多余的 transitions:");
                    for j in r_trans.len()..a_trans.len().min(r_trans.len() + 5) {
                        println!("    transition[{}]: time={}, value={:?}",
                            j, a_trans[j].time, a_trans[j].value);
                    }
                }
            }
        }
        (Err(e), _) => println!("[COMPARE-TEST] 反序列化 reader 数据失败: {:?}", e),
        (_, Err(e)) => println!("[COMPARE-TEST] 反序列化 api 数据失败: {:?}", e),
    }
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
