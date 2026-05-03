//! SqliteMemoryAdapter — IEntityPort + IEpisodicPort 통합 SQLite 어댑터.
//!
//! 옛 TS SqliteEntityAdapter + SqliteEpisodicAdapter Rust 재구현 (Phase B-12 minimum).
//!
//! Phase B-12 minimum:
//! - Entity / Fact / Event / Event-Entity m2m link CRUD 박힘
//! - Search = name + alias + content substring 매칭 (옛 TS 의 cosine 미박음)
//! - Phase B-15+ IEmbedderPort 박힌 후 cosine search 활성 (this file 한 곳만 수정)
//!
//! Schema: 옛 TS migration v2 (entities + entity_facts) + v3 (events + event_entities) Rust port.

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

use crate::ports::{
    EntityFactRecord, EntityRecord, EntitySearchOpts, EventRecord, EventSearchOpts, FactSearchOpts,
    IEntityPort, IEpisodicPort, InfraResult, ListRecentOpts, SaveEntityInput, SaveEventInput,
    SaveFactInput, TimelineOpts, UpdateEntityPatch, UpdateEventPatch, UpdateFactPatch,
};

pub struct SqliteMemoryAdapter {
    conn: Mutex<Connection>,
}

impl SqliteMemoryAdapter {
    pub fn new(db_path: impl AsRef<Path>) -> Result<Self, String> {
        let path = db_path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Memory DB 디렉토리 생성 실패: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("Memory DB open 실패: {e}"))?;
        Self::initialize(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Memory DB in-memory open 실패: {e}"))?;
        Self::initialize(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn initialize(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            r#"
            -- Entities (Phase 1)
            CREATE TABLE IF NOT EXISTS entities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                aliases TEXT NOT NULL DEFAULT '[]',
                metadata TEXT,
                source_conv_id TEXT,
                created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
                updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
                UNIQUE(name, type)
            );
            CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
            CREATE INDEX IF NOT EXISTS idx_entities_updated ON entities(updated_at DESC);

            -- Entity Facts (Phase 1)
            CREATE TABLE IF NOT EXISTS entity_facts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_id INTEGER NOT NULL,
                content TEXT NOT NULL,
                fact_type TEXT,
                occurred_at INTEGER,
                tags TEXT NOT NULL DEFAULT '[]',
                source_conv_id TEXT,
                expires_at INTEGER,
                created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
                FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_facts_entity ON entity_facts(entity_id);
            CREATE INDEX IF NOT EXISTS idx_facts_type ON entity_facts(fact_type);
            CREATE INDEX IF NOT EXISTS idx_facts_occurred ON entity_facts(occurred_at DESC);
            CREATE INDEX IF NOT EXISTS idx_facts_expires ON entity_facts(expires_at);

            -- Events (Phase 2)
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                who TEXT,
                context TEXT,
                occurred_at INTEGER NOT NULL,
                source_conv_id TEXT,
                expires_at INTEGER,
                created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
            );
            CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
            CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at DESC);
            CREATE INDEX IF NOT EXISTS idx_events_expires ON events(expires_at);

