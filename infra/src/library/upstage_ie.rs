//! Upstage Information Extraction (IE) client — document → structured JSON.
//!
//! Live-verified contract (2026-07-22, server key against the real API — never trust docs):
//! `POST https://api.upstage.ai/v1/information-extraction`, OpenAI chat/completions shape:
//!   { model: "information-extract",
//!     messages: [{ role:"user", content:[{ type:"image_url",
//!                   image_url:{ url:"data:<mime>;base64,<b64>" } }] }],
//!     response_format: { type:"json_schema", json_schema:{ name, schema } } }   ← REQUIRED
//! → 200 `{ choices:[{ message:{ content:"<json string matching schema>" } }], usage }`.
//!
//! `response_format` is mandatory — a call without it 400s ("universal-extraction" still needs a
//! schema). So when the caller gives no schema we first auto-generate one:
//! `POST /v1/information-extraction/schema-generation` (same doc message) → 200 with a
//! `{ type:"json_schema", json_schema:{...} }` body → feed that straight back as `response_format`.
//! This is the "자동 인식" path (schema is generated FROM the document, never hardcoded per file);
//! a caller-supplied schema (a skill's canonical exam/receipt schema) skips the extra round trip
//! and gives tighter, render-ready fields.
//!
//! Unlike Document Parse (layout → text, reading-order is the engine's and was non-deterministic
//! on multi-column exam papers), IE extracts by MEANING against the schema — choice→question
//! binding is structural, so the "②④ under 2." mangling doesn't happen.

use serde::Deserialize;

const IE_ENDPOINT: &str = "https://api.upstage.ai/v1/information-extraction";
const SCHEMA_GEN_ENDPOINT: &str = "https://api.upstage.ai/v1/information-extraction/schema-generation";

#[derive(Deserialize)]
struct ChatResponse {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}
#[derive(Deserialize)]
struct ChatChoice {
    #[serde(default)]
    message: ChatMessage,
}
#[derive(Deserialize, Default)]
struct ChatMessage {
    #[serde(default)]
    content: String,
}

/// MIME for the data URL from a file extension (IE takes PDF + common image types).
fn mime_for(file_path: &str) -> &'static str {
    let ext = std::path::Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "tiff" | "tif" => "image/tiff",
        "bmp" => "image/bmp",
        // PDF (+ unknown → PDF, the dominant document input)
        _ => "application/pdf",
    }
}

/// One chat/completions POST. `response_format` optional — schema-generation omits it.
async fn post_chat(
    api_key: &str,
    endpoint: &str,
    data_url: &str,
    response_format: Option<&serde_json::Value>,
) -> Result<String, String> {
    let mut body = serde_json::json!({
        "model": "information-extract",
        "messages": [{
            "role": "user",
            "content": [{ "type": "image_url", "image_url": { "url": data_url } }]
        }]
    });
    if let Some(rf) = response_format {
        body["response_format"] = rf.clone();
    }
    let resp = crate::llm::formats::common::http_client()
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Upstage IE 요청 실패: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Upstage IE 응답 read 실패: {e}"))?;
    if !status.is_success() {
        let head: String = text.chars().take(400).collect();
        return Err(format!("Upstage IE {status}: {head}"));
    }
    let parsed: ChatResponse =
        serde_json::from_str(&text).map_err(|e| format!("Upstage IE 응답 파싱 실패: {e}"))?;
    let content = parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .unwrap_or_default();
    if content.trim().is_empty() {
        return Err("Upstage IE 결과가 비어 있습니다.".to_string());
    }
    Ok(content)
}

/// Extract structured JSON from a document file.
/// `schema_json` = a `response_format` value (`{type:"json_schema", json_schema:{...}}`) OR just the
/// inner `{name, schema}` / bare JSON-schema object — normalized here. `None` = auto-generate the
/// schema from the document first (the "자동 인식" path).
/// Returns the model's content string (a JSON document matching the schema).
pub async fn extract_structured(
    api_key: &str,
    file_path: &str,
    schema_json: Option<&str>,
) -> Result<String, String> {
    let bytes = std::fs::read(file_path).map_err(|e| format!("파일 read 실패: {e}"))?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let data_url = format!("data:{};base64,{}", mime_for(file_path), b64);

    // response_format 확정 — 제공 스키마 정규화 or 자동 생성.
    let response_format: serde_json::Value = match schema_json {
        Some(raw) if !raw.trim().is_empty() => normalize_response_format(raw)?,
        _ => {
            // schema-generation: 문서에서 스키마 자동 생성 → 그대로 response_format 로.
            let gen = post_chat(api_key, SCHEMA_GEN_ENDPOINT, &data_url, None).await?;
            let v: serde_json::Value = serde_json::from_str(&gen)
                .map_err(|e| format!("Upstage IE 스키마 자동생성 파싱 실패: {e}"))?;
            normalize_response_format_value(v)?
        }
    };
    post_chat(api_key, IE_ENDPOINT, &data_url, Some(&response_format)).await
}

fn normalize_response_format(raw: &str) -> Result<serde_json::Value, String> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("스키마 JSON 파싱 실패: {e}"))?;
    normalize_response_format_value(v)
}

/// 받은 스키마를 `{type:"json_schema", json_schema:{name, schema}}` 형태로 정규화 —
/// 이미 그 shape 이면 그대로, `{name, schema}` 면 감싸고, 순수 JSON-schema 면 name 부여해 감싼다.
fn normalize_response_format_value(v: serde_json::Value) -> Result<serde_json::Value, String> {
    if v.get("type").and_then(|t| t.as_str()) == Some("json_schema") && v.get("json_schema").is_some()
    {
        return Ok(v);
    }
    let json_schema = if v.get("schema").is_some() {
        // {name?, schema}
        let name = v
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("document_schema");
        serde_json::json!({ "name": name, "schema": v.get("schema").cloned().unwrap() })
    } else if v.get("type").and_then(|t| t.as_str()) == Some("object") {
        // 순수 JSON schema object
        serde_json::json!({ "name": "document_schema", "schema": v })
    } else {
        return Err("스키마 형식을 인식하지 못했습니다 (json_schema / {name,schema} / JSON schema object).".to_string());
    };
    Ok(serde_json::json!({ "type": "json_schema", "json_schema": json_schema }))
}
