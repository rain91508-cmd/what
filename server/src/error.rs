use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;
use tracing::error;

/// 服务器错误类型定义
#[derive(Error, Debug)]
pub enum ServerError {
    #[error("知识库不存在：{0}")]
    KdbNotFound(String),

    #[error("知识库损坏：{0}")]
    KdbCorrupted(String),

    #[error("波形文件不存在：{0}")]
    WaveformNotFound(String),

    #[error("信号不存在：{0}")]
    SignalNotFound(String),

    #[error("无效的 LoD 层级：{0}")]
    InvalidLod(u32),

    #[error("无效的时间范围：{0}")]
    InvalidTimeRange(String),

    #[error("不支持 Range 请求：{0}")]
    RangeNotSupported(String),

    #[error("无效的 Range 请求")]
    InvalidRange,

    #[error("无效的参数：{0}")]
    InvalidParameter(String),

    #[error("文件 IO 错误：{0}")]
    IoError(#[from] std::io::Error),

    #[error("波形解析错误：{0}")]
    WaveParseError(String),

    #[error("URL 解析错误：{0}")]
    UrlParseError(#[from] url::ParseError),

    #[error("JSON 序列化错误：{0}")]
    JsonError(#[from] serde_json::Error),

    #[error("内部服务器错误：{0}")]
    Internal(String),

    #[error("配置错误：{0}")]
    ConfigError(String),
}

impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
        let (status, error_code, message) = match &self {
            ServerError::KdbNotFound(msg) => {
                (StatusCode::NOT_FOUND, "KDB_NOT_FOUND", msg.clone())
            }
            ServerError::KdbCorrupted(msg) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "KDB_CORRUPTED", msg.clone())
            }
            ServerError::WaveformNotFound(msg) => {
                (StatusCode::NOT_FOUND, "WAVEFORM_NOT_FOUND", msg.clone())
            }
            ServerError::SignalNotFound(msg) => {
                (StatusCode::NOT_FOUND, "SIGNAL_NOT_FOUND", msg.clone())
            }
            ServerError::InvalidLod(lod) => (
                StatusCode::BAD_REQUEST,
                "INVALID_LOD",
                format!("LoD 层级 {} 超出范围 (0-11)", lod),
            ),
            ServerError::InvalidTimeRange(msg) => {
                (StatusCode::BAD_REQUEST, "INVALID_TIME_RANGE", msg.clone())
            }
            ServerError::RangeNotSupported(msg) => (
                StatusCode::RANGE_NOT_SATISFIABLE,
                "RANGE_NOT_SUPPORTED",
                msg.clone(),
            ),
            ServerError::InvalidRange => (
                StatusCode::RANGE_NOT_SATISFIABLE,
                "INVALID_RANGE",
                "无效的 Range 请求范围".to_string(),
            ),
            ServerError::InvalidParameter(msg) => (
                StatusCode::BAD_REQUEST,
                "INVALID_PARAMETER",
                msg.clone(),
            ),
            ServerError::IoError(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "IO_ERROR",
                format!("文件操作失败：{}", e),
            ),
            ServerError::WaveParseError(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "WAVE_PARSE_ERROR",
                format!("波形解析失败：{}", msg),
            ),
            ServerError::UrlParseError(e) => (
                StatusCode::BAD_REQUEST,
                "URL_PARSE_ERROR",
                format!("URL 解析失败：{}", e),
            ),
            ServerError::JsonError(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "JSON_ERROR",
                format!("JSON 处理失败：{}", e),
            ),
            ServerError::Internal(msg) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", msg.clone())
            }
            ServerError::ConfigError(msg) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "CONFIG_ERROR", msg.clone())
            }
        };

        error!("服务器错误：{:?} - {}", error_code, message);

        let body = Json(json!({
            "status": "error",
            "data": null,
            "error": {
                "code": error_code,
                "message": message
            }
        }));

        (status, body).into_response()
    }
}

/// 统一的结果类型
pub type Result<T> = std::result::Result<T, ServerError>;

/// 成功响应包装器
#[derive(Debug, serde::Serialize)]
pub struct SuccessResponse<T> {
    pub status: String,
    pub data: T,
    pub error: Option<()>,
}

impl<T: serde::Serialize> IntoResponse for SuccessResponse<T> {
    fn into_response(self) -> Response {
        Json(self).into_response()
    }
}

/// 创建成功响应
pub fn success<T: serde::Serialize>(data: T) -> SuccessResponse<T> {
    SuccessResponse {
        status: "success".to_string(),
        data,
        error: None,
    }
}
