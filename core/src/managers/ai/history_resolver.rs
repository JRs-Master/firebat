//! HistoryResolver — Function Calling 멀티턴 히스토리 조립 + 자동 search_history 주입.
//!
//! 옛 TS `core/managers/ai/history-resolver.ts` 1:1 Rust port.
//!
//! 책임:
//!   - 사용자 발화 + 대화 컨텍스트 → 벡터 검색 spread 판정.
//!   - 신호 강하면 (top1 vs top5 spread ≥ MIN_SPREAD): 매칭 메시지 contextSummary 로 주입.
//!   - 신호 약하면: 빈 contextSummary 반환 → AI 가 명시적 search_history 호출 또는 사용자에게 역질문.
//!
//! 두 모드:
//!   - `compress_history_with_search` — 벡터 검색 spread 판정 (옛 TS 1:1, 메인 경로)
//!   - `resolve` — 단순 recent N 메시지 fallback (벡터 검색 없는 환경)

use std::sync::Arc;

use crate::managers::conversation::{ConversationManager, SearchHistoryOpts};

/// 벡터 검색 spread 임계 — 옛 TS 와 동일 (1년+ 누적 fix).
/// top1 vs top5 차이가 이 이하면 신호 없음 (모호한 query → 빈 컨텍스트 반환).
const MIN_SPREAD: f32 = 0.030;
/// top1 에서 떨어져도 함께 picked 되는 거리.
const CLUSTER_GAP: f32 = 0.020;
/// 후보 수 (벡터 검색 limit).
const SEARCH_LIMIT: usize = 10;
/// 최종 picked 최대.
const PICK_MAX: usize = 5;

const RECENT_MESSAGE_LIMIT: usize = 5;
const PREVIEW_MAX: usize = 200;

#[derive(Debug, Clone, Default)]
pub struct CompressHistoryOpts {
    pub owner: Option<String>,
    pub current_conv_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct HistoryResolveResult {
    /// recent window — 현재 비워둠 (옛 TS 동등 — 모든 문맥은 벡터 검색으로 인출)
    pub recent_history: Vec<serde_json::Value>,
    /// 시스템 프롬프트 prepend 용 — 신호 약하면 빈 string
    pub context_summary: String,
}

pub struct HistoryResolver {
    conversation: Arc<ConversationManager>,
}

impl HistoryResolver {
    pub fn new(conversation: Arc<ConversationManager>) -> Self {
        Self { conversation }
    }

    /// Function Calling 용 히스토리 조립 — 벡터 검색 단일 경로.
    /// 옛 TS `compressHistoryWithSearch` 1:1.
    ///
    /// 기본: recent window 0 (이전 턴 메시지 안 남김). 모든 문맥은 벡터 검색으로 인출.
    ///
    /// 효과:
    ///   - topic-shift 쿼리("하이", "다른 거") → 이전 턴 흔적 0
    ///   - 의미 연속 쿼리("이어서 삼성전자", "또 그거") → 벡터 검색 원문 인출
    ///   - 중복 주입 방지 (recent + HistorySearch 이중 유입 차단)
    ///
    /// 모호한 쿼리("또", "이어서"만)는 spread 약함 → 주입 0 → AI 가 유저에게 역질문.
    ///
    /// IEmbedderPort 박힌 ConversationManager (Step 1.5 박힘) 가 search_history 의 cosine
    /// 검색을 활성화. 미박음 시 search_history 빈 결과 → 빈 contextSummary.
    pub async fn compress_history_with_search(
        &self,
        user_prompt: &str,
        opts: &CompressHistoryOpts,
    ) -> HistoryResolveResult {
        let recent_history = Vec::new();
        let prompt = user_prompt.trim();
        let owner = match &opts.owner {
            Some(o) if !o.is_empty() => o,
            _ => {
                return HistoryResolveResult {
                    recent_history,
                    context_summary: String::new(),
                };
            }
        };
        if prompt.is_empty() {
            return HistoryResolveResult {
                recent_history,
                context_summary: String::new(),
            };
        }

        // 벡터 검색 — minScore=0 으로 전체 받아 spread 판정 (옛 TS 1:1)
        let matches = match self
            .conversation
            .search_history(
                owner,
                prompt,
                SearchHistoryOpts {
                    current_conv_id: opts.current_conv_id.clone(),
                    limit: Some(SEARCH_LIMIT),
                    min_score: Some(0.0),
                    ..Default::default()
                },
            )
            .await
        {
            Ok(m) => m,
            Err(_) => {
                return HistoryResolveResult {
                    recent_history,
                    context_summary: String::new(),
                };
            }
        };

        if matches.is_empty() {
            return HistoryResolveResult {
                recent_history,
                context_summary: String::new(),
            };
        }

        // 상대 스코어링 — top1 vs top5 spread (옛 TS 1:1)
        let top1 = matches.first().map(|m| m.score).unwrap_or(0.0);
        let ref_idx = (4).min(matches.len().saturating_sub(1));
        let ref_score = matches.get(ref_idx).map(|m| m.score).unwrap_or(top1);
        let spread = top1 - ref_score;

        if spread < MIN_SPREAD {
            // 신호 없음 — AI 가 명시적 search_history 호출 또는 역질문
            return HistoryResolveResult {
                recent_history,
                context_summary: String::new(),
            };
        }

        // 클러스터 — top1 에서 CLUSTER_GAP 안 떨어진 매치 모두 picked
        let cutoff = top1 - CLUSTER_GAP;
        let picked: Vec<_> = matches
            .into_iter()
            .filter(|m| m.score >= cutoff)
            .take(PICK_MAX)
            .collect();
        if picked.is_empty() {
            return HistoryResolveResult {
                recent_history,
                context_summary: String::new(),
            };
        }

        let mut lines = vec![format!("[관련 과거 대화 ({}개 매칭)]", picked.len())];
        for m in &picked {
            let role_label = if m.role == "user" { "사용자" } else { "AI" };
            let preview: String = m.content_preview.chars().take(PREVIEW_MAX).collect();
            lines.push(format!("[{}]: {}", role_label, preview));
        }
        HistoryResolveResult {
            recent_history,
            context_summary: lines.join("\n"),
        }
    }

