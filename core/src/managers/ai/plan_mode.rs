//! Plan mode 시스템 프롬프트 prefix — 옛 TS ai-manager.ts 1:1.
//!
//! `PlanMode` enum 별 prefix:
//! - `Off` — 빈 string (AI 자유 판단)
//! - `Auto` — destructive·복합 작업만 propose_plan / suggest 강제
//! - `Always` — 모든 요청에 plan 강제 (인사·단답 포함, 예외 0건)
//!
//! 외부화 (2026-05-13) — 옛 `include_str!` 컴파일 시점 박힘 폐기.
//! 통합 i18n loader (`firebat_core::i18n`) 가 부팅 시점 `system/prompts/{name}/lang/{lang}.md` 자동 scan.
//! 매 호출 시 `i18n::prompt(name, None)` lookup — 사용자 lang task-local 자동 적용.
//!
//! 옛 `IPromptLoaderPort` adapter 영역 폐기 (2026-05-16) — core 가 직접 i18n 사용.

use crate::i18n;
use crate::ports::PlanMode;

/// PlanMode 별 시스템 프롬프트 prefix. 옛 TS `planModePrefix` 1:1.
/// 매 호출 시 i18n lookup — 사용자 lang task-local 자동 적용.
pub fn prefix(mode: PlanMode) -> String {
    match mode {
        PlanMode::Off => String::new(),
        PlanMode::Auto => i18n::prompt("plan_mode_auto", None),
        PlanMode::Always => i18n::prompt("plan_mode_always", None),
    }
}

/// LLM 호출 직전 user prompt 에 설정하는 hint — Gemini 가 시스템 프롬프트 무시 시 fallback.
/// 옛 TS `promptForLlm` 의 첫 turn 분기 1:1.
pub fn prompt_hint(mode: PlanMode) -> Option<&'static str> {
    match mode {
        PlanMode::Off => None,
        PlanMode::Auto => Some(
            "[플랜모드 AUTO — destructive·복합 작업만 propose_plan, 단순 read-only 는 즉시 도구 호출. 앱 만들기는 3-stage suggest]"
        ),
        PlanMode::Always => Some(
            "[플랜모드 ALWAYS — 모든 요청에 propose_plan 먼저 호출 (예외 0건, 인사·단답도 plan). 앱 만들기만 suggest 3단계. 호출 후 즉시 턴 종료]"
        ),
    }
}

// 통합 검증 (i18n init + prompt lookup) 은 infra integration test 영역.
// 본 module 의 단위 tests 는 i18n init 의존 — 별도 setup 필요. 제거.
