//! ToolDispatcher integration test — 옛 core inline tests 이관.

use std::path::PathBuf;
use std::sync::{Arc, Once};
use serde_json::json;
use tempfile::TempDir;

use firebat_core::managers::ai::tool_dispatcher::{CallTarget, ToolDispatcher};
use firebat_core::ports::{IStoragePort, ToolCall};
use firebat_infra::adapters::storage::LocalStorageAdapter;

/// workspace root 기준 `i18n::init` 1회 — 미호출 시 i18n::t() 가 raw key 반환.
fn init_i18n_once() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let workspace_root: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("infra crate 의 parent (workspace root)")
            .to_path_buf();
        firebat_core::i18n::init(&workspace_root);
    });
}

fn make_dispatcher() -> (ToolDispatcher, TempDir) {
    init_i18n_once();
    let tmp = tempfile::tempdir().unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(tmp.path()));
    (ToolDispatcher::new(storage), tmp)
}

fn tool_call(name: &str, args: serde_json::Value) -> ToolCall {
    ToolCall {
        id: name.to_string(),
        name: name.to_string(),
        arguments: args,
    }
}

// ── resolve_call_target ──────────────────────────────────────────────────

#[tokio::test]
async fn resolve_with_no_modules_returns_none() {
    let (d, _tmp) = make_dispatcher();
    assert!(d.resolve_call_target("nonexistent").await.is_none());
}

#[tokio::test]
async fn resolve_module_with_variants() {
    let tmp = tempfile::tempdir().unwrap();
    let storage_concrete = LocalStorageAdapter::new(tmp.path());
    // system/modules/kakao-talk + user/modules/my_module 저장
    storage_concrete
        .write("system/modules/kakao-talk/index.mjs", "// stub")
        .await
        .unwrap();
    storage_concrete
        .write("user/modules/my_module/index.mjs", "// stub")
        .await
        .unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(storage_concrete);
    let d = ToolDispatcher::new(storage);

    // 정확한 이름
    assert!(matches!(
        d.resolve_call_target("kakao-talk").await,
        Some(CallTarget::Execute { .. })
    ));
    // snake → kebab 변형
    assert!(matches!(
        d.resolve_call_target("kakao_talk").await,
        Some(CallTarget::Execute { .. })
    ));
    // sysmod_ 접두사
    assert!(matches!(
        d.resolve_call_target("sysmod_kakao_talk").await,
        Some(CallTarget::Execute { .. })
    ));
    // user/modules — kebab 변형
    assert!(matches!(
        d.resolve_call_target("my-module").await,
        Some(CallTarget::Execute { .. })
    ));
}

#[tokio::test]
async fn resolve_uses_60sec_cache() {
    let tmp = tempfile::tempdir().unwrap();
    let storage_concrete = LocalStorageAdapter::new(tmp.path());
    storage_concrete
        .write("system/modules/foo/index.mjs", "// stub")
        .await
        .unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(storage_concrete);
    let d = ToolDispatcher::new(storage);

    // 첫 호출 — 캐시 빌드
    let r1 = d.resolve_call_target("foo").await;
    assert!(r1.is_some());
    // 두번째 호출 — 캐시 hit (시간 매우 짧음)
    let r2 = d.resolve_call_target("foo").await;
    assert!(r2.is_some());
}

// ── check_needs_approval ─────────────────────────────────────────────────

#[tokio::test]
async fn approval_new_file_skipped() {
    let (d, _tmp) = make_dispatcher();
    // 파일 미존재 → 즉시 작성 OK (None)
    let r = d
        .check_needs_approval(&tool_call(
            "write_file",
            json!({"path": "user/new.txt", "content": "x"}),
        ))
        .await;
    assert!(r.is_none());
}

#[tokio::test]
async fn approval_existing_file_required() {
    let tmp = tempfile::tempdir().unwrap();
    let storage_concrete = LocalStorageAdapter::new(tmp.path());
    storage_concrete.write("user/exist.txt", "old").await.unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(storage_concrete);
    let d = ToolDispatcher::new(storage);

    let r = d
        .check_needs_approval(&tool_call(
            "write_file",
            json!({"path": "user/exist.txt", "content": "new"}),
        ))
        .await;
    assert!(r.is_some());
    assert!(r.unwrap().summary.contains("파일 수정"));
}

#[tokio::test]
async fn approval_delete_always_required() {
    let (d, _tmp) = make_dispatcher();
    let r = d
        .check_needs_approval(&tool_call("delete_file", json!({"path": "x"})))
        .await;
    assert!(r.is_some());
    assert!(r.unwrap().summary.contains("파일 삭제"));

    let r2 = d
        .check_needs_approval(&tool_call("delete_page", json!({"slug": "y"})))
        .await;
    assert!(r2.is_some());
    assert!(r2.unwrap().summary.contains("페이지 삭제"));
}

#[tokio::test]
async fn approval_schedule_task_with_when() {
    let (d, _tmp) = make_dispatcher();
    let r = d
        .check_needs_approval(&tool_call(
            "schedule_task",
            json!({"title": "주간 시황", "cronTime": "0 9 * * 1"}),
        ))
        .await;
    assert!(r.is_some());
    let s = r.unwrap().summary;
    assert!(s.contains("예약 등록"));
    assert!(s.contains("주간 시황"));
    assert!(s.contains("0 9 * * 1"));
}

