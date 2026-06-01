//! LibraryManager — Library Phase 1 (2026-05-17) 의 비즈니스 로직.
//!
//! NotebookLM 같은 RAG 영역:
//! - 매 Reference = 자료 그룹 (예: "법률 자료 2026")
//! - 매 Source = 매 자료 (PDF / TXT / MD / URL / 직접 입력)
//! - 매 Chunk = ~500 토큰 임베딩 단위 (Arctic 1024-dim)
//!
//! 매 사용자 query 시점 → dense(E5 cosine) + sparse(BM25/FTS5 trigram) 하이브리드 검색 → RRF 융합
//! → top-K → 시스템 프롬프트 영역 `<LIBRARY_CONTEXT>` prepend (RetrievalEngine 5tier 영역).
//! dense 는 의미, sparse 는 정확 토큰(고유명사·법조문 코드·숫자)을 잡아 서로 보완.

use std::collections::HashMap;
use std::sync::Arc;

use crate::ports::{
    IEmbedderPort, ILibraryPort, InfraResult, LibraryChunk, LibraryHit, LibraryReference,
    LibrarySource,
};

/// Chunking 영역 — Phase 1 단순 영역 (~500 토큰 + 50 overlap).
/// 토큰 단위 = 단순 char 단위 (1 char ~= 1 token 가정 — 한국어는 ~1.5x 가 될 수 있음).
const CHUNK_SIZE: usize = 500;
const CHUNK_OVERLAP: usize = 50;

pub struct LibraryManager {
    library: Arc<dyn ILibraryPort>,
    embedder: Arc<dyn IEmbedderPort>,
}

impl LibraryManager {
    pub fn new(library: Arc<dyn ILibraryPort>, embedder: Arc<dyn IEmbedderPort>) -> Self {
        Self { library, embedder }
    }

    // ─── Reference CRUD ─────────────────────────────────────────────────────

    pub async fn create_reference(
        &self,
        name: &str,
        description: Option<&str>,
        owner: &str,
    ) -> InfraResult<String> {
        let id = uuid::Uuid::new_v4().to_string();
        self.library
            .create_reference(&id, name, description, owner)
            .await?;
        Ok(id)
    }

    pub async fn list_references(&self, owner: &str) -> InfraResult<Vec<LibraryReference>> {
        self.library.list_references(owner).await
    }

    pub async fn delete_reference(&self, id: &str) -> InfraResult<()> {
        self.library.delete_reference(id).await
    }

    // ─── Source upload — 텍스트 추출 후 호출 ─────────────────────

    /// Source 생성 + Chunking + Arctic 임베딩 + DB 저장 영역 통합.
    /// `extracted_text` = infra/src/library/extractor.rs 영역에서 추출된 결과 (PDF / TXT / MD / URL / text).
    /// page_numbers = PDF 영역만 의미 — TXT / URL 영역 = None.
    pub async fn upload_source(
        &self,
        reference_id: &str,
        name: &str,
        source_type: &str,
        source_url: Option<&str>,
        file_path: Option<&str>,
        extracted_text: &str,
        page_numbers: Option<&[(usize, usize, usize)]>, // (page_num, start_char, end_char)
    ) -> InfraResult<String> {
        let source_id = uuid::Uuid::new_v4().to_string();
        // 1. Source 영역 저장
        self.library
            .create_source(
                &source_id,
                reference_id,
                name,
                source_type,
                source_url,
                file_path,
                extracted_text,
            )
            .await?;

        // 2. Chunking
        let chunks = chunk_text(extracted_text, CHUNK_SIZE, CHUNK_OVERLAP);
        tracing::info!(
            category = "library",
            "라이브러리 자료 인덱싱 시작 — 자료='{}' 청크 {}개",
            name,
            chunks.len()
        );

        // 3. 매 chunk 영역 — Arctic 임베딩 + 저장
        for (idx, (content, start_char, end_char)) in chunks.iter().enumerate() {
            let chunk_id = uuid::Uuid::new_v4().to_string();
            let vec = self.embedder.embed_passage(content).await?;
            let bytes = self.embedder.vec_to_bytes(&vec);
            // PDF page 영역 매핑 — start_char 영역 포함하는 page 영역 찾기
            let page_num = page_numbers.and_then(|pages| {
                pages
                    .iter()
                    .find(|(_, s, e)| start_char >= s && start_char < e)
                    .map(|(p, _, _)| *p as i64)
            });
            self.library
                .save_chunk(
                    &chunk_id,
                    &source_id,
                    idx as i64,
                    content,
                    &bytes,
                    page_num,
                    *start_char as i64,
                    *end_char as i64,
                )
                .await?;
        }

        // 4. chunk_count 갱신
        self.library
            .update_source_chunk_count(&source_id, chunks.len() as i64)
            .await?;
        tracing::info!(
            category = "library",
            "라이브러리 자료 인덱싱 완료 — 자료='{}' 청크 {}개",
            name,
            chunks.len()
        );
        Ok(source_id)
    }

