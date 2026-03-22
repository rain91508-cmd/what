use crate::state::ServerState;
use axum::{extract::State, Json, routing::post};

/// 获取服务器统计信息
pub async fn get_stats(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let stats = state.stats.get_stats().await;
    
    Json(serde_json::json!({
        "status": "success",
        "data": {
            "stats": stats
        },
        "error": null
    }))
}

/// 健康检查端点
pub async fn health_check() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "success",
        "data": {
            "status": "healthy",
            "timestamp": chrono::Utc::now().to_rfc3339()
        },
        "error": null
    }))
}

/// 获取服务器配置信息 (不包含敏感信息)
pub async fn get_config(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let config = &state.config;
    
    Json(serde_json::json!({
        "status": "success",
        "data": {
            "config": {
                "port": config.port,
                "host": config.host,
                "kdb_dir": config.kdb_dir.to_string_lossy(),
                "wave_dir": config.wave_dir.to_string_lossy(),
                "max_connections": config.max_connections,
                "cache_capacity_mb": config.cache_capacity_mb,
                "chunk_size_kb": config.chunk_size_kb,
                "enable_cors": config.enable_cors,
                "enable_auth": config.enable_auth,
                "rate_limit": config.rate_limit,
            }
        },
        "error": null
    }))
}

/// 清除所有缓存
pub async fn clear_cache(State(state): State<ServerState>) -> Json<serde_json::Value> {
    state.clear_all_caches();
    
    Json(serde_json::json!({
        "status": "success",
        "data": {
            "message": "All caches cleared successfully"
        },
        "error": null
    }))
}

/// 清除信号数据缓存
pub async fn clear_signal_data_cache(State(state): State<ServerState>) -> Json<serde_json::Value> {
    state.clear_signal_data_cache();

    Json(serde_json::json!({
        "status": "success",
        "data": {
            "message": "Signal data cache cleared successfully"
        },
        "error": null
    }))
}
