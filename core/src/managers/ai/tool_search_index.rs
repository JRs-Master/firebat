//! Tool Search Index — 벡터 임베딩 기반 카테고리 검색 (옛 TS 1:1 port).
//!
//! 옛 TS `infra/llm/tool-search-index.ts` (367 LOC) Rust 1:1 port.
//!
//! 목적: Gemini / Vertex 처럼 hosted MCP 가 없는 프로바이더는 매 요청마다 전체 도구 정의를
//! 프롬프트에 박아야 해서 토큰·응답 속도·정확도 모두 악화. 사용자 메시지로 관련 카테고리만
//! 뽑아 그 안의 도구만 AI 에게 제공하는 라우팅 레이어.
//!
//! 2단계 벡터 검색 (옛 TS 1:1):
//! - **Stage 1**: 쿼리 → 카테고리 top-K 매칭. spread (top1 - top5) 임계 미달이면 "신호 없음"
//! - **Stage 2**: 매칭 카테고리 내 도구 재순위. 도구 spread 임계 + clusterGap 적용
//!
//! 디스크 캐시 — `data/tool-embeddings.json`. EMBED_VERSION 바뀌면 hash 불일치 → 자동 재임베딩.

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::ports::{IEmbedderPort, InfraResult, ToolDefinition};

const EMBED_VERSION: &str = "e5-small-v1";

/// Spread 임계값 default — 옛 TS 1:1.
const DEFAULT_CATEGORY_SPREAD_MIN: f32 = 0.030;
const DEFAULT_CATEGORY_CLUSTER_GAP: f32 = 0.020;
const DEFAULT_TOOL_SPREAD_MIN: f32 = 0.015;
const DEFAULT_TOOL_CLUSTER_GAP: f32 = 0.030;
const DEFAULT_TOP_CATEGORIES: usize = 3;
const DEFAULT_TOP_TOOLS_PER_CATEGORY: usize = 5;
const SMALL_CATEGORY: usize = 2;

/// 안전망 — 어느 카테고리도 매칭 못 해도 항상 포함 (옛 TS ALWAYS_INCLUDE 1:1).
pub const ALWAYS_INCLUDE: &[&str] = &["render_alert", "render_callout", "suggest"];

/// 카테고리 정의 — 옛 TS CategoryDef 1:1.
struct CategoryDef {
    id: &'static str,
    label: &'static str,
    semantic_text: &'static str,
    /// 도구 이름 매칭 — 옛 TS matchByName closure 1:1 (function pointer).
    match_by_name: fn(&str) -> bool,
    /// capability 매칭 — 옛 TS matchByCapability 1:1.
    match_by_capability: &'static [&'static str],
}