            -- Event-Entity m2m
            CREATE TABLE IF NOT EXISTS event_entities (
                event_id INTEGER NOT NULL,
                entity_id INTEGER NOT NULL,
                PRIMARY KEY (event_id, entity_id),
                FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
                FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_event_entities_event ON event_entities(event_id);
            CREATE INDEX IF NOT EXISTS idx_event_entities_entity ON event_entities(entity_id);
            "#,
        )
        .map_err(|e| format!("Memory schema 초기화 실패: {e}"))
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_str_array(raw: Option<String>) -> Vec<String> {
    raw.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn parse_json_value(raw: Option<String>) -> Option<serde_json::Value> {
    raw.and_then(|s| serde_json::from_str(&s).ok())
}

impl SqliteMemoryAdapter {
    fn entity_from_row(row: &rusqlite::Row, fact_count: i64) -> rusqlite::Result<EntityRecord> {
        let aliases_raw: Option<String> = row.get(3)?;
        let metadata_raw: Option<String> = row.get(4)?;
        Ok(EntityRecord {
            id: row.get(0)?,
            name: row.get(1)?,
            entity_type: row.get(2)?,
            aliases: parse_str_array(aliases_raw),
            metadata: parse_json_value(metadata_raw),
            source_conv_id: row.get(5)?,
            fact_count,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    }

    fn fact_from_row(row: &rusqlite::Row) -> rusqlite::Result<EntityFactRecord> {
        let tags_raw: Option<String> = row.get(5)?;
        Ok(EntityFactRecord {
            id: row.get(0)?,
            entity_id: row.get(1)?,
            content: row.get(2)?,
            fact_type: row.get(3)?,
            occurred_at: row.get(4)?,
            tags: parse_str_array(tags_raw),
            source_conv_id: row.get(6)?,
            expires_at: row.get(7)?,
            created_at: row.get(8)?,
        })
    }
}

impl IEntityPort for SqliteMemoryAdapter {
    fn save_entity(&self, input: &SaveEntityInput) -> InfraResult<(i64, bool)> {
        if input.name.trim().is_empty() {
            return Err("entity name 누락".to_string());
        }
        if input.entity_type.trim().is_empty() {
            return Err("entity type 누락".to_string());
        }
        let conn = self.conn.lock().unwrap();
        let now = now_ms();
        let aliases_json =
            serde_json::to_string(&input.aliases).map_err(|e| format!("aliases 직렬화: {e}"))?;
        let metadata_json = match &input.metadata {
            Some(v) => Some(
                serde_json::to_string(v).map_err(|e| format!("metadata 직렬화: {e}"))?,
            ),
            None => None,
        };

        // upsert by UNIQUE(name, type)
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM entities WHERE name = ?1 AND type = ?2",
                params![input.name, input.entity_type],
                |r| r.get(0),
            )
            .ok();

        if let Some(id) = existing {
            conn.execute(
                "UPDATE entities SET aliases = ?1, metadata = ?2, source_conv_id = COALESCE(?3, source_conv_id), updated_at = ?4 WHERE id = ?5",
                params![aliases_json, metadata_json, input.source_conv_id, now, id],
            )
            .map_err(|e| format!("entity update 실패: {e}"))?;
            Ok((id, false))
        } else {
            conn.execute(
                "INSERT INTO entities (name, type, aliases, metadata, source_conv_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![input.name, input.entity_type, aliases_json, metadata_json, input.source_conv_id, now],
            )
            .map_err(|e| format!("entity insert 실패: {e}"))?;
            Ok((conn.last_insert_rowid(), true))
        }
    }

    fn update_entity(&self, id: i64, patch: &UpdateEntityPatch) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        let mut sets: Vec<&str> = vec![];
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![];
        if let Some(n) = &patch.name {
            sets.push("name = ?");
            values.push(Box::new(n.clone()));
        }
        if let Some(t) = &patch.entity_type {
            sets.push("type = ?");
            values.push(Box::new(t.clone()));
        }
        if let Some(a) = &patch.aliases {
            sets.push("aliases = ?");
            values.push(Box::new(
                serde_json::to_string(a).map_err(|e| format!("aliases 직렬화: {e}"))?,
            ));
        }
        if let Some(m) = &patch.metadata {
            sets.push("metadata = ?");
            values.push(Box::new(
                serde_json::to_string(m).map_err(|e| format!("metadata 직렬화: {e}"))?,
            ));
        }
        if sets.is_empty() {
            return Ok(());
        }
        sets.push("updated_at = ?");
        values.push(Box::new(now_ms()));
        let sql = format!("UPDATE entities SET {} WHERE id = ?", sets.join(", "));
        values.push(Box::new(id));
        let value_refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| b.as_ref()).collect();
        let updated = conn
            .execute(&sql, value_refs.as_slice())
            .map_err(|e| format!("entity update 실패: {e}"))?;
        if updated == 0 {
            return Err(format!("entity id={} 미존재", id));
        }
        Ok(())
    }

    fn remove_entity(&self, id: i64) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        // ON DELETE CASCADE 활성화 — entity_facts / event_entities 자동 정리
        conn.execute("PRAGMA foreign_keys = ON", [])
            .map_err(|e| format!("foreign_keys ON 실패: {e}"))?;
        let n = conn
            .execute("DELETE FROM entities WHERE id = ?1", params![id])
            .map_err(|e| format!("entity delete 실패: {e}"))?;
        if n == 0 {
            return Err(format!("entity id={} 미존재", id));
        }
        Ok(())
    }

    fn get_entity(&self, id: i64) -> InfraResult<Option<EntityRecord>> {
        let conn = self.conn.lock().unwrap();
        let fact_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entity_facts WHERE entity_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let result = conn.query_row(
            "SELECT id, name, type, aliases, metadata, source_conv_id, created_at, updated_at FROM entities WHERE id = ?1",
            params![id],
            |row| Self::entity_from_row(row, fact_count),
        );
        match result {
            Ok(e) => Ok(Some(e)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("get_entity 실패: {e}")),
        }
    }

