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
    /// Primary slot — Option 이라 **한쪽 slot 만 성공해도 엔트리가 영속**된다(slot-wise).
    /// 옛 "primary 있는 엔트리만 영속" 불변식은 스왑 마이그레이션에서 재앙이었음: 원격
    /// primary(429)가 실패하면 방금 계산한 로컬 secondary 까지 통째 버려져 매 재빌드가
    /// 같은 E5 를 재계산(1 vCPU 수 분 CPU 폭풍 = 2026-07-22 턴 랙 실측). 구 캐시 파일의
    /// `vector: [..]` 는 Some 으로 자연 역직렬화(하위호환).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    vector: Option<Vec<f32>>,
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
    /// The entry's declared tags — capability words, in the vocabulary a user would ask in.
    ///
    /// These were held out of the embedded text from 2026-08-10, on the reasoning that the gate
    /// wants every word it can get while the ranker wants none it does not need. The reasoning
    /// was never measured, and what has been measured since points the other way: length is what
    /// blurs a vector, not vocabulary. A 602-char description scored below a 389-char one for a
    /// query whose answer was in the longer text (2026-08-15), and kakao-map sat 5th with tags
    /// that let its query through and then counted for nothing.
    ///
    /// So tags are embedded now, and one text serves both jobs again. What to watch is the
    /// failure the old note feared, which is real: a module declaring fifteen generic tags drags
    /// every action it owns toward generic queries. Specific nouns earn their place; `조회` does
    /// not.
    pub vocab: Vec<String>,
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
    /// 실제로 임베딩된 질의 — 원문과 다를 수 있다(OOV 제거 후). 응답에 실어 모델이
    /// "내가 물은 것"과 "실제로 검색된 것"의 차이를 그 자리에서 보게 한다. 이게 없어서
    /// 모델이 시행착오로 질의 위생을 스스로 학습했다(2026-07-27 cxmt 턴 실측).
    pub searched_with: String,
    /// **실제로 서빙한 임베더** — 같은 질의가 다른 순위를 내는 세 번째 경로. dual-embed 는
    /// primary 장애(60초 쿨다운)뿐 아니라 **primary 공간이 아직 덜 찼을 때**(스왑 마이그레이션
    /// 중 429 로 증분 임베딩)도 secondary 로 서빙하고, 재빌드(300초)로 다 차는 순간 조용히
    /// primary 로 넘어간다. 두 공간은 top-1 이 자주 갈리므로(섀도우 로그 `top1_agree:false`
    /// 다수) 이 전환이 곧 순위 반전인데, 응답에 아무 표시가 없어 "질의를 바꿔서 그런가"와
    /// 구분이 안 됐다. A/B 는 임베더를 고정하고 재야 한다.
    pub embedder: String,
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

