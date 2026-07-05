//! TimeseriesStoreAdapter — 시계열 영구 store (range-coverage), SQLite `data/timeseries.db`.
//!
//! 원리 (CLAUDE.md 1-3 설계): 시계열을 "덮인 구간(intervals) 집합"으로 관리. 조회 [a,b) 는
//! 미커버 구간만 fetch → 날짜 dedup 병합. 과거 확장/최신 추가/중간 갭 = 전부 같은
//! "미커버 fill" 한 연산 (특수 분기 0). 겹치는 완결-과거 row 의 내용 불일치 = 소급 조정
//! (액면분할/배당 수정) 신호 → 시계열 통째 무효화 후 이번 응답으로 재시작.
//!
//! date_key = normalized 14-digit i64 (core/utils/timeseries.rs). 키/스펙은 core 가
//! 선언형 config 에서 파싱 — 이 어댑터는 provider 지식 0 (순수 저장).

use std::path::PathBuf;
use std::sync::Mutex;

use firebat_core::ports::ITimeseriesStorePort;
use rusqlite::{params, Connection};

pub struct TimeseriesStoreAdapter {
    conn: Mutex<Connection>,
}

impl TimeseriesStoreAdapter {
    pub fn new(db_path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(&db_path).map_err(|e| format!("timeseries db open: {e}"))?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS ts_rows (
                series_key TEXT NOT NULL,
                date_key   INTEGER NOT NULL,
                row        TEXT NOT NULL,
                PRIMARY KEY (series_key, date_key)
            );
            CREATE TABLE IF NOT EXISTS ts_coverage (
                series_key TEXT NOT NULL,
                start      INTEGER NOT NULL,
                end        INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ts_cov_key ON ts_coverage(series_key);
            "#,
        )
        .map_err(|e| format!("timeseries schema: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 커버 구간들 (병합 전 raw) — 시간순.
    fn coverage(&self, conn: &Connection, key: &str) -> Vec<(i64, i64)> {
        let mut stmt = match conn
            .prepare("SELECT start, end FROM ts_coverage WHERE series_key = ?1 ORDER BY start")
        {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![key], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    /// 구간 집합 정규화 — 겹침/인접 병합.
    fn merge_intervals(mut iv: Vec<(i64, i64)>) -> Vec<(i64, i64)> {
        iv.sort();
        let mut out: Vec<(i64, i64)> = Vec::with_capacity(iv.len());
        for (s, e) in iv {
            if s >= e {
                continue;
            }
            match out.last_mut() {
                Some(last) if s <= last.1 => {
                    if e > last.1 {
                        last.1 = e;
                    }
                }
                _ => out.push((s, e)),
            }
        }
        out
    }
}

impl ITimeseriesStorePort for TimeseriesStoreAdapter {
    fn uncovered(&self, key: &str, start: i64, end: i64) -> Vec<(i64, i64)> {
        if start >= end {
            return Vec::new();
        }
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let covered = Self::merge_intervals(self.coverage(&conn, key));
        let mut gaps = Vec::new();
        let mut cur = start;
        for (s, e) in covered {
            if e <= cur {
                continue;
            }
            if s >= end {
                break;
            }
            if s > cur {
                gaps.push((cur, s.min(end)));
            }
            cur = cur.max(e);
            if cur >= end {
                break;
            }
        }
        if cur < end {
            gaps.push((cur, end));
        }
        gaps
    }

    fn read_rows(&self, key: &str, start: i64, end: i64) -> Vec<serde_json::Value> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT row FROM ts_rows WHERE series_key = ?1 AND date_key >= ?2 AND date_key < ?3
             ORDER BY date_key",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![key, start, end], |r| r.get::<_, String>(0))
            .map(|rows| {
                rows.filter_map(|r| r.ok())
                    .filter_map(|raw| serde_json::from_str(&raw).ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn merge_rows(
        &self,
        key: &str,
        rows: &[(i64, serde_json::Value)],
        cov_start: i64,
        cov_end: i64,
    ) -> (usize, bool) {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());

        // 1) 소급 조정 감지 — 완결 과거(cov 대상 이전 date)의 기존 row 와 내용 불일치.
        //    (미완결 최신 봉 — cov_end 이후 — 은 장중 갱신이 정상이라 conflict 아님.)
        let mut conflict = false;
        for (dk, row) in rows {
            if *dk >= cov_end {
                continue;
            }
            let existing: Option<String> = conn
                .query_row(
                    "SELECT row FROM ts_rows WHERE series_key = ?1 AND date_key = ?2",
                    params![key, dk],
                    |r| r.get(0),
                )
                .ok();
            if let Some(raw) = existing {
                let same = serde_json::from_str::<serde_json::Value>(&raw)
                    .map(|old| &old == row)
                    .unwrap_or(false);
                if !same {
                    conflict = true;
                    break;
                }
            }
        }
        if conflict {
            // 시계열 무효화 — 소스가 과거를 소급 수정했으므로 옛 데이터 전체가 의심.
            let _ = conn.execute("DELETE FROM ts_rows WHERE series_key = ?1", params![key]);
            let _ = conn.execute(
                "DELETE FROM ts_coverage WHERE series_key = ?1",
                params![key],
            );
            tracing::info!(
                target: "timeseries",
                series = %key,
                "backfill revision detected — series invalidated, restarting from this fetch"
            );
        }

        // 2) rows upsert (최신 봉 포함 — coverage 만 clamp).
        let mut upserted = 0usize;
        for (dk, row) in rows {
            let raw = match serde_json::to_string(row) {
                Ok(r) => r,
                Err(_) => continue,
            };
            if conn
                .execute(
                    "INSERT INTO ts_rows (series_key, date_key, row) VALUES (?1, ?2, ?3)
                     ON CONFLICT(series_key, date_key) DO UPDATE SET row = excluded.row",
                    params![key, dk, raw],
                )
                .is_ok()
            {
                upserted += 1;
            }
        }

        // 3) coverage [cov_start, cov_end) 추가 + 전체 병합 재기록.
        if cov_start < cov_end {
            let mut iv = self.coverage(&conn, key);
            iv.push((cov_start, cov_end));
            let merged = Self::merge_intervals(iv);
            let _ = conn.execute(
                "DELETE FROM ts_coverage WHERE series_key = ?1",
                params![key],
            );
            for (s, e) in merged {
                let _ = conn.execute(
                    "INSERT INTO ts_coverage (series_key, start, end) VALUES (?1, ?2, ?3)",
                    params![key, s, e],
                );
            }
        }

        (upserted, conflict)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn store() -> (tempfile::TempDir, TimeseriesStoreAdapter) {
        let dir = tempdir().unwrap();
        let a = TimeseriesStoreAdapter::new(dir.path().join("ts.db")).unwrap();
        (dir, a)
    }

    fn row(d: i64, close: f64) -> (i64, serde_json::Value) {
        (d, json!({"date": d.to_string(), "close": close}))
    }

    #[test]
    fn uncovered_full_when_empty() {
        let (_d, s) = store();
        assert_eq!(s.uncovered("k", 10, 20), vec![(10, 20)]);
    }

    #[test]
    fn merge_then_gaps_and_read() {
        let (_d, s) = store();
        // [10,15) 커버
        let (n, inv) = s.merge_rows("k", &[row(10, 1.0), row(12, 2.0), row(14, 3.0)], 10, 15);
        assert_eq!(n, 3);
        assert!(!inv);
        // 요청 [8,20) → 갭 = [8,10) + [15,20)
        assert_eq!(s.uncovered("k", 8, 20), vec![(8, 10), (15, 20)]);
        // 뒤 구간 병합 → [10,20)
        s.merge_rows("k", &[row(16, 4.0), row(18, 5.0)], 15, 20);
        assert_eq!(s.uncovered("k", 10, 20), Vec::<(i64, i64)>::new());
        let rows = s.read_rows("k", 10, 20);
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0]["close"], 1.0);
        assert_eq!(rows[4]["close"], 5.0);
        // 과거 확장 = 같은 연산
        s.merge_rows("k", &[row(8, 0.5)], 8, 10);
        assert_eq!(s.uncovered("k", 8, 20), Vec::<(i64, i64)>::new());
    }

    #[test]
    fn backfill_revision_invalidates_series() {
        let (_d, s) = store();
        s.merge_rows("k", &[row(10, 1.0), row(12, 2.0)], 10, 15);
        // 같은 완결-과거 date(10)에 다른 값 = 소급 조정 → invalidate + 이번 것만
        let (n, inv) = s.merge_rows("k", &[row(10, 9.9)], 10, 11);
        assert!(inv);
        assert_eq!(n, 1);
        assert_eq!(s.read_rows("k", 0, 100).len(), 1);
        assert_eq!(s.uncovered("k", 10, 15), vec![(11, 15)]); // coverage 재시작
    }

    #[test]
    fn open_candle_update_is_not_conflict() {
        let (_d, s) = store();
        // cov_end=15 — date 16 은 미완결 영역 (coverage 밖, row 만 저장)
        s.merge_rows("k", &[row(12, 1.0), row(16, 5.0)], 10, 15);
        // 같은 date 16 이 다른 값으로 재도착 = 장중 갱신 → conflict 아님, overwrite
        let (_, inv) = s.merge_rows("k", &[row(16, 5.5)], 10, 15);
        assert!(!inv);
        let rows = s.read_rows("k", 16, 17);
        assert_eq!(rows[0]["close"], 5.5);
    }

    #[test]
    fn series_are_isolated_by_key() {
        let (_d, s) = store();
        s.merge_rows("a", &[row(10, 1.0)], 10, 11);
        assert_eq!(s.uncovered("b", 10, 11), vec![(10, 11)]);
        assert!(s.read_rows("b", 0, 100).is_empty());
    }
}
