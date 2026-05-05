//! gRPC NetworkService impl — sandbox 안 외부 fetch.
//!
//! Phase B-17.5 minimum: GET / POST / PUT / DELETE 표준 fetch + body / headers.
//! reqwest::Client (LLM 모듈에 있는 공유 pool) 재사용.

use tonic::{Request, Response, Status as TonicStatus};

use crate::proto::{network_service_server::NetworkService, JsonArgs, JsonValue};
use crate::utils::http_client::http_client;

pub struct NetworkServiceImpl;

impl NetworkServiceImpl {
    pub fn new() -> Self {
        Self
    }
}

fn json_response<T: serde::Serialize>(value: &T) -> Result<Response<JsonValue>, TonicStatus> {
    let raw = serde_json::to_string(value)
        .map_err(|e| TonicStatus::internal(format!("JSON 직렬화 실패: {e}")))?;
    Ok(Response::new(JsonValue { raw }))
}

#[tonic::async_trait]
impl NetworkService for NetworkServiceImpl {
    async fn fetch(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            url: String,
            #[serde(default = "default_method")]
            method: String,
            #[serde(default)]
            body: Option<serde_json::Value>,
            #[serde(default)]
            headers: Option<std::collections::HashMap<String, String>>,
            #[serde(default = "default_timeout_ms", rename = "timeoutMs")]
            timeout_ms: u64,
        }
        fn default_method() -> String { "GET".to_string() }
        fn default_timeout_ms() -> u64 { 30_000 }

        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("fetch args: {e}")))?;

        let method: reqwest::Method = args
            .method
            .parse()
            .map_err(|e| TonicStatus::invalid_argument(format!("invalid method: {e}")))?;

        let mut builder = http_client()
            .request(method, &args.url)
            .timeout(std::time::Duration::from_millis(args.timeout_ms));

        if let Some(headers) = args.headers {
            for (k, v) in headers {
                builder = builder.header(&k, &v);
            }
        }
        if let Some(body) = args.body {
            // body 가 string 이면 raw, object 면 JSON
            match body {
                serde_json::Value::String(s) => {
                    builder = builder.body(s);
                }
                other => {
                    builder = builder.json(&other);
                }
            }
        }

        let response = builder.send().await.map_err(|e| {
            TonicStatus::internal(format!("HTTP fetch 실패: {e}"))
        })?;
        let status = response.status();
        let response_headers: std::collections::HashMap<String, String> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        let text = response
            .text()
            .await
            .map_err(|e| TonicStatus::internal(format!("body read 실패: {e}")))?;

        // body 가 JSON 이면 parse, 아니면 string 그대로
        let body_value: serde_json::Value = serde_json::from_str(&text)
            .unwrap_or(serde_json::Value::String(text));

        json_response(&serde_json::json!({
            "status": status.as_u16(),
            "ok": status.is_success(),
            "headers": response_headers,
            "body": body_value,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fetch_invalid_url_returns_error() {
        let svc = NetworkServiceImpl::new();
        let resp = svc
            .fetch(Request::new(JsonArgs {
                raw: serde_json::json!({"url": "not-a-url"}).to_string(),
            }))
            .await;
        assert!(resp.is_err());
    }

    #[tokio::test]
    async fn invalid_method_returns_error() {
        let svc = NetworkServiceImpl::new();
        // RFC 7230 token grammar 위반 — whitespace 포함
        let resp = svc
            .fetch(Request::new(JsonArgs {
                raw: serde_json::json!({
                    "url": "https://example.com",
                    "method": "GET POST"
                })
                .to_string(),
            }))
            .await;
        assert!(resp.is_err());
    }
}
