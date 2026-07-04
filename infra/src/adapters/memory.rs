//! SqliteMemoryAdapter — IEntityPort + IEpisodicPort 통합 SQLite 어댑터.
//!
//! 옛 TS SqliteEntityAdapter + SqliteEpisodicAdapter Rust 재구현 (Phase B-12 minimum).
//!
//! Phase B-12 minimum:
//! - Entity / Fact / Event / Event-Entity m2m link CRUD 설정
//! - Search = name + alias + content substring 매칭 (옛 TS 의 cosine 미설정)
//! - Phase B-15+ IEmbedderPort 설정된 후 cosine search 활성 (this file 한 곳만 수정)
//!
//! Schema: 옛 TS migration v2 (entities + entity_facts) + v3 (events + event_entities) Rust port.

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::{Arc, Mutex};

use firebat_core::ports::{
    EntityFactRecord, EntityRecord, EntitySearchOpts, EventRecord, EventSearchOpts, FactSearchOpts,
    IEmbedderPort, IEntityPort, IEpisodicPort, InfraResult, ListRecentOpts, SaveEntityInput,
    SaveEventInput, SaveFactInput, TimelineOpts, UpdateEntityPatch, UpdateEventPatch,
    UpdateFactPatch,
};

/// 같은 type 의 event dedup 검출 시 — 7일 이내 occurredAt 한정 (옛 TS 동등).
const EVENT_DEDUP_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;

