//! Integration tests for `core::managers::ai::prompt_builder::PromptBuilder`.
//! Phase B-post audit E4 — inline tests 이관 (private const 정리 후).
//!
//! 2026-05-16: 옛 `IPromptLoaderPort` / `FilePromptLoader` 폐기 후 — `firebat_core::i18n`
//! 통합 다국어 loader 가 `system/prompts/{name}/lang/{lang}.md` 자동 scan. 매 prompt build 시점
//! `i18n::prompt(name, None)` lookup. 본 test 의 setup = workspace root 기준 `i18n::init` 1회 호출.

use std::path::PathBuf;
use std::sync::{Arc, Once};

use firebat_core::managers::ai::prompt_builder::{CronAgentContext, PromptBuilder};
use firebat_core::ports::IVaultPort;
use firebat_core::vault_keys::{VK_SYSTEM_TIMEZONE, VK_SYSTEM_USER_PROMPT};
use firebat_infra::adapters::vault::SqliteVaultAdapter;

static INIT_I18N: Once = Once::new();

/// workspace root 기준 `i18n::init` 1회 — CARGO_MANIFEST_DIR = infra/ 의 부모.
fn init_i18n_once() {
    INIT_I18N.call_once(|| {
        let workspace_root: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("infra crate 의 parent (workspace root)")
            .to_path_buf();
        firebat_core::i18n::init(&workspace_root);
    });
}

fn vault() -> (Arc<dyn IVaultPort>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let v: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    (v, dir)
}

fn pb(v: Arc<dyn IVaultPort>) -> PromptBuilder {
    init_i18n_once();
    PromptBuilder::new(v)
}

#[test]
fn base_prompt_contains_tool_system_sections() {
    let (v, _dir) = vault();
    let pb = pb(v);
    let prompt = pb.build(None, None);
    assert!(prompt.contains("Firebat 도구 사용 시스템"));
    assert!(prompt.contains("도구 사용 원칙"));
    assert!(prompt.contains("컴포넌트 렌더링"));
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
