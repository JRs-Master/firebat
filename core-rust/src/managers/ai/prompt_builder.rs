//! AiManager 시스템 프롬프트 builder — 옛 TS prompt-builder.ts 핵심 부분 Rust port.
//!
//! 옛 TS 의 buildSystemPrompt 470줄 → Rust 핵심만 (base 프롬프트 + reusable 4 규칙 + 사용자 prompt
//! 주입). Phase B 에서 enrich (도구별 사용 규칙 / suggestions / propose_plan / render_* hint 등)
//! 후속 batch.

use crate::ports::IVaultPort;
use std::sync::Arc;

/// 시스템 프롬프트 base — Firebat 도구 사용 시스템 + reusable 4 규칙.
/// 옛 TS prompt-builder.ts 의 BASE_SYSTEM_PROMPT 핵심 1:1 port.
const BASE_SYSTEM_PROMPT: &str = r#"Firebat User AI — 도구 사용 시스템.

# Reusable 4 규칙 (절대 위반 금지)
1. 외부 API 호출은 sysmod 만 — user/modules 에서 직접 fetch 금지.
2. 시크릿 직접 사용 금지 — process.env.X / os.environ["X"] 는 sysmod 안에서만.
3. UI 렌더링은 render_* 도구만 — user 모듈이 HTML 직접 생성 X.
4. 조건 분기는 모듈 내부 코드 OR pipeline CONDITION step.

# 도구 사용 규칙
- 사용자 요청에 도구가 필요하면 자동으로 호출. 사용자한테 "도구 쓸까요?" 묻지 말 것.
- 도구 호출 결과는 그대로 사용 — 추측·가정 금지. 원본에 없는 정보 추가 금지.
- 동일 도구 여러 번 호출 시 N개 대상별 분리 호출 (예: 종목 3개면 sysmod_kiwoom 3번).
- save_page 도구로 페이지 발행 시 spec.body 는 render_* 컴포넌트 객체 배열 강제.
- pipeline 짤 때 LLM_TRANSFORM 의 instruction 안에 도구명 박지 말 것 (별도 EXECUTE step 으로 분리).

# 응답 형식
- 한국어 + 존댓말. 추임새 ("좋은 질문", "훌륭합니다") 금지. 본론만.
- 숫자 포맷: 금액·수량·거래량은 3자리 콤마 (1,253,000원). 연도·전화번호·코드번호는 콤마 금지.
- 표·차트 제시 시 render_table / render_chart 활용. 마크다운 표 직접 출력 금지.
"#;

/// 사용자 정의 prompt — Vault `system:user-prompt` 에 박혀있으면 시스템 프롬프트 말미에 prepend.
/// 옛 TS pattern — 페르소나 / 도메인 / 톤 사용자 정의.
const USER_PROMPT_HEADER: &str = "\n\n# 사용자 지시사항\n";

pub struct PromptBuilder {
    vault: Arc<dyn IVaultPort>,
}

impl PromptBuilder {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self { vault }
    }

    /// 시스템 프롬프트 생성 — base + 사용자 prompt + 추가 컨텍스트.
    /// extra_context: gatherSystemContext 결과 (sysmod 동적 description / 매니저 capability list).
    /// Phase B-17+ 에서 enrich.
    pub fn build(&self, extra_context: Option<&str>) -> String {
        let mut prompt = String::from(BASE_SYSTEM_PROMPT);

        // Vault `system:user-prompt` 박혀있으면 prepend
        if let Some(user_prompt) = self
            .vault
            .get_secret("system:user-prompt")
            .filter(|v| !v.trim().is_empty())
        {
            prompt.push_str(USER_PROMPT_HEADER);
            prompt.push_str(&user_prompt);
        }

        if let Some(ctx) = extra_context {
            if !ctx.trim().is_empty() {
                prompt.push_str("\n\n# 시스템 컨텍스트\n");
                prompt.push_str(ctx);
            }
        }

        prompt
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
    fn base_prompt_contains_reusable_rules() {
        let (v, _dir) = vault();
        let pb = PromptBuilder::new(v);
        let prompt = pb.build(None);
        assert!(prompt.contains("Reusable 4 규칙"));
        assert!(prompt.contains("외부 API 호출은 sysmod"));
        assert!(prompt.contains("render_*"));
    }

    #[test]
    fn user_prompt_appended_when_set() {
        let (v, _dir) = vault();
        v.set_secret("system:user-prompt", "당신은 자동매매 전문가입니다.");
        let pb = PromptBuilder::new(v);
        let prompt = pb.build(None);
        assert!(prompt.contains("자동매매 전문가"));
        assert!(prompt.contains("# 사용자 지시사항"));
    }

    #[test]
    fn user_prompt_skipped_when_empty() {
        let (v, _dir) = vault();
        v.set_secret("system:user-prompt", "");
        let pb = PromptBuilder::new(v);
        let prompt = pb.build(None);
        assert!(!prompt.contains("# 사용자 지시사항"));
    }

    #[test]
    fn extra_context_appended_when_provided() {
        let (v, _dir) = vault();
        let pb = PromptBuilder::new(v);
        let prompt = pb.build(Some("등록된 sysmod: kiwoom, naver-search"));
        assert!(prompt.contains("# 시스템 컨텍스트"));
        assert!(prompt.contains("등록된 sysmod"));
    }
}