#[tokio::test]
async fn approval_unknown_tool_returns_none() {
    let (d, _tmp) = make_dispatcher();
    let r = d.check_needs_approval(&tool_call("render_table", json!({}))).await;
    assert!(r.is_none());
}

// ── pre_validate_pending_args ────────────────────────────────────────────

#[test]
fn validate_schedule_task_missing_target_and_pipeline() {
    let (d, _tmp) = make_dispatcher();
    // targetPath / pipeline / agent 모드 모두 없음
    let err = d
        .pre_validate_pending_args(&tool_call("schedule_task", json!({"cronTime": "0 9 * * *"})))
        .unwrap();
    assert!(err.contains("targetPath 또는 pipeline"));
}

#[test]
fn validate_schedule_task_missing_when() {
    let (d, _tmp) = make_dispatcher();
    let err = d
        .pre_validate_pending_args(&tool_call(
            "schedule_task",
            json!({"targetPath": "system/modules/kakao-talk/index.mjs"}),
        ))
        .unwrap();
    assert!(err.contains("cronTime / runAt / delaySec"));
}

#[test]
fn validate_schedule_task_agent_mode_no_prompt() {
    let (d, _tmp) = make_dispatcher();
    let err = d
        .pre_validate_pending_args(&tool_call(
            "schedule_task",
            json!({"executionMode": "agent", "cronTime": "0 9 * * *"}),
        ))
        .unwrap();
    assert!(err.contains("agentPrompt 필수"));
}

#[test]
fn validate_schedule_task_pipeline_invalid_step() {
    let (d, _tmp) = make_dispatcher();
    let err = d
        .pre_validate_pending_args(&tool_call(
            "schedule_task",
            json!({
                "cronTime": "0 9 * * *",
                "pipeline": [{"type": "UNKNOWN"}]
            }),
        ))
        .unwrap();
    assert!(err.contains("알 수 없는 type"));
}

#[test]
fn validate_pipeline_execute_missing_input_data() {
    let (d, _tmp) = make_dispatcher();
    // EXECUTE 의 잘못된 평면 인자 (action / symbol step 자체에 설정) — inputData 객체 누락
    let err = d
        .pre_validate_pending_args(&tool_call(
            "schedule_task",
            json!({
                "cronTime": "0 9 * * *",
                "pipeline": [
                    {"type": "EXECUTE", "path": "system/modules/kiwoom/index.mjs",
                     "action": "price", "symbol": "005930"}
                ]
            }),
        ))
        .unwrap();
    assert!(err.contains("inputData 객체"));
}

#[test]
fn validate_pipeline_mcp_call_missing_server_tool() {
    let (d, _tmp) = make_dispatcher();
    let err = d
        .pre_validate_pending_args(&tool_call(
            "schedule_task",
            json!({
                "cronTime": "0 9 * * *",
                "pipeline": [{"type": "MCP_CALL"}]
            }),
        ))
        .unwrap();
    assert!(err.contains("server, tool 필수"));
}

#[test]
fn validate_pipeline_valid_pipeline_passes() {
    let (d, _tmp) = make_dispatcher();
    let r = d.pre_validate_pending_args(&tool_call(
        "schedule_task",
        json!({
            "title": "test",
            "cronTime": "0 9 * * *",
            "pipeline": [
                {"type": "EXECUTE", "path": "x.mjs", "inputData": {"a": 1}},
                {"type": "LLM_TRANSFORM", "instruction": "summarize"}
            ]
        }),
    ));
    assert!(r.is_none());
}

#[test]
fn validate_write_file_missing_path() {
    let (d, _tmp) = make_dispatcher();
    let err = d
        .pre_validate_pending_args(&tool_call("write_file", json!({"content": "x"})))
        .unwrap();
    assert!(err.contains("path 필수"));
}

#[test]
fn validate_write_file_missing_content() {
    let (d, _tmp) = make_dispatcher();
    let err = d
        .pre_validate_pending_args(&tool_call("write_file", json!({"path": "x.txt"})))
        .unwrap();
    assert!(err.contains("content 필수"));
}

#[test]
fn validate_save_page_missing_slug() {
    let (d, _tmp) = make_dispatcher();
    let err = d
        .pre_validate_pending_args(&tool_call("save_page", json!({"spec": {}})))
        .unwrap();
    assert!(err.contains("slug 필수"));
}

#[test]
fn validate_save_page_missing_spec() {
    let (d, _tmp) = make_dispatcher();
    let err = d
        .pre_validate_pending_args(&tool_call("save_page", json!({"slug": "x"})))
        .unwrap();
    assert!(err.contains("spec 필수"));
}

#[test]
fn validate_unknown_tool_passes() {
    let (d, _tmp) = make_dispatcher();
    // 검증 안 설정된 도구는 None (즉시 실행 OK)
    let r = d.pre_validate_pending_args(&tool_call("render_table", json!({})));
    assert!(r.is_none());
}
