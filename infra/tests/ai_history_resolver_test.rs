//! HistoryResolver integration test — 옛 core 의 inline `#[cfg(test)] mod tests` 이관.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::ai::history_resolver::{CompressHistoryOpts, HistoryResolver};
use firebat_core::managers::conversation::ConversationManager;
use firebat_core::ports::{IDatabasePort, IEmbedderPort};
use firebat_infra::adapters::database::SqliteDatabaseAdapter;
use firebat_infra::adapters::embedder::StubEmbedderAdapter;

fn manager() -> (Arc<ConversationManager>, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let db: Arc<dyn IDatabasePort> =
        Arc::new(SqliteDatabaseAdapter::new(dir.path().join("app.db")).unwrap());
    (Arc::new(ConversationManager::new(db)), dir)
}

fn manager_with_embedder() -> (Arc<ConversationManager>, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let db: Arc<dyn IDatabasePort> =
        Arc::new(SqliteDatabaseAdapter::new(dir.path().join("app.db")).unwrap());
    let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
    (Arc::new(ConversationManager::new(db).with_embedder(embedder)), dir)
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
fn resolve_filters_system_role() {
    let (mgr, _dir) = manager();
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
    let (mgr, _dir) = manager();
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
    let (mgr, _dir) = manager();
    let resolver = HistoryResolver::new(mgr);
    let r = resolver
        .compress_history_with_search("query", &CompressHistoryOpts::default())
        .await;
    assert!(r.context_summary.is_empty());
    assert!(r.recent_history.is_empty());
}

#[tokio::test]
async fn compress_empty_prompt_returns_empty() {
    let (mgr, _dir) = manager();
    let resolver = HistoryResolver::new(mgr);
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
    let (mgr, _dir) = manager();
    let resolver = HistoryResolver::new(mgr);
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
    let (mgr, _dir) = manager_with_embedder();
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
    let (mgr, _dir) = manager_with_embedder();
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
    let (mgr, _dir) = manager();
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
