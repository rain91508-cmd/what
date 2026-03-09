use crate::error::{Result, ServerError};
use crate::services::{FstBackend, WaveService, CompressionAlgorithm};
use crate::services::wave_data::{MultiTileChunkSerializer, TileInfo};
use crate::state::ServerState;
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;
use tracing::info;

/// 根据配置创建 WaveService
fn create_wave_service(state: &ServerState) -> WaveService {
    let backend = match state.config.fst_backend.as_str() {
        "fst-reader" => FstBackend::FstReader,
        _ => FstBackend::FstApi,
    };
    WaveService::with_backend(state.clone(), backend)
}

/// 波形列表查询参数
#[derive(Debug, Deserialize)]
pub struct WaveListQuery {
    /// 限制返回数量
    limit: Option<usize>,
    /// 偏移量
    offset: Option<usize>,
}

/// 信号列表查询参数
#[derive(Debug, Deserialize)]
pub struct SignalListQuery {
    /// 限制返回数量
    limit: Option<usize>,
    /// 偏移量
    offset: Option<usize>,
    /// 信号名称正则表达式过滤
    #[serde(default)]
    name_regex: Option<String>,
    /// 起始 handle (包含)
    #[serde(default)]
    handle_from: Option<u32>,
    /// 结束 handle (包含)
    #[serde(default)]
    handle_to: Option<u32>,
}

/// 波形数据查询参数
#[derive(Debug, Deserialize)]
pub struct WaveDataQuery {
    /// LoD 层级 (0-12) - 已移至路径参数，保留用于兼容
    lod: Option<u32>,
    /// 起始时间 (time_unit 单位) - 已移至路径参数
    #[serde(default)]
    start: i64,
    /// 结束时间 (time_unit 单位) - 已移至路径参数
    #[serde(default)]
    end: i64,
    /// 压缩算法 - 已移至路径参数
    #[serde(default)]
    compress: Option<String>,
    /// 时间戳，用于 CDN 缓存刷新（服务器不处理，从波形 info 的 date 字段获取）
    #[serde(default)]
    time_stamp: Option<String>,
}

/// 获取所有可用的波形文件列表
pub async fn list_waves(
    State(state): State<ServerState>,
    Query(query): Query<WaveListQuery>,
) -> Result<Json<serde_json::Value>> {
    state.stats.record_request(crate::state::RequestType::Wave).await;
    
    let wave_service = WaveService::new(state.clone());
    let waves = wave_service.list_waves().await?;
    
    // 应用分页
    let mut waves: Vec<_> = if let Some(offset) = query.offset {
        waves.into_iter().skip(offset).collect()
    } else {
        waves
    };
    
    if let Some(limit) = query.limit {
        waves = waves.into_iter().take(limit).collect();
    }

    Ok(Json(serde_json::json!({
        "status": "success",
        "data": {
            "waves": waves
        },
        "error": null
    })))
}

/// 获取波形文件元信息
pub async fn get_wave_info(
    State(state): State<ServerState>,
    Path(waveform_name): Path<String>,
) -> Result<Json<serde_json::Value>> {
    state.stats.record_request(crate::state::RequestType::Wave).await;
    
    let wave_service = WaveService::new(state.clone());
    let info = wave_service.get_wave_info(&waveform_name).await?;

    Ok(Json(serde_json::json!({
        "status": "success",
        "data": {
            "wave_info": info
        },
        "error": null
    })))
}

