//! SqliteLibraryAdapter — ILibraryPort 의 SQLite 구현 (memory.db 자연 활용).
//!
//! Library Phase 1 (2026-05-17) — NotebookLM 같은 RAG. 매 Reference = 자료 그룹,
//! 매 Source = 매 자료, 매 Chunk = 임베딩 단위.
//!
//! Schema = `infra/src/adapters/memory.rs::initialize()` 안에 정의되어 있음 (library_references /
//! library_sources / library_chunks 3 tables). 매 부팅 시점 SqliteMemoryAdapter 가 자동 초기화.
//! 본 어댑터 = 별도 Connection (Mutex) — write 거의 없음 (Source 업로드 시점만) →
//! 동시 lock 부담 작음.

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

use firebat_core::ports::{
    ILibraryPort, InfraResult, LibraryChunk, LibraryReference, LibrarySource,
};

pub struct SqliteLibraryAdapter {
    conn: Mutex<Connection>,
}

impl SqliteLibraryAdapter {
    pub fn new(db_path: impl AsRef<Path>) -> Result<Self, String> {
        let path = db_path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Library DB 디렉토리 생성 실패: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("Library DB open 실패: {e}"))?;
        // schema = SqliteMemoryAdapter::initialize 안에 정의되어 있어 부팅 시점 자동 적용.
        // 본 어댑터 = 단독 호출도 안전 — SqliteMemoryAdapter::new 호출 후에 사용.
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Library DB in-memory open 실패: {e}"))?;
        // test 용 — schema 자동 초기화 없음 — SqliteMemoryAdapter::new_in_memory 와 별도 path.
        // 본 어댑터 사용 시점에 schema 가 필요 → 직접 생성.
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS library_references (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                owner TEXT NOT NULL DEFAULT 'admin',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS library_sources (
                id TEXT PRIMARY KEY,
                reference_id TEXT NOT NULL,
                name TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_url TEXT,
                file_path TEXT,
                full_text TEXT NOT NULL,
                char_count INTEGER NOT NULL DEFAULT 0,
                chunk_count INTEGER NOT NULL DEFAULT 0,
                content_hash TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (reference_id) REFERENCES library_references(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS library_chunks (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                embedding BLOB,
                page_number INTEGER,
                start_char INTEGER NOT NULL DEFAULT 0,
                end_char INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (source_id) REFERENCES library_sources(id) ON DELETE CASCADE
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS library_chunks_fts USING fts5(
                chunk_id UNINDEXED,
                content,
                tokenize='trigram'
            );
            "#,
        )
        .map_err(|e| format!("Library schema 초기화 실패: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

fn now_ms() -> i64 {
    firebat_core::utils::time::now_ms()
}

#[async_trait::async_trait]
impl ILibraryPort for SqliteLibraryAdapter {
    async fn create_reference(
        &self,
        id: &str,
        name: &str,
        description: Option<&str>,
        owner: &str,
    ) -> InfraResult<()> {
        let conn = self.conn.lock().map_err(|e| format!("conn lock: {e}"))?;
        let now = now_ms();
        conn.execute(
            "INSERT INTO library_references (id, name, description, owner, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, name, description, owner, now],
        )
        .map_err(|e| format!("create_reference: {e}"))?;
        Ok(())
    }

    async fn list_references(&self, owner: &str) -> InfraResult<Vec<LibraryReference>> {
        let conn = self.conn.lock().map_err(|e| format!("conn lock: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, description, owner, created_at, updated_at
                 FROM library_references WHERE owner = ?1 ORDER BY updated_at DESC",
            )
            .map_err(|e| format!("prepare list_references: {e}"))?;
        let rows = stmt
            .query_map(params![owner], |r| {
                Ok(LibraryReference {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    owner: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            })
            .map_err(|e| format!("query list_references: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    async fn delete_reference(&self, id: &str) -> InfraResult<()> {
        let conn = self.conn.lock().map_err(|e| format!("conn lock: {e}"))?;
        // FTS5 수동 정리 — 이 reference 하위 모든 chunk (cascade 전에).
        conn.execute(
            "DELETE FROM library_chunks_fts WHERE chunk_id IN
                (SELECT c.id FROM library_chunks c
                 JOIN library_sources s ON c.source_id = s.id
                 WHERE s.reference_id = ?1)",
            params![id],
        )
        .map_err(|e| format!("delete_reference fts: {e}"))?;
        conn.execute("DELETE FROM library_references WHERE id = ?1", params![id])
            .map_err(|e| format!("delete_reference: {e}"))?;
        Ok(())
    }

    async fn create_source(
        &self,
        id: &str,
        reference_id: &str,
        name: &str,
        source_type: &str,
        source_url: Option<&str>,
        file_path: Option<&str>,
        full_text: &str,
        content_hash: Option<&str>,
    ) -> InfraResult<()> {
        let conn = self.conn.lock().map_err(|e| format!("conn lock: {e}"))?;
        let char_count = full_text.chars().count() as i64;
        let now = now_ms();
        conn.execute(
            "INSERT INTO library_sources (id, reference_id, name, source_type, source_url,
                                          file_path, full_text, char_count, chunk_count, content_hash, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10)",
            params![id, reference_id, name, source_type, source_url, file_path, full_text, char_count, content_hash, now],
        )
        .map_err(|e| format!("create_source: {e}"))?;
        // Reference 의 updated_at 도 갱신 (sort 영역)
        conn.execute(
            "UPDATE library_references SET updated_at = ?1 WHERE id = ?2",
            params![now, reference_id],
        )
        .map_err(|e| format!("update ref updated_at: {e}"))?;
        Ok(())
    }

    async fn list_sources(&self, reference_id: &str) -> InfraResult<Vec<LibrarySource>> {
        let conn = self.conn.lock().map_err(|e| format!("conn lock: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, reference_id, name, source_type, source_url, file_path,
                        full_text, char_count, chunk_count, created_at
                 FROM library_sources WHERE reference_id = ?1 ORDER BY created_at DESC",
            )
            .map_err(|e| format!("prepare list_sources: {e}"))?;
        let rows = stmt
            .query_map(params![reference_id], |r| {
                Ok(LibrarySource {
                    id: r.get(0)?,
                    reference_id: r.get(1)?,
                    name: r.get(2)?,
                    source_type: r.get(3)?,
                    source_url: r.get(4)?,
                    file_path: r.get(5)?,
                    full_text: r.get(6)?,
                    char_count: r.get(7)?,
                    chunk_count: r.get(8)?,
                    created_at: r.get(9)?,
                })
            })
            .map_err(|e| format!("query list_sources: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    async fn get_source(&self, id: &str) -> InfraResult<Option<LibrarySource>> {
        let conn = self.conn.lock().map_err(|e| format!("conn lock: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, reference_id, name, source_type, source_url, file_path,
                        full_text, char_count, chunk_count, created_at
                 FROM library_sources WHERE id = ?1",
            )
            .map_err(|e| format!("prepare get_source: {e}"))?;
        let mut rows = stmt
            .query_map(params![id], |r| {
                Ok(LibrarySource {
                    id: r.get(0)?,
                    reference_id: r.get(1)?,
                    name: r.get(2)?,
                    source_type: r.get(3)?,
                    source_url: r.get(4)?,
                    file_path: r.get(5)?,
                    full_text: r.get(6)?,
                    char_count: r.get(7)?,
                    chunk_count: r.get(8)?,
                    created_at: r.get(9)?,
                })
            })
            .map_err(|e| format!("query get_source: {e}"))?;
        Ok(rows.next().and_then(|r| r.ok()))
    }

    async fn find_source_by_hash(
        &self,
        reference_id: &str,
        content_hash: &str,
    ) -> InfraResult<Option<LibrarySource>> {
        let conn = self.conn.lock().map_err(|e| format!("conn lock: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, reference_id, name, source_type, source_url, file_path,
                        full_text, char_count, chunk_count, created_at
                 FROM library_sources WHERE reference_id = ?1 AND content_hash = ?2 LIMIT 1",
            )
            .map_err(|e| format!("prepare find_source_by_hash: {e}"))?;
        let mut rows = stmt
            .query_map(params![reference_id, content_hash], |r| {
                Ok(LibrarySource {
                    id: r.get(0)?,
                    reference_id: r.get(1)?,
                    name: r.get(2)?,
                    source_type: r.get(3)?,
                    source_url: r.get(4)?,
                    file_path: r.get(5)?,
                    full_text: r.get(6)?,
                    char_count: r.get(7)?,
                    chunk_count: r.get(8)?,
                    created_at: r.get(9)?,
                })
            })
            .map_err(|e| format!("query find_source_by_hash: {e}"))?;
        Ok(rows.next().and_then(|r| r.ok()))
    }

    async fn delete_source(&self, id: &str) -> InfraResult<()> {
        let conn = self.conn.lock().map_err(|e| format!("conn lock: {e}"))?;
        // FTS5 는 FK cascade 대상이 아니라 먼저 수동 정리 (chunk 가 cascade 로 사라지기 전 id 확보).
        conn.execute(
            "DELETE FROM library_chunks_fts WHERE chunk_id IN
                (SELECT id FROM library_chunks WHERE source_id = ?1)",
            params![id],
        )
        .map_err(|e| format!("delete_source fts: {e}"))?;
        conn.execute("DELETE FROM library_sources WHERE id = ?1", params![id])
            .map_err(|e| format!("delete_source: {e}"))?;
        Ok(())
    }

    async fn save_chunk(
        &self,
        id: &str,
        source_id: &str,
        chunk_index: i64,
        content: &str,
        embedding: &[u8],
        page_number: Option<i64>,
        start_char: i64,
        end_char: i64,
    ) -> InfraResult<()> {
        let conn = self.conn.lock().map_err(|e| format!("conn lock: {e}"))?;
        conn.execute(
            "INSERT INTO library_chunks (id, source_id, chunk_index, content, embedding,
                                         page_number, start_char, end_char)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, source_id, chunk_index, content, embedding, page_number, start_char, end_char],
        )
        .map_err(|e| format!("save_chunk: {e}"))?;
        // 하이브리드 검색 FTS5 동기화 — BM25 sparse 인덱스 (trigram).
        conn.execute(
            "INSERT INTO library_chunks_fts (chunk_id, content) VALUES (?1, ?2)",
            params![id, content],
        )
        .map_err(|e| format!("save_chunk fts: {e}"))?;
        Ok(())
    }

    async fn update_source_chunk_count(&self, source_id: &str, chunk_count: i64) -> InfraResult<()> {
        let conn = self.conn.lock().map_err(|e| format!("conn lock: {e}"))?;
        conn.execute(
            "UPDATE library_sources SET chunk_count = ?1 WHERE id = ?2",
            params![chunk_count, source_id],
        )
        .map_err(|e| format!("update_source_chunk_count: {e}"))?;
        Ok(())
    }

    async fn list_chunks_for_search(
        &self,
        reference_ids: &[String],
    ) -> InfraResult<Vec<LibraryChunk>> {
        if reference_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().map_err(|e| format!("conn lock: {e}"))?;
        // dynamic IN clause — placeholder 를 매 reference_id 별 생성
        let placeholders = (1..=reference_ids.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT c.id, c.source_id, c.chunk_index, c.content, c.embedding,
                    c.page_number, c.start_char, c.end_char
             FROM library_chunks c
             INNER JOIN library_sources s ON c.source_id = s.id
             WHERE s.reference_id IN ({placeholders})"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("prepare list_chunks_for_search: {e}"))?;
        let params: Vec<&dyn rusqlite::ToSql> = reference_ids
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        let rows = stmt
            .query_map(params.as_slice(), |r| {
                Ok(LibraryChunk {
                    id: r.get(0)?,
                    source_id: r.get(1)?,
                    chunk_index: r.get(2)?,
                    content: r.get(3)?,
                    embedding: r.get::<_, Option<Vec<u8>>>(4)?,
                    page_number: r.get(5)?,
                    start_char: r.get(6)?,
                    end_char: r.get(7)?,
                })
            })
            .map_err(|e| format!("query list_chunks_for_search: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    async fn search_chunks_bm25(
        &self,
        reference_ids: &[String],
        query: &str,
        limit: usize,
    ) -> InfraResult<Vec<String>> {
        if reference_ids.is_empty() {
            return Ok(Vec::new());
        }
        // trigram FTS5 — 부분문자열 매칭. 3자 미만 토큰은 trigram 불가라 제외.
        // 각 토큰을 따옴표로 감싸 phrase(리터럴 substring) 질의 + OR 결합 (MATCH 구문·연산자 오인 방지).
        let terms: Vec<String> = query
            .split_whitespace()
            .filter(|t| t.chars().count() >= 3)
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let match_query = terms.join(" OR ");
        let conn = self.conn.lock().map_err(|e| format!("conn lock: {e}"))?;
        // bind: ?1 = MATCH query, ?2 = limit, ?3.. = reference_ids
        let placeholders = (3..3 + reference_ids.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT library_chunks_fts.chunk_id
             FROM library_chunks_fts
             JOIN library_chunks c ON library_chunks_fts.chunk_id = c.id
             JOIN library_sources s ON c.source_id = s.id
             WHERE library_chunks_fts MATCH ?1 AND s.reference_id IN ({placeholders})
             ORDER BY bm25(library_chunks_fts) LIMIT ?2"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("prepare search_chunks_bm25: {e}"))?;
        let limit_i = limit as i64;
        let mut binds: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(2 + reference_ids.len());
        binds.push(&match_query);
        binds.push(&limit_i);
        for r in reference_ids {
            binds.push(r as &dyn rusqlite::ToSql);
        }
        let ids = stmt
            .query_map(binds.as_slice(), |row| row.get::<_, String>(0))
            .map_err(|e| format!("query search_chunks_bm25: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reference_crud() {
        let adapter = SqliteLibraryAdapter::new_in_memory().unwrap();
        adapter
            .create_reference("ref-1", "법률 자료 2026", Some("법률 영역"), "admin")
            .await
            .unwrap();
        adapter
            .create_reference("ref-2", "주식 분석", None, "admin")
            .await
            .unwrap();
        let refs = adapter.list_references("admin").await.unwrap();
        assert_eq!(refs.len(), 2);
        adapter.delete_reference("ref-1").await.unwrap();
        let refs = adapter.list_references("admin").await.unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].name, "주식 분석");
    }

    #[tokio::test]
    async fn source_crud_and_chunk_search() {
        let adapter = SqliteLibraryAdapter::new_in_memory().unwrap();
        adapter
            .create_reference("ref-1", "주식 분석", None, "admin")
            .await
            .unwrap();
        adapter
            .create_source("src-1", "ref-1", "samsung.pdf", "pdf", None, Some("/path/a.pdf"),
                           "삼성전자 2026 Q1 영업이익 6.4조원")
            .await
            .unwrap();
        let sources = adapter.list_sources("ref-1").await.unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].char_count, "삼성전자 2026 Q1 영업이익 6.4조원".chars().count() as i64);

        // chunk 저장 — dummy embedding (4 bytes = 1 f32)
        let embedding = (0.5_f32).to_le_bytes().to_vec();
        adapter
            .save_chunk("chunk-1", "src-1", 0, "삼성전자 영업이익", &embedding, Some(1), 0, 10)
            .await
            .unwrap();
        adapter.update_source_chunk_count("src-1", 1).await.unwrap();
        let s = adapter.get_source("src-1").await.unwrap().unwrap();
        assert_eq!(s.chunk_count, 1);

        let chunks = adapter
            .list_chunks_for_search(&["ref-1".to_string()])
            .await
            .unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, "삼성전자 영업이익");
        assert_eq!(chunks[0].embedding.as_ref().unwrap().len(), 4);
    }
}
