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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DiskCacheEntry {
    hash: String,
    vector: Vec<f32>,
    /// Secondary (local fallback) slot — dual-embed when a remote primary is configured.
    /// serde-default so pre-dual cache files deserialize as None → only the secondary gets
    /// backfilled (local = free), the primary vectors are reused untouched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secondary_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secondary: Option<Vec<f32>>,
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
    /// Secondary (local fallback) vector space — populated only when a secondary embedder is
    /// configured. NEVER mixed with `vectors`: a fallback query switches to this set wholesale
    /// (different dimensions/space — per-call mixing would be garbage matching).
    secondary_vectors: HashMap<String, Vec<f32>>,
    /// Lowercased concat of all entry texts — the vocabulary check for OOV query cleaning
    /// (see `clean_query`). Rebuilt with the entries; substring lookups are memchr-fast.
    corpus: String,
}

/// `query_analyzed` outcome — matches + what the OOV cleaner did to the query.
/// `all_oov` = every token was out-of-vocabulary (e.g. a bare subject name like a company):
/// the query carries zero catalog signal, so no embedding search ran — callers should
/// surface a teaching hint ("describe the capability; resolve names via a lookup action")
/// instead of returning confident junk (2026-07-12 실측: 잡탕 top-5 가 결과처럼 보여
/// 모델이 변형 재검색으로 캡을 태우는 죽음 나선의 입구였다).
pub struct CatalogQueryOutcome {
    pub matches: Vec<CatalogMatch>,
    /// Tokens dropped as OOV (absent from every entry text, even after suffix trim).
    pub dropped_tokens: Vec<String>,
    pub all_oov: bool,
}

/// Drop query tokens that appear in NO catalog entry text — they cannot contribute any
/// match signal (nothing contains them) and only pull the query embedding toward junk
/// (실측: "LG에너지솔루션" 이 섞이면 ELW 잡탕이 뜸 → 제거 시 정답 1위). Generic — no NER,
/// no name lists: the catalog's own vocabulary is the filter. Korean particles are
/// tolerated by a 1–2 char suffix trim before declaring a token OOV ("차트랑" → "차트").
fn clean_query(user_query: &str, corpus: &str) -> (String, Vec<String>) {
    let mut kept: Vec<&str> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();
    for tok in user_query.split_whitespace() {
        let lower = tok.to_lowercase();
        let mut found = corpus.contains(&lower);
        if !found {
            // suffix trim (조사 tolerance) — drop up to 2 trailing chars, keep ≥ 2 chars.
            let chars: Vec<char> = lower.chars().collect();
            for cut in 1..=2usize {
                if chars.len() < cut + 2 {
                    break;
                }
                let trimmed: String = chars[..chars.len() - cut].iter().collect();
                if corpus.contains(&trimmed) {
                    found = true;
                    break;
                }
            }
        }
        if found {
            kept.push(tok);
        } else {
            dropped.push(tok.to_string());
        }
    }
    (kept.join(" "), dropped)
}

pub struct SemanticCatalog {
    /// Disk cache filename — `{stem}-embeddings.json` under the embedder cache dir.
    cache_file: String,
    embedder: Arc<dyn IEmbedderPort>,
    /// Local fallback embedder (dual-embed) — when the primary is a remote API, entries are
    /// ALSO embedded locally (free) so a primary outage degrades to a full-quality local
    /// search instead of an error or mixed-space garbage.
    secondary: Option<Arc<dyn IEmbedderPort>>,
    /// Primary-outage cooldown (epoch ms) — after a query-embed failure the fallback set is
    /// used directly for 60s, avoiding a chain of remote timeouts on every search.
    primary_down_until: std::sync::atomic::AtomicI64,
    cache_port: Arc<dyn IEmbedderCachePort>,
    /// Arc — the background shadow-compare task re-reads the state after its (possibly remote)
    /// query embed finishes, without cloning vector maps per query.
    state: Arc<RwLock<CatalogState>>,
}