/// 获取波形中所有信号列表
pub async fn list_wave_signals(
    State(state): State<ServerState>,
    Path(waveform_name): Path<String>,
    Query(query): Query<SignalListQuery>,
) -> Result<Json<serde_json::Value>> {
    state.stats.record_request(crate::state::RequestType::Wave).await;

    info!("处理信号列表请求: waveform={}, query={:?}", waveform_name, query);

    let wave_service = create_wave_service(&state);
    info!("WaveService 创建成功, 后端: {:?}", wave_service.backend());

    let mut signals = wave_service.list_signals(&waveform_name).await?;
    info!("获取到 {} 个信号", signals.len());

    // 应用名称正则过滤
    if let Some(regex_pattern) = &query.name_regex {
        match regex::Regex::new(regex_pattern) {
            Ok(regex) => {
                signals.retain(|s| regex.is_match(&s.name));
                info!("正则过滤后剩余 {} 个信号", signals.len());
            }
            Err(e) => {
                return Err(crate::error::ServerError::InvalidParameter(format!(
                    "无效的正则表达式: {}",
                    e
                )));
            }
        }
    }

    // 应用 handle 范围过滤
    if let Some(handle_from) = query.handle_from {
        signals.retain(|s| s.handle >= handle_from);
    }
    if let Some(handle_to) = query.handle_to {
        signals.retain(|s| s.handle <= handle_to);
    }

    // 应用分页
    if let Some(offset) = query.offset {
        signals = signals.into_iter().skip(offset).collect();
    }
    if let Some(limit) = query.limit {
        signals = signals.into_iter().take(limit).collect();
    }

    Ok(Json(serde_json::json!({
        "status": "success",
        "data": {
            "waveform_name": waveform_name,
            "signal_count": signals.len(),
            "signals": signals
        },
        "error": null
    })))
}