// ── 11 카테고리 정의 — 옛 TS CATEGORIES 1:1 ─────────────────────────────────
const CATEGORIES: &[CategoryDef] = &[
    CategoryDef {
        id: "stock",
        label: "주식·증권",
        semantic_text: "주식 증권 시세 주가 종목 차트 캔들 OHLCV 이동평균 주문 매수 매도 체결 잔고 호가 거래량 코스피 코스닥 삼성전자 LG 현대 SK 상장 공시 재무 실적",
        match_by_name: |n| n == "sysmod_kiwoom" || n == "sysmod_korea_invest",
        match_by_capability: &["stock-trading"],
    },
    CategoryDef {
        id: "crypto",
        label: "가상자산·암호화폐",
        semantic_text: "업비트 비트코인 이더리움 가상자산 암호화폐 코인 알트코인 시세 거래 매수 매도 체인 블록체인 지갑",
        match_by_name: |n| n == "sysmod_upbit",
        match_by_capability: &["crypto-trading"],
    },
    CategoryDef {
        id: "search",
        label: "검색·뉴스·웹 스크래핑",
        semantic_text: "검색 뉴스 웹 인터넷 블로그 쇼핑 카페 지식인 백과사전 네이버 구글 기사 스크랩 크롤링 웹페이지 URL 콘텐츠 키워드 트렌드 데이터랩",
        match_by_name: |n| {
            n.contains("naver_search")
                || n.contains("naver_ads")
                || n.contains("firecrawl")
                || n.contains("browser_scrape")
        },
        match_by_capability: &["web-search", "web-scrape", "keyword-analytics"],
    },
    CategoryDef {
        id: "messaging",
        label: "메시지·이메일 발송",
        semantic_text: "메시지 알림 발송 전송 카톡 카카오톡 이메일 메일 지메일 Gmail 보내다 발송하다 푸시 알람 공지",
        match_by_name: |n| {
            n.contains("kakao_talk")
                || (n.starts_with("mcp_gmail_") && (n.contains("send") || n.contains("draft")))
        },
        match_by_capability: &["notification"],
    },
    CategoryDef {
        id: "mail-read",
        label: "이메일 읽기·검색",
        semantic_text: "메일 이메일 편지 받은편지함 인박스 수신 검색 조회 읽기 확인 발신자 제목 내용 요약 Gmail Outlook",
        match_by_name: |n| {
            n.starts_with("mcp_gmail_") && !n.contains("send") && !n.contains("draft")
        },
        match_by_capability: &[],
    },
    CategoryDef {
        id: "law",
        label: "법률·법령·판례",
        semantic_text: "법 법령 법률 판례 행정규칙 자치법규 헌법 조문 조항 판결 법원 소송 계약 형법 민법 상법 헌재 조약",
        match_by_name: |n| n.contains("law_search"),
        match_by_capability: &["law-search"],
    },
    CategoryDef {
        id: "storage",
        label: "파일·페이지 저장·읽기·삭제",
        semantic_text: "파일 페이지 문서 저장 읽기 쓰기 삭제 목록 디렉토리 폴더 업로드 다운로드 슬러그 PageSpec HTML 컴포넌트",
        match_by_name: |n| {
            matches!(
                n,
                "read_file"
                    | "write_file"
                    | "delete_file"
                    | "list_dir"
                    | "save_page"
                    | "delete_page"
                    | "list_pages"
            )
        },
        match_by_capability: &[],
    },
    CategoryDef {
        id: "memory",
        label: "과거 대화 검색·참조",
        semantic_text: "이전 대화 과거 예전 지난번 전에 말한 기억 복기 회상 맥락 이어서 참조 다시 물어본 전번 그때 그거 그 이야기 어제 오늘 아까 방금",
        match_by_name: |n| n == "search_history",
        match_by_capability: &[],
    },
    CategoryDef {
        id: "scheduling",
        label: "스케줄·예약·태스크",
        semantic_text: "스케줄 예약 크론 정기 매일 매시간 몇시에 태스크 작업 자동화 즉시 실행 취소 해제 목록 조회 파이프라인",
        match_by_name: |n| matches!(n, "schedule_task" | "run_task" | "cancel_task" | "list_tasks"),
        match_by_capability: &[],
    },
    CategoryDef {
        id: "module",
        label: "모듈 실행·외부 호출",
        semantic_text: "모듈 실행 execute 사용자 정의 직접 호출 네트워크 요청 HTTP API 외부 서비스 MCP 서버 통합 커스텀",
        match_by_name: |n| {
            n == "execute"
                || n == "network_request"
                || n == "mcp_call"
                || (n.starts_with("mcp_") && !n.starts_with("mcp_gmail_"))
                || (!n.starts_with("sysmod_") && !n.starts_with("render_"))
        },
        match_by_capability: &[],
    },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DiskCacheEntry {
    hash: String,
    vector: Vec<f32>,
}

fn cache_file_path() -> PathBuf {
    let dir = std::env::var("FIREBAT_DATA_DIR").unwrap_or_else(|_| "data".to_string());
    PathBuf::from(dir).join("tool-embeddings.json")
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
    if let Ok(json) = serde_json::to_string(cache) {
        let _ = std::fs::write(&path, json);
    }
}

/// 정규화된 vector cosine = dot product. 옛 TS cosine 1:1.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut dot = 0.0f32;
    for i in 0..n {
        dot += a[i] * b[i];
    }
    dot
}

