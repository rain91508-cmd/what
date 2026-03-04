use crate::error::{Result, ServerError};
use crate::services::{FstBackend, WaveService};
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
        "wavefst" => FstBackend::WaveFst,
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
    /// LoD 层级 (0-11)
    lod: Option<u32>,
    /// 起始时间 (time_unit 单位，与波形文件的 time_unit 一致)
    start: i64,
    /// 结束时间 (time_unit 单位，与波形文件的 time_unit 一致)
    end: i64,
    /// 压缩算法 (none, zstd, lz4)
    #[serde(default)]
    compress: Option<String>,
}

/// 获取所有可用的波形文件列表
pub async fn list_waves(
    State(state): State<ServerState>,
    Query(query): Query<WaveListQuery>,
) -> Result<Json<serde_json::Value>> {
    state.stats.record_request(crate::state::RequestType::Wave).await;
    
    let wave_service = WaveService::new(state.clone());
    let mut waves = wave_service.list_waves().await?;

    // 应用分页
    if let Some(offset) = query.offset {
        waves = waves.into_iter().skip(offset).collect();
    }
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
    if lod > 11 {
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

/// 获取多个信号的波形数据（新 API，LoD 在路径中，支持前缀压缩）
/// 
/// # 路径格式
/// - 无前缀: `/api/wave/{waveform}/lod/{lod}/signals/{names}/data`
/// - 有前缀: `/api/wave/{waveform}/lod/{lod}/signals/p:{prefix}/{names}/data`
pub async fn get_wave_data_multi(
    State(state): State<ServerState>,
    Path((waveform_name, lod, signal_pattern)): Path<(String, u32, String)>,
    Query(query): Query<WaveDataQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>> {
    state.stats.record_request(crate::state::RequestType::Wave).await;

    // 验证 LoD 层级
    if lod > 11 {
        return Err(ServerError::InvalidLod(lod));
    }

    // 解析信号模式（支持前缀压缩）
    let (prefix, signal_names) = parse_signal_pattern(&signal_pattern);
    
    // 展开完整信号名
    let full_signal_names: Vec<String> = if let Some(prefix) = prefix {
        signal_names
            .iter()
            .map(|name| format!("{}{}", prefix, name))
            .collect()
    } else {
        signal_names
    };

    info!(
        "获取多信号波形数据: {}.{} (LoD {}, {} 个信号)",
        waveform_name,
        full_signal_names.join(","),
        lod,
        full_signal_names.len()
    );

    let wave_service = create_wave_service(&state);

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
        .get_wave_data_multi(
            &waveform_name,
            &full_signal_names,
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
        "返回多信号波形数据：{} (LoD {}, {} 个信号)",
        waveform_name, lod, full_signal_names.len()
    );
    Ok(response)
}

/// 解析信号模式
/// 
/// # 格式
/// - "clk,reset,data" -> (None, ["clk", "reset", "data"])
/// - "p:cpu_/alu,reg,pc" -> (Some("cpu_"), ["alu", "reg", "pc"])
fn parse_signal_pattern(pattern: &str) -> (Option<String>, Vec<String>) {
    if pattern.starts_with("p:") {
        // 有前缀格式：p:prefix/names
        let rest = &pattern[2..]; // 去掉 "p:"
        if let Some(sep_pos) = rest.find('/') {
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
        let (prefix, names) = parse_signal_pattern("p:cpu_/alu,reg,pc");
        assert_eq!(prefix, Some("cpu_".to_string()));
        assert_eq!(names, vec!["alu", "reg", "pc"]);
    }
}