/// 질의가 정제로 **망가졌는가** — 드롭이 있었는데 살아남은 토큰이 1개 이하.
///
/// `all_oov`(전부 OOV)만 막던 게 너무 좁았다: "이번 주 로또 당첨번호 정확히 예측" 은 "주" 하나가
/// 살아남아 가드를 통과하고 예비특보를 1위로 돌려줬다(2026-07-28 사용자 A/B). 한 토큰은 변별을
/// 못 하는데 임베딩은 반드시 무언가를 1위로 뱉기 때문에, 남은 게 1개면 결과 모양의 잡탕이 된다.
///
/// **임계 없음** — 점수 컷은 액션 문서 품질 fix 가 배포되어 분포가 바뀐 뒤에 재본다. 여기 조건은
/// 순전히 구조적이라 임베더가 바뀌어도 유효하다. 드롭이 0인 짧은 질의("일봉")는 발동하지 않는다.
pub fn query_degraded(kept: &str, dropped: &[String]) -> bool {
    !dropped.is_empty() && kept.split_whitespace().count() <= 1
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

/// One text per entry, for both jobs: the vector the ranker compares, and the haystack the OOV
/// gate checks a query's words against.
///
/// The declared tags are part of it. They used to gate only — a word like `길찾기` survived the
/// query cleaner because a module declared it, and then contributed nothing to the score, so a
/// module could be reachable and still never win (kakao-map, 2026-08-14: tags fixed the gate and
/// left it 5th at 0.513; only per-action prose moved it to 1st at 0.638). Tags are also the
/// densest capability signal an entry has — a curated noun per line against a description that
/// wanders into paging caps and sort vocabularies. Measured 2026-08-15 on two near-identical
/// vendors: daum-search's 602-char description scored BELOW naver-search's 389-char one for
/// `웹문서 검색`, while carrying the very facts that distinguish it (video, books). Length
/// dilutes; tags do not.
///
/// Tags are declared per module, so every action of one module shares them — which lifts the
/// module as a whole against a query and leaves the ordering among its own actions to their
/// names and descriptions, where it belongs.
fn entry_text(e: &CatalogEntry) -> String {
    if e.vocab.is_empty() {
        return format!("Name: {}\nDesc: {}", e.name, e.description);
    }
    format!(
        "Name: {}\nTags: {}\nDesc: {}",
        e.name,
        e.vocab.join(", "),
        e.description
    )
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

    /// Primary embedder version label (e.g. "upstage-solar-embed-2" / "e5-small-multilingual-v1")
    /// — 서빙 임베더 식별용. S0 섀도우 로그에 태그해 어느 임베더의 shortlist 인지 사후 판독 가능.
    pub fn embedder_label(&self) -> &str {
        self.embedder.version()
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
            // slot-wise 재사용 — hash 일치 + 벡터 실재(실패 slot 은 hash 만 남을 수 있음).
            match hit.and_then(|h| if h.hash == hash { h.vector.clone() } else { None }) {
                Some(v) => {
                    vectors.insert(e.id.clone(), v);
                }
                None => prim_needed.push((e.id.clone(), text.clone())),
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
        // ── primary — **배치**(embed_passages) ──
        // 옛 per-entry 개별 호출(Semaphore 8)은 로컬 임베더 전제였는데, 스왑으로 primary 가
        // 원격(Upstage)이 되자 재빌드마다 수백 개별 콜 = RPM(100) 즉시 소진 → 429 + 엔트리당
        // WARN 폭풍(2026-07-22 실측: 재빌드가 턴 안에서 ~100개씩만 전진). 배치는 어댑터가
        // 64개/콜 청크 = 920 엔트리 ≈ 15콜로 RPM 안. 로컬(E5)은 trait 기본 구현이 순차 루프라
        // 동작 동일(1 vCPU 에선 동시성 이득도 없음). 실패 = WARN 1줄 + 이번 빌드 slot skip.
        if !prim_needed.is_empty() {
            let texts: Vec<String> = prim_needed.iter().map(|(_, t)| t.clone()).collect();
            match self.embedder.embed_passages(&texts).await {
                Ok(vecs) => {
                    for ((id, _), v) in prim_needed.iter().zip(vecs) {
                        vectors.insert(id.clone(), v);
                    }
                }
                Err(err) => {
                    tracing::warn!(
                        target: "semantic_catalog",
                        "primary batch embed failed ({}, {} entries): {} — slot skipped this build",
                        self.cache_file,
                        prim_needed.len(),
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
        // ── fresh 재구성 — **slot-wise**: 어느 한쪽 벡터라도 확보된 엔트리는 영속. 실패한
        //    slot 은 None 으로 남고 다음 재빌드가 그 slot 만 이어서 채움(성공분 재계산 0). ──
        let mut fresh: HashMap<String, DiskCacheEntry> = HashMap::new();
        for e in &entries {
            let pv = vectors.get(&e.id).cloned();
            let sv = secondary_vectors.get(&e.id).cloned();
            if pv.is_none() && sv.is_none() {
                continue;
            }
            let (hash, sec_hash) = hashes.get(&e.id).cloned().unwrap_or_default();
            fresh.insert(
                e.id.clone(),
                DiskCacheEntry {
                    hash,
                    vector: pv,
                    secondary_hash: sec_hash,
                    secondary: sv,
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
            searched_with: String::new(),
            embedder: String::new(),
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
        if query_degraded(&cleaned, &dropped) {
            // 전부 OOV(빈 질의)이거나, 드롭 뒤 한 토큰만 남아 변별력이 없는 경우 — 둘 다 검색을
            // 하지 않는다. 임베딩은 무엇이든 1위로 뱉으므로 결과 모양의 잡탕이 되고, 그 잡탕이
            // 모델을 변형 재검색의 죽음 나선으로 밀어 넣는다(2026-07-11/12/28 실측).
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
        // Coverage gate — 스왑 마이그레이션 중엔 원격 primary 공간이 재빌드마다 증분으로
        // 차오른다(429 rate limit). 반쪽 공간으로 서빙하면 미임베딩 엔트리가 검색에서 조용히
        // 증발(2026-07-22 실측: 202/920 상태에서 recall 0) → 더 꽉 찬 공간을 서빙한다.
        // 완성되면 자동으로 primary 로 넘어감. 동률 = primary.
        let primary_incomplete =
            self.secondary.is_some() && state.secondary_vectors.len() > state.vectors.len();
        let (q, use_secondary) = if self.secondary.is_some() && (primary_cooling || primary_incomplete) {
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
        Ok(CatalogQueryOutcome {
            matches: scored,
            dropped_tokens: dropped,
            all_oov: false,
            searched_with: embed_input.to_string(),
            embedder: if use_secondary {
                self.secondary.as_ref().map(|s| s.version().to_string()).unwrap_or_default()
            } else {
                self.embedder.version().to_string()
            },
        })
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

    /// 한 prefix(=모듈)의 엔트리 전체 — 임베딩을 거치지 않는 **목록** 경로.
    /// 검색이 못 미더울 때 모델이 쓰는 통로(관측: 틀린 action 을 일부러 넣어 검증 에러로 enum 을
    /// 뽑아내는 프로브). 순위 없이 선언 순서를 유지한다.
    pub async fn entries_with_prefix(&self, prefix: &str) -> Vec<CatalogEntry> {
        let state = self.state.read().await;
        state
            .entries
            .iter()
            .filter(|e| e.id.starts_with(prefix))
            .cloned()
            .collect()
    }
}

/// A catalog data source — enumerates the current entries (e.g. skills on disk, module
/// action declarations). Consumed by `RefreshingCatalog` on TTL rebuild.
#[async_trait::async_trait]
pub trait CatalogSource: Send + Sync {
    async fn load(&self) -> Vec<CatalogEntry>;

    /// A cheap value that changes whenever `load()` would return something different — for a
    /// disk-backed source, the names, sizes and mtimes of the files it reads.
    ///
    /// `None` means the source cannot answer, and the TTL decides alone (the old behaviour).
    /// A source that CAN answer turns the timer into a debounce on this check instead of a
    /// rebuild schedule: an untouched catalog is never re-read, and an edited one does not wait
    /// out the remaining clock.
    async fn fingerprint(&self) -> Option<String> {
        None
    }
}

/// SemanticCatalog + a TTL-gated source rebuild — the standard shape for dynamic domains
/// (skills/templates/pages/media/module-actions). Rebuild re-reads the source but only
/// re-embeds entries whose text changed (sha1 disk cache), so a 5-min TTL is nearly free.
pub struct RefreshingCatalog {
    catalog: SemanticCatalog,
    source: Arc<dyn CatalogSource>,
    ttl: std::time::Duration,
    built_at: tokio::sync::Mutex<Option<std::time::Instant>>,
    /// The source's fingerprint as of the last build — see `CatalogSource::fingerprint`.
    fingerprint: tokio::sync::Mutex<Option<String>>,
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
            fingerprint: tokio::sync::Mutex::new(None),
        }
    }

    /// Local fallback embedder passthrough (dual-embed) — see `SemanticCatalog::with_secondary`.
    pub fn with_secondary(mut self, secondary: Arc<dyn IEmbedderPort>) -> Self {
        self.catalog = self.catalog.with_secondary(secondary);
        self
    }

    /// Primary embedder version label — S0 섀도우 로그 태그용.
    pub fn embedder_label(&self) -> &str {
        self.catalog.embedder_label()
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
                // Inside the window nothing is checked at all — the TTL's remaining job is to keep
                // a burst of calls in one turn from stat-walking the source once each.
                if t.elapsed() < self.ttl {
                    return;
                }
            }
        }
        // Past the window, the question is whether anything actually changed. A source that can
        // answer saves the whole rebuild when the answer is no, and — more to the point — a source
        // that says yes is rebuilt now rather than at the end of some later window.
        let fresh = self.source.fingerprint().await;
        if fresh.is_some() && fresh == *self.fingerprint.lock().await {
            *self.built_at.lock().await = Some(std::time::Instant::now());
            return;
        }
        let entries = self.source.load().await;
        self.catalog.set_entries(entries).await;
        *self.fingerprint.lock().await = fresh;
        *self.built_at.lock().await = Some(std::time::Instant::now());
    }

    /// Drop the build so the next read reloads — for changes the fingerprint cannot see, which is
    /// anything not on disk. The enable toggle is a vault write; `ModuleService` already calls the
    /// dynamic-tool registry's `invalidate` on it and this is its other half.
    pub async fn invalidate(&self) {
        *self.built_at.lock().await = None;
        *self.fingerprint.lock().await = None;
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

    pub async fn entries_with_prefix(&self, prefix: &str) -> Vec<CatalogEntry> {
        self.ensure().await;
        self.catalog.entries_with_prefix(prefix).await
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
    /// The gate and the ranker read the same entry but must not read the same text: a word can
    /// be added to the vocabulary — so a query carrying it is not thrown away — without ever
    /// entering the embedded document, where it would pull the vector around.
    fn tags_are_embedded_and_gate_from_one_text() {
        let e = CatalogEntry {
            id: "binance:get_candles".into(),
            name: "Candles".into(),
            description: "binance OHLCV bars".into(),
            extra: serde_json::Value::Null,
            vocab: vec!["암호화폐".into(), "코인".into()],
        };
        // One text now: the words that let a query through are the words that score it.
        assert_eq!(
            entry_text(&e),
            "Name: Candles
Tags: 암호화폐, 코인
Desc: binance OHLCV bars"
        );
        let corpus = entry_text(&e).to_lowercase();
        let (cleaned, dropped) = clean_query("코인 binance", &corpus);
        assert_eq!(cleaned, "코인 binance");
        assert!(dropped.is_empty());
        // An entry that declares nothing carries no empty Tags line.
        let bare = CatalogEntry { vocab: Vec::new(), ..e };
        assert_eq!(entry_text(&bare), "Name: Candles
Desc: binance OHLCV bars");
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
        // 정제 후 한 토큰만 남으면 검색을 하지 않는다 — 드롭 0 인 짧은 질의는 발동하지 않아야.
        assert!(query_degraded("주", &["로또".into(), "당첨번호".into()]));
        assert!(query_degraded("", &["LG에너지솔루션".into()]));
        assert!(!query_degraded("일봉", &[]), "드롭 없는 짧은 질의는 정상");
        assert!(!query_degraded("내일 비", &["서울".into(), "우산".into()]), "2토큰은 검색한다");
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
                    vocab: Vec::new(),
        };
        let h1 = sha1_hash("e5-small-v1", &entry_text(&e));
        let h2 = sha1_hash("e5-small-v1", &entry_text(&e));
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 40);
        // embedder swap → different version → different hash → auto re-embed
        assert_ne!(h1, sha1_hash("upstage-solar-embed-2", &entry_text(&e)));
    }
}
