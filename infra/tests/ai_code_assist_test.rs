//! code_assist (AI 코드 어시스턴트) integration test — 옛 core inline tests 이관.

use firebat_core::managers::ai::code_assist::{
    build_system_prompt, code_assist, is_explain_mode, strip_code_fences, CodeAssistParams,
};
use firebat_core::ports::AiRequestOpts;
use firebat_infra::adapters::llm::StubLlmAdapter;

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
