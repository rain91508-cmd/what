pub mod kdb_handler;
pub mod wave_handler;
pub mod stats_handler;

pub use kdb_handler::*;
pub use wave_handler::*;
pub use stats_handler::*;

/// 解码信号名列表（支持 Base64 和 Trie 压缩）
/// 
/// 格式：
/// - b64:base64encodedstring - 普通 Base64 编码
/// - trie:base64encodedstring - Trie 压缩编码
/// 
/// 示例：
/// - b64:dGJfdG9wLmNsa2EscmVzZXQsZGF0YQ==
/// - trie:SGVsbG8gV29ybGQh
pub fn decode_signal_names(encoded: &str) -> Result<Vec<String>, crate::error::ServerError> {
    crate::utils::decode_signals(encoded)
        .map_err(|e| crate::error::ServerError::InvalidParameter(e))
}

/// 编码信号名列表（自动选择 Base64 或 Trie 压缩）
/// 
/// - 单个信号：使用 Base64
/// - 多个信号：使用 Trie 压缩
/// 
/// 格式：
/// - b64:base64encodedstring
/// - trie:base64encodedstring
pub fn encode_signal_names(names: &[String]) -> String {
    crate::utils::encode_signals_with_trie(names)
}

use axum::{
    middleware::from_fn_with_state,
    routing::{get, post},
    Router,
};
use crate::middleware::AuthMiddleware;
use crate::state::ServerState;

/// 创建服务器路由
pub fn create_router(state: ServerState) -> Router<ServerState> {
    // 健康检查和统计路由
    let health_routes = Router::new()
        .route("/health", get(health_check))
        .route("/stats", get(get_stats))
        .route("/config", get(get_config))
        .route("/api/cache/clear", post(clear_cache))
        .route("/api/cache/wave-chunk/clear", post(clear_wave_chunk_cache))
        .route("/api/cache/wave-metadata/clear", post(clear_wave_metadata_cache));

    // 知识库 API 路由
    let kdb_routes = Router::new()
        .route("/api/kdb", get(list_kdbs))
        .route("/api/kdb/:name", get(get_kdb_info))
        .route("/api/kdb/:name/file", get(get_kdb_file));

    // 波形数据 API 路由
    let wave_routes = Router::new()
        .route("/api/wave/list", get(list_waves))
        .route("/api/wave/:waveform_name/info", get(get_wave_info))
        .route("/api/wave/:waveform_name/signals", get(list_wave_signals))
        .route(
            "/api/wave/:waveform_name/signals/:signal_name/info",
            get(get_signal_info),
        )
        // 波形数据 API：支持多信号，LoD、时间范围、压缩算法在路径中
        // 格式：/api/wave/{waveform}/lod/{lod}/time/{start}/{end}/compress/{compress}/signals/{signal_names}/data
        // 示例：/api/wave/riscv2/lod/2/time/0/1000000/compress/zstd/signals/b64:xxx/data
        // 示例（完整波形）：/api/wave/riscv2/lod/2/time/0/-/compress/none/signals/b64:xxx/data
        .route(
            "/api/wave/:waveform_name/lod/:lod/time/:start/:end/compress/:compress/signals/:signal_names/data",
            get(get_wave_data_multi),
        )
        // Tile-based API：获取多个连续的 tiles
        // 格式：/api/wave/{waveform}/lod/{lod}/tile/{start}/{span}/{num}/compress/{compress}/signals/{signal_names}/data
        // 示例：/api/wave/riscv2/lod/2/tile/0/1000000/10/compress/zstd/signals/b64:xxx/data
        .route(
            "/api/wave/:waveform_name/lod/:lod/tile/:start/:span/:num/compress/:compress/signals/:signal_names/data",
            get(get_wave_data_tiles),
        )
        // Pattern Search API：搜索信号值模式
        // 格式：POST /api/wave/{waveform_name}/signals/{signal_names}/pattern-search
        // 示例：POST /api/wave/riscv2/signals/b64:dGJfdG9wLmNsaw==/pattern-search
        .route(
            "/api/wave/:waveform_name/signals/:signal_names/pattern-search",
            post(pattern_search),
        );

    // 合并所有路由
    let app = health_routes
        .merge(kdb_routes)
        .merge(wave_routes)
        .fallback(handler_404);

    // 如果启用认证，添加认证中间件
    if state.config.enable_auth {
        app.layer(from_fn_with_state(state, AuthMiddleware::verify_bearer))
    } else {
        app
    }
}

/// 404 处理器
pub async fn handler_404() -> (axum::http::StatusCode, &'static str) {
    (axum::http::StatusCode::NOT_FOUND, "404 Not Found")
}
