//! ConversationManager — 어드민 채팅 대화 DB 저장 / 조회 / cli_session resume.
//!
//! 옛 TS ConversationManager (`core/managers/conversation-manager.ts`) Rust 재구현.
//! Phase B-10 minimum: CRUD + cli_session + active_plan_state.
//! 임베딩 검색 (search_history) / Share / 메시지 단위 임베딩 동기 등은 Phase B-15+ 후속.

use std::sync::Arc;

use crate::ports::{
    ConversationRecord, ConversationSummary, IDatabasePort, InfraResult,
};

pub struct ConversationManager {
    db: Arc<dyn IDatabasePort>,
}

impl ConversationManager {
    pub fn new(db: Arc<dyn IDatabasePort>) -> Self {
        Self { db }
    }

    pub fn list(&self, owner: &str) -> Vec<ConversationSummary> {
        self.db.list_conversations(owner)
    }

    pub fn get(&self, owner: &str, id: &str) -> Option<ConversationRecord> {
        self.db.get_conversation(owner, id)
    }

    /// 대화 저장 — JSON 직렬화. Phase B-15 에서 메시지 단위 임베딩 동기 추가.
    pub fn save(
        &self,
        owner: &str,
        id: &str,
        title: &str,
        messages: &serde_json::Value,
        created_at: Option<i64>,
    ) -> InfraResult<()> {
        // Tombstone 검사 — 다른 기기에서 삭제된 대화면 reject
        if self.db.is_conversation_deleted(owner, id) {
            return Err(format!("대화 {}는 삭제됨 (tombstone)", id));
        }
        let messages_json = serde_json::to_string(messages)
            .map_err(|e| format!("messages 직렬화 실패: {e}"))?;
        if self.db.save_conversation(owner, id, title, &messages_json, created_at) {
            Ok(())
        } else {
            Err(format!("대화 저장 실패: {}", id))
        }
    }

    pub fn delete(&self, owner: &str, id: &str) -> InfraResult<()> {
        if self.db.delete_conversation(owner, id) {
            Ok(())
        } else {
            Err(format!("대화 삭제 실패: {}", id))
        }
    }

    pub fn is_deleted(&self, owner: &str, id: &str) -> bool {
        self.db.is_conversation_deleted(owner, id)
    }

    /// CLI 모드 session resume — 같은 모델일 때만 재사용. 모델 바뀌면 자동 무효.
    pub fn get_cli_session(&self, conversation_id: &str, current_model: &str) -> Option<String> {
        self.db.get_cli_session(conversation_id, current_model)
    }

    pub fn set_cli_session(&self, conversation_id: &str, session_id: &str, model: &str) -> bool {
        self.db.set_cli_session(conversation_id, session_id, model)
    }

    pub fn get_active_plan_state(&self, conversation_id: &str) -> Option<serde_json::Value> {
        let raw = self.db.get_active_plan_state(conversation_id)?;
        serde_json::from_str(&raw).ok()
    }

    pub fn set_active_plan_state(
        &self,
        conversation_id: &str,
        state: Option<&serde_json::Value>,
    ) -> bool {
        let json = match state {
            Some(v) => match serde_json::to_string(v) {
                Ok(s) => Some(s),
                Err(_) => return false,
            },
            None => None,
        };
        self.db.set_active_plan_state(conversation_id, json.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::database::SqliteDatabaseAdapter;

    fn make_manager() -> ConversationManager {
        let db: Arc<dyn IDatabasePort> = Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        ConversationManager::new(db)
    }

    #[test]
    fn save_get_list_delete_roundtrip() {
        let mgr = make_manager();
        let messages = serde_json::json!([
            {"role": "user", "content": "안녕"},
            {"role": "assistant", "content": "반가워요"}
        ]);

        mgr.save("admin", "c1", "테스트 대화", &messages, None).unwrap();
        let got = mgr.get("admin", "c1").unwrap();
        assert_eq!(got.title, "테스트 대화");
        assert_eq!(got.messages.as_array().unwrap().len(), 2);

        let list = mgr.list("admin");
        assert_eq!(list.len(), 1);

        mgr.delete("admin", "c1").unwrap();
        assert!(mgr.get("admin", "c1").is_none());
    }

    #[test]
    fn deleted_tombstone_rejects_save() {
        let mgr = make_manager();
        mgr.save("admin", "c1", "v1", &serde_json::json!([]), None).unwrap();
        mgr.delete("admin", "c1").unwrap();
        assert!(mgr.is_deleted("admin", "c1"));
        // 같은 owner+id 로 다시 저장하려 하면 reject (tombstone)
        let result = mgr.save("admin", "c1", "v2", &serde_json::json!([]), None);
        assert!(result.is_err());
    }

    #[test]
    fn cli_session_model_match() {
        let mgr = make_manager();
        mgr.save("admin", "c1", "test", &serde_json::json!([]), None).unwrap();
        assert!(mgr.set_cli_session("c1", "sess-abc", "claude-4"));

        // 같은 모델 — 반환 OK
        assert_eq!(
            mgr.get_cli_session("c1", "claude-4"),
            Some("sess-abc".to_string())
        );
        // 다른 모델 — None (자동 무효)
        assert!(mgr.get_cli_session("c1", "gpt-5").is_none());
    }

    #[test]
    fn active_plan_state_roundtrip() {
        let mgr = make_manager();
        mgr.save("admin", "c1", "test", &serde_json::json!([]), None).unwrap();

        assert!(mgr.get_active_plan_state("c1").is_none());
        let state = serde_json::json!({"planId": "p1", "stage": 2});
        assert!(mgr.set_active_plan_state("c1", Some(&state)));
        let got = mgr.get_active_plan_state("c1").unwrap();
        assert_eq!(got["planId"], "p1");
        assert_eq!(got["stage"], 2);

        // None → 삭제
        assert!(mgr.set_active_plan_state("c1", None));
        assert!(mgr.get_active_plan_state("c1").is_none());
    }

    #[test]
    fn list_orders_by_updated_at_desc() {
        let mgr = make_manager();
        mgr.save("admin", "c1", "first", &serde_json::json!([]), Some(1000)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        mgr.save("admin", "c2", "second", &serde_json::json!([]), Some(2000)).unwrap();

        let list = mgr.list("admin");
        assert_eq!(list.len(), 2);
        // 가장 최근 update 가 첫번째
        assert!(list[0].updated_at >= list[1].updated_at);
    }
}
