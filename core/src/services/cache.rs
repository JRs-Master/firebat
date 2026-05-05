//! gRPC CacheService impl — SysmodCacheAdapter wrapping.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::utils::sysmod_cache::SysmodCacheAdapter;
use crate::proto::{cache_service_server::CacheService, JsonArgs, JsonValue, Status, StringRequest};

pub struct CacheServiceImpl {
    cache: Arc<SysmodCacheAdapter>,
}

impl CacheServiceImpl {
    pub fn new(cache: Arc<SysmodCacheAdapter>) -> Self {
        Self { cache }
    }
}

fn json_response<T: serde::Serialize>(value: &T) -> Result<Response<JsonValue>, TonicStatus> {
    let raw = serde_json::to_string(value)
        .map_err(|e| TonicStatus::internal(format!("JSON 직렬화 실패: {e}")))?;
    Ok(Response::new(JsonValue { raw }))
}

#[tonic::async_trait]
impl CacheService for CacheServiceImpl {
    async fn read(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            key: String,
            #[serde(default)]
            offset: usize,
            #[serde(default = "default_limit")]
            limit: usize,
        }
        fn default_limit() -> usize { 100 }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("read args: {e}")))?;
        match self.cache.read(&args.key, args.offset, args.limit) {
            Ok(v) => json_response(&v),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn grep(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            key: String,
            field: String,
            op: String,
            value: serde_json::Value,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("grep args: {e}")))?;
        match self.cache.grep(&args.key, &args.field, &args.op, &args.value) {
            Ok(v) => json_response(&v),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn aggregate(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            key: String,
            field: String,
            op: String,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("aggregate args: {e}")))?;
        match self.cache.aggregate(&args.key, &args.field, &args.op) {
            Ok(v) => json_response(&v),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn drop(&self, req: Request<StringRequest>) -> Result<Response<Status>, TonicStatus> {
        let key = req.into_inner().value;
        match self.cache.drop_key(&key) {
            Ok(()) => Ok(Response::new(Status {
                ok: true,
                error: String::new(),
                error_code: String::new(),
            })),
            Err(e) => Ok(Response::new(Status {
                ok: false,
                error: e,
                error_code: String::new(),
            })),
        }
    }
}
