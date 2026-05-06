//! ReqwestNetworkAdapter — `INetworkPort` 의 reqwest 0.12 구현.
//!
//! Phase B-post audit cleanup A5 (2026-05-06): services 의 reqwest 직접 의존 제거.
//! 옛 `core/src/utils/http_client.rs` 의 공유 reqwest::Client pool 재사용 (LLM format handlers
//! 와 같은 connection pool — 자원 절약).

use async_trait::async_trait;
use std::time::Duration;

use firebat_core::ports::{INetworkPort, InfraResult, NetworkRequest, NetworkResponse};
use firebat_core::utils::http_client::http_client;

pub struct ReqwestNetworkAdapter;

impl ReqwestNetworkAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ReqwestNetworkAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl INetworkPort for ReqwestNetworkAdapter {
    async fn fetch(&self, req: NetworkRequest) -> InfraResult<NetworkResponse> {
        let method: reqwest::Method = req
            .method
            .parse()
            .map_err(|e| format!("invalid method: {e}"))?;

        let mut builder = http_client()
            .request(method, &req.url)
            .timeout(Duration::from_millis(req.timeout_ms));

        if let Some(headers) = req.headers {
            for (k, v) in headers {
                builder = builder.header(&k, &v);
            }
        }
        if let Some(body) = req.body {
            // body 가 string 이면 raw, 그 외엔 JSON serialize.
            match body {
                serde_json::Value::String(s) => {
                    builder = builder.body(s);
                }
                other => {
                    builder = builder.json(&other);
                }
            }
        }

        let response = builder
            .send()
            .await
            .map_err(|e| format!("HTTP fetch 실패: {e}"))?;
        let status = response.status();
        let response_headers: std::collections::HashMap<String, String> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        let text = response
            .text()
            .await
            .map_err(|e| format!("body read 실패: {e}"))?;
        let body_value: serde_json::Value =
            serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));

        Ok(NetworkResponse {
            status: status.as_u16(),
            ok: status.is_success(),
            headers: response_headers,
            body: body_value,
        })
    }
}
