//! ConversationManager integration test — 옛 core inline tests 이관.
//!
//! private 접근 (mgr.db / message_to_text / sha1_hex / take_chars 등) test 는 inline 유지.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::conversation::{ConversationManager, SearchHistoryOpts};
use firebat_core::ports::{IDatabasePort, IEmbedderPort};
use firebat_infra::adapters::database::SqliteDatabaseAdapter;
use firebat_infra::adapters::embedder::StubEmbedderAdapter;

fn make_manager() -> (ConversationManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let db: Arc<dyn IDatabasePort> =
        Arc::new(SqliteDatabaseAdapter::new(dir.path().join("app.db")).unwrap());
    (ConversationManager::new(db), dir)
}

fn make_manager_with_embedder() -> (ConversationManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let db: Arc<dyn IDatabasePort> =
        Arc::new(SqliteDatabaseAdapter::new(dir.path().join("app.db")).unwrap());
    let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
    (ConversationManager::new(db).with_embedder(embedder), dir)
}

#[test]
fn save_get_list_delete_roundtrip_sync() {
    let (mgr, _dir) = make_manager();
    let messages = serde_json::json!([
        {"role": "user", "content": "안녕"},
        {"role": "assistant", "content": "반가워요"}
    ]);

    mgr.save_sync("admin", "c1", "테스트 대화", &messages, None).unwrap();
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
    let (mgr, _dir) = make_manager();
    mgr.save_sync("admin", "c1", "v1", &serde_json::json!([]), None).unwrap();
    mgr.delete("admin", "c1").unwrap();
    assert!(mgr.is_deleted("admin", "c1"));
    let result = mgr.save_sync("admin", "c1", "v2", &serde_json::json!([]), None);
    assert!(result.is_err());
}

#[test]
fn cli_session_model_match() {
    let (mgr, _dir) = make_manager();
    mgr.save_sync("admin", "c1", "test", &serde_json::json!([]), None)
        .unwrap();
    assert!(mgr.set_cli_session("c1", "sess-abc", "claude-4"));
    assert_eq!(
        mgr.get_cli_session("c1", "claude-4"),
        Some("sess-abc".to_string())
    );
    assert!(mgr.get_cli_session("c1", "gpt-5").is_none());
}

#[test]
fn active_plan_state_roundtrip() {
    let (mgr, _dir) = make_manager();
    mgr.save_sync("admin", "c1", "test", &serde_json::json!([]), None)
        .unwrap();

    assert!(mgr.get_active_plan_state("c1").is_none());
    let state = serde_json::json!({"planId": "p1", "stage": 2});
    assert!(mgr.set_active_plan_state("c1", Some(&state)));
    let got = mgr.get_active_plan_state("c1").unwrap();
    assert_eq!(got["planId"], "p1");
    assert_eq!(got["stage"], 2);

    assert!(mgr.set_active_plan_state("c1", None));
    assert!(mgr.get_active_plan_state("c1").is_none());
}

