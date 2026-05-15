//! gRPC NetworkService impl — sandbox 안 외부 fetch.
//!
//! Phase B-post audit cleanup A5 (2026-05-06): 옛 reqwest 직접 의존 → INetworkPort port 위임.
//! 어댑터는 `infra/src/adapters/network.rs::ReqwestNetworkAdapter`.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + 매 RPC unique Request / Response.
//! 2026-05-15 — 옛 공유 RawJsonPb 폐기 + unique NetworkFetchResponse 박힘.
//! NetworkResponse 는 status/headers/body 복합 구조 → response_json 안에 직렬화.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::ports::{INetworkPort, NetworkRequest};
use crate::proto::{
    network_service_server::NetworkService, NetworkFetchRequest as NetworkFetchPb,
    NetworkFetchResponse,
};

pub struct NetworkServiceImpl {
    network: Arc<dyn INetworkPort>,
}

impl NetworkServiceImpl {
    pub fn new(network: Arc<dyn INetworkPort>) -> Self {
        Self { network }
    }
}

#[tonic::async_trait]
impl NetworkService for NetworkServiceImpl {
    async fn fetch(
        &self,
        req: Request<NetworkFetchPb>,
    ) -> Result<Response<NetworkFetchResponse>, TonicStatus> {
        let args = req.into_inner();
        let headers = args
            .headers_json
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok());
        let body = args.body.map(serde_json::Value::String);
        let parsed = NetworkRequest {
            url: args.url,
            method: args.method.unwrap_or_else(|| "GET".to_string()),
            headers,
            body,
            timeout_ms: args.timeout_ms.map(|v| v as u64).unwrap_or(30_000),
        };

        let response = self.network.fetch(parsed).await.map_err(|e| {
            if e.starts_with("invalid method") {
                TonicStatus::invalid_argument(e)
            } else {
                TonicStatus::internal(e)
            }
        })?;

        let response_json =
            serde_json::to_string(&response).unwrap_or_else(|_| "null".to_string());
        Ok(Response::new(NetworkFetchResponse { response_json }))
    }
}

// Tests 이관 — `infra/tests/svc_network_test.rs` (integration test).
