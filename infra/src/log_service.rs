//! LogServiceImpl — gRPC LogService 구현 (로그 시스템 Phase 4, 2026-05-21).
//!
//! sqlite ring buffer (data/logs.db) 조회 + 런타임 filter 동적 변경 (SIGHUP 대신 RPC).
//! log_buffer (sqlite query) + tracing_log (reload handle) 의존이라 infra 에 배치
//! (의존 단방향 infra → core 준수 — core/grpc 가 infra 호출하면 위반).
//! admin 로그 탭 (Phase 5) 이 본 RPC 호출.

use std::path::PathBuf;

use tonic::{Request, Response, Status};

use firebat_core::proto::{
    log_service_server::LogService, LogEntryPb, LogQueryRequest, LogQueryResponse,
    SetLogFilterRequest, SetLogFilterResponse,
};

use crate::adapters::log_buffer::{query_logs, LogQueryFilter};
use crate::adapters::tracing_log::{reload_log_filter, LogReloadHandle};

pub struct LogServiceImpl {
    log_db_path: PathBuf,
    reload_handle: LogReloadHandle,
}

impl LogServiceImpl {
    pub fn new(log_db_path: PathBuf, reload_handle: LogReloadHandle) -> Self {
        Self {
            log_db_path,
            reload_handle,
        }
    }
}

#[tonic::async_trait]
impl LogService for LogServiceImpl {
    async fn query_logs(
        &self,
        req: Request<LogQueryRequest>,
    ) -> Result<Response<LogQueryResponse>, Status> {
        let args = req.into_inner();
        let filter = LogQueryFilter {
            min_level: if args.min_level.is_empty() {
                None
            } else {
                Some(args.min_level)
            },
            target_prefix: if args.target_prefix.is_empty() {
                None
            } else {
                Some(args.target_prefix)
            },
            since_ms: if args.since_ms == 0 {
                None
            } else {
                Some(args.since_ms)
            },
            limit: if args.limit <= 0 {
                200
            } else {
                args.limit as usize
            },
            contains: if args.contains.trim().is_empty() {
                None
            } else {
                Some(args.contains)
            },
        };
        // rusqlite blocking — tokio runtime 막지 않게 spawn_blocking.
        let db = self.log_db_path.clone();
        let rows = tokio::task::spawn_blocking(move || query_logs(&db, &filter))
            .await
            .map_err(|e| Status::internal(e.to_string()))?
            .map_err(Status::internal)?;
        let entries = rows
            .into_iter()
            .map(|r| LogEntryPb {
                ts_ms: r.ts_ms,
                level: r.level,
                target: r.target,
                message: r.message,
            })
            .collect();
        Ok(Response::new(LogQueryResponse { entries }))
    }

    async fn set_log_filter(
        &self,
        req: Request<SetLogFilterRequest>,
    ) -> Result<Response<SetLogFilterResponse>, Status> {
        let filter = req.into_inner().filter;
        match reload_log_filter(&self.reload_handle, &filter) {
            Ok(_) => {
                tracing::info!(filter = %filter, "[log] filter reloaded (RPC)");
                Ok(Response::new(SetLogFilterResponse {
                    ok: true,
                    error: String::new(),
                }))
            }
            Err(e) => Ok(Response::new(SetLogFilterResponse {
                ok: false,
                error: e,
            })),
        }
    }
}