pub struct SqliteMemoryAdapter {
    conn: Mutex<Connection>,
    /// IEmbedderPort 옵션 — 설정되면 자동 임베딩 + cosine 검색 활성. 없으면 substring 매칭.
    embedder: Option<Arc<dyn IEmbedderPort>>,
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
            embedder: None,
        })
    }

    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Memory DB in-memory open 실패: {e}"))?;
        Self::initialize(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            embedder: None,
        })
    }

    /// Embedder 주입 — 설정되면 saveEntity / saveFact / saveEvent 자동 임베딩 +
    /// search_* cosine 정렬 + dedup_threshold cosine 활성.
    /// 미설정 시 옛 Phase B-12 substring 매칭 fallback (테스트·embedder 없는 환경 호환).
    pub fn with_embedder(mut self, embedder: Arc<dyn IEmbedderPort>) -> Self {
        self.embedder = Some(embedder);
        self
    }

    fn initialize(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            r#"
            -- Entities (Phase 1)
            -- owner: "admin" = 본인 메모리 (default), "hub:<instance_id>" = 해당 hub 격리.
            -- UNIQUE(name, type, owner) — 다른 owner 가 같은 (name, type) 을 가질 수 있어야 함.
            CREATE TABLE IF NOT EXISTS entities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                aliases TEXT NOT NULL DEFAULT '[]',
                metadata TEXT,
                embedding BLOB,
                source_conv_id TEXT,
                owner TEXT NOT NULL DEFAULT 'admin',
                created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
                updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
                UNIQUE(name, type, owner)
            );
            CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
            CREATE INDEX IF NOT EXISTS idx_entities_owner ON entities(owner);
            CREATE INDEX IF NOT EXISTS idx_entities_updated ON entities(updated_at DESC);

            -- Entity Facts (Phase 1)
            -- Staging/supersession columns (Intelligence rebuild 2026-07-04):
            --   superseded_by = retired by a newer value of the same (entity, factType) — history kept, one active.
            --   explicit      = 1 when the user explicitly asked to remember (vs autonomous/cron extraction).
            --   confidence    = promotion score; below the promote threshold = staging (not injected into recall).
            --   seen_count/last_seen = repeated-observation signal (dedup match bumps these → promotion).
            CREATE TABLE IF NOT EXISTS entity_facts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_id INTEGER NOT NULL,
                content TEXT NOT NULL,
                fact_type TEXT,
                occurred_at INTEGER,
                tags TEXT NOT NULL DEFAULT '[]',
                embedding BLOB,
                source_conv_id TEXT,
                expires_at INTEGER,
                owner TEXT NOT NULL DEFAULT 'admin',
                created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
                superseded_by INTEGER,
                explicit INTEGER NOT NULL DEFAULT 0,
                confidence REAL NOT NULL DEFAULT 1.0,
                seen_count INTEGER NOT NULL DEFAULT 1,
                last_seen INTEGER,
                FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_facts_entity ON entity_facts(entity_id);
            CREATE INDEX IF NOT EXISTS idx_facts_type ON entity_facts(fact_type);
            CREATE INDEX IF NOT EXISTS idx_facts_occurred ON entity_facts(occurred_at DESC);
            CREATE INDEX IF NOT EXISTS idx_facts_expires ON entity_facts(expires_at);
            CREATE INDEX IF NOT EXISTS idx_facts_owner ON entity_facts(owner);

            -- Events (Phase 2) — staging columns mirror entity_facts (see comment there).
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                who TEXT,
                context TEXT,
                embedding BLOB,
                occurred_at INTEGER NOT NULL,
                source_conv_id TEXT,
                expires_at INTEGER,
                owner TEXT NOT NULL DEFAULT 'admin',
                created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
                superseded_by INTEGER,
                explicit INTEGER NOT NULL DEFAULT 0,
                confidence REAL NOT NULL DEFAULT 1.0,
                seen_count INTEGER NOT NULL DEFAULT 1,
                last_seen INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
            CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at DESC);
            CREATE INDEX IF NOT EXISTS idx_events_expires ON events(expires_at);
            CREATE INDEX IF NOT EXISTS idx_events_owner ON events(owner);

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

            -- Library Phase 1 — Reference / Source / Chunk 영역 (2026-05-17 신설)
            -- NotebookLM 같은 RAG 영역 — 매 Reference = 자료 그룹, 매 Source = 매 자료, 매 Chunk = 임베딩 단위.
            CREATE TABLE IF NOT EXISTS library_references (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                owner TEXT NOT NULL DEFAULT 'admin',
                created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
                updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
            );
            CREATE INDEX IF NOT EXISTS idx_library_refs_owner ON library_references(owner);
            CREATE INDEX IF NOT EXISTS idx_library_refs_updated ON library_references(updated_at DESC);

            CREATE TABLE IF NOT EXISTS library_sources (
                id TEXT PRIMARY KEY,
                reference_id TEXT NOT NULL,
                name TEXT NOT NULL,
                source_type TEXT NOT NULL,             -- 'pdf' / 'txt' / 'md' / 'url' / 'text'
                source_url TEXT,                       -- URL type 영역
                file_path TEXT,                        -- 디스크 영역 (PDF 등 원본 파일)
                full_text TEXT NOT NULL,               -- 추출된 전체 텍스트 (cache + 검색 영역)
                char_count INTEGER NOT NULL DEFAULT 0,
                chunk_count INTEGER NOT NULL DEFAULT 0,
                content_hash TEXT,                     -- 중복 업로드 dedup (sha256 of 원본 파일/텍스트)
                created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
                FOREIGN KEY (reference_id) REFERENCES library_references(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_library_sources_ref ON library_sources(reference_id);
            CREATE INDEX IF NOT EXISTS idx_library_sources_type ON library_sources(source_type);
            CREATE INDEX IF NOT EXISTS idx_library_sources_created ON library_sources(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_library_sources_hash ON library_sources(reference_id, content_hash);

            CREATE TABLE IF NOT EXISTS library_chunks (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,          -- 0-based 순서
                content TEXT NOT NULL,                 -- ~500 토큰 텍스트
                embedding BLOB,                        -- Arctic 1024-dim 영역 (4096 bytes)
                page_number INTEGER,                   -- PDF page (citation 영역)
                start_char INTEGER NOT NULL DEFAULT 0,
                end_char INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (source_id) REFERENCES library_sources(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_library_chunks_source ON library_chunks(source_id);
            CREATE INDEX IF NOT EXISTS idx_library_chunks_index ON library_chunks(source_id, chunk_index);

            -- 하이브리드 검색용 FTS5 (trigram) — BM25 sparse 인덱스. dense(E5 cosine) 과 RRF 융합.
            -- trigram = 부분문자열 매칭(한국어 띄어쓰기 변동·법조문 코드·고유명사에 강함). FK cascade 가
            -- 가상테이블엔 미적용 → save_chunk insert / delete 시 어댑터가 수동 동기화.
            CREATE VIRTUAL TABLE IF NOT EXISTS library_chunks_fts USING fts5(
                chunk_id UNINDEXED,
                content,
                tokenize='trigram'
            );

            -- Hub Phase 1 (2026-05-17) — system service hub 인스턴스 settings + 대화 + 메시지.
            -- 외부 워드프레스 사이트 영역 연결용. admin chat 과 별개 (conversation / message 테이블 분리).
            CREATE TABLE IF NOT EXISTS hub_instances (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,             -- URL 영역 (예: lawassistant)
                name TEXT NOT NULL,
                description TEXT,
                system_prompt TEXT,                    -- 챗봇 페르소나 / 가드레일
                allowed_references TEXT NOT NULL DEFAULT '[]',  -- JSON array of Library Reference id
                allowed_sysmods TEXT NOT NULL DEFAULT '[]',     -- JSON array of sysmod name (빈 = 0개 노출)
                model_id TEXT,                         -- LLM 영역 (CLI / API). NULL = system default
                enabled INTEGER NOT NULL DEFAULT 1,    -- 0=비활성 (외부 호출 차단)
                api_token TEXT NOT NULL,               -- 외부 호출 인증 (자동 생성, 32 byte hex)
                allowed_domains TEXT NOT NULL DEFAULT '[]',     -- JSON array of origin (CORS / origin 검사)
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                expose_widget INTEGER NOT NULL DEFAULT 1,       -- 1=widget 임베드 노출, 0=숨김
                expose_page INTEGER NOT NULL DEFAULT 1,         -- 1=/hub/{slug} 풀스크린 노출, 0=숨김
                kind TEXT NOT NULL DEFAULT 'widget'             -- 'tenant'(full workspace) | 'widget'(embed chatbot)
            );
            CREATE INDEX IF NOT EXISTS idx_hub_instances_slug ON hub_instances(slug);
            CREATE INDEX IF NOT EXISTS idx_hub_instances_updated ON hub_instances(updated_at DESC);

            CREATE TABLE IF NOT EXISTS hub_conversations (
                id TEXT PRIMARY KEY,
                instance_id TEXT NOT NULL,             -- hub_instances.id FK
                session_id TEXT NOT NULL,              -- 방문자 localStorage UUID (동일성 유지)
                title TEXT,                            -- 자동 생성 (첫 user 메시지 요약)
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                deleted_at INTEGER,                    -- soft delete. NULL = 정상, 값 = 휴지통 (30일 후 cron 영구 삭제)
                FOREIGN KEY (instance_id) REFERENCES hub_instances(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_hub_conv_instance ON hub_conversations(instance_id);
            CREATE INDEX IF NOT EXISTS idx_hub_conv_session ON hub_conversations(instance_id, session_id);
            CREATE INDEX IF NOT EXISTS idx_hub_conv_updated ON hub_conversations(updated_at DESC);

            CREATE TABLE IF NOT EXISTS hub_messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,                    -- 'user' / 'system'
                content TEXT,                          -- 본문 (system 영역 reply text)
                data_json TEXT,                        -- 영역 (blocks / tool_results / library_hits 등 raw JSON)
                created_at INTEGER NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES hub_conversations(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_hub_msg_conv ON hub_messages(conversation_id);
            CREATE INDEX IF NOT EXISTS idx_hub_msg_created ON hub_messages(conversation_id, created_at);
            "#,
        )
        .map_err(|e| format!("Memory schema 초기화 실패: {e}"))?;

        // Defensive column adds for pre-existing DBs (fresh DBs get these via CREATE TABLE above).
        // "duplicate column name" errors are ignored on purpose. Any index touching these columns
        // MUST come after the ALTERs — a batch index on a missing column fails schema init before
        // the ALTER runs (crash-loop lesson, INFRA_BIBLE 제2-A장).
        for sql in [
            "ALTER TABLE entity_facts ADD COLUMN superseded_by INTEGER",
            "ALTER TABLE entity_facts ADD COLUMN explicit INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE entity_facts ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0",
            "ALTER TABLE entity_facts ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE entity_facts ADD COLUMN last_seen INTEGER",
            "ALTER TABLE events ADD COLUMN superseded_by INTEGER",
            "ALTER TABLE events ADD COLUMN explicit INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE events ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0",
            "ALTER TABLE events ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE events ADD COLUMN last_seen INTEGER",
        ] {
            let _ = conn.execute(sql, []);
        }
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_facts_superseded ON entity_facts(superseded_by)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_events_superseded ON events(superseded_by)",
            [],
        );
        Ok(())
    }
}

/// Staging promotion threshold — facts/events below this confidence are "승격 대기"
/// (visible in the admin UI review section, excluded from retrieval/search injection).
/// The frontend grouping mirrors this value.
#[allow(dead_code)]
const PROMOTE_CONFIDENCE: f64 = 0.7;

// memory.rs 안 사용처가 다수 — 별 alias 보존 + utils::time::now_ms 위임.
fn now_ms() -> i64 {
    firebat_core::utils::time::now_ms()
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
        // owner column 영역 — 옛 schema 호환 위해 try_get (없으면 'admin').
        let owner: String = row.get::<_, Option<String>>(8).ok().flatten().unwrap_or_else(|| "admin".to_string());
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
            owner,
        })
    }

    fn fact_from_row(row: &rusqlite::Row) -> rusqlite::Result<EntityFactRecord> {
        let tags_raw: Option<String> = row.get(5)?;
        let owner: String = row.get::<_, Option<String>>(9).ok().flatten().unwrap_or_else(|| "admin".to_string());
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
            owner,
            // Staging/supersession columns (10-14) — resilient reads so a SELECT without them
            // (or a pre-ALTER row) degrades to defaults instead of erroring.
            superseded_by: row.get::<_, Option<i64>>(10).ok().flatten(),
            explicit: row.get::<_, Option<i64>>(11).ok().flatten().unwrap_or(0) != 0,
            confidence: row.get::<_, Option<f64>>(12).ok().flatten().unwrap_or(1.0),
            seen_count: row.get::<_, Option<i64>>(13).ok().flatten().unwrap_or(1),
            last_seen: row.get::<_, Option<i64>>(14).ok().flatten(),
        })
    }

    // ── 임베딩 헬퍼 (Phase B-18 Step 1.5) ─────────────────────────────────────

    /// Entity 임베딩용 passage text — name + aliases (옛 TS 와 동등).
    fn entity_passage_text(name: &str, aliases: &[String]) -> String {
        if aliases.is_empty() {
            name.to_string()
        } else {
            format!("{} {}", name, aliases.join(" "))
        }
    }

    /// Event 임베딩용 passage text — title + (description 있으면 newline + description).
    fn event_passage_text(title: &str, description: Option<&str>) -> String {
        match description.map(str::trim).filter(|s| !s.is_empty()) {
            Some(d) => format!("{}\n{}", title, d),
            None => title.to_string(),
        }
    }

    /// embedder 설정되어 있으면 embed_passage → bytes, 없거나 실패 시 None.
    /// 옛 TS 의 try/catch + log.debug 패턴 — 임베딩 실패해도 row 저장 자체는 성공.
    async fn embed_text_passage(&self, text: &str) -> Option<Vec<u8>> {
        let embedder = self.embedder.as_ref()?;
        match embedder.embed_passage(text).await {
            Ok(v) => Some(embedder.vec_to_bytes(&v)),
            Err(_) => None,
        }
    }

    /// Cosine 정렬 — query 임베딩 ↔ 후보 row embedding 비교.
    /// 옛 TS searchEntities/searchFacts/searchEvents 의 cosine 분기 1:1 패턴.
    /// 후보 (id, embedding_blob, payload) 받아 score 정렬 후 limit 슬라이스.
    fn cosine_rerank<T>(
        embedder: &Arc<dyn IEmbedderPort>,
        query_vec: &[f32],
        candidates: Vec<(Vec<u8>, T)>,
        limit: usize,
        offset: usize,
        label: &str,
    ) -> Vec<T> {
        let mut scored: Vec<(f32, T)> = candidates
            .into_iter()
            .filter_map(|(blob, payload)| {
                if blob.is_empty() {
                    return None;
                }
                let v = embedder.bytes_to_vec(&blob);
                let s = embedder.cosine(query_vec, &v);
                Some((s, payload))
            })
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        // 관련도 진단 — top + 컷 경계(limit번째) cosine + 후보 수. library/history 와 같이 보고
        // 자동회상 threshold 튜닝용. 현재 컷 0 = top-K 무조건. "하이"(무관) 점수 확인 후 컷 값 결정.
        let top = scored.first().map(|(s, _)| *s).unwrap_or(0.0);
        let cut = scored.get(limit.saturating_sub(1)).map(|(s, _)| *s).unwrap_or(top);
        tracing::info!(
            category = "recall",
            "Recall cosine — {label} top_score={top:.4} cut_score={cut:.4} candidates={}",
            scored.len()
        );
        scored
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|(_, payload)| payload)
            .collect()
    }
}