    pub async fn list_sources(&self, reference_id: &str) -> InfraResult<Vec<LibrarySource>> {
        self.library.list_sources(reference_id).await
    }

    pub async fn get_source(&self, id: &str) -> InfraResult<Option<LibrarySource>> {
        self.library.get_source(id).await
    }

    pub async fn delete_source(&self, id: &str) -> InfraResult<()> {
        self.library.delete_source(id).await
    }

    // ─── 검색 — query → cosine 매치 → top-K LibraryHit ──────────────────────

    /// 매 reference_ids 영역의 매 chunk 영역 cosine 매치 → top_k.
    /// reference_ids 미지정 (빈 배열) = 매 admin reference 전체 대상.
    pub async fn search(
        &self,
        owner: &str,
        reference_ids: &[String],
        query: &str,
        top_k: usize,
    ) -> InfraResult<Vec<LibraryHit>> {
        // reference_ids 영역 빈 영역 = 매 owner reference 영역 전체
        let target_refs: Vec<String> = if reference_ids.is_empty() {
            self.library
                .list_references(owner)
                .await?
                .into_iter()
                .map(|r| r.id)
                .collect()
        } else {
            reference_ids.to_vec()
        };
        if target_refs.is_empty() {
            return Ok(Vec::new());
        }

        // query 임베딩
        tracing::info!(
            category = "library",
            "라이브러리 검색 — query='{}' 대상 reference {}개",
            query,
            target_refs.len()
        );
        let q_vec = self.embedder.embed_query(query).await?;

        // ── 하이브리드: dense(E5 cosine) + sparse(BM25/FTS5) → RRF 융합 ──
        let chunks = self.library.list_chunks_for_search(&target_refs).await?;
        // chunk id → chunk 매핑 (최종 hit 구성용 — 메타 lookup 은 top_k 에만)
        let chunk_map: HashMap<&str, &LibraryChunk> =
            chunks.iter().map(|c| (c.id.as_str(), c)).collect();

        // dense — 모든 chunk cosine → desc 정렬 → rank. cosine 점수는 hit.score 로도 사용.
        let mut dense: Vec<(String, f32)> = chunks
            .iter()
            .filter_map(|c| {
                let emb = c.embedding.as_ref()?;
                let v = self.embedder.bytes_to_vec(emb);
                Some((c.id.clone(), self.embedder.cosine(&q_vec, &v)))
            })
            .collect();
        dense.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let cosine_score: HashMap<String, f32> = dense.iter().cloned().collect();

        // sparse — BM25 best-first chunk_id (실패/0건이면 dense 단독으로 자연 진행)
        let sparse_ids = self
            .library
            .search_chunks_bm25(&target_refs, query, top_k.saturating_mul(5).max(10))
            .await
            .unwrap_or_default();

        // RRF 융합 — score = Σ 1/(k + rank). dense·sparse 양쪽 상위면 가산되어 위로.
        const RRF_K: f32 = 60.0;
        let mut rrf: HashMap<String, f32> = HashMap::new();
        for (rank, (id, _)) in dense.iter().enumerate() {
            *rrf.entry(id.clone()).or_insert(0.0) += 1.0 / (RRF_K + rank as f32);
        }
        for (rank, id) in sparse_ids.iter().enumerate() {
            *rrf.entry(id.clone()).or_insert(0.0) += 1.0 / (RRF_K + rank as f32);
        }
        let mut ranked: Vec<(String, f32)> = rrf.into_iter().collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        ranked.truncate(top_k);

        // 최종 top_k hit 구성 — reference 목록 1회 조회 (옛 chunk 별 N+1 제거)
        let refs = self.library.list_references(owner).await?;
        let mut hits: Vec<LibraryHit> = Vec::with_capacity(ranked.len());
        for (chunk_id, _rrf) in ranked {
            let Some(chunk) = chunk_map.get(chunk_id.as_str()) else {
                continue;
            };
            let Some(source) = self.library.get_source(&chunk.source_id).await? else {
                continue;
            };
            let ref_name = refs
                .iter()
                .find(|r| r.id == source.reference_id)
                .map(|r| r.name.clone())
                .unwrap_or_default();
            // hit.score = dense cosine (0~1 직관적 의미 유사도). 정렬 순서는 RRF.
            let score = cosine_score.get(&chunk_id).copied().unwrap_or(0.0);
            hits.push(LibraryHit {
                source_id: chunk.source_id.clone(),
                source_name: source.name,
                reference_id: source.reference_id,
                reference_name: ref_name,
                chunk_id: chunk.id.clone(),
                chunk_index: chunk.chunk_index,
                content: chunk.content.clone(),
                page_number: chunk.page_number,
                score,
            });
        }
        Ok(hits)
    }
}

