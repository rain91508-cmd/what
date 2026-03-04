pub mod kdb_handler;
pub mod wave_handler;
pub mod stats_handler;

pub use kdb_handler::*;
pub use wave_handler::*;
pub use stats_handler::*;

use axum::{
    middleware::from_fn_with_state,
    routing::get,
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
        .route("/config", get(get_config));

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
        // 波形数据 API：支持多信号，LoD 在路径中，支持前缀压缩
        // 格式：/api/wave/{waveform}/lod/{lod}/signals/{signal_pattern}/data
        // 示例：/api/wave/riscv2/lod/2/signals/clk,reset,data/data
        // 示例（有前缀）：/api/wave/riscv2/lod/2/signals/p:cpu_/alu,reg,pc/data
        .route(
            "/api/wave/:waveform_name/lod/:lod/signals/:signal_pattern/data",
            get(get_wave_data_multi),
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
