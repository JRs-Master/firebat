//! Integration tests for `core::managers::ai::prompt_builder::PromptBuilder`.
//! Phase B-post audit E4 — inline tests 이관 (private const 정리 후).

use std::sync::Arc;

use firebat_core::managers::ai::prompt_builder::{CronAgentContext, PromptBuilder};
use firebat_core::ports::{IPromptLoaderPort, IVaultPort};
use firebat_core::vault_keys::{VK_SYSTEM_TIMEZONE, VK_SYSTEM_USER_PROMPT};
use firebat_infra::adapters::prompt_loader::FilePromptLoader;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

fn vault() -> (Arc<dyn IVaultPort>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let v: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    (v, dir)
}

/// 테스트용 prompt loader — CARGO_MANIFEST_DIR/../infra/data/prompts/ 기준.
/// (이 test 가 infra crate 의 integration test 라 MANIFEST_DIR = infra/, prompts = infra/data/prompts/).
fn prompt_loader() -> Arc<dyn IPromptLoaderPort> {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("data/prompts");
    Arc::new(FilePromptLoader::new(dir))
}

fn pb(v: Arc<dyn IVaultPort>) -> PromptBuilder {
    PromptBuilder::new(v, prompt_loader())
}

#[test]
fn base_prompt_contains_tool_system_sections() {
    let (v, _dir) = vault();
    let pb = pb(v);
    let prompt = pb.build(None, None);
    assert!(prompt.contains("Firebat 도구 사용 시스템"));
    assert!(prompt.contains("도구 사용 원칙"));
    assert!(prompt.contains("컴포넌트 카탈로그"));
    assert!(prompt.contains("Reusable 5 규칙"));
    assert!(prompt.contains("스케줄링"));
    assert!(prompt.contains("파이프라인"));
    assert!(prompt.contains("페이지 생성 가이드"));
    assert!(prompt.contains("메타 인지 룰"));
}

#[test]
fn user_prompt_appended_when_set() {
    let (v, _dir) = vault();
    v.set_secret(VK_SYSTEM_USER_PROMPT, "당신은 도메인 전문가입니다.");
    let pb = pb(v);
    let prompt = pb.build(None, None);
    assert!(prompt.contains("도메인 전문가"));
    assert!(prompt.contains("USER_INSTRUCTIONS"));
    assert!(prompt.contains("사용자 지시사항"));
}

#[test]
fn user_prompt_skipped_when_empty() {
    let (v, _dir) = vault();
    v.set_secret(VK_SYSTEM_USER_PROMPT, "");
    let pb = pb(v);
    let prompt = pb.build(None, None);
    assert!(!prompt.contains("USER_INSTRUCTIONS"));
    assert!(!prompt.contains("사용자 지시사항"));
}

#[test]
fn timezone_default_seoul_appears_in_prompt() {
    let (v, _dir) = vault();
    let pb = pb(v);
    let prompt = pb.build(None, None);
    // Vault 미설정 → Asia/Seoul fallback
    assert!(prompt.contains("Asia/Seoul"));
}

#[test]
fn timezone_override_via_vault() {
    let (v, _dir) = vault();
    v.set_secret(VK_SYSTEM_TIMEZONE, "America/New_York");
    let pb = pb(v);
    let prompt = pb.build(None, None);
    assert!(prompt.contains("America/New_York"));
    let scheduling_section_idx = prompt.find("타임존:").expect("타임존 섹션 필요");
    let scheduling_section = &prompt[scheduling_section_idx..scheduling_section_idx + 200];
    assert!(scheduling_section.contains("America/New_York"));
}

#[test]
fn extra_context_replaces_system_context_placeholder() {
    let (v, _dir) = vault();
    let pb = pb(v);
    let prompt = pb.build(Some("등록된 sysmod: kiwoom, naver-search"), None);
    assert!(prompt.contains("등록된 sysmod: kiwoom, naver-search"));
    assert!(!prompt.contains("{system_context}"));
}

#[test]
fn cron_agent_prelude_prepended() {
    let (v, _dir) = vault();
    let pb = pb(v);
    let prompt = pb.build(
        None,
        Some(&CronAgentContext {
            job_id: "job-2026-04-25-stock-weekly".to_string(),
            title: Some("주간 증시 일정".to_string()),
        }),
    );
    assert!(prompt.contains("Cron Agent 모드"));
    assert!(prompt.contains("job-2026-04-25-stock-weekly"));
    assert!(prompt.contains("주간 증시 일정"));
    assert!(prompt.contains("사용자 부재 중"));
    let prelude_idx = prompt.find("Cron Agent 모드").unwrap();
    let base_idx = prompt.find("도구 사용 원칙").unwrap();
    assert!(prelude_idx < base_idx);
}

#[test]
fn cron_agent_without_title_handles_gracefully() {
    let (v, _dir) = vault();
    let pb = pb(v);
    let prompt = pb.build(
        None,
        Some(&CronAgentContext {
            job_id: "job-id-only".to_string(),
            title: None,
        }),
    );
    assert!(prompt.contains("job-id-only"));
    assert!(!prompt.contains("{job_title_line}"));
}

#[test]
fn no_unreplaced_placeholders_in_default_build() {
    let (v, _dir) = vault();
    let pb = pb(v);
    let prompt = pb.build(Some("ctx"), None);
    let unreplaced_patterns = ["{system_context}", "{user_tz}", "{now_korean}", "{user_section}"];
    for pattern in unreplaced_patterns {
        assert!(!prompt.contains(pattern), "placeholder {} 미치환", pattern);
    }
}

#[test]
fn cron_agent_replaces_all_placeholders() {
    let (v, _dir) = vault();
    let pb = pb(v);
    let prompt = pb.build(
        Some("ctx"),
        Some(&CronAgentContext {
            job_id: "test-job".to_string(),
            title: Some("test title".to_string()),
        }),
    );
    let unreplaced_patterns = [
        "{system_context}",
        "{user_tz}",
        "{now_korean}",
        "{user_section}",
        "{job_id}",
        "{job_title_line}",
    ];
    for pattern in unreplaced_patterns {
        assert!(!prompt.contains(pattern), "placeholder {} 미치환", pattern);
    }
}