/// 단순 Chunking 영역 (Phase 1) — char 영역 기준 ~CHUNK_SIZE + CHUNK_OVERLAP overlap.
/// 반환값 = `[(content, start_char, end_char), ...]`.
/// 매 chunk boundary 는 자연 단어 boundary 가 아님 (Phase 2 에서 token boundary 도입 예정).
fn chunk_text(text: &str, chunk_size: usize, overlap: usize) -> Vec<(String, usize, usize)> {
    if text.is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    if total <= chunk_size {
        return vec![(text.to_string(), 0, total)];
    }
    let step = chunk_size.saturating_sub(overlap).max(1);
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < total {
        let end = (start + chunk_size).min(total);
        let content: String = chars[start..end].iter().collect();
        chunks.push((content, start, end));
        if end == total {
            break;
        }
        start += step;
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_text_short_text_single_chunk() {
        let chunks = chunk_text("hello world", 500, 50);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].0, "hello world");
        assert_eq!(chunks[0].1, 0);
        assert_eq!(chunks[0].2, 11);
    }

    #[test]
    fn chunk_text_long_text_overlap() {
        let text = "a".repeat(1100);
        let chunks = chunk_text(&text, 500, 50);
        // step = 450, total = 1100. start 영역 = 0, 450, 900. 매 영역 = 500 chars (마지막 영역 = 200 chars)
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].1, 0);
        assert_eq!(chunks[0].2, 500);
        assert_eq!(chunks[1].1, 450);
        assert_eq!(chunks[1].2, 950);
        assert_eq!(chunks[2].1, 900);
        assert_eq!(chunks[2].2, 1100);
    }

    #[test]
    fn chunk_text_empty() {
        let chunks = chunk_text("", 500, 50);
        assert_eq!(chunks.len(), 0);
    }

    #[test]
    fn chunk_text_korean() {
        let text: String = "가".repeat(1000);
        let chunks = chunk_text(&text, 500, 50);
        // step = 450, total = 1000. start 영역 = 0, 450, 900. 매 영역 = 500 chars (마지막 영역 = 100 chars)
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].2 - chunks[0].1, 500);
    }
}
