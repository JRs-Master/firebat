//! gRPC NetworkService impl — sandbox 안 외부 fetch.
//!
//! Phase B-post audit cleanup A5 (2026-05-06): 옛 reqwest 직접 의존 → INetworkPort port 위임.
//! 어댑터는 `infra/src/adapters/network.rs::ReqwestNetworkAdapter`.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::ports::{INetworkPort, NetworkRequest};
use crate::proto::{network_service_server::NetworkService, JsonArgs, JsonValue};

pub struct NetworkServiceImpl {
    network: Arc<dyn INetworkPort>,
}

impl NetworkServiceImpl {
    pub fn new(network: Arc<dyn INetworkPort>) -> Self {
        Self { network }
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
        let parsed: NetworkRequest = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("fetch args: {e}")))?;

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

        json_response(&response)
    }
}

// Tests 이관 — `infra/tests/svc_network_test.rs` (integration test).
