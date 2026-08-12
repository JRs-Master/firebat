//! HistoryResolver integration test — 옛 core 의 inline `#[cfg(test)] mod tests` 이관.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::ai::history_resolver::HistoryResolver;
use firebat_core::managers::conversation::ConversationManager;
use firebat_core::ports::IDatabasePort;
use firebat_infra::adapters::database::SqliteDatabaseAdapter;

fn manager() -> (Arc<ConversationManager>, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let db: Arc<dyn IDatabasePort> =
        Arc::new(SqliteDatabaseAdapter::new(dir.path().join("app.db")).unwrap());
    (Arc::new(ConversationManager::new(db)), dir)
}

#[test]
fn resolve_returns_none_for_unknown_conv() {
    let (mgr, _dir) = manager();
    let resolver = HistoryResolver::new(mgr);
    assert!(resolver.resolve("admin", Some("missing")).is_none());
}

#[test]
fn resolve_returns_recent_messages() {
    let (mgr, _dir) = manager();
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
fn resolve_includes_system_role_as_ai() {
    // AI 응답은 이 스토어에서 role "system" 으로 저장된다 → 직전 발언을 기억하려면 history 에 포함해야 한다
    // (옛엔 제외해 망각하던 root, hub 는 system→assistant 로 이미 포함). 이제 [AI] 라벨로 포함.
    let (mgr, _dir) = manager();
    let messages = serde_json::json!([
        {"role": "system", "content": "이전 답변 내용"},
        {"role": "user", "content": "안녕"},
    ]);
    mgr.save_sync("admin", "c1", "test", &messages, None).unwrap();
    let resolver = HistoryResolver::new(mgr);
    let ctx = resolver.resolve("admin", Some("c1")).unwrap();
    assert!(ctx.contains("이전 답변 내용")); // AI 응답(system) 포함
    assert!(ctx.contains("안녕"));
    assert!(ctx.contains("[AI]")); // system → AI 라벨
}

#[test]
fn resolve_includes_lone_system_message() {
    // AI 응답(system) 하나만 있어도 컨텍스트 생성 (옛엔 None — system 제외라서). 이제 포함되어 Some.
    let (mgr, _dir) = manager();
    let messages = serde_json::json!([
        {"role": "system", "content": "init reply"}
    ]);
    mgr.save_sync("admin", "c1", "test", &messages, None).unwrap();
    let resolver = HistoryResolver::new(mgr);
    let ctx = resolver.resolve("admin", Some("c1")).unwrap();
    assert!(ctx.contains("init reply"));
}

// ── resolve (recent N window) ────────────────────────────────────────────

#[test]
fn resolve_limits_to_recent_n() {
    let (mgr, _dir) = manager();
    let mut msgs: Vec<serde_json::Value> = Vec::new();
    for i in 0..20 {
        msgs.push(serde_json::json!({
            "role": "user",
            "content": format!("message {}", i)
        }));
    }
    let messages = serde_json::Value::Array(msgs);
    mgr.save_sync("admin", "c1", "long", &messages, None).unwrap();
    let resolver = HistoryResolver::new(mgr);
    let ctx = resolver.resolve("admin", Some("c1")).unwrap();
    // RECENT_MESSAGE_LIMIT = 12, 가장 오래된 메시지 (message 0~7) 는 미포함
    assert!(!ctx.contains("message 0"));
    assert!(!ctx.contains("message 7"));
    assert!(ctx.contains("message 19"));
}
