//! gRPC CacheService impl — SysmodCacheAdapter wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + RawJsonPb 사용.
//! Read / Grep / Aggregate 결과는 동적 JSONL 레코드 배열 / 집계값 → unique Response 의
//! raw_json field. 2026-05-15: 옛 공유 타입 (Empty / StringRequest / RawJsonPb) → RPC 별
//! unique Request/Response 분리 (buf STANDARD lint RPC_REQUEST_RESPONSE_UNIQUE).

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::proto::{
    cache_service_server::CacheService, CacheAggregateRequest, CacheAggregateResponse,
    CacheDropRequest, CacheDropResponse, CacheGrepRequest, CacheGrepResponse, CacheReadRequest,
    CacheReadResponse,
};
use crate::utils::sysmod_cache::SysmodCacheAdapter;

pub struct CacheServiceImpl {
    cache: Arc<SysmodCacheAdapter>,
}

impl CacheServiceImpl {
    pub fn new(cache: Arc<SysmodCacheAdapter>) -> Self {
        Self { cache }
    }
}

fn to_raw_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[tonic::async_trait]
impl CacheService for CacheServiceImpl {
    async fn read(
        &self,
        req: Request<CacheReadRequest>,
    ) -> Result<Response<CacheReadResponse>, TonicStatus> {
        let args = req.into_inner();
        let offset = args.offset.map(|v| v as usize).unwrap_or(0);
        let limit = args.limit.map(|v| v as usize).unwrap_or(100);
        match self.cache.read(&args.key, offset, limit) {
            Ok(v) => Ok(Response::new(CacheReadResponse {
                raw_json: to_raw_json(&v),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn grep(
        &self,
        req: Request<CacheGrepRequest>,
    ) -> Result<Response<CacheGrepResponse>, TonicStatus> {
        let args = req.into_inner();
        let value: serde_json::Value = if args.value_json.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(&args.value_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("value_json: {e}")))?
        };
        match self.cache.grep(&args.key, &args.field, &args.op, &value) {
            Ok(v) => Ok(Response::new(CacheGrepResponse {
                raw_json: to_raw_json(&v),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn aggregate(
        &self,
        req: Request<CacheAggregateRequest>,
    ) -> Result<Response<CacheAggregateResponse>, TonicStatus> {
        let args = req.into_inner();
        match self.cache.aggregate(&args.key, &args.field, &args.op) {
            Ok(v) => Ok(Response::new(CacheAggregateResponse {
                raw_json: to_raw_json(&v),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn drop(
        &self,
        req: Request<CacheDropRequest>,
    ) -> Result<Response<CacheDropResponse>, TonicStatus> {
        let key = req.into_inner().key;
        self.cache.drop_key(&key).map_err(TonicStatus::internal)?;
        Ok(Response::new(CacheDropResponse {}))
    }
}
