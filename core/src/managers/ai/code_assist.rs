//! Code Assist — Monaco 에디터 통합 AI 어시스턴트.
//!
//! 옛 TS `core/managers/ai-manager.ts` `codeAssist` 메서드 (1704-1777) 1:1 port.
//!
//! 두 모드:
//! - **설명 모드** (explain) — "알려줘/설명/분석/검토/리뷰" 계열 키워드 감지 시 활성.
//!   마크다운 응답, 코드 재작성 금지, line 번호·함수명 언급 필수.
//! - **코드 모드** (rewrite) — 그 외 모든 지시 ("수정/추가/리팩토링/고쳐줘"). raw 코드만 반환,
//!   코드펜스 자동 strip, 들여쓰기·네이밍 보존.
//!
//! Monaco 어시스턴트는 코드 품질 보호를 위해 사용자 커스텀 프롬프트 (페르소나·톤·도메인) 주입 안 함.
//! 어드민 채팅만 user_section 주입 (옛 TS prompt-builder).
//!
//! **도구 호출 불가** — `ask_text` 만 사용. file I/O / 외부 호출 금지.

use crate::ports::{AiRequestOpts, ILlmPort, InfraResult, LlmCallOpts};

/// 설명 모드 키워드 — 옛 TS `explainKeywords` 1:1 + 영어 키워드 포함.
const EXPLAIN_KEYWORDS: &[&str] = &[
    "알려줘",
    "알려달",
    "설명",
    "분석",
    "검토",
    "리뷰",
    "뭐가 문제",
    "왜",
    "어떻게",
    "파악",
    "평가",
    "explain",
    "review",
    "analyze",
    "analyse",
    "what does",
    "why",
    "describe",
];

/// codeAssist 의 인자 — 옛 TS `codeAssist` 의 params 1:1.
#[derive(Debug, Clone)]
pub struct CodeAssistParams<'a> {
    pub code: &'a str,
    pub language: &'a str,
    pub instruction: &'a str,
    pub selected_code: Option<&'a str>,
}

/// 사용자 지시를 분석·설명 모드 vs 코드 수정 모드로 분기 — 옛 TS 1:1.
pub fn is_explain_mode(instruction: &str) -> bool {
    let lowered = instruction.to_lowercase();
    EXPLAIN_KEYWORDS.iter().any(|k| {
        instruction.contains(k) || lowered.contains(&k.to_lowercase())
    })
}

/// 시스템 프롬프트 빌드 — 옛 TS basePrompt 1:1 (explain / rewrite 분기).
pub fn build_system_prompt(language: &str, explain: bool) -> String {
    if explain {
        format!(
            "당신은 Monaco 에디터에 통합된 코드 리뷰어입니다.\n\
             **도구 호출·파일 I/O 불가** — 오직 응답 텍스트만 반환.\n\
             사용자는 코드를 이해하거나 개선점을 알고 싶어합니다. 코드 재작성 금지.\n\
             \n\
             ## 응답 형식\n\
             - 한국어 마크다운. bullet points + 짧은 섹션.\n\
             - 반드시 구체적 line 번호·함수명·변수명을 언급.\n\
             - 원본 코드를 그대로 재출력하지 마라 (사용자는 이미 코드를 보고 있음).\n\
             - actionable 관찰만. \"좋은 코드입니다\" 같은 평가·칭찬 금지.\n\
             \n\
             ## 안전 가이드라인\n\
             - destructive 조작(rm -rf, DROP TABLE, git reset --hard 등) 추천 금지.\n\
             - 추측 대신 근거 — 확실하지 않은 동작은 \"확인 필요\" 로 표시.\n\
             \n\
             ## 대상 언어: {language}"
        )
    } else {
        format!(
            "당신은 Monaco 에디터에 통합된 코드 어시스턴트입니다.\n\
             **도구 호출·파일 I/O 불가** — 오직 응답 텍스트만 반환.\n\
             \n\
             ## 응답 형식\n\
             - 오직 raw 코드만. 설명·마크다운 코드펜스(```) 금지.\n\
             - 원본 들여쓰기·네이밍·언어 관례 보존.\n\
             - 선택 영역이 주어지면 그 부분만 교체, 아니면 파일 전체 재작성.\n\
             - 주석은 한국어로 (원본이 영어 주석 유지 중이 아니라면).\n\
             \n\
             ## 안전·품질\n\
             - 명백한 버그·엣지 케이스(null/빈 배열/타입 불일치)는 함께 수정.\n\
             - 새 외부 의존성 추가 금지 (있는 것 활용).\n\
             - destructive 조작·eval·Function constructor 사용 금지.\n\
             \n\
             ## 대상 언어: {language}"
        )
    }
}