#[async_trait::async_trait]
impl IEntityPort for SqliteMemoryAdapter {
    async fn save_entity(&self, input: &SaveEntityInput) -> InfraResult<(i64, bool)> {
        if input.name.trim().is_empty() {
            return Err("entity name 누락".to_string());
        }
        if input.entity_type.trim().is_empty() {
            return Err("entity type 누락".to_string());
        }
        let aliases_json =
            serde_json::to_string(&input.aliases).map_err(|e| format!("aliases 직렬화: {e}"))?;
        let metadata_json = match &input.metadata {
            Some(v) => Some(
                serde_json::to_string(v).map_err(|e| format!("metadata 직렬화: {e}"))?,
            ),
            None => None,
        };

        // 임베딩 자동 — 옛 TS 패턴: name + aliases.join(' ') text → embed_passage → BLOB.
        // embedder 없거나 실패해도 silent fail (entity 저장 자체는 성공 보장).
        let embedding: Option<Vec<u8>> = self
            .embed_text_passage(&Self::entity_passage_text(&input.name, &input.aliases))
            .await;
        if embedding.is_some() {
            tracing::info!(category = "recall", "Recall 임베딩 저장 — entity");
        }

        let now = now_ms();
        let owner = input.owner.clone().unwrap_or_else(|| "admin".to_string());
        let dedup_on = input.dedup_threshold.is_some();
        let conn = self.conn.lock().unwrap();
        // dedup 키 정규화 — 모든 공백 제거 + 소문자. "LG전자" = "LG 전자" = "LG  전자" = "lg전자".
        // split_whitespace 는 전각 공백(U+3000) 포함 Unicode 공백을 전부 흡수.
        let norm = |s: &str| s.split_whitespace().collect::<String>().to_lowercase();
        let parse_aliases = |raw: Option<String>| -> Vec<String> {
            raw.as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default()
        };

        // 갱신 대상 엔티티 + 그 정식명·기존 별칭을 정한다. 둘 중 하나로 매칭:
        //   1. exact (name, type, owner) — 원래 upsert / dedup-off 경로 (대소문자까지 정확, 인덱스).
        //   2. else dedup: 정규화(공백 제거+소문자) 이름 OR 별칭 겹침 (type 무관) → 그 엔티티에 병합.
        //      삼성전자/stock ↔ 삼성전자/종목 합치고, 약어·티커(삼전·005930)는 별칭으로 매칭.
        //      cosine 폐기 — 'X전자' 류를 다른 회사(삼성↔LG name_sim 0.95)까지 합치고, type
        //      의미동등(stock≈종목 0.837 vs stock≉제품 0.823)도 임베딩 분리 불가였음.
        let target_row: Option<(i64, String, Vec<String>)> = {
            let exact = conn
                .query_row(
                    "SELECT id, name, aliases FROM entities WHERE name = ?1 AND type = ?2 AND owner = ?3",
                    params![input.name, input.entity_type, owner],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .ok()
                .map(|(id, name, raw)| (id, name, parse_aliases(raw)));

            if exact.is_some() {
                exact
            } else if dedup_on {
                let new_keys: std::collections::HashSet<String> =
                    std::iter::once(norm(&input.name))
                        .chain(input.aliases.iter().map(|a| norm(a)))
                        .filter(|s| !s.is_empty())
                        .collect();
                let mut stmt = conn
                    .prepare("SELECT id, name, aliases FROM entities WHERE owner = ?1")
                    .map_err(|e| format!("entity dedup prepare: {e}"))?;
                let rows = stmt
                    .query_map(params![owner], |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, Option<String>>(2)?,
                        ))
                    })
                    .map_err(|e| format!("entity dedup query: {e}"))?;
                let mut found = None;
                for (id, name, raw) in rows.filter_map(|r| r.ok()) {
                    let ex_aliases = parse_aliases(raw);
                    let ex_keys: std::collections::HashSet<String> =
                        std::iter::once(norm(&name))
                            .chain(ex_aliases.iter().map(|a| norm(a)))
                            .filter(|s| !s.is_empty())
                            .collect();
                    if new_keys.intersection(&ex_keys).next().is_some() {
                        found = Some((id, name, ex_aliases));
                        break;
                    }
                }
                if let Some((id, ref into_name, _)) = found {
                    tracing::info!(
                        category = "recall",
                        entity_id = id,
                        new_name = %input.name,
                        into_name = %into_name,
                        "엔티티 dedup — 같은 이름/별칭에 병합 (새 row 생성 안 함)"
                    );
                }
                found
            } else {
                None
            }
        };

        if let Some((id, ref canon_name, ref ex_aliases)) = target_row {
            // 별칭 누적 — 기존 별칭 ∪ 새 이름 ∪ 새 별칭 (정식명 제외). exact 재저장도 변형을 잃지 않음.
            let canon_lc = norm(canon_name);
            let mut set: Vec<String> = ex_aliases.clone();
            for a in std::iter::once(input.name.clone()).chain(input.aliases.iter().cloned()) {
                let al = a.trim();
                if al.is_empty() || norm(al) == canon_lc {
                    continue;
                }
                if !set.iter().any(|e| norm(e) == norm(al)) {
                    set.push(al.to_string());
                }
            }
            let aliases_out =
                serde_json::to_string(&set).unwrap_or_else(|_| aliases_json.clone());
            // embedding 업데이트 — 새 임베딩 설정되었으면 갱신, 미설정이면 기존값 유지 (COALESCE)
            conn.execute(
                "UPDATE entities SET
                    aliases = ?1,
                    metadata = ?2,
                    embedding = COALESCE(?3, embedding),
                    source_conv_id = COALESCE(?4, source_conv_id),
                    updated_at = ?5
                 WHERE id = ?6",
                params![
                    aliases_out,
                    metadata_json,
                    embedding,
                    input.source_conv_id,
                    now,
                    id
                ],
            )
            .map_err(|e| format!("entity update 실패: {e}"))?;
            Ok((id, false))
        } else {
            conn.execute(
                "INSERT INTO entities (name, type, aliases, metadata, embedding, source_conv_id, owner, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![
                    input.name,
                    input.entity_type,
                    aliases_json,
                    metadata_json,
                    embedding,
                    input.source_conv_id,
                    owner,
                    now
                ],
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
            "SELECT id, name, type, aliases, metadata, source_conv_id, created_at, updated_at, owner FROM entities WHERE id = ?1",
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
        // canonical name 또는 alias 매칭 — alias 는 JSON LIKE. owner 영역 = admin scope 만
        // (find_entity_by_name 은 owner 인자 없으므로 admin default — hub-aware lookup 은 search_entities 통해).
        let row = conn.query_row(
            r#"SELECT id, name, type, aliases, metadata, source_conv_id, created_at, updated_at, owner
               FROM entities
               WHERE (name = ?1 OR aliases LIKE ?2) AND owner = 'admin'
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

    async fn search_entities(&self, opts: &EntitySearchOpts) -> InfraResult<Vec<EntityRecord>> {
        let limit = opts.limit.unwrap_or(20).min(200);
        let offset = opts.offset.unwrap_or(0);
        let has_query = !opts.query.trim().is_empty();
        let has_embedder = self.embedder.is_some();
        // owner filter — None = admin scope only.
        let owner_filter = opts.owner.clone().unwrap_or_else(|| "admin".to_string());

        // Cosine 모드 — query 설정되어 있고 embedder 설정되어 있으면 후보 row + embedding 가져와 cosine 정렬.
        // 옛 TS searchEntities 의 hasSemanticQuery 분기 1:1.
        if has_query && has_embedder {
            tracing::info!(category = "recall", "Recall 검색 — entity query='{}'", opts.query);
            let embedder = self.embedder.as_ref().expect("checked above");
            let q_vec = embedder
                .embed_query(&opts.query)
                .await
                .map_err(|e| format!("embed_query 실패: {e}"))?;

            let conn = self.conn.lock().unwrap();
            let mut sql = String::from(
                r#"SELECT id, name, type, aliases, metadata, source_conv_id, created_at, updated_at, owner, embedding
                   FROM entities WHERE owner = ?"#,
            );
            let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(owner_filter.clone())];
            if let Some(t) = &opts.entity_type {
                sql.push_str(" AND type = ?");
                values.push(Box::new(t.clone()));
            }
            let mut stmt = conn.prepare(&sql).map_err(|e| format!("search prepare: {e}"))?;
            let value_refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| b.as_ref()).collect();
            let rows = stmt
                .query_map(value_refs.as_slice(), |row| {
                    let entity = Self::entity_from_row(row, 0)?;
                    let blob: Option<Vec<u8>> = row.get(9)?;
                    Ok((entity, blob))
                })
                .map_err(|e| format!("search rows: {e}"))?;

            let mut candidates: Vec<(Vec<u8>, EntityRecord)> = Vec::new();
            for r in rows {
                let (entity, blob) = r.map_err(|e| format!("search row: {e}"))?;
                let Some(b) = blob else { continue };
                if b.is_empty() {
                    continue;
                }
                candidates.push((b, entity));
            }
            drop(stmt);

            let mut out = Self::cosine_rerank(embedder, &q_vec, candidates, limit, offset, "entity");
            // factCount 별도 조회
            for e in &mut out {
                e.fact_count = conn
                    .query_row(
                        "SELECT COUNT(*) FROM entity_facts WHERE entity_id = ?1",
                        params![e.id],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
            }
            return Ok(out);
        }

        // Fallback (embedder 미설정 또는 query 빈 string) — substring 매칭 + updated_at DESC.
        let conn = self.conn.lock().unwrap();
        let q_pattern = format!("%{}%", opts.query);
        let alias_pattern = format!("%\"{}\"%", opts.query);
        let mut sql = String::from(
            r#"SELECT id, name, type, aliases, metadata, source_conv_id, created_at, updated_at, owner
               FROM entities WHERE owner = ?"#,
        );
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(owner_filter)];
        if let Some(t) = &opts.entity_type {
            sql.push_str(" AND type = ?");
            values.push(Box::new(t.clone()));
        }
        if has_query {
            sql.push_str(" AND (name LIKE ? OR aliases LIKE ?)");
            values.push(Box::new(q_pattern));
            values.push(Box::new(alias_pattern));
        }
        sql.push_str(" ORDER BY updated_at DESC LIMIT ? OFFSET ?");
        values.push(Box::new(limit as i64));
        values.push(Box::new(offset as i64));

        let mut stmt = conn.prepare(&sql).map_err(|e| format!("search prepare: {e}"))?;
        let value_refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| b.as_ref()).collect();
        let rows = stmt
            .query_map(value_refs.as_slice(), |row| Self::entity_from_row(row, 0))
            .map_err(|e| format!("search rows: {e}"))?;
        let mut out: Vec<EntityRecord> = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("search row: {e}"))?);
        }
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

    async fn save_fact(&self, input: &SaveFactInput) -> InfraResult<(i64, bool, Option<f64>)> {
        if input.content.trim().is_empty() {
            return Err("fact content 누락".to_string());
        }
        // Entity 존재 + owner scope 검증 — caller(input.owner) 가 지정되면 대상 entity 가 그 owner 소유일 때만
        // 허용(hub 방문자가 admin·타 hub 엔티티에 fact 주입 = cross-tenant write + prompt-injection 차단).
        // admin(owner None/빈값) = 무검사. 미존재·소유 불일치 모두 동일 에러로 존재 은닉.
        {
            let conn = self.conn.lock().unwrap();
            let entity_owner: Option<String> = conn
                .query_row(
                    "SELECT owner FROM entities WHERE id = ?1",
                    params![input.entity_id],
                    |r| r.get(0),
                )
                .ok();
            let ok = match (entity_owner, input.owner.as_deref().filter(|o| !o.is_empty())) {
                (Some(eo), Some(caller)) => eo == caller, // hub: 대상 entity 가 caller 소유여야 허용
                (Some(_), None) => true,                  // admin: 무검사
                (None, _) => false,                       // 미존재
            };
            if !ok {
                return Err(format!("entity id={} 미존재", input.entity_id));
            }
        }

        // 임베딩 자동 — content → embed_passage. embedder 미설정 시 None (silent fail OK).
        let embedding: Option<Vec<u8>> = self.embed_text_passage(&input.content).await;
        if embedding.is_some() {
            tracing::info!(category = "recall", "Recall 임베딩 저장 — fact");
        }

        // dedup_threshold cosine — 옛 TS 패턴: 같은 entity 의 기존 active fact 와 cosine 비교.
        // ≥ threshold 면 skip + 기존 id 반환. embedder + 새 임베딩 둘 다 설정되었을 때만 활성.
        if let (Some(threshold), Some(new_blob), Some(embedder)) = (
            input.dedup_threshold,
            embedding.as_ref(),
            self.embedder.as_ref(),
        ) {
            if threshold > 0.0 {
                let now = now_ms();
                let conn = self.conn.lock().unwrap();
                let mut stmt = conn
                    .prepare(
                        "SELECT id, embedding FROM entity_facts
                         WHERE entity_id = ?1 AND embedding IS NOT NULL
                           AND superseded_by IS NULL
                           AND (expires_at IS NULL OR expires_at > ?2)",
                    )
                    .map_err(|e| format!("dedup prepare: {e}"))?;
                let rows = stmt
                    .query_map(params![input.entity_id, now], |r| {
                        let id: i64 = r.get(0)?;
                        let blob: Vec<u8> = r.get(1)?;
                        Ok((id, blob))
                    })
                    .map_err(|e| format!("dedup query: {e}"))?;
                let new_vec = embedder.bytes_to_vec(new_blob);
                let mut best_id: Option<i64> = None;
                let mut best_sim: f32 = 0.0;
                for r in rows {
                    let (id, blob) = r.map_err(|e| format!("dedup row: {e}"))?;
                    let v = embedder.bytes_to_vec(&blob);
                    let sim = embedder.cosine(&new_vec, &v);
                    if sim > best_sim {
                        best_sim = sim;
                        best_id = Some(id);
                    }
                }
                if let Some(id) = best_id {
                    if best_sim >= threshold as f32 {
                        // Repeated observation = promotion signal — bump seen_count/last_seen and
                        // nudge confidence toward the promote threshold (explicit rows unchanged).
                        let _ = conn.execute(
                            "UPDATE entity_facts SET seen_count = seen_count + 1, last_seen = ?2,
                             confidence = CASE WHEN explicit = 1 THEN confidence ELSE MIN(0.95, confidence + 0.15) END
                             WHERE id = ?1",
                            params![id, now],
                        );
                        return Ok((id, true, Some(best_sim as f64)));
                    }
                }
            }
        }

        let now = now_ms();
        let tags_json =
            serde_json::to_string(&input.tags).map_err(|e| format!("tags 직렬화: {e}"))?;
        let expires_at = input.ttl_days.map(|d| now + d * 24 * 60 * 60 * 1000);
        let conn = self.conn.lock().unwrap();
        // fact.owner = 부모 entity 의 owner 자동 매핑 (cascade 일관성).
        let entity_owner: String = conn
            .query_row(
                "SELECT owner FROM entities WHERE id = ?1",
                params![input.entity_id],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| "admin".to_string());
        // Confidence: explicit user request = 1.0; autonomous inline default 0.7;
        // cron extraction passes Some(0.5) = staging (excluded from recall until promoted).
        let confidence = input
            .confidence
            .unwrap_or(if input.explicit { 1.0 } else { 0.7 });
        conn.execute(
            r#"INSERT INTO entity_facts
               (entity_id, content, fact_type, occurred_at, tags, embedding, source_conv_id, expires_at, owner, created_at, explicit, confidence, seen_count, last_seen)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13)"#,
            params![
                input.entity_id,
                input.content,
                input.fact_type,
                input.occurred_at,
                tags_json,
                embedding,
                input.source_conv_id,
                expires_at,
                entity_owner,
                now,
                input.explicit as i64,
                confidence,
                now
            ],
        )
        .map_err(|e| format!("fact insert 실패: {e}"))?;
        let new_id = conn.last_insert_rowid();

        // Model-judged supersession — this fact is a NEW VALUE of a state the entity already has:
        // retire the previous active rows of the same (entity, factType). History rows keep
        // superseded_by = new id (timeline shows them struck through), exactly one active value.
        if input.supersede {
            if let Some(ft) = input.fact_type.as_deref().filter(|f| !f.trim().is_empty()) {
                conn.execute(
                    "UPDATE entity_facts SET superseded_by = ?1
                     WHERE entity_id = ?2 AND fact_type = ?3 AND superseded_by IS NULL AND id != ?1",
                    params![new_id, input.entity_id, ft],
                )
                .map_err(|e| format!("fact supersede 실패: {e}"))?;
            }
        }

        // Entity last_updated 갱신 (옛 TS 동등)
        conn.execute(
            "UPDATE entities SET updated_at = ?1 WHERE id = ?2",
            params![now, input.entity_id],
        )
        .map_err(|e| format!("entity touch 실패: {e}"))?;

        Ok((new_id, false, None))
    }

    fn update_fact(&self, id: i64, patch: &UpdateFactPatch, owner: Option<&str>) -> InfraResult<()> {
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
        if let Some(c) = patch.confidence {
            // Manual promotion/demotion from the admin UI (승격 대기 -> 승격 = set >= threshold).
            sets.push("confidence = ?");
            values.push(Box::new(c));
        }
        if sets.is_empty() {
            return Ok(());
        }
        let mut sql = format!("UPDATE entity_facts SET {} WHERE id = ?", sets.join(", "));
        values.push(Box::new(id));
        if let Some(o) = owner {
            // Scoped mutation (hub) — owner mismatch gives updated=0, raising the same
            // not-found error below (existence hiding, remove_event mirror).
            sql.push_str(" AND owner = ?");
            values.push(Box::new(o.to_string()));
        }
        let value_refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| b.as_ref()).collect();
        let updated = conn
            .execute(&sql, value_refs.as_slice())
            .map_err(|e| format!("fact update 실패: {e}"))?;
        if updated == 0 {
            return Err(format!("fact id={} 미존재 또는 권한 없음", id));
        }
        Ok(())
    }

    fn remove_fact(&self, id: i64, owner: Option<&str>) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        // owner=Some: scoped delete (hub). Mismatch/absent gives n=0, raising the error below.
        let n = match owner {
            Some(o) => conn
                .execute(
                    "DELETE FROM entity_facts WHERE id = ?1 AND owner = ?2",
                    params![id, o],
                )
                .map_err(|e| format!("fact delete 실패: {e}"))?,
            None => conn
                .execute("DELETE FROM entity_facts WHERE id = ?1", params![id])
                .map_err(|e| format!("fact delete 실패: {e}"))?,
        };
        if n == 0 {
            return Err(format!("fact id={} 미존재 또는 권한 없음", id));
        }
        Ok(())
    }

    fn get_fact(&self, id: i64) -> InfraResult<Option<EntityFactRecord>> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            r#"SELECT id, entity_id, content, fact_type, occurred_at, tags, source_conv_id, expires_at, created_at, owner, superseded_by, explicit, confidence, seen_count, last_seen
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
        let owner = opts.owner.clone().unwrap_or_else(|| "admin".to_string());
        // Active-only by default (retrieval per-entity timelines) — the admin UI passes
        // includeInactive to review staging/superseded rows grouped separately.
        let active_gate = if opts.include_inactive {
            ""
        } else {
            " AND superseded_by IS NULL AND confidence >= 0.7"
        };
        let sql = format!(
            r#"SELECT id, entity_id, content, fact_type, occurred_at, tags, source_conv_id, expires_at, created_at, owner, superseded_by, explicit, confidence, seen_count, last_seen
               FROM entity_facts WHERE entity_id = ?1 AND owner = ?2{} ORDER BY {} DESC LIMIT ?3 OFFSET ?4"#,
            active_gate, order
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("timeline prepare: {e}"))?;
        let rows = stmt
            .query_map(params![entity_id, owner, limit, offset], Self::fact_from_row)
            .map_err(|e| format!("timeline query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("timeline row: {e}"))?);
        }
        Ok(out)
    }

    async fn search_facts(&self, opts: &FactSearchOpts) -> InfraResult<Vec<EntityFactRecord>> {
        let limit = opts.limit.unwrap_or(20).min(200);
        let offset = opts.offset.unwrap_or(0);
        let has_query = !opts.query.trim().is_empty();
        let has_embedder = self.embedder.is_some();

        // ── 공통 SQL 빌드 (filter conditions). cosine 모드는 LIMIT 없이 후보 전체 가져옴.
        // tag filter 는 SQL 미사용 Rust 측 tag JSON 매칭 (LIKE 한계 — 일반 로직).
        fn build_filters<'a>(
            opts: &'a FactSearchOpts,
            select_embedding: bool,
        ) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
            let cols = if select_embedding {
                "id, entity_id, content, fact_type, occurred_at, tags, source_conv_id, expires_at, created_at, owner, superseded_by, explicit, confidence, seen_count, last_seen, embedding"
            } else {
                "id, entity_id, content, fact_type, occurred_at, tags, source_conv_id, expires_at, created_at, owner, superseded_by, explicit, confidence, seen_count, last_seen"
            };
            let owner = opts.owner.clone().unwrap_or_else(|| "admin".to_string());
            let mut sql = format!(
                "SELECT {} FROM entity_facts WHERE owner = ? AND (expires_at IS NULL OR expires_at > ?)",
                cols
            );
            if !opts.include_inactive {
                // Retrieval/search see promoted, active facts only (staging + superseded excluded).
                sql.push_str(" AND superseded_by IS NULL AND confidence >= 0.7");
            }
            let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(owner), Box::new(now_ms())];
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
            (sql, values)
        }

        // ── Cosine 모드 — embedder 설정되어 있고 query 설정되어 있을 때
        if has_query && has_embedder {
            tracing::info!(category = "recall", "Recall 검색 — fact query='{}'", opts.query);
            let embedder = self.embedder.as_ref().expect("checked above");
            let q_vec = embedder
                .embed_query(&opts.query)
                .await
                .map_err(|e| format!("embed_query 실패: {e}"))?;

            let (sql, values) = build_filters(opts, true);
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(&sql).map_err(|e| format!("search facts: {e}"))?;
            let value_refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| b.as_ref()).collect();
            let rows = stmt
                .query_map(value_refs.as_slice(), |r| {
                    let fact = Self::fact_from_row(r)?;
                    let blob: Option<Vec<u8>> = r.get(15)?;
                    Ok((fact, blob))
                })
                .map_err(|e| format!("search facts query: {e}"))?;

            let mut candidates: Vec<(Vec<u8>, EntityFactRecord)> = Vec::new();
            for r in rows {
                let (fact, blob) = r.map_err(|e| format!("search facts row: {e}"))?;
                // tag filter 적용 — 빈 set 시 통과, 설정되어 있을 시 fact.tags 와 ANY 매칭
                if !opts.tags.is_empty() {
                    let want_lower: Vec<String> = opts.tags.iter().map(|t| t.to_lowercase()).collect();
                    let row_lower: Vec<String> = fact.tags.iter().map(|t| t.to_lowercase()).collect();
                    if !want_lower.iter().any(|w| row_lower.contains(w)) {
                        continue;
                    }
                }
                let Some(b) = blob else { continue };
                if b.is_empty() {
                    continue;
                }
                candidates.push((b, fact));
            }
            return Ok(Self::cosine_rerank(embedder, &q_vec, candidates, limit, offset, "fact"));
        }

        // ── Fallback (LIKE + 시간 정렬) ─────────────────────────────────────────
        let (mut sql, mut values) = build_filters(opts, false);
        if has_query {
            sql.push_str(" AND content LIKE ?");
            values.push(Box::new(format!("%{}%", opts.query)));
        }
        sql.push_str(" ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT ? OFFSET ?");
        values.push(Box::new(limit as i64));
        values.push(Box::new(offset as i64));

        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("search facts: {e}"))?;
        let value_refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| b.as_ref()).collect();
        let rows = stmt
            .query_map(value_refs.as_slice(), Self::fact_from_row)
            .map_err(|e| format!("search facts query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            let fact = r.map_err(|e| format!("search facts row: {e}"))?;
            // tag filter — fallback 모드에도 적용 (옛 TS 동등)
            if !opts.tags.is_empty() {
                let want_lower: Vec<String> = opts.tags.iter().map(|t| t.to_lowercase()).collect();
                let row_lower: Vec<String> = fact.tags.iter().map(|t| t.to_lowercase()).collect();
                if !want_lower.iter().any(|w| row_lower.contains(w)) {
                    continue;
                }
            }
            out.push(fact);
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

    fn count_entities(&self, owner: Option<&str>) -> InfraResult<i64> {
        let conn = self.conn.lock().unwrap();
        // owner-scoped count: None = admin scope (matches the search convention). Each owner counts only its own, not a global sum.
        conn.query_row("SELECT COUNT(*) FROM entities WHERE owner = ?1", params![owner.unwrap_or("admin")], |r| r.get(0))
            .map_err(|e| format!("count_entities: {e}"))
    }

    fn count_facts(&self, owner: Option<&str>) -> InfraResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM entity_facts WHERE owner = ?1", params![owner.unwrap_or("admin")], |r| r.get(0))
            .map_err(|e| format!("count_facts: {e}"))
    }

    fn list_fact_types(&self, owner: Option<&str>) -> InfraResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT fact_type FROM entity_facts
                 WHERE owner = ?1 AND fact_type IS NOT NULL AND TRIM(fact_type) != ''
                   AND superseded_by IS NULL
                 ORDER BY fact_type",
            )
            .map_err(|e| format!("list_fact_types: {e}"))?;
        let rows = stmt
            .query_map(params![owner.unwrap_or("admin")], |r| r.get::<_, String>(0))
            .map_err(|e| format!("list_fact_types query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("list_fact_types row: {e}"))?);
        }
        Ok(out)
    }

    fn count_entities_by_type(&self, owner: Option<&str>) -> InfraResult<Vec<(String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT type, COUNT(*) FROM entities WHERE owner = ?1 GROUP BY type ORDER BY 2 DESC")
            .map_err(|e| format!("count by type: {e}"))?;
        let rows = stmt
            .query_map(params![owner.unwrap_or("admin")], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
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
        let owner: String = row.get::<_, Option<String>>(10).ok().flatten().unwrap_or_else(|| "admin".to_string());
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
            owner,
            // Staging/supersession columns (11-15) — resilient reads (defaults when not selected).
            superseded_by: row.get::<_, Option<i64>>(11).ok().flatten(),
            explicit: row.get::<_, Option<i64>>(12).ok().flatten().unwrap_or(0) != 0,
            confidence: row.get::<_, Option<f64>>(13).ok().flatten().unwrap_or(1.0),
            seen_count: row.get::<_, Option<i64>>(14).ok().flatten().unwrap_or(1),
            last_seen: row.get::<_, Option<i64>>(15).ok().flatten(),
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

#[async_trait::async_trait]
impl IEpisodicPort for SqliteMemoryAdapter {
    async fn save_event(&self, input: &SaveEventInput) -> InfraResult<(i64, bool, Option<f64>)> {
        if input.title.trim().is_empty() {
            return Err("event title 누락".to_string());
        }
        if input.event_type.trim().is_empty() {
            return Err("event type 누락".to_string());
        }

        // 임베딩 자동 — title (+ description) → embed_passage. 옛 TS 동등.
        let passage = Self::event_passage_text(&input.title, input.description.as_deref());
        let embedding: Option<Vec<u8>> = self.embed_text_passage(&passage).await;
        if embedding.is_some() {
            tracing::info!(category = "recall", "Recall 임베딩 저장 — event");
        }

        // dedup_threshold cosine — 옛 TS 패턴: 같은 type + occurred_at 7일 이내 active event 와 비교.
        // ≥ threshold 면 skip + 기존 id 반환 (entity_ids 설정되어 있으면 link 추가).
        if let (Some(threshold), Some(new_blob), Some(embedder)) = (
            input.dedup_threshold,
            embedding.as_ref(),
            self.embedder.as_ref(),
        ) {
            if threshold > 0.0 {
                let now = now_ms();
                let cutoff = now - EVENT_DEDUP_WINDOW_MS;
                let conn = self.conn.lock().unwrap();
                let mut stmt = conn
                    .prepare(
                        "SELECT id, embedding FROM events
                         WHERE type = ?1 AND embedding IS NOT NULL
                           AND superseded_by IS NULL
                           AND occurred_at >= ?2
                           AND (expires_at IS NULL OR expires_at > ?3)",
                    )
                    .map_err(|e| format!("dedup prepare: {e}"))?;
                let rows = stmt
                    .query_map(params![input.event_type, cutoff, now], |r| {
                        let id: i64 = r.get(0)?;
                        let blob: Vec<u8> = r.get(1)?;
                        Ok((id, blob))
                    })
                    .map_err(|e| format!("dedup query: {e}"))?;
                let new_vec = embedder.bytes_to_vec(new_blob);
                let mut best_id: Option<i64> = None;
                let mut best_sim: f32 = 0.0;
                for r in rows {
                    let (id, blob) = r.map_err(|e| format!("dedup row: {e}"))?;
                    let v = embedder.bytes_to_vec(&blob);
                    let sim = embedder.cosine(&new_vec, &v);
                    if sim > best_sim {
                        best_sim = sim;
                        best_id = Some(id);
                    }
                }
                drop(stmt);
                if let Some(id) = best_id {
                    if best_sim >= threshold as f32 {
                        // 기존 event 에 entity_ids link 추가 (옛 TS 동등 — m2m upsert)
                        for entity_id in &input.entity_ids {
                            let _ = conn.execute(
                                "INSERT OR IGNORE INTO event_entities (event_id, entity_id) VALUES (?1, ?2)",
                                params![id, entity_id],
                            );
                        }
                        // Repeated observation = promotion signal (mirrors save_fact).
                        let _ = conn.execute(
                            "UPDATE events SET seen_count = seen_count + 1, last_seen = ?2,
                             confidence = CASE WHEN explicit = 1 THEN confidence ELSE MIN(0.95, confidence + 0.15) END
                             WHERE id = ?1",
                            params![id, now],
                        );
                        return Ok((id, true, Some(best_sim as f64)));
                    }
                }
            }
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

        let owner = input.owner.clone().unwrap_or_else(|| "admin".to_string());
        // Confidence: explicit = 1.0; autonomous inline default 0.7; cron extraction Some(0.5).
        let confidence = input
            .confidence
            .unwrap_or(if input.explicit { 1.0 } else { 0.7 });
        conn.execute(
            r#"INSERT INTO events
               (type, title, description, who, context, embedding, occurred_at, source_conv_id, expires_at, owner, created_at, explicit, confidence, seen_count, last_seen)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, ?14)"#,
            params![
                input.event_type,
                input.title,
                input.description,
                input.who,
                context_json,
                embedding,
                occurred_at,
                input.source_conv_id,
                expires_at,
                owner,
                now,
                input.explicit as i64,
                confidence,
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

        // entity_ids 설정되어 있으면 link 전체 교체
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

    fn remove_event(&self, id: i64, owner: Option<&str>) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("PRAGMA foreign_keys = ON", [])
            .map_err(|e| format!("foreign_keys ON: {e}"))?;
        // owner=Some: owner-scoped delete (hub). Mismatch/absent gives n=0, raising the permission/not-found error below.
        let n = match owner {
            Some(o) => conn
                .execute(
                    "DELETE FROM events WHERE id = ?1 AND owner = ?2",
                    params![id, o],
                )
                .map_err(|e| format!("event delete: {e}"))?,
            None => conn
                .execute("DELETE FROM events WHERE id = ?1", params![id])
                .map_err(|e| format!("event delete: {e}"))?,
        };
        if n == 0 {
            return Err(format!("event id={} 미존재 또는 권한 없음", id));
        }
        Ok(())
    }

    fn get_event(&self, id: i64) -> InfraResult<Option<EventRecord>> {
        let conn = self.conn.lock().unwrap();
        let entity_ids = Self::fetch_event_entity_ids(&conn, id);
        let result = conn.query_row(
            r#"SELECT id, type, title, description, who, context, occurred_at, source_conv_id, expires_at, created_at, owner, superseded_by, explicit, confidence, seen_count, last_seen
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

    async fn search_events(&self, opts: &EventSearchOpts) -> InfraResult<Vec<EventRecord>> {
        let limit = opts.limit.unwrap_or(20).min(200);
        let offset = opts.offset.unwrap_or(0);
        let has_query = !opts.query.trim().is_empty();
        let has_embedder = self.embedder.is_some();

        // ── 공통 SQL 빌드 (filter conditions). cosine 모드는 LIMIT 없이 후보 전체.
        // entity_id filter 면 INNER JOIN, 없으면 직접 events e.
        fn build_filters<'a>(
            opts: &'a EventSearchOpts,
            select_embedding: bool,
            apply_query_like: bool,
        ) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
            let cols = if select_embedding {
                "e.id, e.type, e.title, e.description, e.who, e.context, e.occurred_at, e.source_conv_id, e.expires_at, e.created_at, e.owner, e.superseded_by, e.explicit, e.confidence, e.seen_count, e.last_seen, e.embedding"
            } else {
                "e.id, e.type, e.title, e.description, e.who, e.context, e.occurred_at, e.source_conv_id, e.expires_at, e.created_at, e.owner, e.superseded_by, e.explicit, e.confidence, e.seen_count, e.last_seen"
            };
            let owner = opts.owner.clone().unwrap_or_else(|| "admin".to_string());
            let mut sql = format!("SELECT DISTINCT {} FROM events e", cols);
            if opts.entity_id.is_some() {
                sql.push_str(" INNER JOIN event_entities ee ON ee.event_id = e.id");
            }
            sql.push_str(" WHERE e.owner = ? AND (e.expires_at IS NULL OR e.expires_at > ?)");
            if !opts.include_inactive {
                // Retrieval/search see promoted, active events only (staging + superseded excluded).
                sql.push_str(" AND e.superseded_by IS NULL AND e.confidence >= 0.7");
            }
            let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(owner), Box::new(now_ms())];

            if apply_query_like && !opts.query.trim().is_empty() {
                let pat = format!("%{}%", opts.query);
                sql.push_str(" AND (e.title LIKE ? OR COALESCE(e.description,'') LIKE ?)");
                values.push(Box::new(pat.clone()));
                values.push(Box::new(pat));
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
            (sql, values)
        }

        // ── Cosine 모드 — embedder + query 설정되어 있을 때
        if has_query && has_embedder {
            tracing::info!(category = "recall", "Recall 검색 — event query='{}'", opts.query);
            let embedder = self.embedder.as_ref().expect("checked above");
            let q_vec = embedder
                .embed_query(&opts.query)
                .await
                .map_err(|e| format!("embed_query 실패: {e}"))?;

            // cosine 모드는 query LIKE 적용 X — 임베딩 매칭으로 충분
            let (sql, values) = build_filters(opts, true, false);
            let conn = self.conn.lock().unwrap();
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
                        row.get::<_, Option<String>>(10)?,
                        (
                            row.get::<_, Option<i64>>(11)?,
                            row.get::<_, Option<i64>>(12)?,
                            row.get::<_, Option<f64>>(13)?,
                            row.get::<_, Option<i64>>(14)?,
                            row.get::<_, Option<i64>>(15)?,
                        ),
                        row.get::<_, Option<Vec<u8>>>(16)?,
                    ))
                })
                .map_err(|e| format!("search events query: {e}"))?;

            let mut candidates: Vec<(Vec<u8>, EventRecord)> = Vec::new();
            for r in rows {
                let (id, ty, title, desc, who, ctx, occ, conv, exp, created, row_owner, staging, blob) =
                    r.map_err(|e| format!("search events row: {e}"))?;
                let Some(b) = blob else { continue };
                if b.is_empty() {
                    continue;
                }
                let entity_ids = Self::fetch_event_entity_ids(&conn, id);
                candidates.push((
                    b,
                    EventRecord {
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
                        owner: row_owner.unwrap_or_else(|| "admin".to_string()),
                        superseded_by: staging.0,
                        explicit: staging.1.unwrap_or(0) != 0,
                        confidence: staging.2.unwrap_or(1.0),
                        seen_count: staging.3.unwrap_or(1),
                        last_seen: staging.4,
                    },
                ));
            }
            return Ok(Self::cosine_rerank(embedder, &q_vec, candidates, limit, offset, "event"));
        }

        // ── Fallback (LIKE + 시간 정렬) ─────────────────────────────────────────
        let (mut sql, mut values) = build_filters(opts, false, true);
        sql.push_str(" ORDER BY e.occurred_at DESC LIMIT ? OFFSET ?");
        values.push(Box::new(limit as i64));
        values.push(Box::new(offset as i64));

        let conn = self.conn.lock().unwrap();
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
                    row.get::<_, Option<String>>(10)?,
                    (
                        row.get::<_, Option<i64>>(11)?,
                        row.get::<_, Option<i64>>(12)?,
                        row.get::<_, Option<f64>>(13)?,
                        row.get::<_, Option<i64>>(14)?,
                        row.get::<_, Option<i64>>(15)?,
                    ),
                ))
            })
            .map_err(|e| format!("search events query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            let (id, ty, title, desc, who, ctx, occ, conv, exp, created, row_owner, staging) =
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
                owner: row_owner.unwrap_or_else(|| "admin".to_string()),
                superseded_by: staging.0,
                explicit: staging.1.unwrap_or(0) != 0,
                confidence: staging.2.unwrap_or(1.0),
                seen_count: staging.3.unwrap_or(1),
                last_seen: staging.4,
            });
        }
        Ok(out)
    }

    fn list_recent_events(&self, opts: &ListRecentOpts) -> InfraResult<Vec<EventRecord>> {
        // sync 유지 — search_events 의 query-empty fallback path 와 동일 SQL 직접 저장.
        let limit = opts.limit.unwrap_or(20).min(200) as i64;
        let offset = opts.offset.unwrap_or(0) as i64;
        let owner = opts.owner.clone().unwrap_or_else(|| "admin".to_string());
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from(
            r#"SELECT e.id, e.type, e.title, e.description, e.who, e.context, e.occurred_at, e.source_conv_id, e.expires_at, e.created_at, e.owner, e.superseded_by, e.explicit, e.confidence, e.seen_count, e.last_seen
               FROM events e WHERE e.owner = ? AND (e.expires_at IS NULL OR e.expires_at > ?)"#,
        );
        if !opts.include_inactive {
            sql.push_str(" AND e.superseded_by IS NULL AND e.confidence >= 0.7");
        }
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(owner), Box::new(now_ms())];
        if let Some(t) = &opts.event_type {
            sql.push_str(" AND e.type = ?");
            values.push(Box::new(t.clone()));
        }
        if let Some(w) = &opts.who {
            sql.push_str(" AND e.who = ?");
            values.push(Box::new(w.clone()));
        }
        sql.push_str(" ORDER BY e.occurred_at DESC LIMIT ? OFFSET ?");
        values.push(Box::new(limit));
        values.push(Box::new(offset));

        let mut stmt = conn.prepare(&sql).map_err(|e| format!("list_recent_events: {e}"))?;
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
                    row.get::<_, Option<String>>(10)?,
                    (
                        row.get::<_, Option<i64>>(11)?,
                        row.get::<_, Option<i64>>(12)?,
                        row.get::<_, Option<f64>>(13)?,
                        row.get::<_, Option<i64>>(14)?,
                        row.get::<_, Option<i64>>(15)?,
                    ),
                ))
            })
            .map_err(|e| format!("list_recent_events query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            let (id, ty, title, desc, who, ctx, occ, conv, exp, created, row_owner, staging) =
                r.map_err(|e| format!("list_recent_events row: {e}"))?;
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
                owner: row_owner.unwrap_or_else(|| "admin".to_string()),
                superseded_by: staging.0,
                explicit: staging.1.unwrap_or(0) != 0,
                confidence: staging.2.unwrap_or(1.0),
                seen_count: staging.3.unwrap_or(1),
                last_seen: staging.4,
            });
        }
        Ok(out)
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

    fn count_events(&self, owner: Option<&str>) -> InfraResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM events WHERE owner = ?1", params![owner.unwrap_or("admin")], |r| r.get(0))
            .map_err(|e| format!("count_events: {e}"))
    }

    fn count_events_by_type(&self, owner: Option<&str>) -> InfraResult<Vec<(String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT type, COUNT(*) FROM events WHERE owner = ?1 GROUP BY type ORDER BY 2 DESC")
            .map_err(|e| format!("count events by type: {e}"))?;
        let rows = stmt
            .query_map(params![owner.unwrap_or("admin")], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
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

    #[tokio::test]
    async fn entity_save_get_search_roundtrip() {
        let a = adapter();
        let (id, created) = a
            .save_entity(&SaveEntityInput {
                name: "삼성전자".to_string(),
                entity_type: "stock".to_string(),
                aliases: vec!["005930".to_string(), "Samsung".to_string()],
                metadata: Some(serde_json::json!({"sector": "tech"})),
                source_conv_id: Some("c1".to_string()),
                dedup_threshold: None,
                owner: None,
            })
            .await
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
            .await
            .unwrap();
        assert_eq!(search.len(), 1);
    }

    #[tokio::test]
    async fn entity_upsert_returns_existing_id() {
        let a = adapter();
        let (id1, created1) = a
            .save_entity(&SaveEntityInput {
                name: "X".to_string(),
                entity_type: "t".to_string(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(created1);
        let (id2, created2) = a
            .save_entity(&SaveEntityInput {
                name: "X".to_string(),
                entity_type: "t".to_string(),
                aliases: vec!["alt".to_string()],
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(id1, id2);
        assert!(!created2);
        let got = a.get_entity(id1).unwrap().unwrap();
        assert_eq!(got.aliases, vec!["alt".to_string()]);
    }

    #[tokio::test]
    async fn fact_link_to_entity_and_timeline() {
        let a = adapter();
        let (eid, _) = a
            .save_entity(&SaveEntityInput {
                name: "삼성".to_string(),
                entity_type: "stock".to_string(),
                ..Default::default()
            })
            .await
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
            .await
            .unwrap();
        assert!(fid > 0);

        let timeline = a.list_facts_by_entity(eid, &TimelineOpts::default()).unwrap();
        assert_eq!(timeline.len(), 1);
        assert_eq!(timeline[0].content, "1주 매수");

        // factCount in get_entity
        let got = a.get_entity(eid).unwrap().unwrap();
        assert_eq!(got.fact_count, 1);
    }

    #[tokio::test]
    async fn fact_ttl_expires_via_cleanup() {
        let a = adapter();
        let (eid, _) = a
            .save_entity(&SaveEntityInput {
                name: "tmp".to_string(),
                entity_type: "t".to_string(),
                ..Default::default()
            })
            .await
            .unwrap();
        let (_, _, _) = a
            .save_fact(&SaveFactInput {
                entity_id: eid,
                content: "곧 만료".to_string(),
                ttl_days: Some(-1), // 즉시 만료
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(a.count_facts(None).unwrap(), 1);
        let removed = a.cleanup_expired_facts().unwrap();
        assert_eq!(removed, 1);
        assert_eq!(a.count_facts(None).unwrap(), 0);
    }

    #[tokio::test]
    async fn event_save_link_entity_and_unlink() {
        let a = adapter();
        let (eid, _) = a
            .save_entity(&SaveEntityInput {
                name: "ent".to_string(),
                entity_type: "t".to_string(),
                ..Default::default()
            })
            .await
            .unwrap();
        let (evid, _, _) = a
            .save_event(&SaveEventInput {
                event_type: "page_publish".to_string(),
                title: "테스트 발행".to_string(),
                occurred_at: Some(1_700_000_000_000),
                entity_ids: vec![eid],
                ..Default::default()
            })
            .await
            .unwrap();
        let got = a.get_event(evid).unwrap().unwrap();
        assert_eq!(got.entity_ids, vec![eid]);

        a.unlink_event_entity(evid, eid).unwrap();
        let after = a.get_event(evid).unwrap().unwrap();
        assert!(after.entity_ids.is_empty());
    }

    #[tokio::test]
    async fn event_search_filters_combine() {
        let a = adapter();
        a.save_event(&SaveEventInput {
            event_type: "cron_trigger".to_string(),
            title: "삼성 점검".to_string(),
            occurred_at: Some(1_700_000_000_000),
            ..Default::default()
        })
        .await
        .unwrap();
        a.save_event(&SaveEventInput {
            event_type: "page_publish".to_string(),
            title: "기타".to_string(),
            occurred_at: Some(1_700_001_000_000),
            ..Default::default()
        })
        .await
        .unwrap();
        let search = a
            .search_events(&EventSearchOpts {
                event_type: Some("cron_trigger".to_string()),
                limit: Some(10),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(search.len(), 1);
        assert_eq!(search[0].title, "삼성 점검");
    }

    #[tokio::test]
    async fn entity_cascade_deletes_facts() {
        let a = adapter();
        let (eid, _) = a
            .save_entity(&SaveEntityInput {
                name: "casc".to_string(),
                entity_type: "t".to_string(),
                ..Default::default()
            })
            .await
            .unwrap();
        a.save_fact(&SaveFactInput {
            entity_id: eid,
            content: "f1".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
        a.save_fact(&SaveFactInput {
            entity_id: eid,
            content: "f2".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
        assert_eq!(a.count_facts(None).unwrap(), 2);
        a.remove_entity(eid).unwrap();
        assert_eq!(a.count_facts(None).unwrap(), 0);
    }

    #[tokio::test]
    async fn count_by_type_aggregates() {
        let a = adapter();
        a.save_entity(&SaveEntityInput {
            name: "a".to_string(),
            entity_type: "stock".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
        a.save_entity(&SaveEntityInput {
            name: "b".to_string(),
            entity_type: "stock".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
        a.save_entity(&SaveEntityInput {
            name: "c".to_string(),
            entity_type: "person".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
        let by_type = a.count_entities_by_type(None).unwrap();
        assert!(by_type.iter().any(|(t, c)| t == "stock" && *c == 2));
        assert!(by_type.iter().any(|(t, c)| t == "person" && *c == 1));
    }

    // ── Phase B-18 Step 1.5 — embedder 설정된 cosine 모드 테스트 ──────────────────

    use crate::adapters::embedder::StubEmbedderAdapter;

    fn adapter_with_embedder() -> SqliteMemoryAdapter {
        let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
        SqliteMemoryAdapter::new_in_memory().unwrap().with_embedder(embedder)
    }

    #[tokio::test]
    async fn save_entity_with_embedder_persists_blob() {
        let a = adapter_with_embedder();
        let (id, _) = a
            .save_entity(&SaveEntityInput {
                name: "삼성전자".to_string(),
                entity_type: "stock".to_string(),
                aliases: vec!["005930".to_string()],
                ..Default::default()
            })
            .await
            .unwrap();
        // 임베딩 BLOB 이 설정되었는지 직접 확인
        let conn = a.conn.lock().unwrap();
        let blob: Option<Vec<u8>> = conn
            .query_row(
                "SELECT embedding FROM entities WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(blob.is_some(), "embedder 설정되었으면 BLOB 저장됐어야 함");
        // Stub embedder = 384-dim x 4 bytes = 1536 bytes
        assert_eq!(blob.unwrap().len(), 384 * 4);
    }

    #[tokio::test]
    async fn search_entities_cosine_mode_activated_with_embedder() {
        let a = adapter_with_embedder();
        a.save_entity(&SaveEntityInput {
            name: "삼성전자".to_string(),
            entity_type: "stock".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
        a.save_entity(&SaveEntityInput {
            name: "하이닉스".to_string(),
            entity_type: "stock".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
        // cosine 검색 — substring 미매칭 query 사용해도 결과 반환 (cosine 모드 진입 검증)
        let result = a
            .search_entities(&EntitySearchOpts {
                query: "반도체".to_string(),
                limit: Some(10),
                ..Default::default()
            })
            .await
            .unwrap();
        // Stub embedder 라 cosine 점수 의미 없음 — 후보가 있으면 정렬 후 limit
        assert_eq!(result.len(), 2);
    }

    #[tokio::test]
    async fn save_fact_dedup_threshold_skips_similar() {
        let a = adapter_with_embedder();
        let (eid, _) = a
            .save_entity(&SaveEntityInput {
                name: "x".to_string(),
                entity_type: "t".to_string(),
                ..Default::default()
            })
            .await
            .unwrap();
        let (fid1, skipped1, _) = a
            .save_fact(&SaveFactInput {
                entity_id: eid,
                content: "같은 내용".to_string(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(!skipped1);

        // 같은 content + 0.99 threshold → skip 검출 (stub embedder 결정론, cosine ~= 1.0)
        let (fid2, skipped2, sim) = a
            .save_fact(&SaveFactInput {
                entity_id: eid,
                content: "같은 내용".to_string(),
                dedup_threshold: Some(0.99),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(skipped2, "같은 임베딩 + threshold 0.99 면 skip 되어야");
        assert_eq!(fid2, fid1, "skip 시 기존 id 반환");
        assert!(sim.unwrap() >= 0.99);
    }

    #[tokio::test]
    async fn save_event_dedup_within_7day_window() {
        // 옛 TS 동작 1:1 — dedup 검사는 "기존 row 의 occurred_at 가 dedup 호출 시점의 7일 이내"
        // 인 후보들 사이에서만. 새 입력의 occurred_at 는 검사에 미사용.
        let a = adapter_with_embedder();

        // 1) 옛날 (지금 - 8일) 설정된 event — dedup 호출 시점에 cutoff 밖
        let now = now_ms();
        let old_ts = now - EVENT_DEDUP_WINDOW_MS - 86_400_000; // -8일
        let (id_old, _, _) = a
            .save_event(&SaveEventInput {
                event_type: "page_publish".to_string(),
                title: "주간 시황".to_string(),
                occurred_at: Some(old_ts),
                ..Default::default()
            })
            .await
            .unwrap();

        // 2) 같은 type + title + dedup threshold → 기존 row 가 윈도우 밖이라 skip 안 됨, 새 row.
        let (id_new, skipped, _) = a
            .save_event(&SaveEventInput {
                event_type: "page_publish".to_string(),
                title: "주간 시황".to_string(),
                occurred_at: Some(now),
                dedup_threshold: Some(0.99),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(!skipped, "기존 row 가 7일+ 지나면 윈도우 밖 → 새 row 설정해야");
        assert_ne!(id_new, id_old);

        // 3) 같은 type + title + dedup threshold + 윈도우 안 — skip
        let (id_dup, dup_skipped, _) = a
            .save_event(&SaveEventInput {
                event_type: "page_publish".to_string(),
                title: "주간 시황".to_string(),
                occurred_at: Some(now),
                dedup_threshold: Some(0.99),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(dup_skipped, "기존 id_new 가 윈도우 안 → skip 되어야");
        assert_eq!(id_dup, id_new);
    }
}
