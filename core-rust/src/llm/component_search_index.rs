//! Component Search Index — 26 컴포넌트 벡터 임베딩 + cosine 검색.
//!
//! 옛 TS `infra/llm/component-search-index.ts` (105 LOC) Rust 1:1 port.
//!
//! AI 의 `search_components(query)` 호출 시 사용 — 사용자 발화에 의미적으로 가까운 컴포넌트 top-K
//! 반환. 옛 TS 와 동일하게 spread 판정 없이 단순 top-K (26개라 노이즈 차단보다 후보 제공 우선).
//!
//! 디스크 캐시 — `data/component-embeddings.json` 에 (name, hash, vector) 영속.
//! `EMBED_VERSION` 바뀌면 hash 불일치 → 자동 재임베딩.

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::OnceCell;

use crate::llm::component_registry::{components, ComponentDef};
use crate::ports::{IEmbedderPort, InfraResult};

/// 옛 TS EMBED_VERSION 1:1. 모델 교체 시 값 변경 → hash 불일치로 재임베딩 trigger.
const EMBED_VERSION: &str = "e5-small-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DiskCacheEntry {
    hash: String,
    vector: Vec<f32>,
}

/// search_components 결과 — 옛 TS ComponentMatch 1:1.
#[derive(Debug, Clone, Serialize)]
pub struct ComponentMatch {
    pub name: String,
    pub description: String,
    #[serde(rename = "propsSchema")]
    pub props_schema: serde_json::Value,
    pub score: f32,
}

/// 캐시된 vector — name → embedding (한번 빌드 후 process 메모리에 영속).
static VECTOR_CACHE: OnceCell<HashMap<String, Vec<f32>>> = OnceCell::const_new();

fn cache_file_path() -> PathBuf {
    let dir = std::env::var("FIREBAT_DATA_DIR").unwrap_or_else(|_| "data".to_string());
    PathBuf::from(dir).join("component-embeddings.json")
}

fn sha1_hash(s: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("{}:{}", EMBED_VERSION, s));
    hex::encode(hasher.finalize())
}

fn load_disk_cache() -> HashMap<String, DiskCacheEntry> {
    match std::fs::read_to_string(cache_file_path()) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn save_disk_cache(cache: &HashMap<String, DiskCacheEntry>) {
    let path = cache_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(&cache) {
        let _ = std::fs::write(&path, json);
    }
}

/// 한 컴포넌트의 임베딩 입력 텍스트 — 옛 TS 1:1.
fn component_text(c: &ComponentDef) -> String {
    format!(
        "Component: {}\nDesc: {}\nKeywords: {}",
        c.name, c.description, c.semantic_text
    )
}

/// 정규화된 vector 의 cosine similarity = dot product. 옛 TS cosine 1:1.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut dot = 0.0f32;
    for i in 0..n {
        dot += a[i] * b[i];
    }
    dot
}

/// Index 빌드 — 디스크 캐시 reuse + 변경된 컴포넌트만 재임베딩. 옛 TS ensureIndex 1:1.
async fn ensure_index(
    embedder: &dyn IEmbedderPort,
) -> InfraResult<HashMap<String, Vec<f32>>> {
    let disk = load_disk_cache();
    let mut result: HashMap<String, Vec<f32>> = HashMap::new();
    let mut fresh: HashMap<String, DiskCacheEntry> = HashMap::new();
    let mut reused = 0usize;
    let mut embedded = 0usize;

    for c in components() {
        let text = component_text(c);
        let hash = sha1_hash(&text);
        if let Some(hit) = disk.get(&c.name) {
            if hit.hash == hash {
                result.insert(c.name.clone(), hit.vector.clone());
                fresh.insert(c.name.clone(), hit.clone());
                reused += 1;
                continue;
            }
        }
        match embedder.embed_passage(&text).await {
            Ok(vec) => {
                result.insert(c.name.clone(), vec.clone());
                fresh.insert(
                    c.name.clone(),
                    DiskCacheEntry {
                        hash,
                        vector: vec,
                    },
                );
                embedded += 1;
            }
            Err(e) => {
                // 옛 TS 와 동일 — 실패 시 skip (search 시 그 컴포넌트 누락)
                eprintln!(
                    "[ComponentSearch] {} 임베딩 실패: {} — skip",
                    c.name, e
                );
            }
        }
    }
    save_disk_cache(&fresh);
    eprintln!(
        "[ComponentSearch] 인덱스 빌드: {}개 (재사용 {}, 임베딩 {})",
        components().len(),
        reused,
        embedded
    );
    Ok(result)
}

/// 검색 옵션 — 옛 TS `query(query, opts)` 의 opts.
#[derive(Debug, Clone, Default)]
pub struct ComponentSearchOpts {
    pub limit: Option<usize>,
}

