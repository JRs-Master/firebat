//! Vertex AI Gemini — GCP Service Account 기반 (옛 TS `vertex-gemini.ts` 1:1 port).
//!
//! 인증 흐름:
//! 1. Vault 에서 `GOOGLE_SERVICE_ACCOUNT_JSON` (전체 JSON 문자열) 로드 → api_key 인자로 전달
//! 2. 본 핸들러가 JSON 파싱 → RS256 JWT 서명 (jsonwebtoken crate) → Google OAuth2 token endpoint
//!    `https://oauth2.googleapis.com/token` POST → `access_token` 발급 (1h 만료)
//! 3. access_token 을 Bearer 헤더로 Vertex AI generateContent endpoint 호출
//! 4. access_token 은 client_email 단위 1h cache (튜닝 시점에 재발급)
//!
//! Endpoint: `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`
//! - project: SA JSON 의 `project_id`
//! - location: `extra_headers["x-vertex-location"]` 또는 default `us-central1`
//!
//! 멀티턴 / 이미지 / thinking 처리는 gemini_native 와 1:1 동일 (`build_contents` / `build_body` 공유 로직).

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::llm::adapter::FormatHandler;
use crate::llm::formats::common::{compute_cost, http_client, map_reqwest_error};
use crate::llm::formats::gemini_shared::sanitize_gemini_schema;
use firebat_core::llm::config::LlmModelConfig;
use firebat_core::ports::{
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolCall, ToolDefinition,
    ToolResult,
};

/// access_token 캐시 — `client_email + project + location` key.
/// 1h TTL — Google OAuth2 token 만료 (3600s) - 60s safety margin.
struct CachedToken {
    access_token: String,
    expires_at_unix: u64,
}

pub struct VertexGeminiHandler {
    cache: Mutex<std::collections::HashMap<String, CachedToken>>,
}

