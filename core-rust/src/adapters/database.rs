//! SqliteDatabaseAdapter — IDatabasePort 의 rusqlite 구현체.
//!
//! 옛 TS SqliteDatabaseAdapter (`infra/database/index.ts`) Rust 재구현.
//! Schema: pages / conversations / shared / deleted / 등 (Phase B 진행하며 점진 추가).
//! Mutex<Connection> 으로 thread-safe.

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

use crate::ports::{IDatabasePort, MediaUsageEntry, PageListItem, PageRecord};

pub struct SqliteDatabaseAdapter {
    conn: Mutex<Connection>,
}

impl SqliteDatabaseAdapter {
    pub fn new(db_path: impl AsRef<Path>) -> Result<Self, String> {
        let path = db_path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("DB 디렉토리 생성 실패: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("DB open 실패: {e}"))?;
        Self::initialize(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("DB in-memory open 실패: {e}"))?;
        Self::initialize(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Schema 초기화 — 필수 테이블 + 마이그레이션. 옛 TS initialize() Rust port.
    fn initialize(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS pages (
                slug TEXT PRIMARY KEY,
                spec TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'published',
                project TEXT,
                visibility TEXT DEFAULT 'public',
                password TEXT,
                created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
                updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
            );
            CREATE INDEX IF NOT EXISTS idx_pages_project ON pages(project);
            CREATE INDEX IF NOT EXISTS idx_pages_updated ON pages(updated_at DESC);

            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                owner TEXT NOT NULL DEFAULT 'admin',
                title TEXT NOT NULL DEFAULT '새 대화',
                messages TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                cli_session_id TEXT,
                cli_model TEXT,
                active_plan_state TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_conversations_owner_updated
                ON conversations(owner, updated_at DESC);

            CREATE TABLE IF NOT EXISTS deleted_conversations (
                id TEXT NOT NULL,
                owner TEXT NOT NULL,
                deleted_at INTEGER NOT NULL,
                PRIMARY KEY (id, owner)
            );

            CREATE TABLE IF NOT EXISTS llm_costs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cached_tokens INTEGER NOT NULL DEFAULT 0,
                cost_usd REAL NOT NULL DEFAULT 0,
                purpose TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_costs_ts ON llm_costs(ts DESC);

            CREATE TABLE IF NOT EXISTS page_redirects (
                from_slug TEXT PRIMARY KEY,
                to_slug TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS media_usage (
                media_slug TEXT NOT NULL,
                page_slug TEXT NOT NULL,
                used_at INTEGER NOT NULL,
                PRIMARY KEY (media_slug, page_slug)
            );
            CREATE INDEX IF NOT EXISTS idx_media_usage_page ON media_usage(page_slug);
            CREATE INDEX IF NOT EXISTS idx_media_usage_media ON media_usage(media_slug, used_at DESC);
            "#,
        )
        .map_err(|e| format!("DB schema 초기화 실패: {e}"))
    }

    /// 다른 어댑터 (CostManager / EntityManager 등) 가 같은 DB 위에 자기 테이블 박을 때 활용.
    pub fn with_conn<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> rusqlite::Result<T>,
    {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("DB lock 실패: {e}"))?;
        f(&conn).map_err(|e| format!("DB query 실패: {e}"))
    }

    /// PageSpec JSON parse → featured_image / excerpt 자동 추출.
    /// 옛 TS extractFeaturedAndExcerpt 와 동일 로직.
    fn extract_featured_excerpt(spec: &str) -> (Option<String>, Option<String>, Option<String>) {
        let Ok(parsed): Result<serde_json::Value, _> = serde_json::from_str(spec) else {
            return (None, None, None);
        };
        let head = parsed.get("head");
        let title = head
            .and_then(|h| h.get("title"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let mut featured: Option<String> = head
            .and_then(|h| h.get("og"))
            .and_then(|og| og.get("image"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let mut excerpt: Option<String> = head
            .and_then(|h| h.get("description"))
            .and_then(|v| v.as_str())
            .map(String::from);
        // body 첫 Image / Text 에서 fallback 추출
        if featured.is_none() || excerpt.is_none() {
            if let Some(body) = parsed.get("body").and_then(|b| b.as_array()) {
                for block in body {
                    let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if featured.is_none() && block_type == "Image" {
                        if let Some(src) = block.get("src").and_then(|v| v.as_str()) {
                            featured = Some(src.to_string());
                        }
                    }
                    if excerpt.is_none() && block_type == "Text" {
                        if let Some(content) = block.get("content").and_then(|v| v.as_str()) {
                            let compact = content.split_whitespace().collect::<Vec<_>>().join(" ");
                            if !compact.is_empty() {
                                excerpt = Some(if compact.chars().count() > 120 {
                                    let truncated: String = compact.chars().take(120).collect();
                                    format!("{}…", truncated)
                                } else {
                                    compact
                                });
                            }
                        }
                    }
                    if featured.is_some() && excerpt.is_some() {
                        break;
                    }
                }
            }
        }
        (featured, excerpt, title)
    }
}

impl IDatabasePort for SqliteDatabaseAdapter {
    fn list_pages(&self) -> Vec<PageListItem> {
        let Ok(conn) = self.conn.lock() else {
            return vec![];
        };
        let Ok(mut stmt) = conn.prepare(
            "SELECT slug, spec, status, project, visibility, created_at, updated_at
             FROM pages ORDER BY updated_at DESC",
        ) else {
            return vec![];
        };
        let rows = stmt
            .query_map([], |row| {
                let slug: String = row.get(0)?;
                let spec: String = row.get(1)?;
                let status: String = row.get(2)?;
                let project: Option<String> = row.get(3)?;
                let visibility: Option<String> = row.get(4)?;
                let created_at: i64 = row.get(5)?;
                let updated_at: i64 = row.get(6)?;
                Ok((slug, spec, status, project, visibility, created_at, updated_at))
            })
            .ok();
        let Some(rows) = rows else { return vec![] };
        rows.filter_map(|r| r.ok())
            .map(|(slug, spec, status, project, visibility, created_at, updated_at)| {
                let (featured, excerpt, title) = Self::extract_featured_excerpt(&spec);
                PageListItem {
                    slug,
                    status,
                    project,
                    visibility,
                    title,
                    updated_at,
                    created_at,
                    featured_image: featured,
                    excerpt,
                }
            })
            .collect()
    }

    fn get_page(&self, slug: &str) -> Option<PageRecord> {
        let conn = self.conn.lock().ok()?;
        let mut stmt = conn
            .prepare(
                "SELECT slug, spec, status, project, visibility, password, created_at, updated_at
                 FROM pages WHERE slug = ?1",
            )
            .ok()?;
        stmt.query_row(params![slug], |row| {
            Ok(PageRecord {
                slug: row.get(0)?,
                spec: row.get(1)?,
                status: row.get(2)?,
                project: row.get(3)?,
                visibility: row.get(4)?,
                password: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .ok()
    }

    fn save_page(
        &self,
        slug: &str,
        spec: &str,
        status: &str,
        project: Option<&str>,
        visibility: Option<&str>,
        password: Option<&str>,
    ) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        conn.execute(
            "INSERT INTO pages (slug, spec, status, project, visibility, password, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(slug) DO UPDATE SET
                spec = excluded.spec,
                status = excluded.status,
                project = excluded.project,
                visibility = excluded.visibility,
                password = excluded.password,
                updated_at = excluded.updated_at",
            params![slug, spec, status, project, visibility, password, now],
        )
        .is_ok()
    }

    fn delete_page(&self, slug: &str) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        conn.execute("DELETE FROM pages WHERE slug = ?1", params![slug])
            .is_ok()
    }

    fn delete_pages_by_project(&self, project: &str) -> Vec<String> {
        let Ok(conn) = self.conn.lock() else {
            return vec![];
        };
        // 먼저 slug 수집
        let slugs: Vec<String> = {
            let Ok(mut stmt) = conn.prepare("SELECT slug FROM pages WHERE project = ?1") else {
                return vec![];
            };
            let Ok(rows) = stmt.query_map(params![project], |row| row.get::<_, String>(0)) else {
                return vec![];
            };
            rows.filter_map(|r| r.ok()).collect()
        };
        // 일괄 삭제
        let _ = conn.execute("DELETE FROM pages WHERE project = ?1", params![project]);
        slugs
    }

    fn list_pages_by_project(&self, project: &str) -> Vec<String> {
        let Ok(conn) = self.conn.lock() else {
            return vec![];
        };
        let Ok(mut stmt) = conn.prepare("SELECT slug FROM pages WHERE project = ?1 ORDER BY updated_at DESC")
        else { return vec![] };
        let rows = stmt.query_map(params![project], |row| row.get::<_, String>(0)).ok();
        let Some(rows) = rows else { return vec![] };
        rows.filter_map(|r| r.ok()).collect()
    }

    fn set_page_visibility(&self, slug: &str, visibility: &str, password: Option<&str>) -> bool {
        let Ok(conn) = self.conn.lock() else { return false };
        // password=None 또는 visibility != 'password' 면 password 컬럼 NULL 로 설정
        let pw = if visibility == "password" { password } else { None };
        conn.execute(
            "UPDATE pages SET visibility = ?1, password = ?2 WHERE slug = ?3",
            params![visibility, pw, slug],
        )
        .is_ok()
    }

    fn verify_page_password(&self, slug: &str, password: &str) -> bool {
        let Ok(conn) = self.conn.lock() else { return false };
        let stored: Option<String> = conn
            .query_row(
                "SELECT password FROM pages WHERE slug = ?1",
                params![slug],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        stored.as_deref() == Some(password)
    }

    fn upsert_page_redirect(&self, from_slug: &str, to_slug: &str) -> bool {
        let Ok(conn) = self.conn.lock() else { return false };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        conn.execute(
            "INSERT INTO page_redirects (from_slug, to_slug, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(from_slug) DO UPDATE SET
                to_slug = excluded.to_slug,
                created_at = excluded.created_at",
            params![from_slug, to_slug, now],
        )
        .is_ok()
    }

    fn get_page_redirect(&self, from_slug: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT to_slug FROM page_redirects WHERE from_slug = ?1",
            params![from_slug],
            |row| row.get(0),
        )
        .ok()
    }

    fn replace_media_usage(&self, page_slug: &str, media_slugs: &[String]) -> bool {
        let Ok(conn) = self.conn.lock() else { return false };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        // 트랜잭션 — 옛 사용처 삭제 + 새 일괄 insert
        let tx_result: rusqlite::Result<()> = (|| {
            conn.execute("DELETE FROM media_usage WHERE page_slug = ?1", params![page_slug])?;
            for media_slug in media_slugs {
                conn.execute(
                    "INSERT OR REPLACE INTO media_usage (media_slug, page_slug, used_at)
                     VALUES (?1, ?2, ?3)",
                    params![media_slug, page_slug, now],
                )?;
            }
            Ok(())
        })();
        tx_result.is_ok()
    }

    fn delete_media_usage_for_page(&self, page_slug: &str) -> bool {
        let Ok(conn) = self.conn.lock() else { return false };
        conn.execute("DELETE FROM media_usage WHERE page_slug = ?1", params![page_slug])
            .is_ok()
    }

    fn find_media_usage(&self, media_slug: &str) -> Vec<MediaUsageEntry> {
        let Ok(conn) = self.conn.lock() else { return vec![] };
        let Ok(mut stmt) = conn.prepare(
            "SELECT page_slug, used_at FROM media_usage WHERE media_slug = ?1 ORDER BY used_at DESC",
        ) else {
            return vec![];
        };
        let rows = stmt
            .query_map(params![media_slug], |row| {
                Ok(MediaUsageEntry {
                    page_slug: row.get(0)?,
                    used_at: row.get(1)?,
                })
            })
            .ok();
        let Some(rows) = rows else { return vec![] };
        rows.filter_map(|r| r.ok()).collect()
    }

    fn search_pages(&self, query: &str, limit: usize) -> Vec<PageListItem> {
        if query.is_empty() {
            return vec![];
        }
        let Ok(conn) = self.conn.lock() else {
            return vec![];
        };
        let pattern = format!("%{}%", query);
        let Ok(mut stmt) = conn.prepare(
            "SELECT slug, spec, status, project, visibility, created_at, updated_at
             FROM pages
             WHERE slug LIKE ?1 OR spec LIKE ?1
             ORDER BY updated_at DESC LIMIT ?2",
        ) else {
            return vec![];
        };
        let rows = stmt
            .query_map(params![pattern, limit as i64], |row| {
                let slug: String = row.get(0)?;
                let spec: String = row.get(1)?;
                let status: String = row.get(2)?;
                let project: Option<String> = row.get(3)?;
                let visibility: Option<String> = row.get(4)?;
                let created_at: i64 = row.get(5)?;
                let updated_at: i64 = row.get(6)?;
                Ok((slug, spec, status, project, visibility, created_at, updated_at))
            })
            .ok();
        let Some(rows) = rows else { return vec![] };
        rows.filter_map(|r| r.ok())
            .map(|(slug, spec, status, project, visibility, created_at, updated_at)| {
                let (featured, excerpt, title) = Self::extract_featured_excerpt(&spec);
                PageListItem {
                    slug,
                    status,
                    project,
                    visibility,
                    title,
                    updated_at,
                    created_at,
                    featured_image: featured,
                    excerpt,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_spec(title: &str, body_text: &str) -> String {
        serde_json::json!({
            "head": { "title": title, "description": format!("desc of {title}") },
            "body": [{"type": "Text", "props": {}, "content": body_text}]
        })
        .to_string()
    }

    #[test]
    fn pages_crud_roundtrip() {
        let db = SqliteDatabaseAdapter::new_in_memory().unwrap();

        assert_eq!(db.list_pages().len(), 0);

        // save
        assert!(db.save_page(
            "weekly",
            &sample_spec("주간 시황", "월요일 시작"),
            "published",
            Some("stock-blog"),
            Some("public"),
            None,
        ));

        // get
        let got = db.get_page("weekly").unwrap();
        assert_eq!(got.slug, "weekly");
        assert_eq!(got.project.as_deref(), Some("stock-blog"));

        // list
        let list = db.list_pages();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title.as_deref(), Some("주간 시황"));
        assert!(list[0].excerpt.is_some());

        // search
        let found = db.search_pages("시황", 10);
        assert_eq!(found.len(), 1);

        // delete
        assert!(db.delete_page("weekly"));
        assert!(db.get_page("weekly").is_none());
    }

    #[test]
    fn delete_by_project() {
        let db = SqliteDatabaseAdapter::new_in_memory().unwrap();
        db.save_page("p1", &sample_spec("a", ""), "published", Some("blog"), None, None);
        db.save_page("p2", &sample_spec("b", ""), "published", Some("blog"), None, None);
        db.save_page("p3", &sample_spec("c", ""), "published", Some("other"), None, None);

        let deleted = db.delete_pages_by_project("blog");
        assert_eq!(deleted.len(), 2);

        let remaining = db.list_pages();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].slug, "p3");
    }

    #[test]
    fn save_upsert_updates_existing() {
        let db = SqliteDatabaseAdapter::new_in_memory().unwrap();
        db.save_page("p1", &sample_spec("v1", ""), "draft", None, None, None);
        let before = db.get_page("p1").unwrap();
        db.save_page("p1", &sample_spec("v2", ""), "published", None, None, None);
        let after = db.get_page("p1").unwrap();
        assert_eq!(after.status, "published");
        assert!(after.spec.contains("v2"));
        assert_ne!(before.spec, after.spec);
    }
}