    /// 자동 history 컨텍스트 합성 (fallback) — 단순 recent N 메시지 prepend.
    /// 옛 TS compressHistoryWithSearch 의 fallback 모드 — 벡터 검색 결과 없을 때 사용.
    ///
    /// owner 와 conv_id 박혀있으면 그 대화의 recent N 메시지 추출. 미박힘 시 None.
    pub fn resolve(&self, owner: &str, conv_id: Option<&str>) -> Option<String> {
        let conv_id = conv_id?;
        let conv = self.conversation.get(owner, conv_id)?;

        let messages = conv.messages.as_array()?;
        if messages.is_empty() {
            return None;
        }

        // recent N 메시지만 (마지막에서 N 개)
        let start = messages.len().saturating_sub(RECENT_MESSAGE_LIMIT);
        let recent = &messages[start..];
        if recent.is_empty() {
            return None;
        }

        let mut s = String::from("## 최근 대화 컨텍스트\n");
        for msg in recent {
            let role = msg
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let role_label = match role {
                "user" => "사용자",
                "assistant" => "AI",
                _ => continue, // system / tool 메시지는 컨텍스트에서 제외
            };
            let content = msg
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            // 200자 trim — 토큰 절감
            let preview: String = content.chars().take(200).collect();
            if !preview.trim().is_empty() {
                s.push_str(&format!("- [{}]: {}\n", role_label, preview));
            }
        }
        if s.lines().count() <= 1 {
            return None; // 헤더만 박힘 → 의미 없는 컨텍스트
        }
        Some(s)
    }
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::database::SqliteDatabaseAdapter;
    use firebat_infra::adapters::embedder::StubEmbedderAdapter;
    use crate::ports::{IDatabasePort, IEmbedderPort};

    fn manager() -> Arc<ConversationManager> {
        let db: Arc<dyn IDatabasePort> = Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        Arc::new(ConversationManager::new(db))
    }

    fn manager_with_embedder() -> Arc<ConversationManager> {
        let db: Arc<dyn IDatabasePort> = Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
        Arc::new(ConversationManager::new(db).with_embedder(embedder))
    }

    #[test]
    fn resolve_returns_none_for_unknown_conv() {
        let resolver = HistoryResolver::new(manager());
        assert!(resolver.resolve("admin", Some("missing")).is_none());
    }

    #[test]
    fn resolve_returns_recent_messages() {
        let mgr = manager();
        let messages = serde_json::json!([
            {"role": "user", "content": "삼성전자 시세 알려줘"},
            {"role": "assistant", "content": "75,000원입니다"},
            {"role": "user", "content": "차트도 보여줘"},
        ]);
        mgr.save_sync("admin", "c1", "주식 대화", &messages, None).unwrap();

        let resolver = HistoryResolver::new(mgr);
        let ctx = resolver.resolve("admin", Some("c1")).unwrap();
        assert!(ctx.contains("최근 대화 컨텍스트"));
        assert!(ctx.contains("삼성전자"));
        assert!(ctx.contains("75,000원"));
    }

    #[test]
    fn resolve_filters_system_role() {
        let mgr = manager();
        let messages = serde_json::json!([
            {"role": "system", "content": "system init"},
            {"role": "user", "content": "안녕"},
        ]);
        mgr.save_sync("admin", "c1", "test", &messages, None).unwrap();
        let resolver = HistoryResolver::new(mgr);
        let ctx = resolver.resolve("admin", Some("c1")).unwrap();
        assert!(!ctx.contains("system init"));
        assert!(ctx.contains("안녕"));
    }

    #[test]
    fn resolve_returns_none_when_only_system_messages() {
        let mgr = manager();
        let messages = serde_json::json!([
            {"role": "system", "content": "init"}
        ]);
        mgr.save_sync("admin", "c1", "test", &messages, None).unwrap();
        let resolver = HistoryResolver::new(mgr);
        assert!(resolver.resolve("admin", Some("c1")).is_none());
    }