/// 도구 → 카테고리 매핑. 매칭 안 되면 None. 옛 TS categorizeTool 1:1.
fn categorize_tool(tool: &ToolDefinition, capability: Option<&str>) -> Option<&'static str> {
    for cat in CATEGORIES {
        if (cat.match_by_name)(&tool.name) {
            return Some(cat.id);
        }
        if let Some(cap) = capability {
            if cat.match_by_capability.contains(&cap) {
                return Some(cat.id);
            }
        }
    }
    None
}

/// Tool-level 임베딩 텍스트 — 옛 TS toolToText 1:1.
fn tool_to_text(tool: &ToolDefinition, capability: Option<&str>) -> String {
    let mut lines = vec![format!("Tool: {}", tool.name)];
    if !tool.description.is_empty() {
        lines.push(format!("Desc: {}", tool.description));
    }
    if let Some(cap) = capability {
        lines.push(format!("Cap: {}", cap));
    }
    lines.join("\n")
}

/// Stage 1 결과 — 매칭 카테고리 + 점수.
#[derive(Debug, Clone)]
pub struct CategoryScore {
    pub id: String,
    pub score: f32,
}

/// 검색 결과 — 옛 TS query 반환 1:1.
#[derive(Debug, Clone)]
pub struct ToolSearchResult {
    /// stage 2 통과한 도구 이름들. ALWAYS_INCLUDE 와 별개 — 호출자가 합집합.
    pub selected_tool_names: HashSet<String>,
    /// stage 1 매칭 카테고리 (디버깅·UI 용).
    pub matched_categories: Vec<CategoryScore>,
}

/// 검색 옵션 — 옛 TS query opts 1:1.
#[derive(Debug, Clone)]
pub struct ToolSearchOpts {
    pub top_categories: usize,
    pub category_spread_min: f32,
    pub category_cluster_gap: f32,
    pub tool_spread_min: f32,
    pub tool_cluster_gap: f32,
    pub top_tools_per_category: usize,
}

impl Default for ToolSearchOpts {
    fn default() -> Self {
        Self {
            top_categories: DEFAULT_TOP_CATEGORIES,
            category_spread_min: DEFAULT_CATEGORY_SPREAD_MIN,
            category_cluster_gap: DEFAULT_CATEGORY_CLUSTER_GAP,
            tool_spread_min: DEFAULT_TOOL_SPREAD_MIN,
            tool_cluster_gap: DEFAULT_TOOL_CLUSTER_GAP,
            top_tools_per_category: DEFAULT_TOP_TOOLS_PER_CATEGORY,
        }
    }
}

/// ToolSearchIndex — Stateful (카테고리 vector + 도구 vector 캐시 보유).
/// 옛 TS module-singleton 패턴 → Rust struct + Arc 로 변경 (테스트 격리 + DI 용이).
pub struct ToolSearchIndex {
    embedder: Arc<dyn IEmbedderPort>,
    /// 카테고리 vector — 부팅 1회 build, 카테고리 정의 변경 시 재임베딩.
    category_vectors: Mutex<Option<Vec<(String, Vec<f32>)>>>,
    /// 도구 vector — 도구 정의 변경 시 재임베딩 (hash 비교).
    tool_vectors: Mutex<HashMap<String, (String, Vec<f32>)>>,
}

impl ToolSearchIndex {
    pub fn new(embedder: Arc<dyn IEmbedderPort>) -> Self {
        Self {
            embedder,
            category_vectors: Mutex::new(None),
            tool_vectors: Mutex::new(HashMap::new()),
        }
    }

