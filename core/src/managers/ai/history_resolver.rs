//! HistoryResolver — Function Calling 멀티턴 히스토리 조립.
//!
//! 옛 TS `core/managers/ai/history-resolver.ts` 에서 온 포트.
//!
//! 두 모드:
//!   - `recent_turns` — recent N 메시지를 **진짜 턴**으로 (multi-turn 요청을 받는 포맷)
//!   - `resolve` — 같은 창을 시스템 프롬프트 prepend 용 산문으로 (blob 포맷)
//!
//! 벡터 검색으로 관련 과거 대화를 프롬프트에 밀어 넣던 `compress_history_with_search` 는 제거됐다:
//! 같은 대화가 `[Related past conversations]` 블록과 `<RETRIEVED_CONTEXT>` 로 두 번 실려 낭비와
//! 혼선을 만들었고, 중복 주입을 없앤 뒤 남은 호출자가 0 이었다. 과거 대화 인출은 이제 retrieval
//! 경로와 모델의 `search_history` / `read_conversation` 호출이 담당한다.

use std::sync::Arc;

use crate::managers::conversation::ConversationManager;

const RECENT_MESSAGE_LIMIT: usize = 12; // recent 회상 = 6 Q&A 턴 (직전 대화 연속성)
const RECENT_FULL_MAX: usize = 1200; // recent 회상 메시지 상한 — 옛 200자 trim 이 "단편적 기억" 원인

/// Age window for the recent-history prepend — ROLLING 24h, measured as a duration back from
/// "now". Not a calendar day: a midnight/timezone boundary would make the same conversation
/// carry a different amount of history depending on the hour it is resumed.
const RECENT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// Turns kept unconditionally, however old they are (user choice, 2026-08-12).
/// A turn = one user message + its assistant reply, so the floor in MESSAGES is twice this.
const FLOOR_TURNS: usize = 5;
const FLOOR_MESSAGES: usize = FLOOR_TURNS * 2;

pub struct HistoryResolver {
    conversation: Arc<ConversationManager>,
}

/// Where the time-aware window starts inside an already count-capped slice of messages.
///
/// Count-only windowing ships stale turns once a conversation lives for days: asking the same
/// question again on day 3 dragged the whole old exchange back into every request (2026-08-12
/// 실측 — reasoning 9.5K→51K chars), and each stale message keeps paying peak context and cost
/// on every later turn.
///
/// Order of operations (the caller has already applied `RECENT_MESSAGE_LIMIT` = the outer bound):
///   1. the newest `FLOOR_MESSAGES` rows are kept unconditionally, however old they are;
///   2. of the older remainder, only rows inside the rolling `RECENT_WINDOW_MS` survive.
/// The floor always wins — the window trims ONLY beyond it.
///
/// Trimming here is safe because older context stays reachable through the existing recall
/// ladder: the retrieval path injects related past conversations, and the model can still call
/// `search_history` / `read_conversation` for anything older. This window decides what is
/// prepended by default, not what the turn is able to see.
///
/// Rows are stored in chronological order (the store's union merge sorts by timestamp), so this
/// is a prefix trim expressed as a start index rather than a per-row filter — a filter could
/// punch a hole in the middle of the turn sequence, and a multi-turn API request wants the
/// user/assistant alternation intact.
///
/// A row whose `createdAt` is missing or non-positive is KEPT: rows predating the stamp carry no
/// age evidence, and absence of evidence must not read as "stale".
fn recent_window_start(messages: &[serde_json::Value], now_ms: i64) -> usize {
    let mut start = messages.len().saturating_sub(FLOOR_MESSAGES);
    let cutoff = now_ms - RECENT_WINDOW_MS;
    while start > 0 {
        let created_at = messages[start - 1]
            .get("createdAt")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if created_at > 0 && created_at < cutoff {
            break;
        }
        start -= 1;
    }
    start
}

impl HistoryResolver {
    pub fn new(conversation: Arc<ConversationManager>) -> Self {
        Self { conversation }
    }

