//! Gemini Native API — AI Studio (옛 TS gemini-native.ts).
//!
//! Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}
//! Request: { contents: [{role, parts: [{text}]}], tools: [{functionDeclarations: [...]}] }
//! Response: { candidates: [{content: {parts: [{text} | {functionCall}]}}], usageMetadata }
//!
//! Phase B-17 minimum: 표준 generateContent. thinking / streaming 후속.

use crate::llm::adapter::FormatHandler;
use crate::llm::config::LlmModelConfig;
use crate::llm::formats::common::{compute_cost, http_client, map_reqwest_error, require_api_key};
use crate::ports::{
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

    fn parse_response(body: &serde_json::Value) -> (String, Vec<ToolCall>, i64, i64) {
        let mut text = String::new();
        let mut tool_calls = Vec::new();
        if let Some(candidates) = body.get("candidates").and_then(|v| v.as_array()) {
            if let Some(first) = candidates.first() {
                if let Some(parts) = first
                    .get("content")
                    .and_then(|c| c.get("parts"))
                    .and_then(|p| p.as_array())
                {
                    for (idx, p) in parts.iter().enumerate() {
                        if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                            text.push_str(t);
                        }
                        if let Some(fc) = p.get("functionCall") {
                            let name = fc
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let args =
                                fc.get("args").cloned().unwrap_or(serde_json::json!({}));
                            // Gemini 는 call_id 필드 없음 — index 합성
                            tool_calls.push(ToolCall {
                                id: format!("gemini-call-{idx}"),
                                name,
                                arguments: args,
                            });
                        }
                    }
                }
            }
        }
        let tokens_in = body
            .get("usageMetadata")
            .and_then(|u| u.get("promptTokenCount"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let tokens_out = body
            .get("usageMetadata")
            .and_then(|u| u.get("candidatesTokenCount"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        (text, tool_calls, tokens_in, tokens_out)
    }

    fn build_body(prompt: &str, opts: &LlmCallOpts, tools: &[ToolDefinition]) -> serde_json::Value {
        let contents = serde_json::json!([
            {"role": "user", "parts": [{"text": prompt}]}
        ]);
        let mut body = serde_json::json!({"contents": contents});
        if let Some(sp) = opts.system_prompt.as_deref() {
            if !sp.is_empty() {
                body["systemInstruction"] = serde_json::json!({
                    "parts": [{"text": sp}]
                });
            }
        }
        // generationConfig
        let mut gen = serde_json::json!({});
        if let Some(t) = opts.temperature {
            gen["temperature"] = serde_json::Value::from(t);
        }
        if let Some(m) = opts.max_tokens {
            gen["maxOutputTokens"] = serde_json::Value::from(m);
        }
        if !gen.as_object().unwrap().is_empty() {
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
            body["tools"] = serde_json::json!([{
                "functionDeclarations": function_declarations
            }]);
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

/// Gemini schema quirk — enum 은 string 배열만, integer/number + enum 조합 금지 → enum 제거.
/// 옛 TS gemini 공통 스키마 어댑터 Rust port.
fn sanitize_gemini_schema(schema: &serde_json::Value) -> serde_json::Value {
    let mut cloned = schema.clone();
    walk_sanitize(&mut cloned);
    cloned
}

fn walk_sanitize(v: &mut serde_json::Value) {
    if let serde_json::Value::Object(map) = v {
        // integer/number + enum 조합 금지
        let ty = map.get("type").and_then(|t| t.as_str()).map(String::from);
        if matches!(ty.as_deref(), Some("integer") | Some("number")) && map.contains_key("enum") {
            map.remove("enum");
        }
        // enum 값을 string 배열로 강제
        if let Some(enum_val) = map.get_mut("enum") {
            if let Some(arr) = enum_val.as_array_mut() {
                let strs: Vec<serde_json::Value> = arr
                    .iter()
                    .map(|v| match v {
                        serde_json::Value::String(s) => serde_json::Value::String(s.clone()),
                        _ => serde_json::Value::String(v.to_string()),
                    })
                    .collect();
                *arr = strs;
            }
        }
        // 재귀 — properties / items / additionalProperties
        for (_k, child) in map.iter_mut() {
            walk_sanitize(child);
        }
    } else if let serde_json::Value::Array(arr) = v {
        for child in arr.iter_mut() {
            walk_sanitize(child);
        }
    }
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
        let body = Self::build_body(prompt, opts, &[]);

        let response = http_client()
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        let body_json: serde_json::Value = response.json().await.map_err(map_reqwest_error)?;
        if !status.is_success() {
            return Err(format!("Gemini API 에러 {}: {}", status, body_json));
        }
        let (text, _calls, tokens_in, tokens_out) = Self::parse_response(&body_json);
        let cost = compute_cost(config, tokens_in, tokens_out);
        Ok(LlmTextResponse {
            text,
            model_id: config.id.clone(),
            cost_usd: Some(cost),
            tokens_in: Some(tokens_in),
            tokens_out: Some(tokens_out),
        })
    }

    async fn ask_with_tools(
        &self,
        config: &LlmModelConfig,
        api_key: Option<&str>,
        prompt: &str,
        tools: &[ToolDefinition],
        _prior_results: &[ToolResult],
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmToolResponse> {
        // Phase B-17 minimum: prior_results 미반영 (Gemini 의 멀티턴 functionResponse 처리는 후속).
        let key = require_api_key(config, api_key)?;
        let url = Self::build_endpoint(config, &key);
        let body = Self::build_body(prompt, opts, tools);

        let response = http_client()
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        let body_json: serde_json::Value = response.json().await.map_err(map_reqwest_error)?;
        if !status.is_success() {
            return Err(format!("Gemini API 에러 {}: {}", status, body_json));
        }
        let (text, tool_calls, tokens_in, tokens_out) = Self::parse_response(&body_json);
        let cost = compute_cost(config, tokens_in, tokens_out);
        Ok(LlmToolResponse {
            text,
            tool_calls,
            model_id: config.id.clone(),
            cost_usd: Some(cost),
            tokens_in: Some(tokens_in),
            tokens_out: Some(tokens_out),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_removes_enum_on_integer() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "n": {"type": "integer", "enum": [1, 2, 3]}
            }
        });
        let cleaned = sanitize_gemini_schema(&schema);
        assert!(cleaned["properties"]["n"].get("enum").is_none());
    }

    #[test]
    fn sanitize_converts_enum_to_strings() {
        let schema = serde_json::json!({
            "type": "string",
            "enum": ["a", "b"]
        });
        let cleaned = sanitize_gemini_schema(&schema);
        let arr = cleaned["enum"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert!(arr[0].is_string());
    }
}
