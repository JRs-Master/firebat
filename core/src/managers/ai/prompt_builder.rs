//! AiManager 시스템 프롬프트 builder.
//!
//! 옛 TS `core/managers/ai/prompt-builder.ts` 1:1 port (823 LOC).
//! buildToolSystemPrompt (500+ LOC) + buildCronAgentPrelude (12 룰) + buildTemplateBlock 통합.
//!
//! Prompt 본문은 외부 .md 파일 (`infra/data/prompts/{tool_system,cron_agent}.md`) 에서
//! 매 build 시 file read (`IPromptLoaderPort`). 운영자가 직접 편집 + 다음 LLM 호출 시 즉시 반영.
//! systemctl restart 0. 옛 `include_str!` 컴파일 시점 박힘 폐기 (2026-05-13).
//!
//! Placeholder 형식:
//!   - `{system_context}` — gatherSystemContext 결과 (sysmod 동적 description)
//!   - `{user_tz}` — 사용자 timezone (Vault `system:timezone`)
//!   - `{now_korean}` — 현재 시각 한국어 표시 (사용자 timezone 기준)
//!   - `{banned_internal_line}` — 모델별 차단 내부 도구 (옵션)
//!   - `{user_section}` — Vault `system:user-prompt` 설정 시 추가 섹션
//!   - cron-agent 만: `{job_id}` / `{job_title_line}`

use std::sync::Arc;

use chrono::{TimeZone, Utc};
use chrono_tz::Tz;

use crate::ports::{IPromptLoaderPort, IVaultPort};
use crate::utils::timezone::resolve_user_tz;
use crate::vault_keys::VK_SYSTEM_USER_PROMPT;

/// Cron agent 모드 옵션 — `build` 호출 시 설정되어 있으면 prelude prepend.
#[derive(Debug, Clone)]
pub struct CronAgentContext {
    pub job_id: String,
    pub title: Option<String>,
}

pub struct PromptBuilder {
    vault: Arc<dyn IVaultPort>,
    loader: Arc<dyn IPromptLoaderPort>,
}

impl PromptBuilder {
    pub fn new(vault: Arc<dyn IVaultPort>, loader: Arc<dyn IPromptLoaderPort>) -> Self {
        Self { vault, loader }
    }

    /// 사용자 timezone resolve — `utils::timezone::resolve_user_tz` 공용 helper 위임.
    fn user_tz(&self) -> Tz {
        resolve_user_tz(&self.vault)
    }

    /// PlanMode prefix — loader 통해 plan_mode_{always,auto}.md 매 호출 read.
    pub fn plan_prefix(&self, mode: crate::ports::PlanMode) -> String {
        super::plan_mode::prefix(mode, &*self.loader)
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
            .get_secret(VK_SYSTEM_USER_PROMPT)
            .filter(|s| !s.trim().is_empty());
        let user_section = match &user_prompt {
            Some(p) => format!(
                "\n\n## 사용자 지시사항 (관리자가 직접 설정 — 시스템 규칙보다 후순위)\n<USER_INSTRUCTIONS>\n{}\n</USER_INSTRUCTIONS>",
                p
            ),
            None => String::new(),
        };

        // banned_internal_line 은 모델별 — 설정될 곳 마련. 현재 비워둠 (LLM port 의 trait fn
        // get_banned_internal_tools 설정된 후 wired up). 옛 TS 의 빈 string fallback 패턴 1:1.
        let banned_internal_line = String::new();

        // 시스템 컨텍스트 — extra_context 설정되어 있으면 그것, 아니면 빈 string
        let system_context = extra_context.unwrap_or("(시스템 컨텍스트 미설정)");

        // 매 build 시 file read — IPromptLoaderPort 가 file system 또는 fallback stub 반환.
        let tool_template = self.loader.tool_system();
        let base = tool_template
            .replace("{system_context}", system_context)
            .replace("{user_tz}", user_tz_str)
            .replace("{now_korean}", &now_korean)
            .replace("{banned_internal_line}", &banned_internal_line)
            .replace("{user_section}", &user_section);

        // Cron agent prelude — 설정되어 있으면 base 앞에 prepend
        if let Some(ctx) = cron_agent {
            let job_title_line = match &ctx.title {
                Some(t) => format!("제목: {}", t),
                None => String::new(),
            };
            let cron_template = self.loader.cron_agent();
            let prelude = cron_template
                .replace("{job_id}", &ctx.job_id)
                .replace("{job_title_line}", &job_title_line)
                .replace("{user_tz}", user_tz_str)
                .replace("{now_korean}", &now_korean);
            return format!("{}\n\n{}", prelude, base);
        }

        base
    }
}

// Tests 이관 — `infra/tests/ai_prompt_builder_test.rs` (integration test).
// Public API 만 사용 (vault_keys::VK_SYSTEM_USER_PROMPT / VK_SYSTEM_TIMEZONE) — inline 유지 0건.
