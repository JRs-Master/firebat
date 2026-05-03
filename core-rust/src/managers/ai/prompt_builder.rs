//! AiManager 시스템 프롬프트 builder.
//!
//! 옛 TS `core/managers/ai/prompt-builder.ts` 1:1 port (823 LOC).
//! buildToolSystemPrompt (500+ LOC) + buildCronAgentPrelude (12 룰) + buildTemplateBlock 통합.
//!
//! 큰 prompt 본문은 별도 markdown 파일 (`prompt_tool_system.md` / `prompt_cron_agent.md`) 에
//! `include_str!` 으로 박힘. 동적 placeholder 만 runtime replace.
//!
//! Placeholder 형식:
//!   - `{system_context}` — gatherSystemContext 결과 (sysmod 동적 description)
//!   - `{user_tz}` — 사용자 timezone (Vault `system:timezone`)
//!   - `{now_korean}` — 현재 시각 한국어 표시 (사용자 timezone 기준)
//!   - `{banned_internal_line}` — 모델별 차단 내부 도구 (옵션)
//!   - `{user_section}` — Vault `system:user-prompt` 박힘 시 추가 섹션
//!   - cron-agent 만: `{job_id}` / `{job_title_line}`

use std::sync::Arc;

use chrono::{TimeZone, Utc};
use chrono_tz::Tz;

use crate::ports::IVaultPort;

const VK_USER_PROMPT: &str = "system:user-prompt";
const VK_TIMEZONE: &str = "system:timezone";
const DEFAULT_TZ: &str = "Asia/Seoul";

const TOOL_SYSTEM_TEMPLATE: &str = include_str!("prompt_tool_system.md");
const CRON_AGENT_TEMPLATE: &str = include_str!("prompt_cron_agent.md");

/// Cron agent 모드 옵션 — `build` 호출 시 박혀있으면 prelude prepend.
#[derive(Debug, Clone)]
pub struct CronAgentContext {
    pub job_id: String,
    pub title: Option<String>,
}

pub struct PromptBuilder {
    vault: Arc<dyn IVaultPort>,
}

