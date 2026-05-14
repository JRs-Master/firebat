//! gRPC CacheService impl — SysmodCacheAdapter wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + RawJsonPb 사용.
//! Read / Grep / Aggregate 결과는 동적 JSONL 레코드 배열 / 집계값 → RawJsonPb.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::proto::{
    cache_service_server::CacheService, CacheAggregateRequest, CacheGrepRequest, CacheReadRequest,
    Empty, RawJsonPb, StringRequest,
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

fn raw_json(value: &impl serde::Serialize) -> RawJsonPb {
    RawJsonPb {
        raw_json: serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

#[tonic::async_trait]
impl CacheService for CacheServiceImpl {
    async fn read(&self, req: Request<CacheReadRequest>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        let offset = args.offset.map(|v| v as usize).unwrap_or(0);
        let limit = args.limit.map(|v| v as usize).unwrap_or(100);
        match self.cache.read(&args.key, offset, limit) {
            Ok(v) => Ok(Response::new(raw_json(&v))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn grep(&self, req: Request<CacheGrepRequest>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        let value: serde_json::Value = if args.value_json.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(&args.value_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("value_json: {e}")))?
        };
        match self.cache.grep(&args.key, &args.field, &args.op, &value) {
            Ok(v) => Ok(Response::new(raw_json(&v))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn aggregate(
        &self,
        req: Request<CacheAggregateRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        match self.cache.aggregate(&args.key, &args.field, &args.op) {
            Ok(v) => Ok(Response::new(raw_json(&v))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn drop(&self, req: Request<StringRequest>) -> Result<Response<Empty>, TonicStatus> {
        let key = req.into_inner().value;
        self.cache.drop_key(&key).map_err(TonicStatus::internal)?;
        Ok(Response::new(Empty {}))
    }
}
