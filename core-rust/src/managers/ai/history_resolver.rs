//! HistoryResolver — 옛 TS history-resolver.ts Rust port.
//!
//! 사용자 발화 + 대화 컨텍스트 → 자동 history 주입.
//!
//! Phase B-17.5+ minimum (IEmbedderPort 미박음):
//! - 옛 TS 의 임베딩 spread 판정 (top1 vs top5 차이 0.030 이상) 은 임베딩 박힌 후 활성
//! - 현재는 ConversationManager.get(owner, conv_id) 의 recent N 메시지를 컨텍스트로 prepend
//!
//! Phase B-15+ 후속 (IEmbedderPort 박힌 후):
//! - core.search_conversation_history(owner, query, limit) 호출 → spread 판정 → 매칭 메시지 prepend
//! - 옛 TS MIN_SPREAD = 0.030 / CLUSTER_GAP = 0.020 / PICK_MAX = 5 그대로

use std::sync::Arc;

use crate::managers::conversation::ConversationManager;

const RECENT_MESSAGE_LIMIT: usize = 5;

pub struct HistoryResolver {
    conversation: Arc<ConversationManager>,
}

impl HistoryResolver {
    pub fn new(conversation: Arc<ConversationManager>) -> Self {
        Self { conversation }
    }

    /// 자동 history 컨텍스트 합성 — 시스템 프롬프트에 prepend 용 마크다운.
    /// 옛 TS compressHistoryWithSearch 의 fallback 모드 (임베딩 미박음 시 recent N).
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::database::SqliteDatabaseAdapter;
    use crate::ports::IDatabasePort;

    fn manager() -> Arc<ConversationManager> {
        let db: Arc<dyn IDatabasePort> = Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        Arc::new(ConversationManager::new(db))
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
