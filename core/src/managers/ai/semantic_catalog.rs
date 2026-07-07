//! SemanticCatalog — shared semantic discovery engine (progressive disclosure, #search-tool).
//!
//! Generalizes the `component_search_index` machinery: a catalog is a list of
//! `CatalogEntry { id, name, description, extra }`; the engine embeds each entry once
//! (E5, sha1 hash disk cache keyed by the entry text — unchanged entries never re-embed),
//! and `query()` returns cosine top-K. First consumer = the module action catalog (S2:
//! `search_module_actions` over korea-invest 275 / kiwoom 200+ cryptic action IDs). The
//! component/template/skill indexes can converge onto this engine incrementally — the
//! existing `component_search_index` is left as-is for now (no rewrite churn).
//!
//! Design mirror of `component_search_index.rs`, with two generalizations:
//! - entries are dynamic (`set_entries` replaces the set; hash cache makes it incremental),
//! - `id` is the stable key (e.g. `"kiwoom:ka10081"`), so an id prefix doubles as a cheap
//!   scope filter (per-module search) without a filter-closure API.

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::ports::{IEmbedderCachePort, IEmbedderPort, InfraResult};

/// Bump on embedder swap — hash mismatch triggers automatic re-embedding.
const EMBED_VERSION: &str = "e5-small-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DiskCacheEntry {
    hash: String,
    vector: Vec<f32>,
}

/// One discoverable item. `description` is the semantic text (what the embedding sees,
/// together with `name`); `extra` is an opaque payload returned with matches (params,
/// approval flags, envelope hints — whatever the consumer needs downstream).
#[derive(Debug, Clone)]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub extra: serde_json::Value,
}

/// Search hit — entry + cosine score.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogMatch {
    pub id: String,
    pub name: String,
    pub description: String,
    pub extra: serde_json::Value,
    pub score: f32,
}

struct CatalogState {
    entries: Vec<CatalogEntry>,
    vectors: HashMap<String, Vec<f32>>,
}

pub struct SemanticCatalog {
    /// Disk cache filename — `{stem}-embeddings.json` under the embedder cache dir.
    cache_file: String,
    embedder: Arc<dyn IEmbedderPort>,
    cache_port: Arc<dyn IEmbedderCachePort>,
    state: RwLock<CatalogState>,
}

fn sha1_hash(s: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("{}:{}", EMBED_VERSION, s));
    hex::encode(hasher.finalize())
}

fn entry_text(e: &CatalogEntry) -> String {
    format!("Name: {}\nDesc: {}", e.name, e.description)
}

/// Normalized-vector cosine = dot product (component_search_index mirror).
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut dot = 0.0f32;
    for i in 0..n {
        dot += a[i] * b[i];
    }
    dot
}

impl SemanticCatalog {
    pub fn new(
        cache_file_stem: &str,
        embedder: Arc<dyn IEmbedderPort>,
        cache_port: Arc<dyn IEmbedderCachePort>,
    ) -> Self {
        Self {
            cache_file: format!("{}-embeddings.json", cache_file_stem),
            embedder,
            cache_port,
            state: RwLock::new(CatalogState { entries: Vec::new(), vectors: HashMap::new() }),
        }
    }

    /// Replace the entry set, embedding incrementally: unchanged (id, text-hash) pairs reuse
    /// the disk-cached vector, only new/changed entries hit the embedder. Failed embeddings
    /// skip that entry (it just won't match) — mirror of component index behavior.
    pub async fn set_entries(&self, entries: Vec<CatalogEntry>) {
        let disk: HashMap<String, DiskCacheEntry> = self
            .cache_port
            .load(&self.cache_file)
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let mut vectors: HashMap<String, Vec<f32>> = HashMap::new();
        let mut fresh: HashMap<String, DiskCacheEntry> = HashMap::new();
        let mut embedded = 0usize;
        for e in &entries {
            let text = entry_text(e);
            let hash = sha1_hash(&text);
            if let Some(hit) = disk.get(&e.id) {
                if hit.hash == hash {
                    vectors.insert(e.id.clone(), hit.vector.clone());
                    fresh.insert(e.id.clone(), hit.clone());
                    continue;
                }
            }
            match self.embedder.embed_passage(&text).await {
                Ok(vec) => {
                    vectors.insert(e.id.clone(), vec.clone());
                    fresh.insert(e.id.clone(), DiskCacheEntry { hash, vector: vec });
                    embedded += 1;
                }
                Err(err) => {
                    tracing::warn!(
                        target: "semantic_catalog",
                        "embed failed for {} ({}): {} — skipped",
                        e.id,
                        self.cache_file,
                        err
                    );
                }
            }
        }
        if let Ok(json) = serde_json::to_string(&fresh) {
            self.cache_port.save(&self.cache_file, &json);
        }
        tracing::info!(
            target: "semantic_catalog",
            "catalog {} built — {} entries ({} embedded, {} reused)",
            self.cache_file,
            entries.len(),
            embedded,
            entries.len() - embedded
        );
        let mut state = self.state.write().await;
        *state = CatalogState { entries, vectors };
    }

    pub async fn len(&self) -> usize {
        self.state.read().await.entries.len()
    }