/// 获取波形中指定信号的元信息
pub async fn get_signal_info(
    State(state): State<ServerState>,
    Path((waveform_name, signal_name)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    state.stats.record_request(crate::state::RequestType::Wave).await;
    
    // URL 解码信号名
    let signal_name = urlencoding::decode(&signal_name)
        .map_err(|_| crate::error::ServerError::SignalNotFound(signal_name.clone()))?
        .to_string();

    let wave_service = WaveService::new(state.clone());
    let info = wave_service.get_signal_info(&waveform_name, &signal_name).await?;

    Ok(Json(serde_json::json!({
        "status": "success",
        "data": info,
        "error": null
    })))
}

/// 获取波形数据 (支持 HTTP Range 和 LoD)
pub async fn get_wave_data(
    State(state): State<ServerState>,
    Path((waveform_name, signal_name)): Path<(String, String)>,
    Query(query): Query<WaveDataQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>> {
    state.stats.record_request(crate::state::RequestType::Wave).await;
    
    // URL 解码信号名
    let signal_name = urlencoding::decode(&signal_name)
        .map_err(|_| crate::error::ServerError::SignalNotFound(signal_name.clone()))?
        .to_string();

    let wave_service = WaveService::new(state.clone());
    
    // 验证 LoD 层级
    let lod = query.lod.unwrap_or(0);
    if lod > 32 {
        return Err(crate::error::ServerError::InvalidLod(lod));
    }

    // 解析压缩算法
    let compression = match query.compress.as_deref() {
        Some("zstd") => crate::services::CompressionAlgorithm::Zstd,
        Some("lz4") => crate::services::CompressionAlgorithm::Lz4,
        _ => crate::services::CompressionAlgorithm::None,
    };

    // 解析 Range 头
    let range = parse_range_header(headers.get("range"))?;
    
    // 获取波形数据
    let (data, file_size, content_length) = wave_service
        .get_wave_data(
            &waveform_name,
            &signal_name,
            lod,
            query.start,
            query.end,
            range,
            compression,
        )
        .await?;

    // 构建响应
    let body = Body::from(data);
    let mut response = Response::new(body);
    
    // 设置 Content-Type
    response.headers_mut().insert(
        "content-type",
        "application/octet-stream".parse().unwrap(),
    );
    
    // 设置 Content-Length
    if let Some(len) = content_length {
        response
            .headers_mut()
            .insert("content-length", len.to_string().parse().unwrap());
    }
    
    // 设置 Accept-Ranges
    response
        .headers_mut()
        .insert("accept-ranges", "bytes".parse().unwrap());

    // 如果有 Range 请求，返回 206 Partial Content
    if let Some((start, end)) = range {
        let end_str = end.map(|e| e.to_string()).unwrap_or_default();
        response.headers_mut().insert(
            "content-range",
            format!("bytes {}-{}/{}", start, end_str, file_size)
                .parse()
                .unwrap(),
        );
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    }

    info!(
        "返回波形数据：{}.{} (LoD {}, {}-{} ps)",
        waveform_name, signal_name, lod, query.start, query.end
    );
    Ok(response)
}

/// 解析 HTTP Range 头
fn parse_range_header(
    range_header: Option<&axum::http::HeaderValue>,
) -> Result<Option<(u64, Option<u64>)>> {
    match range_header {
        Some(value) => {
            let range_str = value.to_str().map_err(|_| {
                crate::error::ServerError::InvalidTimeRange("Range 头格式错误".to_string())
            })?;
            
            if !range_str.starts_with("bytes=") {
                return Err(crate::error::ServerError::InvalidTimeRange(
                    "Range 头必须以 'bytes=' 开头".to_string(),
                ));
            }
            
            let range_part = &range_str[6..];
            let parts: Vec<&str> = range_part.split('-').collect();
            
            if parts.len() != 2 {
                return Err(crate::error::ServerError::InvalidTimeRange(
                    "Range 头格式错误，应为 'bytes=start-end'".to_string(),
                ));
            }
            
            let start = parts[0].parse::<u64>().map_err(|_| {
                crate::error::ServerError::InvalidTimeRange("起始位置必须是数字".to_string())
            })?;
            
            let end = if parts[1].is_empty() {
                None
            } else {
                Some(parts[1].parse::<u64>().map_err(|_| {
                    crate::error::ServerError::InvalidTimeRange("结束位置必须是数字".to_string())
                })?)
            };
            
            Ok(Some((start, end)))
        }
        None => Ok(None),
    }
}

/// 获取多个信号的波形数据（LoD、时间范围、压缩算法在路径中）
/// 
/// # 路径格式
/// `/api/wave/{waveform}/lod/{lod}/time/{start}/{end}/compress/{compress}/signals/{names}/data`
/// 
/// # 查询参数
/// - `time_stamp`: 可选，用于 CDN 缓存刷新（服务器不处理）
/// 
/// # 示例
/// - `/api/wave/riscv2/lod/2/time/0/1000000/compress/zstd/signals/b64:xxx/data`
/// - `/api/wave/riscv2/lod/2/time/0/-/compress/none/signals/b64:xxx/data?time_stamp=123456`
pub async fn get_wave_data_multi(
    State(state): State<ServerState>,
    Path((waveform_name, lod, start_str, end_str, compress_str, signal_names)): Path<(String, u32, String, String, String, String)>,
    Query(query): Query<WaveDataQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>> {
    state.stats.record_request(crate::state::RequestType::Wave).await;

    // 验证 LoD 层级
    if lod > 32 {
        return Err(ServerError::InvalidLod(lod));
    }

    // 解析时间范围
    let start_time = if start_str == "-" {
        0
    } else {
        start_str.parse::<i64>()
            .map_err(|_| ServerError::InvalidParameter(format!("Invalid start time: {}", start_str)))?
    };
    
    let end_time = if end_str == "-" {
        -1 // 表示到文件结束
    } else {
        end_str.parse::<i64>()
            .map_err(|_| ServerError::InvalidParameter(format!("Invalid end time: {}", end_str)))?
    };

    // URL 解码信号名
    let signal_names = urlencoding::decode(&signal_names)
        .map_err(|_| ServerError::SignalNotFound(signal_names.clone()))?
        .to_string();

    // 解析信号名列表（支持 Base64 编码整个列表）
    let full_signal_names = crate::handlers::decode_signal_names(&signal_names)?;

    // time_stamp 查询参数仅用于 CDN 缓存刷新，服务器不处理
    // 客户端应从波形 info 的 date 字段获取
    let _time_stamp = query.time_stamp.as_deref().unwrap_or("");

    info!(
        "获取多信号波形数据: {}.{} (LoD {}, time {}-{}, compress {}, {} 个信号)",
        waveform_name,
        full_signal_names.join(","),
        lod,
        start_time,
        end_time,
        compress_str,
        full_signal_names.len()
    );

    let wave_service = create_wave_service(&state);

    // 解析压缩算法（从路径参数）
    let compression = match compress_str.as_str() {
        "zstd" => crate::services::CompressionAlgorithm::Zstd,
        "lz4" => crate::services::CompressionAlgorithm::Lz4,
        _ => crate::services::CompressionAlgorithm::None,
    };

    // 解析 Range 头
    let range = parse_range_header(headers.get("range"))?;

    // 获取波形数据
    let (data, file_size, content_length) = wave_service
        .get_wave_data_multi(
            &waveform_name,
            &full_signal_names,
            lod,
            start_time,
            end_time,
            range,
            compression,
        )
        .await?;

    // 构建响应
    let body = Body::from(data);
    let mut response = Response::new(body);

    // 设置 Content-Type
    response.headers_mut().insert(
        "content-type",
        "application/octet-stream".parse().unwrap(),
    );

    // 设置 CDN 缓存头
    response.headers_mut().insert(
        "cache-control",
        "public, max-age=3600, immutable".parse().unwrap(),
    );

    // 设置 Content-Length
    if let Some(len) = content_length {
        response
            .headers_mut()
            .insert("content-length", len.to_string().parse().unwrap());
    }

    // 设置 Accept-Ranges
    response
        .headers_mut()
        .insert("accept-ranges", "bytes".parse().unwrap());

    // 如果有 Range 请求，返回 206 Partial Content
    if let Some((start, end)) = range {
        let end_str = end.map(|e| e.to_string()).unwrap_or_default();
        response.headers_mut().insert(
            "content-range",
            format!("bytes {}-{}/{}", start, end_str, file_size)
                .parse()
                .unwrap(),
        );
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    }

    info!(
        "返回多信号波形数据：{} (LoD {}, time {}-{}, compress {}, {} 个信号)",
        waveform_name, lod, start_time, end_time, compress_str, full_signal_names.len()
    );
    Ok(response)
}

/// 获取多个信号的波形数据（Tile-based 模式）
///
/// # 路径格式
/// `/api/wave/{waveform}/lod/{lod}/tile/{start}/{span}/{num}/compress/{compress}/signals/{names}/data`
///
/// # 参数说明
/// - `start`: 第一个 tile 的起始时间
/// - `span`: 每个 tile 的时间跨度
/// - `num`: tile 数量（1-100）
///
/// # 与 time 模式的区别
/// - time 模式: 获取单个时间范围的波形数据
/// - tile 模式: 获取多个连续的 tile，每个 tile 是一个独立的时间范围
///
/// # 示例
/// - `/api/wave/riscv2/lod/2/tile/0/1000000/10/compress/zstd/signals/b64:xxx/data`
///   获取 10 个 tiles，每个 tile 1000000 时间单位，从时间 0 开始
pub async fn get_wave_data_tiles(
    State(state): State<ServerState>,
    Path((waveform_name, lod, start_time, tile_span, num_tiles, compress_str, signal_names)): Path<(String, u32, u64, u64, usize, String, String)>,
    Query(query): Query<WaveDataQuery>,
) -> Result<Response<Body>> {
    state.stats.record_request(crate::state::RequestType::Wave).await;

    // 验证 LoD 层级
    if lod > 32 {
        return Err(ServerError::InvalidLod(lod));
    }

    // 解码信号名
    let full_signal_names: Vec<String> = if signal_names.starts_with("b64:") {
        // Base64 编码
        let b64_part = &signal_names[4..];
        match base64::decode(b64_part) {
            Ok(decoded) => {
                let decoded_str = String::from_utf8_lossy(&decoded);
                decoded_str.split(',').map(|s| s.to_string()).collect()
            }
            Err(_) => return Err(ServerError::InvalidSignalNameFormat),
        }
    } else if signal_names.starts_with("trie:") {
        // Trie 压缩编码
        match crate::utils::trie::decode_signals(&signal_names) {
            Ok(signals) => signals,
            Err(_) => return Err(ServerError::InvalidSignalNameFormat),
        }
    } else {
        // 普通逗号分隔
        signal_names.split(',').map(|s| s.to_string()).collect()
    };

    if full_signal_names.is_empty() {
        return Err(ServerError::SignalNotFound("No signals specified".to_string()));
    }

    // 解析压缩算法
    let compression = match compress_str.as_str() {
        "zstd" => crate::services::CompressionAlgorithm::Zstd,
        "lz4" => crate::services::CompressionAlgorithm::Lz4,
        _ => crate::services::CompressionAlgorithm::None,
    };

    // 获取波形数据
    let wave_service = crate::services::WaveService::new(state.clone());
    let (data, file_size) = wave_service
        .get_wave_data_tiles(
            &waveform_name,
            &full_signal_names,
            lod,
            start_time,
            tile_span,
            num_tiles,
            compression,
        )
        .await?;

    // 构建响应
    let content_length = data.len();
    let body = Body::from(data);
    let mut response = Response::new(body);

    // 设置 Content-Type
    response.headers_mut().insert(
        "content-type",
        "application/octet-stream".parse().unwrap(),
    );

    // 设置 CDN 缓存头
    response.headers_mut().insert(
        "cache-control",
        "public, max-age=3600, immutable".parse().unwrap(),
    );

    // 设置 Content-Length
    response
        .headers_mut()
        .insert("content-length", content_length.to_string().parse().unwrap());

    // 设置 Accept-Ranges
    response
        .headers_mut()
        .insert("accept-ranges", "bytes".parse().unwrap());

    info!(
        "返回多信号 Tile 数据：{} (LoD {}, tiles={}×{}, compress {}, {} 个信号, {} bytes)",
        waveform_name, lod, num_tiles, tile_span, compress_str, full_signal_names.len(), content_length
    );
    Ok(response)
}

/// 解析信号模式
/// 
/// # 格式
/// - "clk,reset,data" -> (None, ["clk", "reset", "data"])
/// - "p:cpu_/alu,reg,pc" -> (Some("cpu_"), ["alu", "reg", "pc"])
fn parse_signal_pattern(pattern: &str) -> (Option<String>, Vec<String>) {
    if pattern.starts_with("pfx~") {
        // 有前缀格式：pfx~prefix~names
        let rest = &pattern[4..]; // 去掉 "pfx~"
        if let Some(sep_pos) = rest.find('~') {
            let prefix = rest[..sep_pos].to_string();
            let names: Vec<String> = rest[sep_pos + 1..]
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            (Some(prefix), names)
        } else {
            // 格式错误，当作普通名称处理
            let names: Vec<String> = pattern
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            (None, names)
        }
    } else {
        // 无前缀格式：names
        let names: Vec<String> = pattern
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        (None, names)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wave_data_query_deserialize() {
        let json = r#"{"lod": 2, "start": 0, "end": 1000000}"#;
        let query: WaveDataQuery = serde_json::from_str(json).unwrap();
        assert_eq!(query.lod, Some(2));
        assert_eq!(query.start, 0);
        assert_eq!(query.end, 1000000);
    }

    #[test]
    fn test_wave_data_query_default_lod() {
        let json = r#"{"start": 0, "end": 1000000}"#;
        let query: WaveDataQuery = serde_json::from_str(json).unwrap();
        assert_eq!(query.lod, None);
    }

    #[test]
    fn test_parse_signal_pattern_no_prefix() {
        let (prefix, names) = parse_signal_pattern("clk,reset,data");
        assert_eq!(prefix, None);
        assert_eq!(names, vec!["clk", "reset", "data"]);
    }

    #[test]
    fn test_parse_signal_pattern_with_prefix() {
        let (prefix, names) = parse_signal_pattern("pfx~cpu_~alu,reg,pc");
        assert_eq!(prefix, Some("cpu_".to_string()));
        assert_eq!(names, vec!["alu", "reg", "pc"]);
    }
}