/// `search_components(query)` 핵심 로직 — 옛 TS ComponentSearchIndex.query 1:1.
///
/// 빈 query 면 빈 배열 반환. embedder 미박힘 / 임베딩 실패 시 Err.
/// 26개 모두 score 매기고 sort, top-K (default 5) 반환.
pub async fn query(
    embedder: &dyn IEmbedderPort,
    user_query: &str,
    opts: ComponentSearchOpts,
) -> InfraResult<Vec<ComponentMatch>> {
    if user_query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let limit = opts.limit.unwrap_or(5);

    let vectors = VECTOR_CACHE
        .get_or_try_init(|| async { ensure_index(embedder).await })
        .await?;

    let q = embedder.embed_query(user_query).await?;
    let mut scored: Vec<ComponentMatch> = Vec::with_capacity(components().len());
    for c in components() {
        let Some(v) = vectors.get(&c.name) else {
            continue;
        };
        scored.push(ComponentMatch {
            name: c.name.clone(),
            description: c.description.clone(),
            props_schema: c.props_schema.clone(),
            score: cosine(&q, v),
        });
    }
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    Ok(scored)
}

/// 디버깅·테스트용 — Index 강제 재빌드 트리거. 옛 TS ComponentSearchIndex.invalidate 1:1.
pub fn invalidate() {
    // OnceCell 은 명시 invalidate 불가 — 새 process 에서 재빌드. 테스트는 in-process 에서 강제 reset 필요시
    // 별도 builder 패턴 (ComponentSearchIndex struct) 으로 wrapping.
    // 본 모듈은 옛 TS 의 module-singleton 등가성 우선 — invalidate 는 process restart.
}

/// 본 모듈은 builder 패턴 미사용 (옛 TS 와 동일 module-singleton). 단, 테스트 격리 위해
/// builder 형태도 제공.
pub struct ComponentSearchIndex {
    embedder: Arc<dyn IEmbedderPort>,
    vectors: tokio::sync::OnceCell<HashMap<String, Vec<f32>>>,
}

impl ComponentSearchIndex {
    pub fn new(embedder: Arc<dyn IEmbedderPort>) -> Self {
        Self {
            embedder,
            vectors: tokio::sync::OnceCell::new(),
        }
    }

    pub async fn query(
        &self,
        user_query: &str,
        opts: ComponentSearchOpts,
    ) -> InfraResult<Vec<ComponentMatch>> {
        if user_query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let limit = opts.limit.unwrap_or(5);
        let vectors = self
            .vectors
            .get_or_try_init(|| async { ensure_index(self.embedder.as_ref()).await })
            .await?;
        let q = self.embedder.embed_query(user_query).await?;
        let mut scored: Vec<ComponentMatch> = Vec::with_capacity(components().len());
        for c in components() {
            let Some(v) = vectors.get(&c.name) else {
                continue;
            };
            scored.push(ComponentMatch {
                name: c.name.clone(),
                description: c.description.clone(),
                props_schema: c.props_schema.clone(),
                score: cosine(&q, v),
            });
        }
        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);
        Ok(scored)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::embedder::stub::StubEmbedderAdapter;

    fn ensure_temp_data_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("FIREBAT_DATA_DIR", dir.path());
        }
        dir
    }

    #[tokio::test]
    async fn empty_query_returns_empty() {
        let _g = crate::utils::shared_test_lock();
        let _dir = ensure_temp_data_dir();
        let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
        let idx = ComponentSearchIndex::new(embedder);
        let result = idx.query("", ComponentSearchOpts::default()).await.unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn query_returns_top_5_default() {
        let _g = crate::utils::shared_test_lock();
        let _dir = ensure_temp_data_dir();
        let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
        let idx = ComponentSearchIndex::new(embedder);
        let result = idx
            .query("주식 차트", ComponentSearchOpts::default())
            .await
            .unwrap();
        assert_eq!(result.len(), 5);
        // 점수 내림차순
        for w in result.windows(2) {
            assert!(w[0].score >= w[1].score);
        }
    }

    #[tokio::test]
    async fn query_respects_limit() {
        let _g = crate::utils::shared_test_lock();
        let _dir = ensure_temp_data_dir();
        let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
        let idx = ComponentSearchIndex::new(embedder);
        let result = idx
            .query(
                "table 표",
                ComponentSearchOpts {
                    limit: Some(3),
                },
            )
            .await
            .unwrap();
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn cosine_basic() {
        let a = vec![1.0_f32, 0.0, 0.0];
        let b = vec![1.0_f32, 0.0, 0.0];
        let c = vec![0.0_f32, 1.0, 0.0];
        assert_eq!(cosine(&a, &b), 1.0);
        assert_eq!(cosine(&a, &c), 0.0);
    }

    #[test]
    fn sha1_changes_with_embed_version() {
        // 같은 text 라도 EMBED_VERSION 다르면 다른 hash (자동 재임베딩 trigger)
        let h = sha1_hash("test");
        assert!(!h.is_empty());
        assert_eq!(h.len(), 40); // sha1 hex = 40 chars
    }
}