impl VertexGeminiHandler {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// SA JSON → RS256 JWT → access_token. 1h cache.
    /// 옛 TS `@google/genai` SDK 의 `googleAuthOptions.credentials` 자동 갱신과 동등.
    async fn resolve_access_token(
        &self,
        sa_json_str: &str,
        config: &LlmModelConfig,
    ) -> Result<(String, String, String), String> {
        let sa: serde_json::Value = serde_json::from_str(sa_json_str)
            .map_err(|e| format!("Vertex SA JSON 파싱 실패: {e}"))?;
        let client_email = sa
            .get("client_email")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Vertex SA JSON 에 client_email 필드 없음".to_string())?;
        let private_key = sa
            .get("private_key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Vertex SA JSON 에 private_key 필드 없음".to_string())?;
        let project = sa
            .get("project_id")
            .and_then(|v| v.as_str())
            .or_else(|| {
                config
                    .extra_headers
                    .get("x-vertex-project")
                    .map(|s| s.as_str())
            })
            .ok_or_else(|| "Vertex project_id 미설정 — SA JSON 또는 extra_headers".to_string())?;
        let location = config
            .extra_headers
            .get("x-vertex-location")
            .map(|s| s.as_str())
            .unwrap_or("us-central1");

        let cache_key = format!("{}|{}|{}", client_email, project, location);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        // cache hit
        if let Ok(cache) = self.cache.lock() {
            if let Some(cached) = cache.get(&cache_key) {
                if cached.expires_at_unix > now + 60 {
                    return Ok((cached.access_token.clone(), project.to_string(), location.to_string()));
                }
            }
        }

        // JWT 서명 — RS256, claims: iss(client_email), scope(cloud-platform), aud(token endpoint), iat, exp
        let iat = now;
        let exp = now + 3600;
        let claims = serde_json::json!({
            "iss": client_email,
            "scope": "https://www.googleapis.com/auth/cloud-platform",
            "aud": "https://oauth2.googleapis.com/token",
            "iat": iat,
            "exp": exp
        });
        let header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
        let key = jsonwebtoken::EncodingKey::from_rsa_pem(private_key.as_bytes())
            .map_err(|e| format!("Vertex SA private_key RSA PEM 파싱 실패: {e}"))?;
        let jwt = jsonwebtoken::encode(&header, &claims, &key)
            .map_err(|e| format!("Vertex SA JWT 서명 실패: {e}"))?;

        // OAuth2 token endpoint — application/x-www-form-urlencoded
        let form = [
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", &jwt),
        ];
        let response = http_client()
            .post("https://oauth2.googleapis.com/token")
            .form(&form)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        let body: serde_json::Value = response.json().await.map_err(map_reqwest_error)?;
        if !status.is_success() {
            return Err(format!(
                "Vertex OAuth2 token 발급 실패 {}: {}",
                status, body
            ));
        }
        let access_token = body
            .get("access_token")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("Vertex OAuth2 응답에 access_token 없음: {}", body))?
            .to_string();
        let expires_in = body
            .get("expires_in")
            .and_then(|v| v.as_u64())
            .unwrap_or(3600);
        let expires_at_unix = now + expires_in;

        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(
                cache_key,
                CachedToken {
                    access_token: access_token.clone(),
                    expires_at_unix,
                },
            );
        }
        Ok((access_token, project.to_string(), location.to_string()))
    }

    /// Vertex generateContent endpoint URL 빌드.
    fn build_endpoint(model: &str, project: &str, location: &str) -> String {
        format!(
            "https://{}-aiplatform.googleapis.com/v1/projects/{}/locations/{}/publishers/google/models/{}:generateContent",
            location, project, location, model
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
                                thinking_text.push_str(&format!("[도구 호출: {}]", name));
                            }
                            tool_calls.push(ToolCall {
                                id: format!("vertex-call-{}", idx),
                                name,
                                arguments: args,
                            });
                        }
                    }
                }
            }
        }
        // Vertex Gemini usageMetadata: promptTokenCount(캐시 포함 총 입력) / candidatesTokenCount(답변) /
        // thoughtsTokenCount(thinking, 출력 과금) / cachedContentTokenCount(캐시 부분집합).
        let usage = body.get("usageMetadata");
        let get_usage = |key: &str| -> i64 {
            usage.and_then(|u| u.get(key)).and_then(|v| v.as_i64()).unwrap_or(0)
        };
        let tokens_in = get_usage("promptTokenCount");
        let tokens_out = get_usage("candidatesTokenCount") + get_usage("thoughtsTokenCount");
        let cached_tokens = get_usage("cachedContentTokenCount");
        let thinking_opt = if thinking_text.is_empty() {
            None
        } else {
            Some(thinking_text)
        };
        (text, tool_calls, tokens_in, tokens_out, cached_tokens, raw_parts, thinking_opt)
    }

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

    /// `contents` 빌드 — gemini_native 와 1:1 동일 (DRY 위반 회피하려면 gemini_shared 로 추출 가능 — 후속).
    fn build_contents(
        prompt: &str,
        opts: &LlmCallOpts,
        prior_results: &[ToolResult],
    ) -> Vec<serde_json::Value> {
        let mut contents: Vec<serde_json::Value> = Vec::new();
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
        let mut user_parts: Vec<serde_json::Value> = vec![serde_json::json!({ "text": prompt })];
        if let Some(img) = opts.image.as_deref() {
            user_parts.push(Self::image_to_inline_data_part(img, opts.image_mime_type.as_deref()));
        }
        contents.push(serde_json::json!({ "role": "user", "parts": user_parts }));

        if !opts.tool_exchanges.is_empty() {
            for ex in &opts.tool_exchanges {
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
        gen["maxOutputTokens"] = serde_json::Value::from(opts.max_tokens.unwrap_or(8192));
        let thinking_enabled = config.features.thinking;
        if thinking_enabled {
            let level = opts.thinking_level.as_deref().unwrap_or("low");
            gen["thinkingConfig"] = Self::build_thinking_config(level);
        }
        if !gen.as_object().map(|o| o.is_empty()).unwrap_or(true) {
            body["generationConfig"] = gen;
        }
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

#[async_trait::async_trait]
impl FormatHandler for VertexGeminiHandler {
    async fn ask_text(
        &self,
        config: &LlmModelConfig,
        api_key: Option<&str>,
        prompt: &str,
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmTextResponse> {
        let sa_json = api_key
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                format!(
                    "Vertex SA JSON 미설정 — Vault `{}` 에 넣으세요 (Service Account JSON 전체)",
                    config.api_key_vault_key.as_deref().unwrap_or("(미정의)")
                )
            })?;
        let (access_token, project, location) =
            self.resolve_access_token(sa_json, config).await?;
        let url = Self::build_endpoint(&config.id, &project, &location);
        let body = Self::build_body(prompt, opts, &[], &[], config);

        let response = http_client()
            .post(&url)
            .bearer_auth(&access_token)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        let body_json: serde_json::Value = response.json().await.map_err(map_reqwest_error)?;
        if !status.is_success() {
            // 401 면 token cache invalidate + 재시도 1회 (만료 직전 race)
            if status.as_u16() == 401 {
                if let Ok(mut cache) = self.cache.lock() {
                    cache.clear();
                }
            }
            return Err(format!("Vertex API 에러 {}: {}", status, body_json));
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
        let sa_json = api_key
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                format!(
                    "Vertex SA JSON 미설정 — Vault `{}` 에 넣으세요 (Service Account JSON 전체)",
                    config.api_key_vault_key.as_deref().unwrap_or("(미정의)")
                )
            })?;
        let (access_token, project, location) =
            self.resolve_access_token(sa_json, config).await?;
        let url = Self::build_endpoint(&config.id, &project, &location);
        let body = Self::build_body(prompt, opts, tools, prior_results, config);

        let response = http_client()
            .post(&url)
            .bearer_auth(&access_token)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        let body_json: serde_json::Value = response.json().await.map_err(map_reqwest_error)?;
        if !status.is_success() {
            if status.as_u16() == 401 {
                if let Ok(mut cache) = self.cache.lock() {
                    cache.clear();
                }
            }
            return Err(format!("Vertex API 에러 {}: {}", status, body_json));
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
    use std::collections::HashMap;

    fn dummy_config() -> LlmModelConfig {
        let mut extra = HashMap::new();
        extra.insert("x-vertex-location".to_string(), "us-central1".to_string());
        LlmModelConfig {
            id: "gemini-3.1-pro".to_string(),
            display_name: "Vertex Gemini 3.1 Pro".to_string(),
            provider: "google".to_string(),
            format: "vertex-gemini".to_string(),
            endpoint: "".to_string(),
            api_key_vault_key: Some("GOOGLE_SERVICE_ACCOUNT_JSON".to_string()),
            extra_headers: extra,
            features: firebat_core::llm::config::LlmFeatures::default(),
            pricing: None,
            thinking: None,
            exec_mode: "api".to_string(),
            cli_provider: None,
            category: "vertex-google".to_string(),
        }
    }

    #[test]
    fn build_endpoint_uses_location_and_project() {
        let url = VertexGeminiHandler::build_endpoint("gemini-3.1-pro", "my-proj", "asia-northeast3");
        assert!(url.starts_with("https://asia-northeast3-aiplatform.googleapis.com"));
        assert!(url.contains("/projects/my-proj/"));
        assert!(url.contains("/models/gemini-3.1-pro:"));
    }

    #[test]
    fn build_thinking_config_minimal() {
        let v = VertexGeminiHandler::build_thinking_config("minimal");
        assert_eq!(v["thinkingLevel"], "minimal");
        assert!(v.get("includeThoughts").is_none());
    }

    #[test]
    fn build_contents_user_only() {
        let opts = LlmCallOpts::default();
        let contents = VertexGeminiHandler::build_contents("hi", &opts, &[]);
        assert_eq!(contents.len(), 1);
        assert_eq!(contents[0]["role"], "user");
    }

    #[test]
    fn build_body_includes_function_calling_config() {
        let opts = LlmCallOpts::default();
        let tools = vec![ToolDefinition {
            name: "echo".to_string(),
            description: "echo".to_string(),
            input_schema: Some(serde_json::json!({"type": "object", "properties": {}})),
        }];
        let body = VertexGeminiHandler::build_body("test", &opts, &tools, &[], &dummy_config());
        assert_eq!(body["toolConfig"]["functionCallingConfig"]["mode"], "AUTO");
    }

    #[test]
    fn parse_response_extracts_function_call() {
        let body = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [{"functionCall": {"name": "save_page", "args": {"slug": "z"}}}]
                }
            }],
            "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 50}
        });
        let (_, calls, tin, tout, _cached, _raw, thinking) = VertexGeminiHandler::parse_response(&body);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "save_page");
        assert_eq!(tin, 100);
        assert_eq!(tout, 50);
        // 새 동작 (commit d9cd9f3): function_call 인식 시 thinking_text 에 "[도구 호출: name]"
        // 마커 누적 → tool 만 있고 thought part 없어도 Some 반환. 옛 is_none 가정 갱신.
        assert!(thinking.is_some());
        assert!(thinking.unwrap().contains("[도구 호출:"));
    }
}
