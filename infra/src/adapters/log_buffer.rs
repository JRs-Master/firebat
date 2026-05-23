//! LogBufferLayer — tracing-subscriber custom Layer 로 모든 tracing event 를 sqlite ring
//! buffer 에 저장 (로그 시스템 Phase 4, 2026-05-21).
//!
//! 목적: ssh journalctl 없이 admin UI (Phase 5) 에서 최근 로그 조회. journalctl layer 와
//! 동시 fan-out — reload layer (Phase 1) 위에 layer 1개 추가하는 구조.
//!
//! 설계:
//! - on_event → MessageVisitor 로 message + fields 추출 → std::sync::mpsc 로 writer thread 전달.
//! - writer thread (std::thread) — rusqlite blocking insert. tokio runtime 오염 X (sqlite sync).
//! - ring = capacity 초과 시 oldest id 삭제 (주기적 trim, 매 insert 마다 X — 비용 절감).
//! - 별도 db (`data/logs.db`) — 로그 폭주 시 app.db / vault.db 영향 0 (분리).
//! - query 는 LogQuery (별도 read-only conn) — writer thread 와 분리.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

/// 단일 로그 항목 — sqlite 1 row.
#[derive(Debug, Clone)]
pub struct LogRow {
    pub ts_ms: i64,
    pub level: String,
    pub target: String,
    pub message: String,
}

/// 조회 필터 — LogService.QueryLogs 가 변환해 전달.
#[derive(Debug, Clone, Default)]
pub struct LogQueryFilter {
    /// 최소 레벨 (이 레벨 이상만). None = 전체. "ERROR" / "WARN" / "INFO" / "DEBUG".
    pub min_level: Option<String>,
    /// target prefix 매칭 (예: "firebat_infra::adapters::sandbox"). None = 전체.
    pub target_prefix: Option<String>,
    /// 이 시각(ms) 이후. None = 전체.
    pub since_ms: Option<i64>,
    /// 최대 건수 (default 200, max 2000).
    pub limit: usize,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn level_rank(level: &str) -> i32 {
    match level.to_ascii_uppercase().as_str() {
        "ERROR" => 4,
        "WARN" => 3,
        "INFO" => 2,
        "DEBUG" => 1,
        "TRACE" => 0,
        _ => 2,
    }
}

/// tracing Event 의 message + 부가 field 를 단일 문자열로 합치는 visitor.
#[derive(Default)]
struct MessageVisitor {
    message: String,
    fields: Vec<String>,
}

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
            // tracing 의 message 는 보통 따옴표 포함 Debug — 양끝 따옴표 제거.
            if self.message.starts_with('"') && self.message.ends_with('"') && self.message.len() >= 2 {
                self.message = self.message[1..self.message.len() - 1].to_string();
            }
        } else {
            self.fields.push(format!("{}={value:?}", field.name()));
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.fields.push(format!("{}={value}", field.name()));
        }
    }
}

/// tracing-subscriber Layer — 매 event 를 writer thread 로 전달.
pub struct LogBufferLayer {
    tx: mpsc::Sender<LogRow>,
}

impl LogBufferLayer {
    /// db_path = data/logs.db, capacity = ring 최대 건수 (예: 5000).
    /// writer thread 1개 spawn (rusqlite blocking — tokio 오염 X).
    pub fn new(db_path: PathBuf, capacity: usize) -> Self {
        let (tx, rx) = mpsc::channel::<LogRow>();
        thread::Builder::new()
            .name("firebat-log-writer".into())
            .spawn(move || log_writer_loop(db_path, capacity, rx))
            .ok();
        Self { tx }
    }
}

impl<S: Subscriber> Layer<S> for LogBufferLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let meta = event.metadata();
        let mut message = visitor.message;
        if !visitor.fields.is_empty() {
            if !message.is_empty() {
                message.push(' ');
            }
            message.push_str(&visitor.fields.join(" "));
        }
        // message cap — 거대 로그가 db 부풀리는 것 차단.
        if message.len() > 4000 {
            message.truncate(4000);
        }
        let row = LogRow {
            ts_ms: now_ms(),
            level: meta.level().to_string(),
            target: meta.target().to_string(),
            message,
        };
        // send 실패 (writer thread 종료) = silent — 로그 1건 누락이 서버 죽이면 안 됨.
        let _ = self.tx.send(row);
    }
}

/// writer thread — rx 수신 → sqlite insert. capacity 초과 시 주기적 trim (ring).
fn log_writer_loop(db_path: PathBuf, capacity: usize, rx: mpsc::Receiver<LogRow>) {
    let conn = match init_log_db(&db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[log_buffer] logs.db open 실패 — sqlite 로그 비활성: {e}");
            // db 못 열어도 rx 는 계속 비워줘야 send 가 막히지 않음 (drain).
            for _ in rx {}
            return;
        }
    };
    let mut since_trim = 0usize;
    for row in rx {
        let _ = conn.execute(
            "INSERT INTO logs (ts_ms, level, target, message) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![row.ts_ms, row.level, row.target, row.message],
        );
        since_trim += 1;
        // 매 100건마다 ring trim — capacity 초과분(oldest) 삭제. 매 insert 비용 회피.
        if since_trim >= 100 {
            let _ = conn.execute(
                "DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?1)",
                rusqlite::params![capacity as i64],
            );
            since_trim = 0;
        }
    }
}

fn init_log_db(db_path: &Path) -> Result<Connection, String> {
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    // WAL — writer 1 + reader N (query) 동시. 로그 폭주 시에도 query 안 막힘.
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.execute(
        "CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts_ms INTEGER NOT NULL,
            level TEXT NOT NULL,
            target TEXT NOT NULL,
            message TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts_ms DESC)", []);
    Ok(conn)
}

/// 로그 조회 — admin LogService 가 호출. read-only conn (writer thread 와 분리, WAL 동시).
pub fn query_logs(db_path: &Path, filter: &LogQueryFilter) -> Result<Vec<LogRow>, String> {
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let limit = filter.limit.clamp(1, 2000);
    // 최신순 → limit. min_level / target_prefix / since_ms 는 in-memory 필터 (sql 단순 유지).
    let mut stmt = conn
        .prepare("SELECT ts_ms, level, target, message FROM logs ORDER BY id DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    // limit 보다 넉넉히 읽어 필터 후 limit (필터로 줄어드는 만큼 보상). 단 과다 방지 cap.
    let scan_limit = (limit * 4).min(8000) as i64;
    let rows = stmt
        .query_map(rusqlite::params![scan_limit], |r| {
            Ok(LogRow {
                ts_ms: r.get(0)?,
                level: r.get(1)?,
                target: r.get(2)?,
                message: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let min_rank = filter.min_level.as_deref().map(level_rank);
    let mut out = Vec::with_capacity(limit);
    for row in rows.flatten() {
        if let Some(mr) = min_rank {
            if level_rank(&row.level) < mr {
                continue;
            }
        }
        if let Some(prefix) = &filter.target_prefix {
            if !row.target.starts_with(prefix.as_str()) {
                continue;
            }
        }
        if let Some(since) = filter.since_ms {
            if row.ts_ms < since {
                continue;
            }
        }
        out.push(row);
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_rank_ordering() {
        assert!(level_rank("ERROR") > level_rank("WARN"));
        assert!(level_rank("WARN") > level_rank("INFO"));
        assert!(level_rank("INFO") > level_rank("DEBUG"));
    }

    #[test]
    fn query_filter_default_limit() {
        let f = LogQueryFilter::default();
        assert_eq!(f.limit, 0); // default 0 → query_logs clamp(1,..) 에서 1로
    }
}
