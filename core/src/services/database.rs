//! gRPC DatabaseService impl — raw SQL query.
//!
//! 옛 TS IDatabasePort.query(sql, params) Rust port. BIBLE 의 DB-agnostic 도메인 port 마이그레이션
//! 영역 — Phase B 개선 후보 (2026-04-29 박힘).
//!
//! Phase B-17.5b minimum: SELECT 만 활성. INSERT/UPDATE/DELETE 는 명시 거부 (도메인 port 사용 권장).

use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;
use tonic::{Request, Response, Status as TonicStatus};

use crate::proto::{database_service_server::DatabaseService, JsonArgs, JsonValue};

pub struct DatabaseServiceImpl {
    conn: Mutex<Connection>,
}

impl DatabaseServiceImpl {
    pub fn new(db_path: PathBuf) -> Result<Self, String> {
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("DB open 실패: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
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
            params: Vec<serde_json::Value>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("query args: {e}")))?;

        // Phase B-17.5 minimum 안전 가드 — SELECT 만 허용.
        // INSERT/UPDATE/DELETE 같은 mutation 은 도메인 port (PageManager.save / etc) 경유 권장.
        let sql_upper = args.sql.trim().to_uppercase();
        if !sql_upper.starts_with("SELECT") && !sql_upper.starts_with("PRAGMA") {
            return Err(TonicStatus::permission_denied(
                "DatabaseService 는 SELECT/PRAGMA 만 허용 — mutation 은 도메인 매니저 사용",
            ));
        }

        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare(&args.sql)
            .map_err(|e| TonicStatus::invalid_argument(format!("SQL prepare: {e}")))?;
        let column_count = stmt.column_count();
        let column_names: Vec<String> = (0..column_count)
            .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
            .collect();

        let params_sql: Vec<rusqlite::types::Value> = args
            .params
            .iter()
            .map(|v| match v {
                serde_json::Value::Null => rusqlite::types::Value::Null,
                serde_json::Value::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
                serde_json::Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        rusqlite::types::Value::Integer(i)
                    } else if let Some(f) = n.as_f64() {
                        rusqlite::types::Value::Real(f)
                    } else {
                        rusqlite::types::Value::Null
                    }
                }
                serde_json::Value::String(s) => rusqlite::types::Value::Text(s.clone()),
                _ => rusqlite::types::Value::Text(v.to_string()),
            })
            .collect();

        let rows: Result<Vec<serde_json::Value>, rusqlite::Error> = stmt
            .query_map(rusqlite::params_from_iter(params_sql.iter()), |row| {
                let mut obj = serde_json::Map::new();
                for (i, name) in column_names.iter().enumerate() {
                    let value: rusqlite::types::Value = row.get(i)?;
                    let json_val = match value {
                        rusqlite::types::Value::Null => serde_json::Value::Null,
                        rusqlite::types::Value::Integer(i) => serde_json::Value::from(i),
                        rusqlite::types::Value::Real(f) => serde_json::Value::from(f),
                        rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
                        rusqlite::types::Value::Blob(_) => {
                            serde_json::Value::String("[blob]".to_string())
                        }
                    };
                    obj.insert(name.clone(), json_val);
                }
                Ok(serde_json::Value::Object(obj))
            })
            .map_err(|e| TonicStatus::internal(format!("query: {e}")))?
            .collect();

        let rows = rows.map_err(|e| TonicStatus::internal(format!("row 추출: {e}")))?;
        json_response(&rows)
    }
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::database::SqliteDatabaseAdapter;
    use tempfile::tempdir;

    #[tokio::test]
    async fn select_returns_rows() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        // schema 초기화
        let _ = SqliteDatabaseAdapter::new(&db_path).unwrap();

        let svc = DatabaseServiceImpl::new(db_path).unwrap();
        let resp = svc
            .query(Request::new(JsonArgs {
                raw: serde_json::json!({"sql": "SELECT COUNT(*) AS cnt FROM pages"}).to_string(),
            }))
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert!(parsed.is_array());
        assert_eq!(parsed[0]["cnt"], 0);
    }

    #[tokio::test]
    async fn insert_rejected() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let _ = SqliteDatabaseAdapter::new(&db_path).unwrap();

        let svc = DatabaseServiceImpl::new(db_path).unwrap();
        let resp = svc
            .query(Request::new(JsonArgs {
                raw: serde_json::json!({"sql": "INSERT INTO pages (slug) VALUES ('x')"})
                    .to_string(),
            }))
            .await;
        assert!(resp.is_err());
    }
}