    fn find_entity_by_name(&self, name: &str) -> InfraResult<Option<EntityRecord>> {
        let conn = self.conn.lock().unwrap();
        // canonical name 또는 alias 매칭 — alias 는 JSON LIKE
        let row = conn.query_row(
            r#"SELECT id, name, type, aliases, metadata, source_conv_id, created_at, updated_at
               FROM entities
               WHERE name = ?1 OR aliases LIKE ?2
               ORDER BY updated_at DESC LIMIT 1"#,
            params![name, format!("%\"{}\"%", name)],
            |row| Self::entity_from_row(row, 0),
        );
        let entity = match row {
            Ok(e) => e,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
            Err(e) => return Err(format!("find_entity_by_name 실패: {e}")),
        };
        let fact_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entity_facts WHERE entity_id = ?1",
                params![entity.id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        Ok(Some(EntityRecord {
            fact_count,
            ..entity
        }))
    }

    fn search_entities(&self, opts: &EntitySearchOpts) -> InfraResult<Vec<EntityRecord>> {
        // Phase B-12 minimum: substring 매칭 (name + aliases). Phase B-15+ 에서 cosine.
        let conn = self.conn.lock().unwrap();
        let limit = opts.limit.unwrap_or(20).min(200) as i64;
        let offset = opts.offset.unwrap_or(0) as i64;
        let q_pattern = format!("%{}%", opts.query);
        let alias_pattern = format!("%\"{}\"%", opts.query);

        // 동적 SQL — 단일 query_map closure 로 통일.
        let mut sql = String::from(
            r#"SELECT id, name, type, aliases, metadata, source_conv_id, created_at, updated_at
               FROM entities WHERE 1=1"#,
        );
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![];
        if let Some(t) = &opts.entity_type {
            sql.push_str(" AND type = ?");
            values.push(Box::new(t.clone()));
        }
        if !opts.query.is_empty() {
            sql.push_str(" AND (name LIKE ? OR aliases LIKE ?)");
            values.push(Box::new(q_pattern));
            values.push(Box::new(alias_pattern));
        }
        sql.push_str(" ORDER BY updated_at DESC LIMIT ? OFFSET ?");
        values.push(Box::new(limit));
        values.push(Box::new(offset));

        let mut stmt = conn.prepare(&sql).map_err(|e| format!("search prepare: {e}"))?;
        let value_refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| b.as_ref()).collect();
        let rows = stmt
            .query_map(value_refs.as_slice(), |row| Self::entity_from_row(row, 0))
            .map_err(|e| format!("search rows: {e}"))?;
        let mut out: Vec<EntityRecord> = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("search row: {e}"))?);
        }
        // factCount 별도 조회 (간소화 — 향후 JOIN 으로 통합 가능)
        for e in &mut out {
            e.fact_count = conn
                .query_row(
                    "SELECT COUNT(*) FROM entity_facts WHERE entity_id = ?1",
                    params![e.id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
        }
        Ok(out)
    }

    fn save_fact(&self, input: &SaveFactInput) -> InfraResult<(i64, bool, Option<f64>)> {
        if input.content.trim().is_empty() {
            return Err("fact content 누락".to_string());
        }
        let conn = self.conn.lock().unwrap();
        // entity 존재 검증
        let entity_exists: bool = conn
            .query_row(
                "SELECT 1 FROM entities WHERE id = ?1",
                params![input.entity_id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !entity_exists {
            return Err(format!("entity id={} 미존재", input.entity_id));
        }
        let now = now_ms();
        let tags_json =
            serde_json::to_string(&input.tags).map_err(|e| format!("tags 직렬화: {e}"))?;
        let expires_at = input.ttl_days.map(|d| now + d * 24 * 60 * 60 * 1000);

        // Phase B-15+ dedup_threshold cosine — 현재는 dedup 미박음 (skipped 항상 false).
        conn.execute(
            r#"INSERT INTO entity_facts
               (entity_id, content, fact_type, occurred_at, tags, source_conv_id, expires_at, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
            params![
                input.entity_id,
                input.content,
                input.fact_type,
                input.occurred_at,
                tags_json,
                input.source_conv_id,
                expires_at,
                now
            ],
        )
        .map_err(|e| format!("fact insert 실패: {e}"))?;

        Ok((conn.last_insert_rowid(), false, None))
    }

    fn update_fact(&self, id: i64, patch: &UpdateFactPatch) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        let mut sets: Vec<&str> = vec![];
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![];
        if let Some(c) = &patch.content {
            sets.push("content = ?");
            values.push(Box::new(c.clone()));
        }
        if let Some(t) = &patch.fact_type {
            sets.push("fact_type = ?");
            values.push(Box::new(t.clone()));
        }
        if let Some(o) = patch.occurred_at {
            sets.push("occurred_at = ?");
            values.push(Box::new(o));
        }
        if let Some(t) = &patch.tags {
            sets.push("tags = ?");
            values.push(Box::new(
                serde_json::to_string(t).map_err(|e| format!("tags 직렬화: {e}"))?,
            ));
        }
        if let Some(d) = patch.ttl_days {
            sets.push("expires_at = ?");
            values.push(Box::new(now_ms() + d * 24 * 60 * 60 * 1000));
        }
        if sets.is_empty() {
            return Ok(());
        }
        let sql = format!("UPDATE entity_facts SET {} WHERE id = ?", sets.join(", "));
        values.push(Box::new(id));
        let value_refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| b.as_ref()).collect();
        let updated = conn
            .execute(&sql, value_refs.as_slice())
            .map_err(|e| format!("fact update 실패: {e}"))?;
        if updated == 0 {
            return Err(format!("fact id={} 미존재", id));
        }
        Ok(())
    }

    fn remove_fact(&self, id: i64) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn
            .execute("DELETE FROM entity_facts WHERE id = ?1", params![id])
            .map_err(|e| format!("fact delete 실패: {e}"))?;
        if n == 0 {
            return Err(format!("fact id={} 미존재", id));
        }
        Ok(())
    }

    fn get_fact(&self, id: i64) -> InfraResult<Option<EntityFactRecord>> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            r#"SELECT id, entity_id, content, fact_type, occurred_at, tags, source_conv_id, expires_at, created_at
               FROM entity_facts WHERE id = ?1"#,
            params![id],
            Self::fact_from_row,
        );
        match result {
            Ok(f) => Ok(Some(f)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("get_fact 실패: {e}")),
        }
    }

    fn list_facts_by_entity(
        &self,
        entity_id: i64,
        opts: &TimelineOpts,
    ) -> InfraResult<Vec<EntityFactRecord>> {
        let conn = self.conn.lock().unwrap();
        let limit = opts.limit.unwrap_or(50).min(500) as i64;
        let offset = opts.offset.unwrap_or(0) as i64;
        let order = match opts.order_by.as_deref() {
            Some("createdAt") => "created_at",
            _ => "COALESCE(occurred_at, created_at)",
        };
        let sql = format!(
            r#"SELECT id, entity_id, content, fact_type, occurred_at, tags, source_conv_id, expires_at, created_at
               FROM entity_facts WHERE entity_id = ?1 ORDER BY {} DESC LIMIT ?2 OFFSET ?3"#,
            order
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("timeline prepare: {e}"))?;
        let rows = stmt
            .query_map(params![entity_id, limit, offset], Self::fact_from_row)
            .map_err(|e| format!("timeline query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("timeline row: {e}"))?);
        }
        Ok(out)
    }

    fn search_facts(&self, opts: &FactSearchOpts) -> InfraResult<Vec<EntityFactRecord>> {
        let conn = self.conn.lock().unwrap();
        let limit = opts.limit.unwrap_or(20).min(200) as i64;
        let offset = opts.offset.unwrap_or(0) as i64;
        // Phase B-12: 단순 LIKE (Phase B-15+ cosine)
        let q_pattern = format!("%{}%", opts.query);
        let mut sql = String::from(
            r#"SELECT id, entity_id, content, fact_type, occurred_at, tags, source_conv_id, expires_at, created_at
               FROM entity_facts WHERE 1=1"#,
        );
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![];
        if !opts.query.is_empty() {
            sql.push_str(" AND content LIKE ?");
            values.push(Box::new(q_pattern));
        }
        if let Some(eid) = opts.entity_id {
            sql.push_str(" AND entity_id = ?");
            values.push(Box::new(eid));
        }
        if let Some(ft) = &opts.fact_type {
            sql.push_str(" AND fact_type = ?");
            values.push(Box::new(ft.clone()));
        }
        if let Some(from) = opts.from_time {
            sql.push_str(" AND COALESCE(occurred_at, created_at) >= ?");
            values.push(Box::new(from));
        }
        if let Some(to) = opts.to_time {
            sql.push_str(" AND COALESCE(occurred_at, created_at) <= ?");
            values.push(Box::new(to));
        }
        sql.push_str(" ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT ? OFFSET ?");
        values.push(Box::new(limit));
        values.push(Box::new(offset));
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("search facts: {e}"))?;
        let value_refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| b.as_ref()).collect();
        let rows = stmt
            .query_map(value_refs.as_slice(), Self::fact_from_row)
            .map_err(|e| format!("search facts query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("search facts row: {e}"))?);
        }
        Ok(out)
    }

    fn cleanup_expired_facts(&self) -> InfraResult<i64> {
        let conn = self.conn.lock().unwrap();
        let now = now_ms();
        let n = conn
            .execute(
                "DELETE FROM entity_facts WHERE expires_at IS NOT NULL AND expires_at < ?1",
                params![now],
            )
            .map_err(|e| format!("cleanup expired facts: {e}"))?;
        Ok(n as i64)
    }

    fn count_entities(&self) -> InfraResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM entities", [], |r| r.get(0))
            .map_err(|e| format!("count_entities: {e}"))
    }

    fn count_facts(&self) -> InfraResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM entity_facts", [], |r| r.get(0))
            .map_err(|e| format!("count_facts: {e}"))
    }

    fn count_entities_by_type(&self) -> InfraResult<Vec<(String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT type, COUNT(*) FROM entities GROUP BY type ORDER BY 2 DESC")
            .map_err(|e| format!("count by type: {e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| format!("count by type query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("count by type row: {e}"))?);
        }
        Ok(out)
    }
}