#[tokio::test]
async fn search_history_returns_match_for_indexed_message() {
    let (mgr, _dir) = make_manager_with_embedder();
    let messages = serde_json::json!([
        {"role": "user", "content": "삼성전자 매수 75000원"},
    ]);
    mgr.save("admin", "c1", "거래", &messages, None).await.unwrap();

    let results = mgr
        .search_history(
            "admin",
            "삼성전자 매수 75000원",
            SearchHistoryOpts {
                min_score: Some(-1.0),
                limit: Some(5),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(!results.is_empty());
    assert_eq!(results[0].conv_id, "c1");
    assert!(results[0].content_preview.contains("삼성전자"));
}

#[tokio::test]
async fn search_history_empty_query_returns_empty() {
    let (mgr, _dir) = make_manager_with_embedder();
    let results = mgr
        .search_history("admin", "", SearchHistoryOpts::default())
        .await
        .unwrap();
    assert!(results.is_empty());
}

#[tokio::test]
async fn search_history_without_embedder_returns_empty() {
    let (mgr, _dir) = make_manager();
    let results = mgr
        .search_history("admin", "anything", SearchHistoryOpts::default())
        .await
        .unwrap();
    assert!(results.is_empty());
}

#[tokio::test]
async fn save_union_merges_with_existing_messages() {
    // 옛 TS unionMergeMessages 1:1 동작 — 모바일·PC 동시 쓰기 시 메시지 유실 방지.
    let (mgr, _dir) = make_manager();
    // PC 가 메시지 2개 저장
    let pc_messages = serde_json::json!([
        {"id": "u-1700000000000", "role": "user", "content": "PC user"},
        {"id": "s-1700000000001", "role": "assistant", "content": "PC reply"}
    ]);
    mgr.save("admin", "c-merge", "t", &pc_messages, None)
        .await
        .unwrap();

    // 모바일 이 자기 메시지만 + 새 메시지 추가해서 저장 (PC 두 번째 메시지 모름)
    let mobile_messages = serde_json::json!([
        {"id": "u-1700000000000", "role": "user", "content": "PC user"},
        {"id": "u-1700000000005", "role": "user", "content": "Mobile user"}
    ]);
    mgr.save("admin", "c-merge", "t", &mobile_messages, None)
        .await
        .unwrap();

    // 결과: 3개 메시지 (PC reply 보존됨)
    let record = mgr.get("admin", "c-merge").unwrap();
    let arr = record.messages.as_array().unwrap();
    assert_eq!(arr.len(), 3);
    let contents: Vec<&str> = arr
        .iter()
        .map(|m| m.get("content").and_then(|v| v.as_str()).unwrap_or(""))
        .collect();
    // timestamp 순 정렬: PC user (000) → PC reply (001) → Mobile user (005)
    assert_eq!(contents, vec!["PC user", "PC reply", "Mobile user"]);
}

// ── 임베딩 sync (Phase B-post audit E4 — `pub fn list_embeddings` 노출 후 이관) ─────

#[tokio::test]
async fn save_with_embedder_indexes_messages() {
    let (mgr, _dir) = make_manager_with_embedder();
    let messages = serde_json::json!([
        {"role": "user", "content": "삼성전자 75000원에 매수"},
        {"role": "assistant", "content": "주문 접수 완료"}
    ]);
    mgr.save("admin", "c1", "거래", &messages, None).await.unwrap();

    let metas = mgr.list_embeddings("admin", "c1");
    assert_eq!(metas.len(), 2);
}

#[tokio::test]
async fn sync_embeddings_grow_with_union_merge() {
    // union_merge_messages 설정된 후 — 메시지는 절대 줄어들지 않고 union 으로 자라기만 함.
    // 모바일·PC 동시 쓰기 race 보호 (옛 TS 1:1).
    let (mgr, _dir) = make_manager_with_embedder();
    let messages = serde_json::json!([
        {"id": "u-1700000000000", "role": "user", "content": "msg 0"},
        {"id": "s-1700000000001", "role": "assistant", "content": "msg 1"},
        {"id": "u-1700000000002", "role": "user", "content": "msg 2"}
    ]);
    mgr.save("admin", "c1", "t", &messages, None).await.unwrap();
    assert_eq!(mgr.list_embeddings("admin", "c1").len(), 3);

    // 두 번째 save — 메시지 1개 추가 (모바일 쪽 새 메시지). union 으로 자람.
    let messages2 = serde_json::json!([
        {"id": "u-1700000000003", "role": "user", "content": "msg 3 from mobile"}
    ]);
    mgr.save("admin", "c1", "t", &messages2, None).await.unwrap();
    let metas = mgr.list_embeddings("admin", "c1");
    // 모든 메시지 보존 (union) → 4개 임베딩
    assert_eq!(metas.len(), 4);
}

#[tokio::test]
async fn delete_cascades_embeddings() {
    let (mgr, _dir) = make_manager_with_embedder();
    let messages = serde_json::json!([{"role": "user", "content": "test"}]);
    mgr.save("admin", "c1", "t", &messages, None).await.unwrap();
    assert_eq!(mgr.list_embeddings("admin", "c1").len(), 1);

    mgr.delete("admin", "c1").unwrap();
    assert_eq!(mgr.list_embeddings("admin", "c1").len(), 0);
}
