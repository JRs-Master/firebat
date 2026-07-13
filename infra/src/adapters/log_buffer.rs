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
    /// message/target 부분문자열 검색 (journalctl grep 대체). None = 전체.
    /// SQL LIKE 로 처리 — in-memory 필터면 scan 창(limit×4) 안만 검색돼 오래된 매치를 놓침.
    pub contains: Option<String>,
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
/// `category` field 는 별도로 잡아 LogRow.target 으로 승격 (메시지 합치기에서 제외).
#[derive(Default)]
struct MessageVisitor {
    message: String,
    fields: Vec<String>,
    /// CategoryLogger 가 붙인 category field — 있으면 meta.target() 대신 LogRow.target 으로 사용.
    category: Option<String>,
}

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        match field.name() {
            "message" => {
                self.message = format!("{value:?}");
                // tracing 의 message 는 보통 따옴표 포함 Debug — 양끝 따옴표 제거.
                if self.message.starts_with('"')
                    && self.message.ends_with('"')
                    && self.message.len() >= 2
                {
                    self.message = self.message[1..self.message.len() - 1].to_string();
                }
            }
            "category" => {
                let mut c = format!("{value:?}");
                if c.starts_with('"') && c.ends_with('"') && c.len() >= 2 {
                    c = c[1..c.len() - 1].to_string();
                }
                self.category = Some(c);
            }
            name => self.fields.push(format!("{name}={value:?}")),
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "message" => self.message = value.to_string(),
            "category" => self.category = Some(value.to_string()),
            name => self.fields.push(format!("{name}={value}")),
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
        // String::truncate 는 byte index 가 char 경계가 아니면 panic → 한글(3byte) 로그가 4000byte 를
        // 넘으면 글자 중간을 잘라 크래시(코어덤프). 4000 이하의 가장 큰 char 경계로 안전하게 자른다.
        if message.len() > 4000 {
            let mut end = 4000;
            while end > 0 && !message.is_char_boundary(end) {
                end -= 1;
            }
            message.truncate(end);
        }
        // category field 가 있으면 (CategoryLogger 경유 매니저 로그) target 으로 승격 —
        // admin 로그 탭의 prefix 필터가 매니저 category 단위로 동작. 없으면 meta.target() (tracing 직접 호출).
        let target = visitor
            .category
            .unwrap_or_else(|| meta.target().to_string());
        let row = LogRow {
            ts_ms: now_ms(),
            level: meta.level().to_string(),
            target,
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

/// rusqlite row → LogRow (query_logs 두 SQL 분기 공용).
fn row_to_log(r: &rusqlite::Row) -> rusqlite::Result<LogRow> {
    Ok(LogRow {
        ts_ms: r.get(0)?,
        level: r.get(1)?,
        target: r.get(2)?,
        message: r.get(3)?,
    })
}

/// LIKE 패턴 이스케이프 — %/_/\ 를 리터럴로 (ESCAPE '\' 전제).
fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// 로그 조회 — admin LogService 가 호출. read-only conn (writer thread 와 분리, WAL 동시).
pub fn query_logs(db_path: &Path, filter: &LogQueryFilter) -> Result<Vec<LogRow>, String> {
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let limit = filter.limit.clamp(1, 2000);
    // limit 보다 넉넉히 읽어 필터 후 limit (필터로 줄어드는 만큼 보상). 단 과다 방지 cap.
    let scan_limit = (limit * 4).min(8000) as i64;
    // contains(부분문자열) 는 SQL LIKE — in-memory 필터면 scan 창 안만 검색돼 링 깊은 곳의
    // 매치를 놓친다(journalctl grep 대체가 목적이라 링 전체가 대상). 나머지(min_level /
    // target_prefix / since_ms) 는 기존대로 in-memory (sql 단순 유지).
    let contains = filter
        .contains
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty());
    let raw: Vec<LogRow> = if let Some(c) = contains {
        let pat = format!("%{}%", like_escape(c));
        let mut stmt = conn
            .prepare(
                "SELECT ts_ms, level, target, message FROM logs \
                 WHERE (message LIKE ?1 ESCAPE '\\' OR target LIKE ?1 ESCAPE '\\') \
                 ORDER BY id DESC LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![pat, scan_limit], row_to_log)
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    } else {
        let mut stmt = conn
            .prepare("SELECT ts_ms, level, target, message FROM logs ORDER BY id DESC LIMIT ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![scan_limit], row_to_log)
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };

    let min_rank = filter.min_level.as_deref().map(level_rank);
    let mut out = Vec::with_capacity(limit);
    for row in raw {
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