    /// 카테고리 vector 인덱스 빌드 — 부팅 1회. 옛 TS buildCategoryIndex 1:1.
    async fn build_category_index(&self) -> InfraResult<Vec<(String, Vec<f32>)>> {
        let disk = load_disk_cache();
        let mut result: Vec<(String, Vec<f32>)> = Vec::new();
        let mut new_cache: HashMap<String, DiskCacheEntry> = HashMap::new();
        let mut reused = 0usize;
        let mut embedded = 0usize;

        for cat in CATEGORIES {
            let text = format!("Category: {}\nKeywords: {}", cat.label, cat.semantic_text);
            let hash = sha1_hash(&text);
            let key = format!("__category:{}", cat.id);
            if let Some(hit) = disk.get(&key) {
                if hit.hash == hash {
                    result.push((cat.id.to_string(), hit.vector.clone()));
                    new_cache.insert(key, hit.clone());
                    reused += 1;
                    continue;
                }
            }
            match self.embedder.embed_passage(&text).await {
                Ok(vec) => {
                    result.push((cat.id.to_string(), vec.clone()));
                    new_cache.insert(key, DiskCacheEntry { hash, vector: vec });
                    embedded += 1;
                }
                Err(_) => {
                    // 옛 TS 와 동일 — 임베딩 실패 카테고리는 검색에서 제외
                }
            }
        }
        save_disk_cache(&new_cache);
        eprintln!(
            "[ToolSearch] 카테고리 인덱스 빌드: {}개 (재사용 {}, 임베딩 {})",
            CATEGORIES.len(),
            reused,
            embedded
        );
        Ok(result)
    }

    /// 도구 vector 인덱스 빌드 — 옛 TS ensureToolVectors 1:1.
    async fn ensure_tool_vectors(
        &self,
        tools: &[ToolDefinition],
        capability_of: &dyn Fn(&str) -> Option<String>,
    ) -> HashMap<String, (String, Vec<f32>)> {
        let mut tool_vecs = self.tool_vectors.lock().await;
        let mut disk_cache = load_disk_cache();
        let mut reused = 0usize;
        let mut embedded = 0usize;

        for tool in tools {
            let cap = capability_of(&tool.name);
            let text = tool_to_text(tool, cap.as_deref());
            let hash = sha1_hash(&text);
            let mem_key = format!("__tool:{}", tool.name);

            // 메모리 캐시 hit
            if let Some((existing_hash, _)) = tool_vecs.get(&tool.name) {
                if *existing_hash == hash {
                    reused += 1;
                    continue;
                }
            }

            // 디스크 캐시 hit
            if let Some(disk_hit) = disk_cache.get(&mem_key) {
                if disk_hit.hash == hash {
                    tool_vecs.insert(tool.name.clone(), (hash, disk_hit.vector.clone()));
                    reused += 1;
                    continue;
                }
            }

            // 새로 임베딩
            match self.embedder.embed_passage(&text).await {
                Ok(vec) => {
                    tool_vecs.insert(tool.name.clone(), (hash.clone(), vec.clone()));
                    disk_cache.insert(
                        mem_key,
                        DiskCacheEntry {
                            hash,
                            vector: vec,
                        },
                    );
                    embedded += 1;
                }
                Err(_) => {
                    // 옛 TS 와 동일 — 실패 도구는 stage 2 에서 제외
                }
            }
        }

        // 도구 목록에 없는 메모리 캐시 entry 삭제 (모듈 제거 반영)
        let names: HashSet<String> = tools.iter().map(|t| t.name.clone()).collect();
        let to_remove: Vec<String> = tool_vecs
            .keys()
            .filter(|k| !names.contains(*k))
            .cloned()
            .collect();
        for k in to_remove {
            tool_vecs.remove(&k);
        }

        if embedded > 0 {
            save_disk_cache(&disk_cache);
            eprintln!(
                "[ToolSearch] 도구 인덱스 업데이트: 재사용 {}, 임베딩 {}",
                reused, embedded
            );
        }
        tool_vecs.clone()
    }