impl SqliteMemoryAdapter {
    fn event_from_row_with_entities(
        &self,
        row: &rusqlite::Row,
        entity_ids: Vec<i64>,
    ) -> rusqlite::Result<EventRecord> {
        let context_raw: Option<String> = row.get(5)?;
        Ok(EventRecord {
            id: row.get(0)?,
            event_type: row.get(1)?,
            title: row.get(2)?,
            description: row.get(3)?,
            who: row.get(4)?,
            context: parse_json_value(context_raw),
            occurred_at: row.get(6)?,
            entity_ids,
            source_conv_id: row.get(7)?,
            expires_at: row.get(8)?,
            created_at: row.get(9)?,
        })
    }

    fn fetch_event_entity_ids(conn: &Connection, event_id: i64) -> Vec<i64> {
        let mut stmt = match conn.prepare("SELECT entity_id FROM event_entities WHERE event_id = ?1 ORDER BY entity_id") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map(params![event_id], |r| r.get::<_, i64>(0)) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(|r| r.ok()).collect()
    }
}

impl IEpisodicPort for SqliteMemoryAdapter {
    fn save_event(&self, input: &SaveEventInput) -> InfraResult<(i64, bool, Option<f64>)> {
        if input.title.trim().is_empty() {
            return Err("event title 누락".to_string());
        }
        if input.event_type.trim().is_empty() {
            return Err("event type 누락".to_string());
        }
        let conn = self.conn.lock().unwrap();
        let now = now_ms();
        let occurred_at = input.occurred_at.unwrap_or(now);
        let context_json = match &input.context {
            Some(v) => Some(
                serde_json::to_string(v).map_err(|e| format!("context 직렬화: {e}"))?,
            ),
            None => None,
        };
        let expires_at = input.ttl_days.map(|d| now + d * 24 * 60 * 60 * 1000);

        // Phase B-15+ dedup_threshold cosine — 현재는 미박음.
        conn.execute(
            r#"INSERT INTO events
               (type, title, description, who, context, occurred_at, source_conv_id, expires_at, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
            params![
                input.event_type,
                input.title,
                input.description,
                input.who,
                context_json,
                occurred_at,
                input.source_conv_id,
                expires_at,
                now
            ],
        )
        .map_err(|e| format!("event insert: {e}"))?;
        let event_id = conn.last_insert_rowid();

        for entity_id in &input.entity_ids {
            conn.execute(
                "INSERT OR IGNORE INTO event_entities (event_id, entity_id) VALUES (?1, ?2)",
                params![event_id, entity_id],
            )
            .map_err(|e| format!("event-entity link: {e}"))?;
        }
        Ok((event_id, false, None))
    }

    fn update_event(&self, id: i64, patch: &UpdateEventPatch) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        let mut sets: Vec<&str> = vec![];
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![];
        if let Some(t) = &patch.event_type {
            sets.push("type = ?");
            values.push(Box::new(t.clone()));
        }
        if let Some(t) = &patch.title {
            sets.push("title = ?");
            values.push(Box::new(t.clone()));
        }
        if let Some(d) = &patch.description {
            sets.push("description = ?");
            values.push(Box::new(d.clone()));
        }
        if let Some(w) = &patch.who {
            sets.push("who = ?");
            values.push(Box::new(w.clone()));
        }
        if let Some(c) = &patch.context {
            sets.push("context = ?");
            values.push(Box::new(
                serde_json::to_string(c).map_err(|e| format!("context 직렬화: {e}"))?,
            ));
        }
        if let Some(o) = patch.occurred_at {
            sets.push("occurred_at = ?");
            values.push(Box::new(o));
        }
        if let Some(d) = patch.ttl_days {
            sets.push("expires_at = ?");
            values.push(Box::new(now_ms() + d * 24 * 60 * 60 * 1000));
        }
        if !sets.is_empty() {
            let sql = format!("UPDATE events SET {} WHERE id = ?", sets.join(", "));
            values.push(Box::new(id));
            let value_refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| b.as_ref()).collect();
            let updated = conn
                .execute(&sql, value_refs.as_slice())
                .map_err(|e| format!("event update: {e}"))?;
            if updated == 0 {
                return Err(format!("event id={} 미존재", id));
            }
        }