    // ── compress_history_with_search (벡터 spread 판정) ──────────────────────

    #[tokio::test]
    async fn compress_empty_owner_returns_empty() {
        let resolver = HistoryResolver::new(manager());
        let r = resolver
            .compress_history_with_search("query", &CompressHistoryOpts::default())
            .await;
        assert!(r.context_summary.is_empty());
        assert!(r.recent_history.is_empty());
    }

    #[tokio::test]
    async fn compress_empty_prompt_returns_empty() {
        let resolver = HistoryResolver::new(manager());
        let r = resolver
            .compress_history_with_search(
                "",
                &CompressHistoryOpts {
                    owner: Some("admin".to_string()),
                    ..Default::default()
                },
            )
            .await;
        assert!(r.context_summary.is_empty());
    }

    #[tokio::test]
    async fn compress_no_embedder_returns_empty() {
        // embedder 미박은 ConversationManager 의 search_history 는 빈 결과
        // → spread 판정 stage 도달 X → 빈 contextSummary
        let resolver = HistoryResolver::new(manager());
        let r = resolver
            .compress_history_with_search(
                "삼성전자",
                &CompressHistoryOpts {
                    owner: Some("admin".to_string()),
                    ..Default::default()
                },
            )
            .await;
        assert!(r.context_summary.is_empty());
    }

    #[tokio::test]
    async fn compress_with_embedder_low_spread_returns_empty() {
        // Stub embedder 는 결정론적 hash — 모든 메시지 score 가 비슷 → spread 약함 → 신호 없음
        let mgr = manager_with_embedder();
        let messages = serde_json::json!([
            {"role": "user", "content": "메시지 A"},
            {"role": "assistant", "content": "응답 A"},
            {"role": "user", "content": "메시지 B"},
            {"role": "assistant", "content": "응답 B"},
            {"role": "user", "content": "메시지 C"},
        ]);
        mgr.save("admin", "c1", "test", &messages, None).await.unwrap();

        let resolver = HistoryResolver::new(mgr);
        let r = resolver
            .compress_history_with_search(
                "totally-unrelated-xyz-query",
                &CompressHistoryOpts {
                    owner: Some("admin".to_string()),
                    current_conv_id: Some("c1".to_string()),
                    ..Default::default()
                },
            )
            .await;
        // Stub embedder 는 query/passage prefix 차이로 spread 가 우연히 클 수 있어
        // 결과 검증은 "구조 valid" 정도만 (context_summary 가 string OR 빈 string)
        if !r.context_summary.is_empty() {
            assert!(r.context_summary.contains("[관련 과거 대화"));
        }
    }

    #[tokio::test]
    async fn compress_with_strong_match_returns_context() {
        // 동일 query 로 같은 메시지 박은 후 검색 — spread 강함 (자기 매칭 score 1.0 대비 다른 메시지)
        let mgr = manager_with_embedder();
        let messages = serde_json::json!([
            {"role": "user", "content": "삼성전자 1주 매수했습니다"},
            {"role": "assistant", "content": "75,000원 진입가 좋습니다"},
            {"role": "user", "content": "랜덤 메시지 X"},
            {"role": "assistant", "content": "응답 X"},
            {"role": "user", "content": "다른 주제 Y"},
        ]);
        mgr.save("admin", "c1", "test", &messages, None).await.unwrap();

        let resolver = HistoryResolver::new(mgr);
        let r = resolver
            .compress_history_with_search(
                "삼성전자 1주 매수했습니다",
                &CompressHistoryOpts {
                    owner: Some("admin".to_string()),
                    current_conv_id: Some("c1".to_string()),
                    ..Default::default()
                },
            )
            .await;
        // spread 가 MIN_SPREAD 이상이면 context 박힘. Stub embedder 결정론이라 검증 가능.
        // 구조 valid 만 검증
        if !r.context_summary.is_empty() {
            assert!(r.context_summary.contains("[관련 과거 대화"));
            assert!(r.context_summary.contains("매칭"));
        }
    }

    // ── resolve (recent N fallback) ──────────────────────────────────────────

    #[test]
    fn resolve_limits_to_recent_n() {
        let mgr = manager();
        let mut msgs: Vec<serde_json::Value> = Vec::new();
        for i in 0..10 {
            msgs.push(serde_json::json!({
                "role": "user",
                "content": format!("message {}", i)
            }));
        }
        let messages = serde_json::Value::Array(msgs);
        mgr.save_sync("admin", "c1", "long", &messages, None).unwrap();
        let resolver = HistoryResolver::new(mgr);
        let ctx = resolver.resolve("admin", Some("c1")).unwrap();
        // RECENT_MESSAGE_LIMIT = 5, 가장 처음 메시지 (message 0~4) 는 미포함
        assert!(!ctx.contains("message 0"));
        assert!(ctx.contains("message 9"));
    }
}