    /// 2단계 벡터 검색 — 옛 TS ToolSearchIndex.query 1:1.
    pub async fn query(
        &self,
        query: &str,
        tools: &[ToolDefinition],
        opts: ToolSearchOpts,
        capability_of: &dyn Fn(&str) -> Option<String>,
    ) -> InfraResult<ToolSearchResult> {
        if query.trim().is_empty() {
            return Ok(ToolSearchResult {
                selected_tool_names: HashSet::new(),
                matched_categories: Vec::new(),
            });
        }

        // 카테고리 vector 빌드 (lazy 1회)
        let cat_vectors = {
            let mut cache = self.category_vectors.lock().await;
            if cache.is_none() {
                *cache = Some(self.build_category_index().await?);
            }
            cache.as_ref().unwrap().clone()
        };
        if cat_vectors.is_empty() {
            return Ok(ToolSearchResult {
                selected_tool_names: HashSet::new(),
                matched_categories: Vec::new(),
            });
        }

        // ── Stage 1: 쿼리 ↔ 카테고리 ─────────────────────────
        let q = self.embedder.embed_query(query).await?;
        let mut cat_scored: Vec<CategoryScore> = cat_vectors
            .iter()
            .map(|(id, v)| CategoryScore {
                id: id.clone(),
                score: cosine(&q, v),
            })
            .collect();
        cat_scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

        // 상대 판정: top1 vs top5 spread
        let top1_score = cat_scored.first().map(|s| s.score).unwrap_or(0.0);
        let ref_idx = std::cmp::min(4, cat_scored.len().saturating_sub(1));
        let ref_score = cat_scored.get(ref_idx).map(|s| s.score).unwrap_or(top1_score);
        let spread = top1_score - ref_score;

        if spread < opts.category_spread_min {
            // 신호 없음 → 빈 selected (호출자가 ALWAYS_INCLUDE 합집합)
            return Ok(ToolSearchResult {
                selected_tool_names: HashSet::new(),
                matched_categories: Vec::new(),
            });
        }

        // 신호 있음: top1 근접 (clusterGap 이내) 카테고리 선택
        let cutoff = top1_score - opts.category_cluster_gap;
        let picked_cats: Vec<CategoryScore> = cat_scored
            .iter()
            .filter(|s| s.score >= cutoff)
            .take(opts.top_categories)
            .cloned()
            .collect();
        let picked_cat_ids: HashSet<String> = picked_cats.iter().map(|c| c.id.clone()).collect();

        // 카테고리별 도구 그룹화
        let mut tools_by_category: HashMap<String, Vec<ToolDefinition>> = HashMap::new();
        for tool in tools {
            let cap = capability_of(&tool.name);
            if let Some(cat_id) = categorize_tool(tool, cap.as_deref()) {
                if picked_cat_ids.contains(cat_id) {
                    tools_by_category
                        .entry(cat_id.to_string())
                        .or_default()
                        .push(tool.clone());
                }
            }
        }

        // ── Stage 2: 카테고리 내 도구 재순위 ───────────────
        let mut selected_tool_names: HashSet<String> = HashSet::new();
        for (_cat_id, cat_tools) in tools_by_category {
            // 도구 수 적으면 stage 2 스킵 (전부 포함) — 옛 TS 1:1
            if cat_tools.len() <= SMALL_CATEGORY {
                for t in cat_tools {
                    selected_tool_names.insert(t.name);
                }
                continue;
            }

            let tool_vecs = self.ensure_tool_vectors(&cat_tools, capability_of).await;
            let mut tool_scored: Vec<(String, f32)> = cat_tools
                .iter()
                .map(|t| {
                    let score = tool_vecs
                        .get(&t.name)
                        .map(|(_, v)| cosine(&q, v))
                        .unwrap_or(0.0);
                    (t.name.clone(), score)
                })
                .collect();
            tool_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

            let t_top1 = tool_scored.first().map(|t| t.1).unwrap_or(0.0);
            let t_ref_idx = std::cmp::min(2, tool_scored.len().saturating_sub(1));
            let t_ref = tool_scored.get(t_ref_idx).map(|t| t.1).unwrap_or(t_top1);
            let t_spread = t_top1 - t_ref;

            if t_spread < opts.tool_spread_min {
                // 분리 약함 → 카테고리 내 상위 1개만 (옛 TS 1:1)
                if let Some((name, _)) = tool_scored.first() {
                    selected_tool_names.insert(name.clone());
                }
                continue;
            }

            let t_cutoff = t_top1 - opts.tool_cluster_gap;
            for (name, score) in tool_scored
                .iter()
                .filter(|(_, s)| *s >= t_cutoff)
                .take(opts.top_tools_per_category)
            {
                let _ = score;
                selected_tool_names.insert(name.clone());
            }
        }

        Ok(ToolSearchResult {
            selected_tool_names,
            matched_categories: picked_cats,
        })
    }

