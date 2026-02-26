use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::body::Body;
use std::time::Instant;
use tracing::{debug, error, info, warn};

/// 请求日志中间件层
pub struct RequestLoggerLayer;

impl RequestLoggerLayer {
    /// 记录请求和响应信息
    pub async fn log_request(
        request: Request<Body>,
        next: Next,
    ) -> Result<Response, StatusCode> {
        let method = request.method().clone();
        let uri = request.uri().clone();
        let start = Instant::now();

        // 记录请求
        debug!("请求：{} {}", method, uri);

        // 处理请求
        let response = next.run(request).await;

        // 计算耗时
        let duration = start.elapsed();
        let status = response.status();

        // 记录响应
        match status.as_u16() {
            200..=299 => info!("响应：{} {} {} - {:?}", method, uri, status, duration),
            300..=399 => debug!("响应：{} {} {} - {:?}", method, uri, status, duration),
            400..=499 => warn!("响应：{} {} {} - {:?}", method, uri, status, duration),
            500..=599 => error!("响应：{} {} {} - {:?}", method, uri, status, duration),
            _ => info!("响应：{} {} {} - {:?}", method, uri, status, duration),
        };

        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        middleware::from_fn,
        routing::get,
        Router,
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn test_logging_middleware() {
        let app = Router::new()
            .route("/test", get(|| async { "OK" }))
            .layer(from_fn(RequestLoggerLayer::log_request));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }
}
