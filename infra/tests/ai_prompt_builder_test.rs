//! Integration tests for `core::managers::ai::prompt_builder::PromptBuilder`.
//!
//! These load the REAL `system/prompts/*.md`. Those ship on the pull channel, while this workflow
//! runs only on `core/**` · `infra/**` · `proto/**` — so a prompt edit triggers no CI, and whatever
//! goes red because of it surfaces days later on somebody else's Rust commit, blaming their change.
//! The two kinds of test here are therefore kept apart on purpose:
//!
//! - **Machine tests** (substitution, prepend order, vault → prompt) assert only on values the test
//!   itself supplies. The prompts can be reworded freely; these cannot notice, and must not.
//! - **Discipline tests** — `base_prompt_carries_the_contracts_the_code_parses` and
//!   `the_prompt_guides_by_consequence_rather_than_prohibition` — are ABOUT the text and are meant
//!   to go red on a bad edit. They take the delayed-blame cost knowingly; each says what it pins.
//!
//! Putting a wording assertion inside a machine test spends that cost where nobody agreed to it.
//! (Known gap, stated in ci-rust.yml: `system/**` is deliberately outside `paths:` because adding
//! it would mean a ~10min rebuild per module edit.)

use std::path::PathBuf;
use std::sync::{Arc, Once};

use firebat_core::managers::ai::prompt_builder::{CronAgentContext, PromptBuilder};
use firebat_core::ports::IVaultPort;
use firebat_core::vault_keys::{VK_SYSTEM_TIMEZONE, VK_SYSTEM_USER_PROMPT};
use firebat_infra::adapters::vault::SqliteVaultAdapter;

static INIT_ONCE: Once = Once::new();

/// workspace root 기준 i18n + prompt_store init 1회 — CARGO_MANIFEST_DIR = infra/ 의 부모.
/// 시스템 프롬프트는 단일 영어 파일 system/prompts/{name}.md → prompt_store (2026-06-08, i18n 에서 분리).
fn init_once() {
    INIT_ONCE.call_once(|| {
        let workspace_root: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("infra crate 의 parent (workspace root)")
            .to_path_buf();
        firebat_core::i18n::init(&workspace_root);
        firebat_core::prompt_store::init(&workspace_root.join("system").join("prompts"));
    });
}

fn vault() -> (Arc<dyn IVaultPort>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let v: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    (v, dir)
}

fn pb(v: Arc<dyn IVaultPort>) -> PromptBuilder {
    init_once();
    PromptBuilder::new(v)
}

/// The base prompt still carries the contracts the CODE depends on.
///
/// This used to list section headings — "Tool usage principles", "Scheduling", "Page generation
/// guide" — which made it a hand-copied table of contents. The 2026-08-15 diet cut the prompt
/// from 46,914 to 4,870 characters by removing case law, and every one of those headings went
/// with it, so the test failed for the one change it should have waved through.
///
/// What a prompt test can usefully pin is what breaks silently if it disappears: the shapes a
/// parser reads and the protocols a response speaks. Section names are prose and may be rewritten
/// freely; these strings may not.
#[test]
fn base_prompt_carries_the_contracts_the_code_parses() {
    let (v, _dir) = vault();
    let pb = pb(v);
    let prompt = pb.build(None, None, None);
    assert!(prompt.contains("Firebat is an AI agent"), "the opening line identifies the prompt");
    // The fence the reply parser reads, and the prop that makes the server inject cached rows.
    assert!(prompt.contains("```firebat-render"), "render fence grammar");
    assert!(prompt.contains("dataCacheKey"), "the prop the server fills from the cache");
    // The key protocol: responses hand one over, cache_read / cache_grep take it back.
    assert!(prompt.contains("_cacheKey"), "cache key protocol");
    // The ladder `conversation_scope` actually enforces — a call whose schema was not fetched in
    // the window is refused before it runs.
    assert!(prompt.contains("search_module_actions"), "ladder step one");
    assert!(prompt.contains("get_action_schema"), "ladder step two");
}

/// The system prompt guides by stating consequences, not by issuing bans (user's call, 2026-08-14).
///
/// "Calling without the form returns a refusal and spends a round" carries the same instruction as
/// "never call without the form", and it stays true on the turns where the model is doing nothing
/// wrong — so it reads as information rather than as suspicion. The sweep that converted ~85 lines
/// is easy to undo one edit at a time, which is what this test is for.
///
/// Descriptive negations are untouched and belong here: "the user never receives it" and "props you
/// don't know exactly" state facts. What the list below catches is the imperative forms.
#[test]
fn the_prompt_guides_by_consequence_rather_than_prohibition() {
    let (v, _dir) = vault();
    let pb = pb(v);
    let prompt = pb.build(None, None, None);

    // Sentence- or bullet-initial imperatives, plus the loud markers. Matched case-sensitively
    // where capitalization is what makes it imperative, so "…and do not" inside a clause survives.
    for banned in [
        "Do not ",
        "Do NOT ",
        "do **NOT**",
        "**Never",
        "must not",
        "Must not",
        "strictly forbidden",
        "is forbidden",
        "are forbidden",
        "Forbidden:",
        "Forbidden phrasing",
        "Prohibitions",
        "not allowed",
        "prohibited",
    ] {
        assert!(
            !prompt.contains(banned),
            "system prompt reverted to prohibition phrasing: {banned:?}\n\
             State what happens instead — the consequence says the same thing and stays true when \
             the model is complying."
        );
    }
}

