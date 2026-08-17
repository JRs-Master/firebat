//! Component Search Index — semantic search over the render catalog (`search_components`). The
//! count lives in components.json; a number written here is a number that goes stale.
//!
//! 2026-07-07 #search-tool 수렴: 자체 임베딩/캐시/cosine 기계를 걷어내고 **S1 공용 엔진**
//! (`semantic_catalog::SemanticCatalog`) 위에 얹었다 — 엔진 하나에 카탈로그 N (components /
//! module-actions / skills / templates / pages / media). 이로써 lexical 부스트(정확 이름 질의
//! 보장) 등 엔진 개선을 자동 상속. 디스크 캐시 파일(`component-embeddings.json`)과 포맷은
//! 옛 구현과 호환(id=name, {hash, vector}) — 마이그레이션 재임베딩 0.
//!
//! 2026-07-16: search results are trigger rows only (no propsSchema) — the schema moved to the
//! `get_component_schema` step so components follow the same search→get ladder as every other
//! discovery surface (module actions / skills / templates).

use serde::Serialize;
use std::sync::Arc;
use tokio::sync::{Mutex, OnceCell};

use crate::managers::ai::component_registry::{components, fingerprint, ComponentDef};
use crate::managers::ai::semantic_catalog::{CatalogEntry, SemanticCatalog};
use crate::ports::{IEmbedderCachePort, IEmbedderPort, InfraResult};

/// search_components 결과 — trigger row only (name + purpose + score). The props schema is
/// deliberately NOT included: discovery surfaces return triggers, action material comes from a
/// get step (`get_component_schema`) — the same search→get ladder as module actions / skills /
/// templates. Fusing the schema into search results was the one deviation from that uniform
/// procedure (2026-07-16 정리).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentMatch {
    pub name: String,
    pub description: String,
    pub score: f32,
}

/// 검색 옵션 — 옛 TS `query(query, opts)` 의 opts.
#[derive(Debug, Clone, Default)]
pub struct ComponentSearchOpts {
    pub limit: Option<usize>,
}

fn component_entries() -> Vec<CatalogEntry> {
    components()
        .iter()
        .map(|c: &ComponentDef| CatalogEntry {
            // id = 컴포넌트 name (콜론 스코프 없음 — 전역 카탈로그). description(임베딩 텍스트) =
            // 설명 + semantic 키워드(ko/en) — 표시용 설명은 extra 로 분리(출력 shape 불변).
            id: c.name.clone(),
            name: c.name.clone(),
            description: format!("{} {}", c.description, c.semantic_text),
            extra: serde_json::json!({
                "displayDescription": c.description,
            }),
                    vocab: Vec::new(),
        })
        .collect()
}

pub struct ComponentSearchIndex {
    catalog: SemanticCatalog,
    /// Catalog fingerprint the entries were built from — `None` until the first query. The index
    /// follows the declaration file: a new row lands in search the moment the file changes, and
    /// the semantic-catalog hash cache means only changed entries re-embed (E5, local).
    built_fp: Mutex<Option<String>>,
}

impl ComponentSearchIndex {
    pub fn new(embedder: Arc<dyn IEmbedderPort>, cache_port: Arc<dyn IEmbedderCachePort>) -> Self {
        Self {
            catalog: SemanticCatalog::new("component", embedder, cache_port),
            built_fp: Mutex::new(None),
        }
    }

    /// Dual-embed passthrough — see `SemanticCatalog::with_secondary` (폴백 + 섀도우 A/B 로그).
    pub fn with_secondary(mut self, secondary: Arc<dyn IEmbedderPort>) -> Self {
        self.catalog = self.catalog.with_secondary(secondary);
        self
    }

    pub async fn query(
        &self,
        user_query: &str,
        opts: ComponentSearchOpts,
    ) -> InfraResult<Vec<ComponentMatch>> {
        if user_query.trim().is_empty() {
            return Ok(Vec::new());
        }
        // Rebuild when the declaration file's fingerprint moves — the lock is held across the
        // rebuild so concurrent queries wait for one build instead of racing three.
        {
            let mut built = self.built_fp.lock().await;
            let fp = fingerprint();
            if built.as_deref() != Some(fp.as_str()) {
                self.catalog.set_entries(component_entries()).await;
                *built = Some(fp);
            }
        }
        let limit = opts.limit.unwrap_or(5);
        let hits = self.catalog.query(user_query, limit, None).await?;
        Ok(hits
            .into_iter()
            .map(|m| ComponentMatch {
                name: m.name,
                description: m
                    .extra
                    .get("displayDescription")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&m.description)
                    .to_string(),
                score: m.score,
            })
            .collect())
    }
}

/// 프로세스 전역 인덱스로 조회 — `search_components` 도구 핸들러 경로 (옛 free-fn API 유지).
static GLOBAL: OnceCell<ComponentSearchIndex> = OnceCell::const_new();

pub async fn query(
    embedder: Arc<dyn IEmbedderPort>,
    cache_port: Arc<dyn IEmbedderCachePort>,
    secondary: Option<Arc<dyn IEmbedderPort>>,
    user_query: &str,
    opts: ComponentSearchOpts,
) -> InfraResult<Vec<ComponentMatch>> {
    let idx = GLOBAL
        .get_or_init(|| async {
            let mut c = ComponentSearchIndex::new(embedder.clone(), cache_port.clone());
            if let Some(s) = secondary.clone() {
                c = c.with_secondary(s);
            }
            c
        })
        .await;
    idx.query(user_query, opts).await
}