/// Hash keyed by the EMBEDDER's version (IEmbedderPort::version) — swapping the embedder
/// (e5 ↔ upstage-solar-embed-2) changes every hash, so the disk cache re-embeds
/// automatically instead of mixing vector spaces.
fn sha1_hash(version: &str, s: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("{}:{}", version, s));
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
            secondary: None,
            primary_down_until: std::sync::atomic::AtomicI64::new(0),
            cache_port,
            state: Arc::new(RwLock::new(CatalogState {
                entries: Vec::new(),
                vectors: HashMap::new(),
                secondary_vectors: HashMap::new(),
                corpus: String::new(),
            })),
        }
    }

    /// Configure the local fallback embedder (dual-embed). No-op semantics when absent —
    /// single-embedder catalogs behave exactly as before.
    pub fn with_secondary(mut self, secondary: Arc<dyn IEmbedderPort>) -> Self {
        self.secondary = Some(secondary);
        self
    }

    /// Replace the entry set, embedding incrementally: unchanged (id, text-hash) pairs reuse
    /// the disk-cached vector, only new/changed entries hit the embedder (bounded-concurrent —
    /// an API embedder's first full build of ~600 entries would take minutes serially).
    /// With a secondary embedder configured, entries are dual-embedded (per-slot hashes —
    /// swapping one embedder never burns the other slot's cache). Failed embeddings skip
    /// that entry in that slot (it just won't match there).
    pub async fn set_entries(&self, entries: Vec<CatalogEntry>) {
        let disk: HashMap<String, DiskCacheEntry> = self
            .cache_port
            .load(&self.cache_file)
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let version = self.embedder.version().to_string();
        let sec_version = self.secondary.as_ref().map(|s| s.version().to_string());
        let mut vectors: HashMap<String, Vec<f32>> = HashMap::new();
        let mut secondary_vectors: HashMap<String, Vec<f32>> = HashMap::new();
        // id → (primary_hash, sec_hash) — fresh 재구성용 (임베딩 패스 뒤 한 번에 조립).
        let mut hashes: HashMap<String, (String, Option<String>)> = HashMap::new();
        let mut prim_needed: Vec<(String, String)> = Vec::new(); // (id, text)
        let mut sec_needed: Vec<(String, String)> = Vec::new();
        for e in &entries {
            let text = entry_text(e);
            let hash = sha1_hash(&version, &text);
            let sec_hash = sec_version.as_deref().map(|v| sha1_hash(v, &text));
            let hit = disk.get(&e.id);
            if hit.map(|h| h.hash == hash).unwrap_or(false) {
                vectors.insert(e.id.clone(), hit.unwrap().vector.clone());
            } else {
                prim_needed.push((e.id.clone(), text.clone()));
            }
            let secondary_ok = match (&sec_hash, hit) {
                (Some(sh), Some(h)) => {
                    if h.secondary_hash.as_deref() == Some(sh.as_str()) {
                        if let Some(v) = &h.secondary {
                            secondary_vectors.insert(e.id.clone(), v.clone());
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                }
                (None, _) => true, // no secondary configured — nothing to do
                _ => false,
            };
            if !secondary_ok {
                sec_needed.push((e.id.clone(), text.clone()));
            }
            hashes.insert(e.id.clone(), (hash, sec_hash));
        }
        let embedded = prim_needed.len();
        let sec_backfill = sec_needed.len();
        // ── primary — bounded concurrent (로컬 임베더 전제, per-entry) ──
        let sem = Arc::new(tokio::sync::Semaphore::new(8));
        let mut tasks = tokio::task::JoinSet::new();
        for (id, text) in prim_needed {
            let emb = self.embedder.clone();
            let sem = sem.clone();
            tasks.spawn(async move {
                let _permit = sem.acquire().await;
                (id, emb.embed_passage(&text).await)
            });
        }
        while let Some(res) = tasks.join_next().await {
            let Ok((id, primary)) = res else { continue };
            match primary {
                Ok(vec) => {
                    vectors.insert(id, vec);
                }
                Err(err) => {
                    tracing::warn!(
                        target: "semantic_catalog",
                        "embed failed for {} ({}): {} — skipped",
                        id,
                        self.cache_file,
                        err
                    );
                }
            }
        }
        // ── secondary — 원격 API 전제라 **배치**(embed_passages, 어댑터가 64개/콜 청크) ──
        // 옛 per-entry 개별 호출 = 재빌드마다 수백 콜 → 429 폭풍 + secondary 미영속이라
        // 매 재빌드 전량 재시도(2026-07-13 실측 2,139콜/일). 실패 = 이번 빌드 slot skip
        // (다음 재빌드로 이월 — 어댑터 쿨다운이 그 사이 호출을 HTTP 없이 끊음).
        if let Some(sec) = &self.secondary {
            if !sec_needed.is_empty() {
                let texts: Vec<String> = sec_needed.iter().map(|(_, t)| t.clone()).collect();
                match sec.embed_passages(&texts).await {
                    Ok(vecs) => {
                        for ((id, _), v) in sec_needed.iter().zip(vecs) {
                            secondary_vectors.insert(id.clone(), v);
                        }
                    }
                    Err(err) => {
                        tracing::warn!(
                            target: "semantic_catalog",
                            "secondary batch embed failed ({}, {} entries): {} — slot skipped this build",
                            self.cache_file,
                            sec_needed.len(),
                            err
                        );
                    }
                }
            }
        }
        // ── fresh 재구성 — primary 벡터가 있는 엔트리만 영속(기존 불변식). secondary 는 이번에
        //    확보된 것만 실림 → 다음 재빌드가 나머지를 이어서 백필. ──
        let mut fresh: HashMap<String, DiskCacheEntry> = HashMap::new();
        for e in &entries {
            let Some(v) = vectors.get(&e.id) else { continue };
            let (hash, sec_hash) = hashes.get(&e.id).cloned().unwrap_or_default();
            fresh.insert(
                e.id.clone(),
                DiskCacheEntry {
                    hash,
                    vector: v.clone(),
                    secondary_hash: sec_hash,
                    secondary: secondary_vectors.get(&e.id).cloned(),
                },
            );
        }
        if let Ok(json) = serde_json::to_string(&fresh) {
            self.cache_port.save(&self.cache_file, &json);
        }
        tracing::info!(
            target: "semantic_catalog",
            "catalog {} built — {} entries ({} embedded, {} reused{})",
            self.cache_file,
            entries.len(),
            embedded,
            entries.len() - embedded,
            if self.secondary.is_some() {
                format!(", dual-embed (secondary backfill {sec_backfill})")
            } else {
                String::new()
            }
        );
        let mut corpus = String::new();
        for e in &entries {
            corpus.push_str(&entry_text(e).to_lowercase());
            corpus.push('\n');
        }
        let mut state = self.state.write().await;
        *state = CatalogState { entries, vectors, secondary_vectors, corpus };
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
        Ok(self.query_analyzed(user_query, limit, scopes).await?.matches)
    }

    /// `query` + OOV analysis. The embedding input is the OOV-cleaned query (tokens absent
    /// from every entry text are dropped — they only pollute the vector); the lexical boost
    /// still runs on the ORIGINAL query so exact-id hits ("ka10081") keep their pin.
    pub async fn query_analyzed(
        &self,
        user_query: &str,
        limit: usize,
        scopes: Option<&[String]>,
    ) -> InfraResult<CatalogQueryOutcome> {
        let empty = |all_oov: bool, dropped: Vec<String>| CatalogQueryOutcome {
            matches: Vec::new(),
            dropped_tokens: dropped,
            all_oov,
        };
        if user_query.trim().is_empty() {
            return Ok(empty(false, Vec::new()));
        }
        if let Some(s) = scopes {
            if s.is_empty() {
                return Ok(empty(false, Vec::new()));
            }
        }
        let state = self.state.read().await;
        if state.entries.is_empty() {
            return Ok(empty(false, Vec::new()));
        }
        let (cleaned, dropped) = clean_query(user_query, &state.corpus);
        if cleaned.is_empty() && !dropped.is_empty() {
            // Every token is OOV — a bare subject name ("<회사명>") or pure chitchat.
            // No embedding search: any top-K would be confident junk.
            return Ok(empty(true, dropped));
        }
        let embed_input: &str = if dropped.is_empty() {
            user_query.trim()
        } else {
            tracing::info!(
                target: "semantic_catalog",
                "OOV tokens dropped from query ({}): {:?} — searching with \"{}\"",
                self.cache_file,
                dropped,
                cleaned
            );
            &cleaned
        };
        // Primary query embed with local fallback — on failure (or during the 60s outage
        // cooldown) the WHOLE match switches to the secondary vector set: spaces are never
        // mixed (remote 1024-dim vs local 384-dim → per-call mixing = garbage matching).
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let primary_cooling = self.primary_down_until.load(std::sync::atomic::Ordering::Relaxed) > now_ms;
        let (q, use_secondary) = if self.secondary.is_some() && primary_cooling {
            let sec = self.secondary.as_ref().unwrap();
            (sec.embed_query(embed_input).await?, true)
        } else {
            match self.embedder.embed_query(embed_input).await {
                Ok(v) => (v, false),
                Err(err) => {
                    let Some(sec) = &self.secondary else { return Err(err) };
                    tracing::warn!(
                        target: "semantic_catalog",
                        "primary embedder failed ({}): {} — falling back to local for 60s",
                        self.cache_file,
                        err
                    );
                    self.primary_down_until
                        .store(now_ms + 60_000, std::sync::atomic::Ordering::Relaxed);
                    (sec.embed_query(embed_input).await?, true)
                }
            }
        };
        let vector_set = if use_secondary { &state.secondary_vectors } else { &state.vectors };
        let q_lower = user_query.trim().to_lowercase();
        let mut scored: Vec<CatalogMatch> = Vec::new();
        for e in &state.entries {
            if let Some(allowed) = scopes {
                if !allowed.iter().any(|p| e.id.starts_with(p.as_str())) {
                    continue;
                }
            }
            let Some(v) = vector_set.get(&e.id) else { continue };
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
        // 섀도우 A/B (백그라운드, 무료기간 전 표면 실측 2026-07-13) — 양 공간(dual-embed)이 있으면
        // 같은 쿼리의 secondary 공간 cosine top-K 를 계산해 비교 로그(target="embed_shadow").
        // 서빙(scored)은 불변. 폴백 서빙 중(use_secondary)엔 primary 가 죽어 있어 비교 불가라 skip.
        if !use_secondary && !scored.is_empty() {
            if let Some(sec) = &self.secondary {
                self.spawn_shadow_compare(
                    sec.clone(),
                    q.clone(),
                    embed_input.to_string(),
                    scopes.map(|s| s.to_vec()),
                    limit,
                );
            }
        }
        Ok(CatalogQueryOutcome { matches: scored, dropped_tokens: dropped, all_oov: false })
    }

    /// 카탈로그 A/B (백그라운드) — primary(서빙) vs secondary 공간의 **cosine-only** top-K 비교
    /// 로그. lexical boost 는 임베더 무관 동일 가산이라 제외(순수 변별력 비교). 판독:
    /// `journalctl -u firebat | grep embed_shadow`. 방향은 배선이 결정 — 설정 solar 면
    /// primary=Upstage vs shadow=E5, 로컬+`system:embed-shadow` 면 primary=E5 vs shadow=Upstage.
    fn spawn_shadow_compare(
        &self,
        secondary: Arc<dyn IEmbedderPort>,
        primary_q: Vec<f32>,
        embed_input: String,
        scopes: Option<Vec<String>>,
        limit: usize,
    ) {
        let state = self.state.clone();
        let catalog = self.cache_file.clone();
        let primary_version = self.embedder.version().to_string();
        tokio::spawn(async move {
            let sq = match secondary.embed_query(&embed_input).await {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(target: "embed_shadow", catalog = %catalog, error = %e, "shadow embed_query failed");
                    return;
                }
            };
            let st = state.read().await;
            let mut prim: Vec<(String, f32)> = Vec::new();
            let mut secr: Vec<(String, f32)> = Vec::new();
            for e in &st.entries {
                if let Some(allowed) = &scopes {
                    if !allowed.iter().any(|p| e.id.starts_with(p.as_str())) {
                        continue;
                    }
                }
                if let Some(v) = st.vectors.get(&e.id) {
                    prim.push((e.id.clone(), cosine(&primary_q, v)));
                }
                if let Some(v) = st.secondary_vectors.get(&e.id) {
                    secr.push((e.id.clone(), cosine(&sq, v)));
                }
            }
            drop(st);
            if secr.is_empty() {
                return; // secondary 공간 미구축(임베딩 실패 등) — 비교 불가
            }
            let top = |mut v: Vec<(String, f32)>| {
                v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                v.truncate(limit);
                v
            };
            let prim = top(prim);
            let secr = top(secr);
            let top1_agree = match (prim.first(), secr.first()) {
                (Some(a), Some(b)) => a.0 == b.0,
                _ => false,
            };
            let prim_ids: std::collections::HashSet<&str> =
                prim.iter().map(|(id, _)| id.as_str()).collect();
            let overlap = secr.iter().filter(|(id, _)| prim_ids.contains(id.as_str())).count();
            let fmt = |v: &[(String, f32)]| {
                v.iter()
                    .map(|(id, s)| serde_json::json!({ "id": id, "score": (s * 1000.0).round() / 1000.0 }))
                    .collect::<Vec<_>>()
            };
            let payload = serde_json::json!({
                "catalog": catalog,
                "query": embed_input,
                "primary": { "embedder": primary_version, "top": fmt(&prim) },
                "shadow": { "embedder": secondary.version(), "top": fmt(&secr) },
                "top1_agree": top1_agree,
                "overlap": overlap,
                "k": limit,
            });
            tracing::info!(target: "embed_shadow", data = %payload, "catalog A/B");
        });
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

    /// Distinct id prefixes (the part before ':'), sorted — e.g. the set of cataloged
    /// modules. Cheap (few names) — lets a searcher tell "not in the catalog" from
    /// "keep searching" (2026-07-07: a model retried a search endlessly for a module
    /// that was never indexed).
    pub async fn id_prefixes(&self) -> Vec<String> {
        let state = self.state.read().await;
        let mut out: Vec<String> = state
            .entries
            .iter()
            .filter_map(|e| e.id.split_once(':').map(|(p, _)| p.to_string()))
            .collect();
        out.sort();
        out.dedup();
        out
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

    /// Local fallback embedder passthrough (dual-embed) — see `SemanticCatalog::with_secondary`.
    pub fn with_secondary(mut self, secondary: Arc<dyn IEmbedderPort>) -> Self {
        self.catalog = self.catalog.with_secondary(secondary);
        self
    }

    /// Boot-time warm-up — build the catalog (and its embedding cache) before the first user
    /// query so an API embedder's initial full embed doesn't stall the first search.
    pub async fn warm(&self) {
        self.ensure().await;
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

    pub async fn query_analyzed(
        &self,
        user_query: &str,
        limit: usize,
        scopes: Option<&[String]>,
    ) -> InfraResult<CatalogQueryOutcome> {
        self.ensure().await;
        self.catalog.query_analyzed(user_query, limit, scopes).await
    }

    pub async fn get(&self, id: &str) -> Option<CatalogEntry> {
        self.ensure().await;
        self.catalog.get(id).await
    }

    pub async fn has_prefix(&self, prefix: &str) -> bool {
        self.ensure().await;
        self.catalog.get_first_with_prefix(prefix).await
    }

    pub async fn id_prefixes(&self) -> Vec<String> {
        self.ensure().await;
        self.catalog.id_prefixes().await
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
    fn clean_query_drops_oov_keeps_vocab() {
        let corpus = "name: 주식일봉차트조회요청\ndesc: 국내주식/차트 기준일자 시세 조회\n".to_lowercase();
        // subject name = OOV → dropped; informative tokens kept
        let (cleaned, dropped) = clean_query("LG에너지솔루션 일봉 시세", &corpus);
        assert_eq!(cleaned, "일봉 시세");
        assert_eq!(dropped, vec!["LG에너지솔루션".to_string()]);
        // particle suffix trim — "차트랑" → "차트" found → kept (original token preserved)
        let (cleaned, dropped) = clean_query("일봉 차트랑", &corpus);
        assert_eq!(cleaned, "일봉 차트랑");
        assert!(dropped.is_empty());
        // all tokens OOV → empty cleaned
        let (cleaned, dropped) = clean_query("LG에너지솔루션", &corpus);
        assert!(cleaned.is_empty());
        assert_eq!(dropped.len(), 1);
        // fully in-vocab query untouched
        let (cleaned, dropped) = clean_query("일봉 차트", &corpus);
        assert_eq!(cleaned, "일봉 차트");
        assert!(dropped.is_empty());
    }

    #[test]
    fn hash_stable_and_versioned() {
        let e = CatalogEntry {
            id: "m:a".into(),
            name: "일봉차트".into(),
            description: "주식 일봉".into(),
            extra: serde_json::json!({}),
        };
        let h1 = sha1_hash("e5-small-v1", &entry_text(&e));
        let h2 = sha1_hash("e5-small-v1", &entry_text(&e));
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 40);
        // embedder swap → different version → different hash → auto re-embed
        assert_ne!(h1, sha1_hash("upstage-solar-embed-2", &entry_text(&e)));
    }
}