    /// 자동 history 컨텍스트 합성 — 단순 recent N 메시지.
    ///
    /// owner 와 conv_id 설정되어 있으면 그 대화의 recent N 메시지 추출. 미설정 시 빈 벡터.
    /// The same recent-N window as `resolve`, but as REAL turns for formats that take a
    /// multi-turn request. Pasting the transcript into the system prompt makes the previous
    /// answer read as text to continue, and the model reproduced it verbatim for a different
    /// question (2026-08-09 실측). As turns, "my last reply" is structurally the past.
    ///
    /// Storage says `system` for an AI reply on older rows; the wire word is `assistant`.
    /// Empty content and tool rows are skipped — an empty turn is a shape some APIs reject.
    ///
    /// The window is count-capped AND time-aware: `RECENT_MESSAGE_LIMIT` is the outer bound, then
    /// `recent_window_start` keeps the newest `FLOOR_TURNS` turns unconditionally and drops older
    /// rows that fall outside the rolling 24h window. CLI formats do not come through here — they
    /// resume their own session transcript.
    pub fn recent_turns(
        &self,
        owner: &str,
        conv_id: Option<&str>,
    ) -> Vec<crate::ports::ChatMessage> {
        let Some(conv_id) = conv_id else { return Vec::new() };
        let Some(conv) = self.conversation.get(owner, conv_id) else { return Vec::new() };
        let Some(messages) = conv.messages.as_array() else { return Vec::new() };
        let capped = &messages[messages.len().saturating_sub(RECENT_MESSAGE_LIMIT)..];
        let windowed = &capped[recent_window_start(capped, crate::utils::time::now_ms())..];
        let mut out: Vec<crate::ports::ChatMessage> = Vec::new();
        for msg in windowed {
            let role = match msg.get("role").and_then(|v| v.as_str()) {
                Some("user") => "user",
                Some("assistant") | Some("system") => "assistant",
                _ => continue,
            };
            let content = super::render_exec::fence_to_plaintext(
                msg.get("content").and_then(|v| v.as_str()).unwrap_or(""),
            );
            let trimmed: String = content.chars().take(RECENT_FULL_MAX).collect();
            if trimmed.trim().is_empty() {
                continue;
            }
            out.push(crate::ports::ChatMessage {
                role: role.to_string(),
                content: serde_json::Value::String(trimmed),
                image: None,
                image_mime_type: None,
            });
        }
        // The turn being answered is sent separately as the final user message, so a trailing
        // user row here would duplicate it.
        if out.last().map(|m| m.role == "user").unwrap_or(false) {
            out.pop();
        }
        out
    }

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

// Resolver tests that need a live ConversationManager — `infra/tests/ai_history_resolver_test.rs`
// (integration test). The window below is pure, so it is tested here.

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_760_000_000_000; // fixed "now" so the tests never race the clock
    const HOUR: i64 = 60 * 60 * 1000;
    const DAY: i64 = 24 * HOUR;

    /// `count` messages alternating user/assistant, every one stamped `age_ms` before NOW.
    fn aged(count: usize, age_ms: i64) -> Vec<serde_json::Value> {
        (0..count)
            .map(|i| {
                serde_json::json!({
                    "role": if i % 2 == 0 { "user" } else { "assistant" },
                    "content": format!("m{}", i),
                    "createdAt": NOW - age_ms,
                })
            })
            .collect()
    }

    #[test]
    fn all_fresh_conversation_is_untouched() {
        // 6 turns, all from the last hour → the window has nothing to trim.
        let msgs = aged(12, HOUR);
        assert_eq!(recent_window_start(&msgs, NOW), 0);
    }

    #[test]
    fn three_day_old_conversation_keeps_exactly_the_floor() {
        // Everything is outside the 24h window, so only the FLOOR_TURNS floor survives.
        let msgs = aged(12, 3 * DAY);
        let start = recent_window_start(&msgs, NOW);
        assert_eq!(start, 2);
        assert_eq!(msgs.len() - start, FLOOR_MESSAGES); // = 5 turns
    }

    #[test]
    fn mixed_age_keeps_floor_plus_fresh_and_drops_stale_beyond_it() {
        // Oldest 4 rows are 3 days old, the newest 8 are fresh. Rows 2-3 are stale but inside the
        // floor, so they stay; rows 0-1 are stale AND beyond the floor, so they go.
        let mut msgs = aged(4, 3 * DAY);
        msgs.extend(aged(8, 2 * HOUR));
        let start = recent_window_start(&msgs, NOW);
        assert_eq!(start, 2);
        assert_eq!(msgs.len() - start, FLOOR_MESSAGES);
    }

    #[test]
    fn floor_wins_over_window_when_every_turn_is_old() {
        // Exactly 5 old turns: the window would drop all of them, the floor keeps all of them.
        let msgs = aged(FLOOR_MESSAGES, 30 * DAY);
        assert_eq!(recent_window_start(&msgs, NOW), 0);
    }

    #[test]
    fn rows_without_a_timestamp_are_kept() {
        // Rows predating the createdAt stamp carry no age evidence — absence is not staleness.
        let mut msgs: Vec<serde_json::Value> = (0..4)
            .map(|i| serde_json::json!({"role": "user", "content": format!("old{}", i)}))
            .collect();
        msgs.extend(aged(8, HOUR));
        assert_eq!(recent_window_start(&msgs, NOW), 0);
    }
}
