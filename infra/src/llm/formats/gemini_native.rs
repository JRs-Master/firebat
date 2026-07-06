//! Gemini Native API — AI Studio (옛 TS `gemini-native.ts` 1:1 port).
//!
//! 핵심 기능:
//! - `POST {endpoint}/v1beta/models/{id}:generateContent?key={api_key}`
//! - `contents: [{role: 'user'|'model', parts: [{text} | {inlineData} | {functionCall} | {functionResponse}]}]`
//! - `systemInstruction: {parts: [{text}]}` 분리
//! - `tools: [{functionDeclarations: [...]}]` + `toolConfig.functionCallingConfig.mode='AUTO'`
//! - 멀티턴 도구 교환: `opts.tool_exchanges` 의 `rawModelParts` echo (thought_signature 보존) +
//!   `functionResponse` 페어 reconstruction. `prior_results` 가 비고 `tool_exchanges` 도 비면 단일 turn.
//! - 첨부 이미지: `parts: [..., {inlineData: {data: base64, mimeType}}]`
//! - thinking: `generationConfig.thinkingConfig` (config.features.thinking 활성 시 thinking_level 매핑)
//! - 응답에서 `candidates[0].content.parts` 원본 → `raw_model_parts` 에 보존
//! - tokens / cost / functionCall 추출

use crate::llm::adapter::FormatHandler;
use crate::llm::formats::common::{
    compute_cost, http_client, map_reqwest_error, require_api_key,
};
use crate::llm::formats::gemini_shared::sanitize_gemini_schema;
use firebat_core::llm::config::LlmModelConfig;
use firebat_core::ports::{
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolCall, ToolDefinition,
    ToolResult,
};

pub struct GeminiNativeHandler;

impl GeminiNativeHandler {
    pub fn new() -> Self {
        Self
    }

    fn build_endpoint(config: &LlmModelConfig, api_key: &str) -> String {
        format!(
            "{}/v1beta/models/{}:generateContent?key={}",
            config.endpoint.trim_end_matches('/'),
            config.id,
            urlencoding(api_key)
        )
    }

    /// thinking config 빌드 — 옛 TS `buildThinkingConfig` 1:1.
    fn build_thinking_config(level: &str) -> serde_json::Value {
        if level == "minimal" {
            serde_json::json!({ "thinkingLevel": "minimal" })
        } else {
            serde_json::json!({ "includeThoughts": true, "thinkingLevel": level })
        }
    }

