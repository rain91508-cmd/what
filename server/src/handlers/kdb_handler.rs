use crate::error::{Result, ServerError};
use crate::services::KdbService;
use crate::state::ServerState;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;
use tracing::info;

/// 知识库查询参数
#[derive(Debug, Deserialize)]
pub struct KdbQuery {
    /// 知识库名称 (可选，用于特定知识库查询)
    name: Option<String>,
}

/// 获取所有可用的知识库列表
pub async fn list_kdbs(State(state): State<ServerState>) -> Result<Json<serde_json::Value>> {
    state.stats.record_request(crate::state::RequestType::Kdb).await;
    
    let kdb_service = KdbService::new(state.clone());
    let kdbs = kdb_service.list_kdbs().await?;
    
    // 统计有效和无效的知识库
    let total_count = kdbs.len();
    let valid_count = kdbs.iter().filter(|k| k.is_valid).count();
    let invalid_count = total_count - valid_count;

    Ok(Json(serde_json::json!({
        "status": "success",
        "data": {
            "kdbs": kdbs,
            "summary": {
                "total": total_count,
                "valid": valid_count,
                "invalid": invalid_count
            }
        },
        "error": null
    })))
}

/// 获取知识库元信息
pub async fn get_kdb_info(
    State(state): State<ServerState>,
    Path(kdb_name): Path<String>,
) -> Result<Json<serde_json::Value>> {
    state.stats.record_request(crate::state::RequestType::Kdb).await;
    
    let kdb_service = KdbService::new(state.clone());
    let info = kdb_service.get_kdb_info(&kdb_name).await?;

    Ok(Json(serde_json::json!({
        "status": "success",
        "data": {
            "kdb_info": info
        },
        "error": null
    })))
}

/// 获取知识库文件 (支持 HTTP Range)
pub async fn get_kdb_file(
    State(state): State<ServerState>,
    Path(kdb_name): Path<String>,
    headers: HeaderMap,
) -> Result<Response<Body>> {
    state.stats.record_request(crate::state::RequestType::Kdb).await;
    
    let kdb_service = KdbService::new(state.clone());
    
    // 解析 Range 头
    let range = parse_range_header(headers.get("range"))?;
    
    // 读取文件
    let (data, file_size, content_length) = kdb_service
        .read_kdb_file(&kdb_name, range)
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

    info!("返回知识库文件：{} ({} bytes)", kdb_name, file_size);
    Ok(response)
}

/// 解析 HTTP Range 头
fn parse_range_header(range_header: Option<&axum::http::HeaderValue>) -> Result<Option<(u64, Option<u64>)>> {
    match range_header {
        Some(value) => {
            let range_str = value.to_str().map_err(|_| {
                ServerError::InvalidTimeRange("Range 头格式错误".to_string())
            })?;
            
            // 解析 "bytes=start-end" 或 "bytes=start-"
            if !range_str.starts_with("bytes=") {
                return Err(ServerError::InvalidTimeRange(
                    "Range 头必须以 'bytes=' 开头".to_string()
                ));
            }
            
            let range_part = &range_str[6..];
            let parts: Vec<&str> = range_part.split('-').collect();
            
            if parts.len() != 2 {
                return Err(ServerError::InvalidTimeRange(
                    "Range 头格式错误，应为 'bytes=start-end'".to_string()
                ));
            }
            
            let start = parts[0].parse::<u64>().map_err(|_| {
                ServerError::InvalidTimeRange("起始位置必须是数字".to_string())
            })?;
            
            let end = if parts[1].is_empty() {
                None
            } else {
                Some(parts[1].parse::<u64>().map_err(|_| {
                    ServerError::InvalidTimeRange("结束位置必须是数字".to_string())
                })?)
            };
            
            Ok(Some((start, end)))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn test_parse_range_full() {
        let header = HeaderValue::from_static("bytes=0-100");
        let range = parse_range_header(Some(&header)).unwrap();
        assert_eq!(range, Some((0, Some(100))));
    }

    #[test]
    fn test_parse_range_open_ended() {
        let header = HeaderValue::from_static("bytes=50-");
        let range = parse_range_header(Some(&header)).unwrap();
        assert_eq!(range, Some((50, None)));
    }

    #[test]
    fn test_parse_range_none() {
        let range = parse_range_header(None).unwrap();
        assert_eq!(range, None);
    }

    #[test]
    fn test_parse_range_invalid() {
        let header = HeaderValue::from_static("invalid");
        assert!(parse_range_header(Some(&header)).is_err());
    }
}