/// 코드 응답에서 마크다운 코드펜스 자동 strip — 옛 TS `replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '')` 1:1.
/// 설명 모드에선 적용 안 함 (마크다운 유지).
pub fn strip_code_fences(s: &str) -> String {
    let trimmed = s.trim();
    let mut out = trimmed.to_string();
    // leading fence — `^\`\`\`(\w*)\n?`
    if out.starts_with("```") {
        if let Some(newline_pos) = out.find('\n') {
            out = out[(newline_pos + 1)..].to_string();
        } else {
            // ``` 만 있고 줄바꿈 없는 경우
            out = out.trim_start_matches("```").to_string();
            // language 식별자 strip
            if let Some(idx) = out.find(|c: char| c.is_whitespace()) {
                out = out[idx..].to_string();
            }
        }
    }
    // trailing fence — `\n?\`\`\`$`
    let trimmed_end = out.trim_end();
    if trimmed_end.ends_with("```") {
        out = trimmed_end.trim_end_matches("```").trim_end().to_string();
    }
    out.trim().to_string()
}

/// 옛 TS `codeAssist` 1:1 — Monaco 어시스턴트 진입점.
///
/// 호출자 (Frontend / API route) 가 ILlmPort 와 params 박아 호출. 시스템 프롬프트 자동 빌드 +
/// LLM ask_text + 코드모드 시 코드펜스 strip.
///
/// 별도 함수로 분리한 이유: AiManager 의 process_with_tools 와 흐름·도구 모두 다름 (도구 호출 불가).
/// 옛 TS 도 codeAssist 는 AiManager 의 별 메서드.
pub async fn code_assist(
    llm: &dyn ILlmPort,
    params: &CodeAssistParams<'_>,
    ai_opts: &AiRequestOpts,
) -> InfraResult<String> {
    let explain = is_explain_mode(params.instruction);
    let system_prompt = build_system_prompt(params.language, explain);

    let context = if let Some(sel) = params.selected_code {
        let label = if explain { "" } else { " (modify this)" };
        format!(
            "Selected code{}:\n{}\n\nFull file for context:\n{}",
            label, sel, params.code
        )
    } else {
        format!("Full file:\n{}", params.code)
    };

    let llm_opts = LlmCallOpts {
        model: ai_opts.model.clone(),
        system_prompt: Some(system_prompt),
        ..Default::default()
    };
    let user_prompt = format!("Instruction: {}\n\n{}", params.instruction, context);

    let response = llm.ask_text(&user_prompt, &llm_opts).await?;
    let cleaned = if explain {
        response.text.trim().to_string()
    } else {
        strip_code_fences(&response.text)
    };
    Ok(cleaned)
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;

    #[test]
    fn explain_mode_korean_keywords() {
        assert!(is_explain_mode("이 함수 알려줘"));
        assert!(is_explain_mode("코드 설명해줘"));
        assert!(is_explain_mode("뭐가 문제야"));
        assert!(is_explain_mode("왜 안 되지"));
        assert!(is_explain_mode("리뷰해줘"));
    }

    #[test]
    fn explain_mode_english_keywords() {
        assert!(is_explain_mode("explain this code"));
        assert!(is_explain_mode("Why is this not working"));
        assert!(is_explain_mode("ANALYZE this function"));
        assert!(is_explain_mode("describe the algorithm"));
    }

    #[test]
    fn rewrite_mode_for_modify_instructions() {
        assert!(!is_explain_mode("이 함수 수정해줘"));
        assert!(!is_explain_mode("리팩토링"));
        assert!(!is_explain_mode("add error handling"));
        assert!(!is_explain_mode("fix the bug"));
        assert!(!is_explain_mode("rewrite this"));
    }

    #[test]
    fn system_prompt_explain_includes_review_guidance() {
        let p = build_system_prompt("typescript", true);
        assert!(p.contains("코드 리뷰어"));
        assert!(p.contains("코드 재작성 금지"));
        assert!(p.contains("typescript"));
    }

    #[test]
    fn system_prompt_rewrite_forbids_codeblock_fences() {
        let p = build_system_prompt("python", false);
        assert!(p.contains("코드 어시스턴트"));
        assert!(p.contains("raw 코드만"));
        assert!(p.contains("코드펜스"));
        assert!(p.contains("python"));
    }

    #[test]
    fn strip_code_fences_basic() {
        let input = "```rust\nfn main() {}\n```";
        assert_eq!(strip_code_fences(input), "fn main() {}");
    }

    #[test]
    fn strip_code_fences_no_language() {
        let input = "```\nlet x = 1;\n```";
        assert_eq!(strip_code_fences(input), "let x = 1;");
    }

    #[test]
    fn strip_code_fences_with_surrounding_whitespace() {
        let input = "  \n  ```ts\nconst x = 1;\nconst y = 2;\n```\n  ";
        assert_eq!(strip_code_fences(input), "const x = 1;\nconst y = 2;");
    }

    #[test]
    fn strip_code_fences_no_fences_returns_as_is() {
        let input = "fn main() {}";
        assert_eq!(strip_code_fences(input), "fn main() {}");
    }

    #[test]
    fn strip_code_fences_only_leading_fence() {
        let input = "```js\nconsole.log('hi');";
        assert_eq!(strip_code_fences(input), "console.log('hi');");
    }

    #[tokio::test]
    async fn code_assist_explain_mode_returns_markdown() {
        use firebat_infra::adapters::llm::StubLlmAdapter;
        let llm = StubLlmAdapter::new("stub");
        let result = code_assist(
            &llm,
            &CodeAssistParams {
                code: "fn main() {}",
                language: "rust",
                instruction: "이 코드 설명해줘",
                selected_code: None,
            },
            &AiRequestOpts::default(),
        )
        .await
        .unwrap();
        // Stub 은 prompt preview 반환 — explain 모드는 마크다운 그대로 반환 (코드펜스 strip X)
        assert!(result.contains("Phase B-17+"));
    }

    #[tokio::test]
    async fn code_assist_rewrite_mode_strips_fences() {
        // ScriptedLlm 처럼 ask_text 가 코드펜스 박힌 응답 반환하면 strip 되는지 확인.
        // Stub 은 prompt preview 만 반환하므로 직접 strip_code_fences 로 검증.
        let response = "```rust\nfn x() { 42 }\n```";
        assert_eq!(strip_code_fences(response), "fn x() { 42 }");
    }

    #[test]
    fn rewrite_mode_label_added_when_selected_code() {
        // 코드 모드 + selected_code → "Selected code (modify this):" label 박힘
        // (실제 prompt 구성은 code_assist 내부 — 본 test 는 build_system_prompt 가 mode 반영하는지만 확인)
        let explain_p = build_system_prompt("ts", true);
        let rewrite_p = build_system_prompt("ts", false);
        assert_ne!(explain_p, rewrite_p);
    }
}