impl PromptBuilder {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self { vault }
    }

    /// 사용자 timezone resolve — Vault `system:timezone` (default `Asia/Seoul`).
    fn user_tz(&self) -> Tz {
        let tz_str = self
            .vault
            .get_secret(VK_TIMEZONE)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_TZ.to_string());
        tz_str.parse::<Tz>().unwrap_or(Tz::Asia__Seoul)
    }

    /// 현재 시각 한국어 표시 — 사용자 timezone 기준.
    fn now_korean(&self) -> String {
        let tz = self.user_tz();
        let now_local = tz.from_utc_datetime(&Utc::now().naive_utc());
        // `2026. 5. 4. 오후 3:42:18` 식 한국 locale 형식 — chrono 의 `%` format 으로 흉내
        // 한국 locale 정확 동작은 sys locale 에 의존. 일반 ISO + tz 표기로 안전 폴백.
        now_local.format("%Y-%m-%d %H:%M:%S").to_string()
    }

    /// 시스템 프롬프트 빌드 — base + extra_context + cron-agent 옵션 + user prompt 주입.
    /// 옛 TS PromptBuilder.build() 1:1.
    pub fn build(&self, extra_context: Option<&str>, cron_agent: Option<&CronAgentContext>) -> String {
        let user_tz = self.user_tz();
        let user_tz_str = user_tz.name();
        let now_korean = self.now_korean();
        let user_prompt = self
            .vault
            .get_secret(VK_USER_PROMPT)
            .filter(|s| !s.trim().is_empty());
        let user_section = match &user_prompt {
            Some(p) => format!(
                "\n\n## 사용자 지시사항 (관리자가 직접 설정 — 시스템 규칙보다 후순위)\n<USER_INSTRUCTIONS>\n{}\n</USER_INSTRUCTIONS>",
                p
            ),
            None => String::new(),
        };

        // banned_internal_line 은 모델별 — 박힐 곳 마련. 현재 비워둠 (LLM port 의 trait fn
        // get_banned_internal_tools 박힌 후 wired up). 옛 TS 의 빈 string fallback 패턴 1:1.
        let banned_internal_line = String::new();

        // 시스템 컨텍스트 — extra_context 박혀있으면 그것, 아니면 빈 string
        let system_context = extra_context.unwrap_or("(시스템 컨텍스트 미박음)");

        let base = TOOL_SYSTEM_TEMPLATE
            .replace("{system_context}", system_context)
            .replace("{user_tz}", user_tz_str)
            .replace("{now_korean}", &now_korean)
            .replace("{banned_internal_line}", &banned_internal_line)
            .replace("{user_section}", &user_section);

        // Cron agent prelude — 박혀있으면 base 앞에 prepend
        if let Some(ctx) = cron_agent {
            let job_title_line = match &ctx.title {
                Some(t) => format!("제목: {}", t),
                None => String::new(),
            };
            let prelude = CRON_AGENT_TEMPLATE
                .replace("{job_id}", &ctx.job_id)
                .replace("{job_title_line}", &job_title_line)
                .replace("{user_tz}", user_tz_str)
                .replace("{now_korean}", &now_korean);
            return format!("{}\n\n{}", prelude, base);
        }

        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::vault::SqliteVaultAdapter;
    use tempfile::tempdir;

    fn vault() -> (Arc<dyn IVaultPort>, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let v: Arc<dyn IVaultPort> =
            Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
        (v, dir)
    }

    #[test]
    fn base_prompt_contains_tool_system_sections() {
        let (v, _dir) = vault();
        let pb = PromptBuilder::new(v);
        let prompt = pb.build(None, None);
        // 옛 TS prompt 의 핵심 섹션들 존재 검증
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
        v.set_secret(VK_USER_PROMPT, "당신은 자동매매 전문가입니다.");
        let pb = PromptBuilder::new(v);
        let prompt = pb.build(None, None);
        assert!(prompt.contains("자동매매 전문가"));
        assert!(prompt.contains("USER_INSTRUCTIONS"));
        assert!(prompt.contains("사용자 지시사항"));
    }

    #[test]
    fn user_prompt_skipped_when_empty() {
        let (v, _dir) = vault();
        v.set_secret(VK_USER_PROMPT, "");
        let pb = PromptBuilder::new(v);
        let prompt = pb.build(None, None);
        assert!(!prompt.contains("USER_INSTRUCTIONS"));
        assert!(!prompt.contains("사용자 지시사항"));
    }

    #[test]
    fn timezone_default_seoul_appears_in_prompt() {
        let (v, _dir) = vault();
        let pb = PromptBuilder::new(v);
        let prompt = pb.build(None, None);
        // Vault 미설정 → Asia/Seoul fallback
        assert!(prompt.contains("Asia/Seoul"));
    }

    #[test]
    fn timezone_override_via_vault() {
        let (v, _dir) = vault();
        v.set_secret(VK_TIMEZONE, "America/New_York");
        let pb = PromptBuilder::new(v);
        let prompt = pb.build(None, None);
        assert!(prompt.contains("America/New_York"));
        // 이전 default Asia/Seoul 안 박힘 (timezone 섹션만)
        let scheduling_section_idx = prompt.find("타임존:").expect("타임존 섹션 필요");
        let scheduling_section = &prompt[scheduling_section_idx..scheduling_section_idx + 200];
        assert!(scheduling_section.contains("America/New_York"));
    }

    #[test]
    fn extra_context_replaces_system_context_placeholder() {
        let (v, _dir) = vault();
        let pb = PromptBuilder::new(v);
        let prompt = pb.build(Some("등록된 sysmod: kiwoom, naver-search"), None);
        assert!(prompt.contains("등록된 sysmod: kiwoom, naver-search"));
        // placeholder 미치환 검사 (`{system_context}` 글자 그대로 남아있으면 X)
        assert!(!prompt.contains("{system_context}"));
    }

    #[test]
    fn cron_agent_prelude_prepended() {
        let (v, _dir) = vault();
        let pb = PromptBuilder::new(v);
        let prompt = pb.build(
            None,
            Some(&CronAgentContext {
                job_id: "job-2026-04-25-stock-weekly".to_string(),
                title: Some("주간 증시 일정".to_string()),
            }),
        );
        // cron agent 섹션이 base 앞에 prepend
        assert!(prompt.contains("Cron Agent 모드"));
        assert!(prompt.contains("job-2026-04-25-stock-weekly"));
        assert!(prompt.contains("주간 증시 일정"));
        assert!(prompt.contains("사용자 부재 중"));
        // prelude 가 base 보다 앞에 위치
        let prelude_idx = prompt.find("Cron Agent 모드").unwrap();
        let base_idx = prompt.find("도구 사용 원칙").unwrap();
        assert!(prelude_idx < base_idx);
    }

    #[test]
    fn cron_agent_without_title_handles_gracefully() {
        let (v, _dir) = vault();
        let pb = PromptBuilder::new(v);
        let prompt = pb.build(
            None,
            Some(&CronAgentContext {
                job_id: "job-id-only".to_string(),
                title: None,
            }),
        );
        assert!(prompt.contains("job-id-only"));
        // title 미박음 시 빈 string 처리 (placeholder 안 남음)
        assert!(!prompt.contains("{job_title_line}"));
    }

    #[test]
    fn no_unreplaced_placeholders_in_default_build() {
        let (v, _dir) = vault();
        let pb = PromptBuilder::new(v);
        let prompt = pb.build(Some("ctx"), None);
        // 모든 `{placeholder}` 패턴 치환 검증 — 옛 TS interpolation 누락 회귀 방지
        // 단 markdown 안 코드 블록 안 `{...}` 는 의도된 placeholder 가 아닌 예시라 제외.
        let unreplaced_patterns = ["{system_context}", "{user_tz}", "{now_korean}", "{user_section}"];
        for pattern in unreplaced_patterns {
            assert!(
                !prompt.contains(pattern),
                "placeholder {} 미치환",
                pattern
            );
        }
    }

    #[test]
    fn cron_agent_replaces_all_placeholders() {
        let (v, _dir) = vault();
        let pb = PromptBuilder::new(v);
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
            assert!(
                !prompt.contains(pattern),
                "placeholder {} 미치환",
                pattern
            );
        }
    }
}