#[test]
fn user_prompt_appended_when_set() {
    let (v, _dir) = vault();
    v.set_secret(VK_SYSTEM_USER_PROMPT, "당신은 도메인 전문가입니다.");
    let pb = pb(v);
    let prompt = pb.build(None, None, None);
    assert!(prompt.contains("도메인 전문가"));
    assert!(prompt.contains("USER_INSTRUCTIONS"));
    assert!(prompt.contains("사용자 지시사항"));
}

#[test]
fn user_prompt_skipped_when_empty() {
    let (v, _dir) = vault();
    v.set_secret(VK_SYSTEM_USER_PROMPT, "");
    let pb = pb(v);
    let prompt = pb.build(None, None, None);
    assert!(!prompt.contains("USER_INSTRUCTIONS"));
    assert!(!prompt.contains("사용자 지시사항"));
}

#[test]
fn timezone_default_seoul_appears_in_prompt() {
    let (v, _dir) = vault();
    let pb = pb(v);
    let prompt = pb.build(None, None, None);
    // Vault 미설정 → Asia/Seoul fallback
    assert!(prompt.contains("Asia/Seoul"));
}

#[test]
fn timezone_override_via_vault() {
    let (v, _dir) = vault();
    v.set_secret(VK_SYSTEM_TIMEZONE, "America/New_York");
    let pb = pb(v);
    let prompt = pb.build(None, None, None);
    assert!(prompt.contains("America/New_York"));
    // The zone is stated next to the clock, so a model reading "now" reads it in the right zone.
    // (The old anchor was a "Timezone:" label that the 2026-08-15 diet folded into this line.)
    let idx = prompt.find("Current time:").expect("the prompt states the current time");
    let line: String = prompt[idx..].lines().next().unwrap_or_default().to_string();
    assert!(
        line.contains("America/New_York"),
        "the clock must carry its zone, or `now` is ambiguous: {line}"
    );
}

#[test]
fn extra_context_replaces_system_context_placeholder() {
    let (v, _dir) = vault();
    let pb = pb(v);
    let prompt = pb.build(Some("등록된 sysmod: kiwoom, naver-search"), None, None);
    assert!(prompt.contains("등록된 sysmod: kiwoom, naver-search"));
    assert!(!prompt.contains("{system_context}"));
}

/// Both anchors are values this test supplies, so the two prompt files can be reworded freely.
///
/// It used to anchor on prose from the files — "Cron Agent mode", "while the user is away", and
/// the base prompt's opening line. Those live on the pull channel, where an edit does not run this
/// workflow at all (`paths:` is core/infra/proto), so a reword went red days later on somebody
/// else's Rust commit, pointing at their change instead of the edit. The 2026-09-02 rewrite of
/// `cron_agent.md` only survived because those two phrases happened to be kept.
///
/// Nothing is lost by dropping them: `{job_id}` is substituted ONLY into the prelude and
/// `{system_context}` ONLY into the base (prompt_builder.rs), so finding each one proves its half
/// is present, and their order proves the prepend. A prose assertion on top of that caught
/// rewording — which is not a defect.
#[test]
fn cron_agent_prelude_prepended() {
    let (v, _dir) = vault();
    let pb = pb(v);
    let prompt = pb.build(
        Some("SYSTEM-CONTEXT-MARKER"),
        Some(&CronAgentContext {
            job_id: "job-2026-04-25-stock-weekly".to_string(),
            title: Some("주간 증시 일정".to_string()),
        }),
        None,
    );
    let prelude_idx = prompt
        .find("job-2026-04-25-stock-weekly")
        .expect("the prelude is present — {job_id} is substituted nowhere else");
    assert!(prompt.contains("주간 증시 일정"), "{{job_title_line}} carries the title");
    let base_idx = prompt
        .find("SYSTEM-CONTEXT-MARKER")
        .expect("the base prompt is present — {system_context} is substituted nowhere else");
    assert!(prelude_idx < base_idx, "the prelude goes before the base prompt");
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
        None,
    );
    assert!(prompt.contains("job-id-only"));
    assert!(!prompt.contains("{job_title_line}"));
}

#[test]
fn no_unreplaced_placeholders_in_default_build() {
    let (v, _dir) = vault();
    let pb = pb(v);
    let prompt = pb.build(Some("ctx"), None, None);
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
        None,
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
