//! gRPC DatabaseService impl — raw SELECT escape hatch.
//!
//! 옛 raw rusqlite 직접 의존 (BIBLE Core 순수성 위반) → 2026-05-06 정정:
//! - `Arc<dyn IDatabasePort>` 만 보유 (concrete Connection 0건)
//! - `port.run_select_query(sql)` 위임 — adapter 가 SELECT/WITH 검증 + dialect 적응
//! - SELECT/WITH 만 허용. INSERT/UPDATE/DELETE 는 어댑터에서 거부 (port 차원 가드)
//!
//! 향후 MariaDB / PostgreSQL adapter 설정될 때 dialect-specific SQL 처리도 어댑터 안에서.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::ports::IDatabasePort;
use crate::proto::{database_service_server::DatabaseService, JsonArgs, JsonValue};

pub struct DatabaseServiceImpl {
    db: Arc<dyn IDatabasePort>,
}

impl DatabaseServiceImpl {
    pub fn new(db: Arc<dyn IDatabasePort>) -> Self {
        Self { db }
    }
}

fn json_response<T: serde::Serialize>(value: &T) -> Result<Response<JsonValue>, TonicStatus> {
    let raw = serde_json::to_string(value)
        .map_err(|e| TonicStatus::internal(format!("JSON 직렬화 실패: {e}")))?;
    Ok(Response::new(JsonValue { raw }))
}

#[tonic::async_trait]
impl DatabaseService for DatabaseServiceImpl {
    async fn query(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            sql: String,
            #[serde(default)]
            #[allow(dead_code)]
            // params 는 Phase B-17.5 minimum 단계에선 unused — adapter 가 raw SELECT 만 받음.
            // 향후 prepared statement 지원 시 port 시그니처 확장 (`run_select_query_with_params`).
            params: Vec<serde_json::Value>,
        }
        let _args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("query args: {e}")))?;
        let parsed: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("query args: {e}")))?;

        let rows = self
            .db
            .run_select_query(&parsed.sql)
            .map_err(|e| {
                if e.starts_with("raw query 거부") {
                    TonicStatus::permission_denied(e)
                } else {
                    TonicStatus::invalid_argument(e)
                }
            })?;

        let json_rows: Vec<serde_json::Value> = rows
            .into_iter()
            .map(serde_json::Value::Object)
            .collect();
        json_response(&json_rows)
    }
}

// Tests 이관 — `infra/tests/svc_database_test.rs` (integration test).
