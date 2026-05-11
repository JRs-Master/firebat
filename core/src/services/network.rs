//! gRPC NetworkService impl — sandbox 안 외부 fetch.
//!
//! Phase B-post audit cleanup A5 (2026-05-06): 옛 reqwest 직접 의존 → INetworkPort port 위임.
//! 어댑터는 `infra/src/adapters/network.rs::ReqwestNetworkAdapter`.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + RawJsonPb 사용.
//! NetworkResponse 는 status/headers/body 복합 구조 → RawJsonPb.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::ports::{INetworkPort, NetworkRequest};
use crate::proto::{
    network_service_server::NetworkService, NetworkFetchRequest as NetworkFetchPb, RawJsonPb,
};

pub struct NetworkServiceImpl {
    network: Arc<dyn INetworkPort>,
}

impl NetworkServiceImpl {
    pub fn new(network: Arc<dyn INetworkPort>) -> Self {
        Self { network }
    }
}

fn raw_json(value: &impl serde::Serialize) -> RawJsonPb {
    RawJsonPb {
        raw_json: serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

#[tonic::async_trait]
impl NetworkService for NetworkServiceImpl {
    async fn fetch(&self, req: Request<NetworkFetchPb>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        let headers = args
            .headers_json
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok());
        let body = args
            .body
            .map(serde_json::Value::String);
        let parsed = NetworkRequest {
            url: args.url,
            method: args.method.unwrap_or_else(|| "GET".to_string()),
            headers,
            body,
            timeout_ms: args.timeout_ms.map(|v| v as u64).unwrap_or(30_000),
        };

        let response = self
            .network
            .fetch(parsed)
            .await
            .map_err(|e| {
                if e.starts_with("invalid method") {
                    TonicStatus::invalid_argument(e)
                } else {
                    TonicStatus::internal(e)
                }
            })?;

        Ok(Response::new(raw_json(&response)))
    }
}

// Tests 이관 — `infra/tests/svc_network_test.rs` (integration test).