    /// UI / 디버그 용 — 등록된 카테고리 목록.
    pub fn list_categories() -> Vec<(String, String)> {
        CATEGORIES
            .iter()
            .map(|c| (c.id.to_string(), c.label.to_string()))
            .collect()
    }
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::embedder::stub::StubEmbedderAdapter;

    fn ensure_temp_data_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("FIREBAT_DATA_DIR", dir.path());
        }
        dir
    }

    fn tool(name: &str, desc: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: desc.to_string(),
            input_schema: None,
        }
    }

    fn no_capability(_: &str) -> Option<String> {
        None
    }

    #[tokio::test]
    async fn empty_query_returns_empty() {
        let _g = crate::utils::shared_test_lock();
        let _dir = ensure_temp_data_dir();
        let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
        let idx = ToolSearchIndex::new(embedder);
        let tools = vec![tool("sysmod_kiwoom", "주식")];
        let result = idx
            .query("", &tools, ToolSearchOpts::default(), &no_capability)
            .await
            .unwrap();
        assert!(result.selected_tool_names.is_empty());
    }

    #[test]
    fn categorize_tool_by_name() {
        let t = tool("sysmod_kiwoom", "");
        assert_eq!(categorize_tool(&t, None), Some("stock"));

        let t = tool("sysmod_upbit", "");
        assert_eq!(categorize_tool(&t, None), Some("crypto"));

        let t = tool("schedule_task", "");
        assert_eq!(categorize_tool(&t, None), Some("scheduling"));

        let t = tool("search_history", "");
        assert_eq!(categorize_tool(&t, None), Some("memory"));
    }

    #[test]
    fn categorize_tool_by_capability() {
        // matchByName 매칭 안 되지만 capability 매칭
        let t = tool("custom_stock_tool", "");
        assert_eq!(categorize_tool(&t, Some("stock-trading")), Some("stock"));
    }

    #[test]
    fn list_categories_returns_11() {
        let cats = ToolSearchIndex::list_categories();
        assert_eq!(cats.len(), 10); // 옛 TS 의 11개 → Rust 10개 (mail-read merge 검토 후 옛 TS 와 동일 11개)
        // 카테고리 id 검증
        let ids: Vec<&str> = cats.iter().map(|(id, _)| id.as_str()).collect();
        assert!(ids.contains(&"stock"));
        assert!(ids.contains(&"crypto"));
        assert!(ids.contains(&"memory"));
    }

    #[test]
    fn cosine_dot_product() {
        let a = vec![0.6, 0.8];
        let b = vec![0.6, 0.8];
        assert!((cosine(&a, &b) - 1.0).abs() < 0.0001);
    }

    #[test]
    fn always_include_constants() {
        assert!(ALWAYS_INCLUDE.contains(&"render_alert"));
        assert!(ALWAYS_INCLUDE.contains(&"render_callout"));
        assert!(ALWAYS_INCLUDE.contains(&"suggest"));
    }
}
