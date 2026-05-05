//! Plan mode 시스템 프롬프트 prefix — 옛 TS ai-manager.ts 1:1.
//!
//! `PlanMode` enum 별 prefix:
//! - `Off` — 빈 string (AI 자유 판단)
//! - `Auto` — destructive·복합 작업만 propose_plan / suggest 강제
//! - `Always` — 모든 요청에 plan 강제 (인사·단답 포함, 예외 0건)

use crate::ports::PlanMode;

const ALWAYS_PREFIX: &str = include_str!("plan_mode_always.md");
const AUTO_PREFIX: &str = include_str!("plan_mode_auto.md");

/// PlanMode 별 시스템 프롬프트 prefix. 옛 TS `planModePrefix` 1:1.
pub fn prefix(mode: PlanMode) -> &'static str {
    match mode {
        PlanMode::Off => "",
        PlanMode::Auto => AUTO_PREFIX,
        PlanMode::Always => ALWAYS_PREFIX,
    }
}

/// LLM 호출 직전 user prompt 에 박는 hint — Gemini 가 시스템 프롬프트 무시 시 fallback.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_returns_empty() {
        assert_eq!(prefix(PlanMode::Off), "");
        assert!(prompt_hint(PlanMode::Off).is_none());
    }

    #[test]
    fn auto_contains_destructive_rule() {
        let p = prefix(PlanMode::Auto);
        assert!(p.contains("플랜모드 AUTO"));
        assert!(p.contains("destructive"));
        assert!(p.contains("propose_plan"));
        let h = prompt_hint(PlanMode::Auto).unwrap();
        assert!(h.contains("AUTO"));
    }

    #[test]
    fn always_forces_plan_for_all_requests() {
        let p = prefix(PlanMode::Always);
        assert!(p.contains("플랜모드 ALWAYS"));
        assert!(p.contains("예외 0건"));
        assert!(p.contains("propose_plan"));
        let h = prompt_hint(PlanMode::Always).unwrap();
        assert!(h.contains("ALWAYS"));
    }
}
