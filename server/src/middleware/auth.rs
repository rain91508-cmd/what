use axum::{
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
    body::Body,
};
use crate::state::ServerState;
use tracing::warn;

/// 认证中间件
/// 验证请求是否包含有效的认证令牌
pub struct AuthMiddleware;

impl AuthMiddleware {
    /// 验证 Bearer Token
    pub async fn verify_bearer(
        State(state): State<ServerState>,
        request: Request<Body>,
        next: Next,
    ) -> Result<Response, StatusCode> {
        // 如果未启用认证，直接通过
        if !state.config.enable_auth {
            return Ok(next.run(request).await);
        }

        // 从 Authorization 头获取 token
        let auth_header = request
            .headers()
            .get("Authorization")
            .and_then(|value| value.to_str().ok());

        match auth_header {
            Some(header) if header.starts_with("Bearer ") => {
                let token = &header[7..];
                if let Some(expected_token) = &state.config.auth_token {
                    if token == expected_token {
                        return Ok(next.run(request).await);
                    }
                }
            }
            _ => {}
        }

        // 认证失败
        warn!("认证失败：无效的 Bearer Token");
        Err(StatusCode::UNAUTHORIZED)
    }

    /// 验证 API Key (从查询参数或头)
    pub async fn verify_api_key(
        State(state): State<ServerState>,
        request: Request<Body>,
        next: Next,
    ) -> Result<Response, StatusCode> {
        // 如果未启用认证，直接通过
        if !state.config.enable_auth {
            return Ok(next.run(request).await);
        }

        // 尝试从查询参数获取 API key
        let uri = request.uri().clone();
        let query_string = uri.query().unwrap_or("");
        
        let api_key_valid = if let Some(expected_key) = &state.config.auth_token {
            // 检查查询参数
            let query_valid = query_string
                .split('&')
                .any(|pair| pair.starts_with("api_key=") && pair[8..] == **expected_key);
            
            // 检查 X-API-Key 头
            let header_valid = request
                .headers()
                .get("X-API-Key")
                .and_then(|value| value.to_str().ok())
                .map(|key| key == expected_key.as_str())
                .unwrap_or(false);
            
            query_valid || header_valid
        } else {
            false
        };

        if api_key_valid {
            return Ok(next.run(request).await);
        }

        // 认证失败
        warn!("认证失败：无效的 API Key");
        Err(StatusCode::UNAUTHORIZED)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ServerConfig;
    use axum::{
        body::Body,
        http::{header, Request},
        middleware::from_fn_with_state,
        routing::get,
        Router,
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn test_auth_disabled() {
        let config = ServerConfig {
            enable_auth: false,
            ..Default::default()
        };
        let state = ServerState::new(config);

        let app = Router::new()
            .route("/test", get(|| async { "OK" }))
            .layer(from_fn_with_state(state.clone(), AuthMiddleware::verify_bearer))
            .with_state(state);

        let response = app
            .oneshot(Request::builder().uri("/test").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_auth_enabled_valid_token() {
        let config = ServerConfig {
            enable_auth: true,
            auth_token: Some("secret-token".to_string()),
            ..Default::default()
        };
        let state = ServerState::new(config);

        let app = Router::new()
            .route("/test", get(|| async { "OK" }))
            .layer(from_fn_with_state(state.clone(), AuthMiddleware::verify_bearer))
            .with_state(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/test")
                    .header(header::AUTHORIZATION, "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_auth_enabled_invalid_token() {
        let config = ServerConfig {
            enable_auth: true,
            auth_token: Some("secret-token".to_string()),
            ..Default::default()
        };
        let state = ServerState::new(config);

        let app = Router::new()
            .route("/test", get(|| async { "OK" }))
            .layer(from_fn_with_state(state.clone(), AuthMiddleware::verify_bearer))
            .with_state(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/test")
                    .header(header::AUTHORIZATION, "Bearer wrong-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