    /// Hybrid top-K over the catalog: cosine + lexical boost. `scopes` = allowed id-prefix set
    /// (owner scoping / per-module filter); None = everything.
    ///
    /// Lexical boost fixes the pure-dense hole where an EXACT id/name query ("ka10081") carries
    /// weak embedding signal and can miss top-K: exact id/name equality pins the entry to the top
    /// (+0.5), and substring containment between query and id/name (either direction, len ≥ 2)
    /// gets a small nudge (+0.15). Mirrors the dense+sparse idea of search_library, sized for
    /// short catalog names (no BM25 needed).
    pub async fn query(
        &self,
        user_query: &str,
        limit: usize,
        scopes: Option<&[String]>,
    ) -> InfraResult<Vec<CatalogMatch>> {
        if user_query.trim().is_empty() {
            return Ok(Vec::new());
        }
        if let Some(s) = scopes {
            if s.is_empty() {
                return Ok(Vec::new());
            }
        }
        let q = self.embedder.embed_query(user_query).await?;
        let q_lower = user_query.trim().to_lowercase();
        let state = self.state.read().await;
        let mut scored: Vec<CatalogMatch> = Vec::new();
        for e in &state.entries {
            if let Some(allowed) = scopes {
                if !allowed.iter().any(|p| e.id.starts_with(p.as_str())) {
                    continue;
                }
            }
            let Some(v) = state.vectors.get(&e.id) else { continue };
            let mut score = cosine(&q, v);
            // lexical boost — id is "{scope}:{key}"; match on the key part + the name.
            let key = e.id.rsplit(':').next().unwrap_or(&e.id).to_lowercase();
            let name_lower = e.name.to_lowercase();
            if key == q_lower || name_lower == q_lower {
                score += 0.5;
            } else if q_lower.len() >= 2
                && (q_lower.contains(&key)
                    || key.contains(&q_lower)
                    || name_lower.contains(&q_lower)
                    || (name_lower.len() >= 2 && q_lower.contains(&name_lower)))
            {
                score += 0.15;
            }
            scored.push(CatalogMatch {
                id: e.id.clone(),
                name: e.name.clone(),
                description: e.description.clone(),
                extra: e.extra.clone(),
                score,
            });
        }
        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);
        Ok(scored)
    }

    /// Exact lookup by id — the "detail" step after a search hit.
    pub async fn get(&self, id: &str) -> Option<CatalogEntry> {
        self.state
            .read()
            .await
            .entries
            .iter()
            .find(|e| e.id == id)
            .cloned()
    }

    /// Any entry under this id prefix? — cheap scope-existence check (error-hint branching).
    pub async fn get_first_with_prefix(&self, prefix: &str) -> bool {
        self.state
            .read()
            .await
            .entries
            .iter()
            .any(|e| e.id.starts_with(prefix))
    }
}

/// A catalog data source — enumerates the current entries (e.g. skills on disk, module
/// action declarations). Consumed by `RefreshingCatalog` on TTL rebuild.
#[async_trait::async_trait]
pub trait CatalogSource: Send + Sync {
    async fn load(&self) -> Vec<CatalogEntry>;
}

/// SemanticCatalog + a TTL-gated source rebuild — the standard shape for dynamic domains
/// (skills/templates/pages/media/module-actions). Rebuild re-reads the source but only
/// re-embeds entries whose text changed (sha1 disk cache), so a 5-min TTL is nearly free.
pub struct RefreshingCatalog {
    catalog: SemanticCatalog,
    source: Arc<dyn CatalogSource>,
    ttl: std::time::Duration,
    built_at: tokio::sync::Mutex<Option<std::time::Instant>>,
}

impl RefreshingCatalog {
    pub fn new(
        cache_file_stem: &str,
        embedder: Arc<dyn IEmbedderPort>,
        cache_port: Arc<dyn IEmbedderCachePort>,
        source: Arc<dyn CatalogSource>,
        ttl: std::time::Duration,
    ) -> Self {
        Self {
            catalog: SemanticCatalog::new(cache_file_stem, embedder, cache_port),
            source,
            ttl,
            built_at: tokio::sync::Mutex::new(None),
        }
    }

    async fn ensure(&self) {
        {
            let built = self.built_at.lock().await;
            if let Some(t) = *built {
                if t.elapsed() < self.ttl {
                    return;
                }
            }
        }
        let entries = self.source.load().await;
        self.catalog.set_entries(entries).await;
        *self.built_at.lock().await = Some(std::time::Instant::now());
    }

    pub async fn query(
        &self,
        user_query: &str,
        limit: usize,
        scopes: Option<&[String]>,
    ) -> InfraResult<Vec<CatalogMatch>> {
        self.ensure().await;
        self.catalog.query(user_query, limit, scopes).await
    }

    pub async fn get(&self, id: &str) -> Option<CatalogEntry> {
        self.ensure().await;
        self.catalog.get(id).await
    }

    pub async fn has_prefix(&self, prefix: &str) -> bool {
        self.ensure().await;
        self.catalog.get_first_with_prefix(prefix).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_basic() {
        let a = vec![1.0_f32, 0.0];
        let b = vec![0.0_f32, 1.0];
        assert_eq!(cosine(&a, &a), 1.0);
        assert_eq!(cosine(&a, &b), 0.0);
    }

    #[test]
    fn hash_stable_and_versioned() {
        let e = CatalogEntry {
            id: "m:a".into(),
            name: "일봉차트".into(),
            description: "주식 일봉".into(),
            extra: serde_json::json!({}),
        };
        let h1 = sha1_hash(&entry_text(&e));
        let h2 = sha1_hash(&entry_text(&e));
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 40);
    }
}