    /// 응답 파싱 — text + tool_calls + tokens + raw_model_parts (rest) + thinking text.
    /// 반환: (text, tool_calls, tokens_in 총입력, tokens_out, cached 부분집합, raw_parts, thinking).
    fn parse_response(
        body: &serde_json::Value,
    ) -> (
        String,
        Vec<ToolCall>,
        i64,
        i64,
        i64,
        Option<serde_json::Value>,
        Option<String>,
    ) {
        let mut text = String::new();
        let mut thinking_text = String::new();
        let mut tool_calls = Vec::new();
        let mut raw_parts: Option<serde_json::Value> = None;

        if let Some(candidates) = body.get("candidates").and_then(|v| v.as_array()) {
            if let Some(first) = candidates.first() {
                if let Some(parts) = first
                    .get("content")
                    .and_then(|c| c.get("parts"))
                    .and_then(|p| p.as_array())
                {
                    raw_parts = Some(serde_json::Value::Array(parts.clone()));
                    for (idx, p) in parts.iter().enumerate() {
                        let is_thought =
                            p.get("thought").and_then(|v| v.as_bool()).unwrap_or(false);
                        if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                            if is_thought {
                                if !thinking_text.is_empty() {
                                    thinking_text.push('\n');
                                }
                                thinking_text.push_str(t);
                            } else {
                                text.push_str(t);
                            }
                        }
                        if let Some(fc) = p.get("functionCall") {
                            let name = fc
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let args = fc.get("args").cloned().unwrap_or(serde_json::json!({}));
                            // 도구 호출 마커 — frontend ThinkingBlock 본문에 누적 표시.
                            // 옛 Node 의 onChunk({type:'thinking', content:'[도구 호출: name]'}) 와 동등.
                            if !name.is_empty() {
                                if !thinking_text.is_empty() {
                                    thinking_text.push('\n');
                                }
                                thinking_text.push_str(&firebat_core::i18n::t("core.llm.tool_call_marker", None, &[("name", &name)]));
                            }
                            tool_calls.push(ToolCall {
                                id: format!("gemini-call-{}", idx),
                                name,
                                arguments: args,
                            });
                        }
                    }
                }
            }
        }
        // Gemini usageMetadata: promptTokenCount(캐시 포함 총 입력) / candidatesTokenCount(답변) /
        // thoughtsTokenCount(thinking, 출력 과금) / cachedContentTokenCount(캐시 부분집합).
        let usage = body.get("usageMetadata");
        let get_usage = |key: &str| -> i64 {
            usage.and_then(|u| u.get(key)).and_then(|v| v.as_i64()).unwrap_or(0)
        };
        let tokens_in = get_usage("promptTokenCount");
        // 출력 = 답변 + thinking (thinking 은 출력 토큰으로 과금).
        let tokens_out = get_usage("candidatesTokenCount") + get_usage("thoughtsTokenCount");
        let cached_tokens = get_usage("cachedContentTokenCount");
        let thinking_opt = if thinking_text.is_empty() {
            None
        } else {
            Some(thinking_text)
        };
        (text, tool_calls, tokens_in, tokens_out, cached_tokens, raw_parts, thinking_opt)
    }

    /// 첨부 이미지 → `inlineData` part 빌드. data URL 또는 raw base64 모두 처리.
    fn image_to_inline_data_part(image: &str, mime_hint: Option<&str>) -> serde_json::Value {
        let base64 = if let Some(idx) = image.find(',') {
            &image[(idx + 1)..]
        } else {
            image
        };
        let mime = if let Some(m) = mime_hint {
            m.to_string()
        } else if let Some(stripped) = image.strip_prefix("data:") {
            stripped.split(';').next().unwrap_or("image/jpeg").to_string()
        } else {
            "image/jpeg".to_string()
        };
        serde_json::json!({
            "inlineData": { "data": base64, "mimeType": mime }
        })
    }

    /// `contents` 배열 빌드 — history + user (image 포함) + tool_exchanges (rawModelParts echo + functionResponse).
    fn build_contents(
        prompt: &str,
        opts: &LlmCallOpts,
        prior_results: &[ToolResult],
    ) -> Vec<serde_json::Value> {
        let mut contents: Vec<serde_json::Value> = Vec::new();
        // history
        for h in &opts.history {
            let role = if h.role == "assistant" { "model" } else { "user" };
            let mut parts: Vec<serde_json::Value> = Vec::new();
            let text_str = match &h.content {
                serde_json::Value::String(s) if !s.trim().is_empty() => s.clone(),
                v => serde_json::to_string(v).unwrap_or_default(),
            };
            parts.push(serde_json::json!({ "text": text_str }));
            if let Some(img) = h.image.as_deref() {
                parts.push(Self::image_to_inline_data_part(img, h.image_mime_type.as_deref()));
            }
            contents.push(serde_json::json!({ "role": role, "parts": parts }));
        }
        // 현재 user message
        let mut user_parts: Vec<serde_json::Value> = vec![serde_json::json!({ "text": prompt })];
        if let Some(img) = opts.image.as_deref() {
            user_parts.push(Self::image_to_inline_data_part(img, opts.image_mime_type.as_deref()));
        }
        contents.push(serde_json::json!({ "role": "user", "parts": user_parts }));

        // 멀티턴 도구 교환 — opts.tool_exchanges 우선, 없으면 prior_results 폴백
        if !opts.tool_exchanges.is_empty() {
            for ex in &opts.tool_exchanges {
                // model turn — rawModelParts 우선 (thought_signature 보존), 없으면 functionCall 합성
                let model_parts: serde_json::Value =
                    if let Some(raw) = &ex.raw_model_parts {
                        raw.clone()
                    } else {
                        serde_json::Value::Array(
                            ex.tool_calls
                                .iter()
                                .map(|tc| {
                                    serde_json::json!({
                                        "functionCall": { "name": tc.name, "args": tc.arguments }
                                    })
                                })
                                .collect(),
                        )
                    };
                contents.push(serde_json::json!({ "role": "model", "parts": model_parts }));
                // user turn — functionResponse 페어
                let user_parts: Vec<serde_json::Value> = ex
                    .tool_results
                    .iter()
                    .map(|tr| {
                        serde_json::json!({
                            "functionResponse": { "name": tr.name, "response": tr.result }
                        })
                    })
                    .collect();
                contents.push(serde_json::json!({ "role": "user", "parts": user_parts }));
            }
        } else if !prior_results.is_empty() {
            // 폴백: prior_results 만 있으면 functionCall 메타 합성
            let model_parts: Vec<serde_json::Value> = prior_results
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "functionCall": { "name": r.name, "args": serde_json::json!({}) }
                    })
                })
                .collect();
            contents.push(serde_json::json!({ "role": "model", "parts": model_parts }));
            let user_parts: Vec<serde_json::Value> = prior_results
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "functionResponse": { "name": r.name, "response": r.result }
                    })
                })
                .collect();
            contents.push(serde_json::json!({ "role": "user", "parts": user_parts }));
        }
        contents
    }

    fn build_body(
        prompt: &str,
        opts: &LlmCallOpts,
        tools: &[ToolDefinition],
        prior_results: &[ToolResult],
        config: &LlmModelConfig,
    ) -> serde_json::Value {
        let contents = Self::build_contents(prompt, opts, prior_results);
        let mut body = serde_json::json!({ "contents": contents });

        if let Some(sp) = opts.system_prompt.as_deref() {
            if !sp.is_empty() {
                body["systemInstruction"] = serde_json::json!({
                    "parts": [{ "text": sp }]
                });
            }
        }
        let mut gen = serde_json::json!({});
        if let Some(t) = opts.temperature {
            gen["temperature"] = serde_json::Value::from(t);
        }
        // Default 8192 — 모든 API 어댑터 일관 default (옛 node 버전의 답변 길이 회복).
        gen["maxOutputTokens"] = serde_json::Value::from(opts.max_tokens.or(config.max_output).unwrap_or(8192));
        // thinking — config.features.thinking 활성 모델만
        let thinking_enabled = config.features.thinking;
        if thinking_enabled {
            let level = opts.thinking_level.as_deref().unwrap_or("low");
            gen["thinkingConfig"] = Self::build_thinking_config(level);
        }
        if !gen.as_object().map(|o| o.is_empty()).unwrap_or(true) {
            body["generationConfig"] = gen;
        }
        // tools
        if !tools.is_empty() {
            let function_declarations: Vec<serde_json::Value> = tools
                .iter()
                .map(|t| {
                    let mut decl = serde_json::json!({
                        "name": t.name,
                        "description": t.description,
                    });
                    if let Some(schema) = &t.input_schema {
                        decl["parameters"] = sanitize_gemini_schema(schema);
                    }
                    decl
                })
                .collect();
            body["tools"] = serde_json::json!([{ "functionDeclarations": function_declarations }]);
            body["toolConfig"] = serde_json::json!({
                "functionCallingConfig": { "mode": "AUTO" }
            });
        }
        body
    }
}

