//! SqliteDatabaseAdapter — IDatabasePort 의 rusqlite 구현체.
//!
//! 옛 TS SqliteDatabaseAdapter (`infra/database/index.ts`) Rust 재구현.
//! Schema: pages / conversations / shared / deleted / 등 (Phase B 진행하며 점진 추가).
//! Mutex<Connection> 으로 thread-safe.

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

use crate::ports::{
    ConversationEmbeddingMeta, ConversationEmbeddingRow, ConversationRecord, ConversationSummary,
    IDatabasePort, InfraResult, MediaUsageEntry, PageListItem, PageRecord,
};

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

            -- 메시지 단위 벡터 임베딩 — search_history 도구용 (과거 대화 cosine 검색).
            -- 옛 TS infra/database/index.ts 의 conversation_embeddings 1:1 port.
            -- content_hash 는 sha1(`${embedder_version}:${text}`) — 모델 교체 시 자동 재임베딩 trigger.
            CREATE TABLE IF NOT EXISTS conversation_embeddings (
                conv_id         TEXT NOT NULL,
                owner           TEXT NOT NULL,
                msg_idx         INTEGER NOT NULL,
                role            TEXT NOT NULL,
                content_hash    TEXT NOT NULL,
                content_preview TEXT NOT NULL,
                embedding       BLOB NOT NULL,
                created_at      INTEGER NOT NULL,
                PRIMARY KEY (conv_id, msg_idx)
            );
            CREATE INDEX IF NOT EXISTS idx_conv_embeddings_owner
                ON conversation_embeddings(owner, created_at DESC);

            -- 공유된 대화 (turn 또는 full) — 외부 URL 으로 공유 가능 (옛 TS shared_conversations 1:1).
            -- TTL 기반 자동 만료 + dedup_key 기반 재사용 (같은 dedup → 같은 share slug 재발급).
            CREATE TABLE IF NOT EXISTS shared_conversations (
                slug            TEXT PRIMARY KEY,
                type            TEXT NOT NULL,        -- 'turn' | 'full'
                title           TEXT NOT NULL,
                messages        TEXT NOT NULL,        -- JSON array
                owner           TEXT,
                source_conv_id  TEXT,
                created_at      INTEGER NOT NULL,
                expires_at      INTEGER NOT NULL,
                dedup_key       TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_shares_dedup
                ON shared_conversations(dedup_key, expires_at DESC);
            CREATE INDEX IF NOT EXISTS idx_shares_expires
                ON shared_conversations(expires_at);
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

    fn list_conversations(&self, owner: &str) -> Vec<ConversationSummary> {
        let Ok(conn) = self.conn.lock() else { return vec![] };
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, title, created_at, updated_at FROM conversations
             WHERE owner = ?1 ORDER BY updated_at DESC",
        ) else { return vec![] };
        let rows = stmt
            .query_map(params![owner], |row| {
                Ok(ConversationSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .ok();
        let Some(rows) = rows else { return vec![] };
        rows.filter_map(|r| r.ok()).collect()
    }

    fn get_conversation(&self, owner: &str, id: &str) -> Option<ConversationRecord> {
        let conn = self.conn.lock().ok()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, title, messages, created_at, updated_at FROM conversations
                 WHERE owner = ?1 AND id = ?2",
            )
            .ok()?;
        stmt.query_row(params![owner, id], |row| {
            let messages_str: String = row.get(2)?;
            let messages: serde_json::Value =
                serde_json::from_str(&messages_str).unwrap_or(serde_json::json!([]));
            Ok(ConversationRecord {
                id: row.get(0)?,
                title: row.get(1)?,
                messages,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .ok()
    }

    fn save_conversation(
        &self,
        owner: &str,
        id: &str,
        title: &str,
        messages_json: &str,
        created_at: Option<i64>,
    ) -> bool {
        let Ok(conn) = self.conn.lock() else { return false };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let created = created_at.unwrap_or(now);
        conn.execute(
            "INSERT INTO conversations (id, owner, title, messages, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                messages = excluded.messages,
                updated_at = excluded.updated_at",
            params![id, owner, title, messages_json, created, now],
        )
        .is_ok()
    }

    fn delete_conversation(&self, owner: &str, id: &str) -> bool {
        let Ok(conn) = self.conn.lock() else { return false };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        // tombstone 기록 + row 삭제 + 임베딩 cascade — 옛 TS 와 동등
        let r1 = conn.execute(
            "INSERT OR REPLACE INTO deleted_conversations (id, owner, deleted_at)
             VALUES (?1, ?2, ?3)",
            params![id, owner, now],
        );
        let r2 = conn.execute(
            "DELETE FROM conversations WHERE id = ?1 AND owner = ?2",
            params![id, owner],
        );
        // conversation_embeddings 도 cascade 정리 (옛 TS 와 동등 — Conv 삭제 시 임베딩도 비움)
        let _ = conn.execute(
            "DELETE FROM conversation_embeddings WHERE conv_id = ?1 AND owner = ?2",
            params![id, owner],
        );
        r1.is_ok() && r2.is_ok()
    }

    fn is_conversation_deleted(&self, owner: &str, id: &str) -> bool {
        let Ok(conn) = self.conn.lock() else { return false };
        conn.query_row(
            "SELECT 1 FROM deleted_conversations WHERE id = ?1 AND owner = ?2",
            params![id, owner],
            |row| row.get::<_, i64>(0),
        )
        .is_ok()
    }

    fn get_cli_session(&self, conversation_id: &str, current_model: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        // session_id 와 model 이 모두 일치할 때만 반환 (모델 바뀌면 자동 무효)
        conn.query_row(
            "SELECT cli_session_id FROM conversations
             WHERE id = ?1 AND cli_model = ?2 AND cli_session_id IS NOT NULL",
            params![conversation_id, current_model],
            |row| row.get(0),
        )
        .ok()
    }

    fn set_cli_session(&self, conversation_id: &str, session_id: &str, model: &str) -> bool {
        let Ok(conn) = self.conn.lock() else { return false };
        conn.execute(
            "UPDATE conversations SET cli_session_id = ?1, cli_model = ?2 WHERE id = ?3",
            params![session_id, model, conversation_id],
        )
        .is_ok()
    }

    fn get_active_plan_state(&self, conversation_id: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT active_plan_state FROM conversations WHERE id = ?1",
            params![conversation_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    fn set_active_plan_state(&self, conversation_id: &str, state: Option<&str>) -> bool {
        let Ok(conn) = self.conn.lock() else { return false };
        conn.execute(
            "UPDATE conversations SET active_plan_state = ?1 WHERE id = ?2",
            params![state, conversation_id],
        )
        .is_ok()
    }

    // ── Conversation embeddings (search_history cosine 검색용) ────────────────

    fn list_conversation_embeddings(
        &self,
        owner: &str,
        conv_id: &str,
    ) -> Vec<ConversationEmbeddingMeta> {
        let Ok(conn) = self.conn.lock() else { return vec![] };
        let Ok(mut stmt) = conn.prepare(
            "SELECT msg_idx, content_hash FROM conversation_embeddings
             WHERE conv_id = ?1 AND owner = ?2",
        ) else {
            return vec![];
        };
        let rows = stmt
            .query_map(params![conv_id, owner], |row| {
                Ok(ConversationEmbeddingMeta {
                    msg_idx: row.get(0)?,
                    content_hash: row.get(1)?,
                })
            })
            .ok();
        let Some(rows) = rows else { return vec![] };
        rows.filter_map(|r| r.ok()).collect()
    }

    fn upsert_conversation_embedding(&self, row: &ConversationEmbeddingRow) -> bool {
        let Ok(conn) = self.conn.lock() else { return false };
        conn.execute(
            "INSERT INTO conversation_embeddings
                (conv_id, owner, msg_idx, role, content_hash, content_preview, embedding, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(conv_id, msg_idx) DO UPDATE SET
                role = excluded.role,
                content_hash = excluded.content_hash,
                content_preview = excluded.content_preview,
                embedding = excluded.embedding,
                created_at = excluded.created_at",
            params![
                row.conv_id,
                row.owner,
                row.msg_idx,
                row.role,
                row.content_hash,
                row.content_preview,
                row.embedding,
                row.created_at,
            ],
        )
        .is_ok()
    }

    fn delete_conversation_embeddings_by_idx(
        &self,
        owner: &str,
        conv_id: &str,
        msg_idxs: &[i64],
    ) -> bool {
        if msg_idxs.is_empty() {
            return true;
        }
        let Ok(conn) = self.conn.lock() else { return false };
        // IN (?,?,?) — 동적 placeholders. 일반 로직 (msg_idxs 길이 무관)
        let placeholders = msg_idxs.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "DELETE FROM conversation_embeddings
             WHERE conv_id = ? AND owner = ? AND msg_idx IN ({})",
            placeholders
        );
        let mut sql_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(msg_idxs.len() + 2);
        sql_params.push(Box::new(conv_id.to_string()));
        sql_params.push(Box::new(owner.to_string()));
        for idx in msg_idxs {
            sql_params.push(Box::new(*idx));
        }
        let refs: Vec<&dyn rusqlite::ToSql> = sql_params.iter().map(|b| b.as_ref()).collect();
        conn.execute(&sql, refs.as_slice()).is_ok()
    }

    fn delete_all_conversation_embeddings(&self, owner: &str, conv_id: &str) -> bool {
        let Ok(conn) = self.conn.lock() else { return false };
        conn.execute(
            "DELETE FROM conversation_embeddings WHERE conv_id = ?1 AND owner = ?2",
            params![conv_id, owner],
        )
        .is_ok()
    }

    fn query_conversation_embeddings_since(
        &self,
        owner: &str,
        cutoff_ms: i64,
    ) -> Vec<ConversationEmbeddingRow> {
        let Ok(conn) = self.conn.lock() else { return vec![] };
        let Ok(mut stmt) = conn.prepare(
            "SELECT e.conv_id, c.title, e.owner, e.msg_idx, e.role,
                    e.content_hash, e.content_preview, e.embedding, e.created_at
             FROM conversation_embeddings e
             LEFT JOIN conversations c ON c.id = e.conv_id
             WHERE e.owner = ?1 AND e.created_at >= ?2",
        ) else {
            return vec![];
        };
        let rows = stmt
            .query_map(params![owner, cutoff_ms], |row| {
                Ok(ConversationEmbeddingRow {
                    conv_id: row.get(0)?,
                    conv_title: row.get(1)?,
                    owner: row.get(2)?,
                    msg_idx: row.get(3)?,
                    role: row.get(4)?,
                    content_hash: row.get(5)?,
                    content_preview: row.get(6)?,
                    embedding: row.get(7)?,
                    created_at: row.get(8)?,
                })
            })
            .ok();
        let Some(rows) = rows else { return vec![] };
        rows.filter_map(|r| r.ok()).collect()
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

    fn create_share(
        &self,
        input: &crate::ports::CreateShareInput,
    ) -> InfraResult<crate::ports::CreateShareResult> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("DB lock 실패: {e}"))?;
        let now = chrono::Utc::now().timestamp_millis();
        let expires_at = now + input.ttl_ms;

        // dedup_key 박혀있고 유효 share 존재 → 재사용 (옛 TS 1:1)
        if let Some(dedup) = &input.dedup_key {
            let existing: Option<(String, i64)> = conn
                .query_row(
                    "SELECT slug, expires_at FROM shared_conversations
                     WHERE dedup_key = ?1 AND expires_at > ?2
                     ORDER BY created_at DESC LIMIT 1",
                    params![dedup, now],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok();
            if let Some((slug, exp)) = existing {
                return Ok(crate::ports::CreateShareResult {
                    slug,
                    expires_at: exp,
                    reused: true,
                });
            }
        }

        // 신규 slug 발급 — 8자 base36 random. 5회까지 충돌 재시도 (옛 TS 1:1).
        let messages_json = serde_json::to_string(&input.messages)
            .map_err(|e| format!("messages 직렬화 실패: {e}"))?;
        for _attempt in 0..5 {
            use rand::RngCore;
            let mut buf = [0u8; 5];
            rand::thread_rng().fill_bytes(&mut buf);
            // 5바이트 → 10 hex char → 8 char prefix
            let slug = hex::encode(buf);
            let slug = &slug[..8];

            let result = conn.execute(
                "INSERT INTO shared_conversations
                 (slug, type, title, messages, owner, source_conv_id, created_at, expires_at, dedup_key)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    slug,
                    input.share_type,
                    input.title,
                    messages_json,
                    input.owner,
                    input.source_conv_id,
                    now,
                    expires_at,
                    input.dedup_key
                ],
            );
            match result {
                Ok(_) => {
                    return Ok(crate::ports::CreateShareResult {
                        slug: slug.to_string(),
                        expires_at,
                        reused: false,
                    });
                }
                Err(rusqlite::Error::SqliteFailure(err, _))
                    if err.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    continue; // slug 충돌 → 재시도
                }
                Err(e) => return Err(format!("create_share 실패: {e}")),
            }
        }
        Err("slug 충돌 5회 — 재시도 포기".to_string())
    }

    fn get_share(&self, slug: &str) -> Option<crate::ports::SharedConversationRecord> {
        let conn = self.conn.lock().ok()?;
        let row: (String, String, String, String, i64, i64) = conn
            .query_row(
                "SELECT slug, type, title, messages, created_at, expires_at
                 FROM shared_conversations WHERE slug = ?1",
                params![slug],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .ok()?;
        // 만료 검사 — 옛 TS 1:1, 만료면 None (404 처리용).
        let now = chrono::Utc::now().timestamp_millis();
        if row.5 < now {
            return None;
        }
        let messages: Vec<serde_json::Value> = serde_json::from_str(&row.3).unwrap_or_default();
        Some(crate::ports::SharedConversationRecord {
            slug: row.0,
            share_type: row.1,
            title: row.2,
            messages,
            created_at: row.4,
            expires_at: row.5,
        })
    }

    fn cleanup_expired_shares(&self) -> i64 {
        let Ok(conn) = self.conn.lock() else {
            return 0;
        };
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "DELETE FROM shared_conversations WHERE expires_at < ?1",
            params![now],
        )
        .map(|n| n as i64)
        .unwrap_or(0)
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

    #[test]
    fn create_share_basic() {
        let db = SqliteDatabaseAdapter::new_in_memory().unwrap();
        let input = crate::ports::CreateShareInput {
            share_type: "turn".to_string(),
            title: "테스트 공유".to_string(),
            messages: vec![serde_json::json!({"id": "u-1", "content": "test"})],
            owner: Some("admin".to_string()),
            source_conv_id: Some("conv-1".to_string()),
            ttl_ms: 3600 * 1000, // 1시간
            dedup_key: None,
        };
        let result = db.create_share(&input).unwrap();
        assert_eq!(result.slug.len(), 8);
        assert!(!result.reused);
        assert!(result.expires_at > 0);

        let retrieved = db.get_share(&result.slug).unwrap();
        assert_eq!(retrieved.title, "테스트 공유");
        assert_eq!(retrieved.share_type, "turn");
        assert_eq!(retrieved.messages.len(), 1);
    }

    #[test]
    fn create_share_dedup_reuses_existing() {
        let db = SqliteDatabaseAdapter::new_in_memory().unwrap();
        let input = crate::ports::CreateShareInput {
            share_type: "full".to_string(),
            title: "dedup test".to_string(),
            messages: vec![],
            owner: None,
            source_conv_id: None,
            ttl_ms: 3600 * 1000,
            dedup_key: Some("conv-123:hash-abc".to_string()),
        };
        let r1 = db.create_share(&input).unwrap();
        assert!(!r1.reused);

        // 같은 dedup_key 재호출 → reused=true + 같은 slug
        let r2 = db.create_share(&input).unwrap();
        assert!(r2.reused);
        assert_eq!(r1.slug, r2.slug);
    }

    #[test]
    fn get_share_returns_none_for_expired() {
        let db = SqliteDatabaseAdapter::new_in_memory().unwrap();
        let input = crate::ports::CreateShareInput {
            share_type: "turn".to_string(),
            title: "만료될 공유".to_string(),
            messages: vec![],
            owner: None,
            source_conv_id: None,
            ttl_ms: -1, // 이미 만료
            dedup_key: None,
        };
        let result = db.create_share(&input).unwrap();
        // 만료된 share 는 get 시 None (옛 TS 1:1)
        assert!(db.get_share(&result.slug).is_none());
    }

    #[test]
    fn cleanup_expired_shares_removes_old() {
        let db = SqliteDatabaseAdapter::new_in_memory().unwrap();
        // 만료된 share 박음
        db.create_share(&crate::ports::CreateShareInput {
            share_type: "turn".to_string(),
            title: "만료1".to_string(),
            messages: vec![],
            owner: None,
            source_conv_id: None,
            ttl_ms: -1000,
            dedup_key: None,
        })
        .unwrap();
        db.create_share(&crate::ports::CreateShareInput {
            share_type: "turn".to_string(),
            title: "만료2".to_string(),
            messages: vec![],
            owner: None,
            source_conv_id: None,
            ttl_ms: -1000,
            dedup_key: None,
        })
        .unwrap();
        // 유효 share 박음
        let valid = db
            .create_share(&crate::ports::CreateShareInput {
                share_type: "turn".to_string(),
                title: "유효".to_string(),
                messages: vec![],
                owner: None,
                source_conv_id: None,
                ttl_ms: 3600 * 1000,
                dedup_key: None,
            })
            .unwrap();

        let deleted = db.cleanup_expired_shares();
        assert_eq!(deleted, 2);
        assert!(db.get_share(&valid.slug).is_some()); // 유효 share 보존
    }
}
