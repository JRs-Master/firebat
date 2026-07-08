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

const RECENT_MESSAGE_LIMIT: usize = 12; // recent 회상 = 6 Q&A 턴 (직전 대화 연속성)
const PREVIEW_MAX: usize = 200; // 벡터 검색 매칭 미리보기 (compress_history_with_search)
const RECENT_FULL_MAX: usize = 1200; // recent 회상 메시지 상한 — 옛 200자 trim 이 "단편적 기억" 원인

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
    /// IEmbedderPort 설정된 ConversationManager (Step 1.5 설정) 가 search_history 의 cosine
    /// 검색을 활성화. 미설정 시 search_history 빈 결과 → 빈 contextSummary.
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

        // 진단 — 벡터(E5) 회상 품질 (admin 로그 탭): 매칭 수 / top score / spread.
        // E5 유지 vs 다른 임베딩 모델 교체 판단용.
        tracing::info!(target: "ai", count = picked.len(), top_score = top1, spread = spread, "search_history vector recall");

        // 매칭 대화의 Q&A 페어 full 원문 — 옛 200자 preview → 전체 (E5 가 고른 대화 통째로).
        // user 매칭이면 다음 assistant, assistant 매칭이면 이전 user 를 같이 (한 덩어리).
        let mut lines = vec![format!("[Related past conversations ({})]", picked.len())];
        let mut seen: std::collections::HashSet<(String, usize)> = std::collections::HashSet::new();
        for m in &picked {
            let mi = m.msg_idx as usize;
            let pair_mi = if m.role == "user" { mi + 1 } else { mi.saturating_sub(1) };
            let lo = mi.min(pair_mi);
            let hi = mi.max(pair_mi);
            if !seen.insert((m.conv_id.clone(), lo)) {
                continue; // 같은 Q&A 페어 중복 방지
            }
            let mut got_full = false;
            if let Some(conv) = self.conversation.get(owner, &m.conv_id) {
                if let Some(msgs) = conv.messages.as_array() {
                    let idxs: Vec<usize> = if lo == hi { vec![lo] } else { vec![lo, hi] };
                    for idx in idxs {
                        if let Some(msg) = msgs.get(idx) {
                            let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
                            let label = match role {
                                "user" => "사용자",
                                "assistant" | "system" => "AI",
                                _ => continue,
                            };
                            // firebat-render fence(X) → 텍스트 값만 (회상에 raw JSON 안 보이게).
                            let content = super::render_exec::fence_to_plaintext(
                                msg.get("content").and_then(|v| v.as_str()).unwrap_or(""),
                            );
                            if !content.trim().is_empty() {
                                lines.push(format!("[{}]: {}", label, content));
                                got_full = true;
                            }
                        }
                    }
                }
            }
            if !got_full {
                // full 조회 실패 — preview(잘림) fallback.
                let role_label = if m.role == "user" { "사용자" } else { "AI" };
                let preview: String = m.content_preview.chars().take(PREVIEW_MAX).collect();
                lines.push(format!("[{}]: {}", role_label, preview));
            }
        }
        HistoryResolveResult {
            recent_history,
            context_summary: lines.join("\n"),
        }
    }

    /// 자동 history 컨텍스트 합성 (fallback) — 단순 recent N 메시지 prepend.
    /// 옛 TS compressHistoryWithSearch 의 fallback 모드 — 벡터 검색 결과 없을 때 사용.
    ///
    /// owner 와 conv_id 설정되어 있으면 그 대화의 recent N 메시지 추출. 미설정 시 None.
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
                // AI 응답 = role "system" (이 스토어 규약). 직전 발언을 기억하려면 history 에 포함해야 한다
                // (hub 는 system→assistant 매핑으로 이미 포함, admin 은 빠뜨려 망각하던 root). "assistant" 동일.
                "assistant" | "system" => "AI",
                _ => continue, // tool 등만 제외
            };
            // firebat-render fence(X) → 텍스트 값만 (직전 대화 주입에 raw JSON 안 섞이게).
            let content = super::render_exec::fence_to_plaintext(
                msg.get("content").and_then(|v| v.as_str()).unwrap_or(""),
            );
            // 직전 대화는 full 에 가깝게 (1200자 상한) — 옛 200자 trim 이 "단편적 기억" 원인.
            let preview: String = content.chars().take(RECENT_FULL_MAX).collect();
            if !preview.trim().is_empty() {
                s.push_str(&format!("- [{}]: {}\n", role_label, preview));
            }
        }
        if s.lines().count() <= 1 {
            return None; // 헤더만 설정 → 의미 없는 컨텍스트
        }
        Some(s)
    }
}

// Tests 이관 — `infra/tests/ai_history_resolver_test.rs` (integration test).