        // entity_ids 박혀있으면 link 전체 교체
        if let Some(ids) = &patch.entity_ids {
            conn.execute("DELETE FROM event_entities WHERE event_id = ?1", params![id])
                .map_err(|e| format!("event_entities clear: {e}"))?;
            for entity_id in ids {
                conn.execute(
                    "INSERT OR IGNORE INTO event_entities (event_id, entity_id) VALUES (?1, ?2)",
                    params![id, entity_id],
                )
                .map_err(|e| format!("event-entity link: {e}"))?;
            }
        }
        Ok(())
    }

    fn remove_event(&self, id: i64) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("PRAGMA foreign_keys = ON", [])
            .map_err(|e| format!("foreign_keys ON: {e}"))?;
        let n = conn
            .execute("DELETE FROM events WHERE id = ?1", params![id])
            .map_err(|e| format!("event delete: {e}"))?;
        if n == 0 {
            return Err(format!("event id={} 미존재", id));
        }
        Ok(())
    }

    fn get_event(&self, id: i64) -> InfraResult<Option<EventRecord>> {
        let conn = self.conn.lock().unwrap();
        let entity_ids = Self::fetch_event_entity_ids(&conn, id);
        let result = conn.query_row(
            r#"SELECT id, type, title, description, who, context, occurred_at, source_conv_id, expires_at, created_at
               FROM events WHERE id = ?1"#,
            params![id],
            |row| self.event_from_row_with_entities(row, entity_ids.clone()),
        );
        match result {
            Ok(e) => Ok(Some(e)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("get_event: {e}")),
        }
    }

    fn search_events(&self, opts: &EventSearchOpts) -> InfraResult<Vec<EventRecord>> {
        let conn = self.conn.lock().unwrap();
        let limit = opts.limit.unwrap_or(20).min(200) as i64;
        let offset = opts.offset.unwrap_or(0) as i64;
        let q_pattern = format!("%{}%", opts.query);
        let mut sql = String::from(
            r#"SELECT DISTINCT e.id, e.type, e.title, e.description, e.who, e.context, e.occurred_at, e.source_conv_id, e.expires_at, e.created_at
               FROM events e"#,
        );
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![];
        if opts.entity_id.is_some() {
            sql.push_str(" INNER JOIN event_entities ee ON ee.event_id = e.id");
        }
        sql.push_str(" WHERE 1=1");
        if !opts.query.is_empty() {
            sql.push_str(" AND (e.title LIKE ? OR COALESCE(e.description,'') LIKE ?)");
            values.push(Box::new(q_pattern.clone()));
            values.push(Box::new(q_pattern));
        }
        if let Some(t) = &opts.event_type {
            sql.push_str(" AND e.type = ?");
            values.push(Box::new(t.clone()));
        }
        if let Some(w) = &opts.who {
            sql.push_str(" AND e.who = ?");
            values.push(Box::new(w.clone()));
        }
        if let Some(eid) = opts.entity_id {
            sql.push_str(" AND ee.entity_id = ?");
            values.push(Box::new(eid));
        }
        if let Some(from) = opts.from_time {
            sql.push_str(" AND e.occurred_at >= ?");
            values.push(Box::new(from));
        }
        if let Some(to) = opts.to_time {
            sql.push_str(" AND e.occurred_at <= ?");
            values.push(Box::new(to));
        }
        sql.push_str(" ORDER BY e.occurred_at DESC LIMIT ? OFFSET ?");
        values.push(Box::new(limit));
        values.push(Box::new(offset));
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("search events: {e}"))?;
        let value_refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| b.as_ref()).collect();
        let rows = stmt
            .query_map(value_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            })
            .map_err(|e| format!("search events query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            let (id, ty, title, desc, who, ctx, occ, conv, exp, created) =
                r.map_err(|e| format!("search events row: {e}"))?;
            let entity_ids = Self::fetch_event_entity_ids(&conn, id);
            out.push(EventRecord {
                id,
                event_type: ty,
                title,
                description: desc,
                who,
                context: parse_json_value(ctx),
                occurred_at: occ,
                entity_ids,
                source_conv_id: conv,
                expires_at: exp,
                created_at: created,
            });
        }
        Ok(out)
    }

    fn list_recent_events(&self, opts: &ListRecentOpts) -> InfraResult<Vec<EventRecord>> {
        let search = EventSearchOpts {
            query: String::new(),
            event_type: opts.event_type.clone(),
            who: opts.who.clone(),
            entity_id: None,
            from_time: None,
            to_time: None,
            limit: opts.limit,
            offset: opts.offset,
        };
        self.search_events(&search)
    }

    fn link_event_entity(&self, event_id: i64, entity_id: i64) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO event_entities (event_id, entity_id) VALUES (?1, ?2)",
            params![event_id, entity_id],
        )
        .map_err(|e| format!("link event entity: {e}"))?;
        Ok(())
    }

    fn unlink_event_entity(&self, event_id: i64, entity_id: i64) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        let n = conn
            .execute(
                "DELETE FROM event_entities WHERE event_id = ?1 AND entity_id = ?2",
                params![event_id, entity_id],
            )
            .map_err(|e| format!("unlink event entity: {e}"))?;
        if n == 0 {
            return Err(format!(
                "event-entity link 미존재 event_id={} entity_id={}",
                event_id, entity_id
            ));
        }
        Ok(())
    }

    fn cleanup_expired_events(&self) -> InfraResult<i64> {
        let conn = self.conn.lock().unwrap();
        let now = now_ms();
        let n = conn
            .execute(
                "DELETE FROM events WHERE expires_at IS NOT NULL AND expires_at < ?1",
                params![now],
            )
            .map_err(|e| format!("cleanup expired events: {e}"))?;
        Ok(n as i64)
    }

    fn count_events(&self) -> InfraResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .map_err(|e| format!("count_events: {e}"))
    }

    fn count_events_by_type(&self) -> InfraResult<Vec<(String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT type, COUNT(*) FROM events GROUP BY type ORDER BY 2 DESC")
            .map_err(|e| format!("count events by type: {e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| format!("count events by type query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("count events by type row: {e}"))?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter() -> SqliteMemoryAdapter {
        SqliteMemoryAdapter::new_in_memory().unwrap()
    }

    #[test]
    fn entity_save_get_search_roundtrip() {
        let a = adapter();
        let (id, created) = a
            .save_entity(&SaveEntityInput {
                name: "삼성전자".to_string(),
                entity_type: "stock".to_string(),
                aliases: vec!["005930".to_string(), "Samsung".to_string()],
                metadata: Some(serde_json::json!({"sector": "tech"})),
                source_conv_id: Some("c1".to_string()),
            })
            .unwrap();
        assert!(id > 0);
        assert!(created);

        let got = a.get_entity(id).unwrap().unwrap();
        assert_eq!(got.name, "삼성전자");
        assert_eq!(got.aliases.len(), 2);
        assert_eq!(got.metadata.unwrap()["sector"], "tech");

        let found = a.find_entity_by_name("Samsung").unwrap();
        assert!(found.is_some());

        let search = a
            .search_entities(&EntitySearchOpts {
                query: "삼성".to_string(),
                limit: Some(10),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(search.len(), 1);
    }

    #[test]
    fn entity_upsert_returns_existing_id() {
        let a = adapter();
        let (id1, created1) = a
            .save_entity(&SaveEntityInput {
                name: "X".to_string(),
                entity_type: "t".to_string(),
                ..Default::default()
            })
            .unwrap();
        assert!(created1);
        let (id2, created2) = a
            .save_entity(&SaveEntityInput {
                name: "X".to_string(),
                entity_type: "t".to_string(),
                aliases: vec!["alt".to_string()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(id1, id2);
        assert!(!created2);
        let got = a.get_entity(id1).unwrap().unwrap();
        assert_eq!(got.aliases, vec!["alt".to_string()]);
    }

    #[test]
    fn fact_link_to_entity_and_timeline() {
        let a = adapter();
        let (eid, _) = a
            .save_entity(&SaveEntityInput {
                name: "삼성".to_string(),
                entity_type: "stock".to_string(),
                ..Default::default()
            })
            .unwrap();
        let (fid, _, _) = a
            .save_fact(&SaveFactInput {
                entity_id: eid,
                content: "1주 매수".to_string(),
                fact_type: Some("transaction".to_string()),
                occurred_at: Some(1_700_000_000_000),
                tags: vec!["test".to_string()],
                ..Default::default()
            })
            .unwrap();
        assert!(fid > 0);

        let timeline = a.list_facts_by_entity(eid, &TimelineOpts::default()).unwrap();
        assert_eq!(timeline.len(), 1);
        assert_eq!(timeline[0].content, "1주 매수");

        // factCount in get_entity
        let got = a.get_entity(eid).unwrap().unwrap();
        assert_eq!(got.fact_count, 1);
    }

    #[test]
    fn fact_ttl_expires_via_cleanup() {
        let a = adapter();
        let (eid, _) = a
            .save_entity(&SaveEntityInput {
                name: "tmp".to_string(),
                entity_type: "t".to_string(),
                ..Default::default()
            })
            .unwrap();
        let (_, _, _) = a
            .save_fact(&SaveFactInput {
                entity_id: eid,
                content: "곧 만료".to_string(),
                ttl_days: Some(-1), // 즉시 만료
                ..Default::default()
            })
            .unwrap();
        assert_eq!(a.count_facts().unwrap(), 1);
        let removed = a.cleanup_expired_facts().unwrap();
        assert_eq!(removed, 1);
        assert_eq!(a.count_facts().unwrap(), 0);
    }

    #[test]
    fn event_save_link_entity_and_unlink() {
        let a = adapter();
        let (eid, _) = a
            .save_entity(&SaveEntityInput {
                name: "ent".to_string(),
                entity_type: "t".to_string(),
                ..Default::default()
            })
            .unwrap();
        let (evid, _, _) = a
            .save_event(&SaveEventInput {
                event_type: "page_publish".to_string(),
                title: "테스트 발행".to_string(),
                occurred_at: Some(1_700_000_000_000),
                entity_ids: vec![eid],
                ..Default::default()
            })
            .unwrap();
        let got = a.get_event(evid).unwrap().unwrap();
        assert_eq!(got.entity_ids, vec![eid]);

        a.unlink_event_entity(evid, eid).unwrap();
        let after = a.get_event(evid).unwrap().unwrap();
        assert!(after.entity_ids.is_empty());
    }

    #[test]
    fn event_search_filters_combine() {
        let a = adapter();
        a.save_event(&SaveEventInput {
            event_type: "cron_trigger".to_string(),
            title: "삼성 점검".to_string(),
            occurred_at: Some(1_700_000_000_000),
            ..Default::default()
        })
        .unwrap();
        a.save_event(&SaveEventInput {
            event_type: "page_publish".to_string(),
            title: "기타".to_string(),
            occurred_at: Some(1_700_001_000_000),
            ..Default::default()
        })
        .unwrap();
        let search = a
            .search_events(&EventSearchOpts {
                event_type: Some("cron_trigger".to_string()),
                limit: Some(10),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(search.len(), 1);
        assert_eq!(search[0].title, "삼성 점검");
    }

    #[test]
    fn entity_cascade_deletes_facts() {
        let a = adapter();
        let (eid, _) = a
            .save_entity(&SaveEntityInput {
                name: "casc".to_string(),
                entity_type: "t".to_string(),
                ..Default::default()
            })
            .unwrap();
        a.save_fact(&SaveFactInput {
            entity_id: eid,
            content: "f1".to_string(),
            ..Default::default()
        })
        .unwrap();
        a.save_fact(&SaveFactInput {
            entity_id: eid,
            content: "f2".to_string(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(a.count_facts().unwrap(), 2);
        a.remove_entity(eid).unwrap();
        assert_eq!(a.count_facts().unwrap(), 0);
    }

    #[test]
    fn count_by_type_aggregates() {
        let a = adapter();
        a.save_entity(&SaveEntityInput {
            name: "a".to_string(),
            entity_type: "stock".to_string(),
            ..Default::default()
        })
        .unwrap();
        a.save_entity(&SaveEntityInput {
            name: "b".to_string(),
            entity_type: "stock".to_string(),
            ..Default::default()
        })
        .unwrap();
        a.save_entity(&SaveEntityInput {
            name: "c".to_string(),
            entity_type: "person".to_string(),
            ..Default::default()
        })
        .unwrap();
        let by_type = a.count_entities_by_type().unwrap();
        assert!(by_type.iter().any(|(t, c)| t == "stock" && *c == 2));
        assert!(by_type.iter().any(|(t, c)| t == "person" && *c == 1));
    }
}