/// URL encode — minimal (key 만 안전 처리).
fn urlencoding(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u8),
        })
        .collect()
}

#[async_trait::async_trait]
impl FormatHandler for GeminiNativeHandler {
    async fn ask_text(
        &self,
        config: &LlmModelConfig,
        api_key: Option<&str>,
        prompt: &str,
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmTextResponse> {
        let key = require_api_key(config, api_key)?;
        let url = Self::build_endpoint(config, &key);
        let body = Self::build_body(prompt, opts, &[], &[], config);

        let response = http_client()
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        let body_json: serde_json::Value = response.json().await.map_err(map_reqwest_error)?;
        if !status.is_success() {
            return Err(firebat_core::i18n::t(
                "core.error.llm.api_error",
                None,
                &[("name", "Gemini"), ("status", &status.to_string()), ("detail", &body_json.to_string())],
            ));
        }
        let (text, _calls, tokens_in, tokens_out, cached_tokens, _raw, _thinking) =
            Self::parse_response(&body_json);
        let cost = compute_cost(config, tokens_in, tokens_out);
        Ok(LlmTextResponse {
            text,
            model_id: config.id.clone(),
            cost_usd: Some(cost),
            tokens_in: Some(tokens_in),
            tokens_out: Some(tokens_out),
            cached_tokens: Some(cached_tokens),
        })
    }

    async fn ask_with_tools(
        &self,
        config: &LlmModelConfig,
        api_key: Option<&str>,
        prompt: &str,
        tools: &[ToolDefinition],
        prior_results: &[ToolResult],
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmToolResponse> {
        let key = require_api_key(config, api_key)?;
        let url = Self::build_endpoint(config, &key);
        let body = Self::build_body(prompt, opts, tools, prior_results, config);

        let response = http_client()
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        let body_json: serde_json::Value = response.json().await.map_err(map_reqwest_error)?;
        if !status.is_success() {
            return Err(firebat_core::i18n::t(
                "core.error.llm.api_error",
                None,
                &[("name", "Gemini"), ("status", &status.to_string()), ("detail", &body_json.to_string())],
            ));
        }
        let (text, tool_calls, tokens_in, tokens_out, cached_tokens, raw_parts, thinking_text) =
            Self::parse_response(&body_json);
        let cost = compute_cost(config, tokens_in, tokens_out);
        Ok(LlmToolResponse {
            text,
            tool_calls,
            model_id: config.id.clone(),
            cost_usd: Some(cost),
            tokens_in: Some(tokens_in),
            tokens_out: Some(tokens_out),
            cached_tokens: Some(cached_tokens),
            raw_model_parts: raw_parts,
            thinking_text,
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use firebat_core::ports::{ChatMessage, ToolExchangeEntry};

    fn dummy_config() -> LlmModelConfig {
        LlmModelConfig {
            id: "gemini-3.1-flash".to_string(),
            display_name: "Gemini 3.1 Flash".to_string(),
            provider: "google".to_string(),
            format: "gemini-native".to_string(),
            endpoint: "https://generativelanguage.googleapis.com".to_string(),
            api_key_vault_key: Some("GEMINI_API_KEY".to_string()),
            extra_headers: std::collections::HashMap::new(),
            features: firebat_core::llm::config::LlmFeatures::default(),
            pricing: None,
            thinking: None,
            exec_mode: "api".to_string(),
            cli_provider: None,
            max_output: None,
            category: "api-google".to_string(),
        }
    }

    #[test]
    fn build_thinking_config_minimal() {
        let v = GeminiNativeHandler::build_thinking_config("minimal");
        assert_eq!(v["thinkingLevel"], "minimal");
        assert!(v.get("includeThoughts").is_none());
    }

    #[test]
    fn build_thinking_config_high() {
        let v = GeminiNativeHandler::build_thinking_config("high");
        assert_eq!(v["thinkingLevel"], "high");
        assert_eq!(v["includeThoughts"], true);
    }

    #[test]
    fn build_contents_user_only() {
        let opts = LlmCallOpts::default();
        let contents = GeminiNativeHandler::build_contents("hi", &opts, &[]);
        assert_eq!(contents.len(), 1);
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[0]["parts"][0]["text"], "hi");
    }

    #[test]
    fn build_contents_with_image() {
        let mut opts = LlmCallOpts::default();
        opts.image = Some("data:image/png;base64,iVBOR".to_string());
        let contents = GeminiNativeHandler::build_contents("describe", &opts, &[]);
        let parts = contents[0]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[1]["inlineData"]["data"], "iVBOR");
        assert_eq!(parts[1]["inlineData"]["mimeType"], "image/png");
    }

    #[test]
    fn build_contents_with_history() {
        let mut opts = LlmCallOpts::default();
        opts.history = vec![
            ChatMessage {
                role: "user".to_string(),
                content: serde_json::Value::String("first".to_string()),
                image: None,
                image_mime_type: None,
            },
            ChatMessage {
                role: "assistant".to_string(),
                content: serde_json::Value::String("answered".to_string()),
                image: None,
                image_mime_type: None,
            },
        ];
        let contents = GeminiNativeHandler::build_contents("now", &opts, &[]);
        // history 2 + 현재 user 1 = 3
        assert_eq!(contents.len(), 3);
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[0]["parts"][0]["text"], "first");
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(contents[1]["parts"][0]["text"], "answered");
        assert_eq!(contents[2]["role"], "user");
        assert_eq!(contents[2]["parts"][0]["text"], "now");
    }

    #[test]
    fn build_contents_with_tool_exchanges_raw_parts() {
        let mut opts = LlmCallOpts::default();
        opts.tool_exchanges = vec![ToolExchangeEntry {
            tool_calls: vec![ToolCall {
                id: "c1".to_string(),
                name: "save_page".to_string(),
                arguments: serde_json::json!({"slug": "x"}),
            }],
            tool_results: vec![ToolResult {
                call_id: "c1".to_string(),
                name: "save_page".to_string(),
                result: serde_json::json!({"success": true}),
                success: true,
                error: None,
                ..Default::default()
            }],
            raw_model_parts: Some(serde_json::json!([
                {"text": "Calling save_page", "thought": true},
                {"functionCall": {"name": "save_page", "args": {"slug": "x"}}}
            ])),
        }];
        let contents = GeminiNativeHandler::build_contents("done", &opts, &[]);
        // 현재 user 1 + (model + user) tool exchange = 3
        assert_eq!(contents.len(), 3);
        // 두 번째: model — rawModelParts echo (thought 포함)
        assert_eq!(contents[1]["role"], "model");
        let model_parts = contents[1]["parts"].as_array().unwrap();
        assert_eq!(model_parts.len(), 2);
        assert_eq!(model_parts[0]["thought"], true);
        // 세 번째: user — functionResponse 페어
        assert_eq!(contents[2]["role"], "user");
        let resp = &contents[2]["parts"][0]["functionResponse"];
        assert_eq!(resp["name"], "save_page");
        assert_eq!(resp["response"]["success"], true);
    }

    #[test]
    fn build_contents_tool_exchanges_fallback_to_synthesis() {
        let mut opts = LlmCallOpts::default();
        opts.tool_exchanges = vec![ToolExchangeEntry {
            tool_calls: vec![ToolCall {
                id: "c1".to_string(),
                name: "save_page".to_string(),
                arguments: serde_json::json!({"slug": "y"}),
            }],
            tool_results: vec![ToolResult {
                call_id: "c1".to_string(),
                name: "save_page".to_string(),
                result: serde_json::json!({"success": true}),
                success: true,
                error: None,
                ..Default::default()
            }],
            raw_model_parts: None, // ← 합성 경로
        }];
        let contents = GeminiNativeHandler::build_contents("ok", &opts, &[]);
        let model_parts = contents[1]["parts"].as_array().unwrap();
        assert_eq!(model_parts.len(), 1);
        assert_eq!(model_parts[0]["functionCall"]["name"], "save_page");
    }

    #[test]
    fn build_body_includes_tools_and_function_calling_config() {
        let opts = LlmCallOpts::default();
        let tools = vec![ToolDefinition {
            name: "echo".to_string(),
            description: "echo".to_string(),
            input_schema: Some(serde_json::json!({"type": "object", "properties": {}})),
        }];
        let body = GeminiNativeHandler::build_body("test", &opts, &tools, &[], &dummy_config());
        let decls = body["tools"][0]["functionDeclarations"].as_array().unwrap();
        assert_eq!(decls.len(), 1);
        assert_eq!(decls[0]["name"], "echo");
        assert_eq!(body["toolConfig"]["functionCallingConfig"]["mode"], "AUTO");
    }

    #[test]
    fn parse_response_extracts_text_and_function_call() {
        let body = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [
                        {"text": "Done"},
                        {"functionCall": {"name": "save_page", "args": {"slug": "z"}}}
                    ]
                }
            }],
            "usageMetadata": {"promptTokenCount": 50, "candidatesTokenCount": 20}
        });
        let (text, calls, tin, tout, _cached, raw, thinking) =
            GeminiNativeHandler::parse_response(&body);
        assert_eq!(text, "Done");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "save_page");
        assert_eq!(calls[0].arguments["slug"], "z");
        assert_eq!(tin, 50);
        assert_eq!(tout, 20);
        assert!(raw.is_some());
        let raw_arr = raw.unwrap();
        assert_eq!(raw_arr.as_array().unwrap().len(), 2);
        // 새 동작 (commit d9cd9f3): function_call 인식 시 thinking_text 에 "[도구 호출: name]"
        // 마커 누적 → tool 만 있고 thought part 없어도 Some 반환. 옛 is_none 가정 갱신.
        assert!(thinking.is_some());
        let th = thinking.unwrap();
        // i18n 미초기화(단위 테스트) = t() 가 키 반환 — 초기화 여부 양쪽 수용.
        assert!(th.contains("[도구 호출:") || th.contains("tool_call_marker"));
    }

    #[test]
    fn parse_response_skips_thought_text() {
        let body = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [
                        {"text": "thinking...", "thought": true},
                        {"text": "Final answer"}
                    ]
                }
            }]
        });
        let (text, _, _, _, _, _, thinking) = GeminiNativeHandler::parse_response(&body);
        assert_eq!(text, "Final answer");
        assert_eq!(thinking.as_deref(), Some("thinking..."));
    }
}
