use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;
use tracing::error;

/// Server error types
#[derive(Error, Debug)]
pub enum ServerError {
    #[error("KDB not found: {0}")]
    KdbNotFound(String),

    #[error("KDB corrupted: {0}")]
    KdbCorrupted(String),

    #[error("Waveform file not found: {0}")]
    WaveformNotFound(String),

    #[error("Signal not found: {0}")]
    SignalNotFound(String),

    #[error("Invalid LoD level: {0}")]
    InvalidLod(u32),

    #[error("Invalid time range: {0}")]
    InvalidTimeRange(String),

    #[error("Range request not supported: {0}")]
    RangeNotSupported(String),

    #[error("Invalid Range request")]
    InvalidRange,

    #[error("Invalid parameter: {0}")]
    InvalidParameter(String),

    #[error("Invalid request: {0}")]
    InvalidRequest(String),

    #[error("File IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Waveform parse error: {0}")]
    WaveParseError(String),

    #[error("URL parse error: {0}")]
    UrlParseError(#[from] url::ParseError),

    #[error("JSON serialization error: {0}")]
    JsonError(#[from] serde_json::Error),

    #[error("Internal server error: {0}")]
    Internal(String),

    #[error("Configuration error: {0}")]
    ConfigError(String),

    #[error("Invalid chunk format")]
    InvalidChunkFormat,

    #[error("Invalid signal name format")]
    InvalidSignalNameFormat,
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
                format!("LoD level {} is out of range (0-12)", lod),
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
                "Invalid Range request".to_string(),
            ),
            ServerError::InvalidParameter(msg) => {
                (StatusCode::BAD_REQUEST, "INVALID_PARAMETER", msg.clone())
            }
            ServerError::InvalidRequest(msg) => {
                (StatusCode::BAD_REQUEST, "INVALID_REQUEST", msg.clone())
            }
            ServerError::IoError(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "IO_ERROR",
                format!("File operation failed: {}", e),
            ),
            ServerError::WaveParseError(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "WAVE_PARSE_ERROR",
                format!("Waveform parse failed: {}", msg),
            ),
            ServerError::UrlParseError(e) => (
                StatusCode::BAD_REQUEST,
                "URL_PARSE_ERROR",
                format!("URL parse failed: {}", e),
            ),
            ServerError::JsonError(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "JSON_ERROR",
                format!("JSON processing failed: {}", e),
            ),
            ServerError::Internal(msg) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", msg.clone())
            }
            ServerError::ConfigError(msg) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "CONFIG_ERROR", msg.clone())
            }
            ServerError::InvalidChunkFormat => (
                StatusCode::BAD_REQUEST,
                "INVALID_CHUNK_FORMAT",
                "Invalid chunk data format".to_string(),
            ),
            ServerError::InvalidSignalNameFormat => (
                StatusCode::BAD_REQUEST,
                "INVALID_SIGNAL_NAME_FORMAT",
                "Invalid signal name format".to_string(),
            ),
        };

        error!("Server error: {:?} - {}", error_code, message);

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

/// Unified result type
pub type Result<T> = std::result::Result<T, ServerError>;

/// Success response wrapper
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

/// Create a success response
pub fn success<T: serde::Serialize>(data: T) -> SuccessResponse<T> {
    SuccessResponse {
        status: "success".to_string(),
        data,
        error: None,
    }
}
