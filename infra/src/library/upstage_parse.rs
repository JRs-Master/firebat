//! Upstage Document Parse client — the "solar" library parse provider.
//!
//! Live-verified contract (2026-07-13, server key against the real API — never trust docs):
//! `POST https://api.upstage.ai/v1/document-digitization`, multipart form
//! `document=@file` + `model=document-parse` + `output_formats=["markdown"]` → 200 with
//! `{ elements: [{ page, content: { markdown, text } }], usage: { pages } }`.
//! Elements carry a 1-based `page`, so per-page text is reconstructible — the library chunker
//! uses that for page mapping, same shape as `extractor::extract_pdf`.
//!
//! Sync API only (page-bounded). Oversized documents fail with the API's own error — the
//! async job API is out of scope for v1 (explicit error > silent partial parse).

use serde::Deserialize;

const ENDPOINT: &str = "https://api.upstage.ai/v1/document-digitization";

#[derive(Deserialize)]
struct DpResponse {
    #[serde(default)]
    elements: Vec<DpElement>,
}

#[derive(Deserialize)]
struct DpElement {
    #[serde(default)]
    page: usize,
    #[serde(default)]
    content: DpContent,
}

#[derive(Deserialize, Default)]
struct DpContent {
    #[serde(default)]
    markdown: String,
    #[serde(default)]
    text: String,
}

/// Parse a document file into markdown. Returns `(full_text, pages)` where `pages` mirrors the
/// local extractor's shape — `[(page_num_1based, start_char, end_char)]` char offsets into
/// `full_text` — so the chunk→page citation mapping works unchanged. Errors are surfaced with
/// the API's own message (no silent fallback — the user picked this provider).
pub async fn parse_document(
    api_key: &str,
    file_path: &str,
) -> Result<(String, Option<Vec<(usize, usize, usize)>>), String> {
    let bytes =
        std::fs::read(file_path).map_err(|e| format!("파일 read 실패: {e}"))?;
    let file_name = std::path::Path::new(file_path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "document".to_string());
    let part = reqwest::multipart::Part::bytes(bytes).file_name(file_name);
    let form = reqwest::multipart::Form::new()
        .part("document", part)
        .text("model", "document-parse")
        .text("output_formats", r#"["markdown","text"]"#);
    let resp = crate::llm::formats::common::http_client()
        .post(ENDPOINT)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Upstage Document Parse 요청 실패: {e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Upstage Document Parse 응답 read 실패: {e}"))?;
    if !status.is_success() {
        let head: String = body.chars().take(300).collect();
        return Err(format!("Upstage Document Parse {status}: {head}"));
    }
    let parsed: DpResponse = serde_json::from_str(&body)
        .map_err(|e| format!("Upstage Document Parse 응답 파싱 실패: {e}"))?;
    // Group element text by page (elements arrive in reading order).
    let mut pages: Vec<(usize, String)> = Vec::new();
    for el in parsed.elements {
        let content = if !el.content.markdown.trim().is_empty() {
            el.content.markdown.trim().to_string()
        } else {
            el.content.text.trim().to_string()
        };
        if content.is_empty() {
            continue;
        }
        match pages.last_mut() {
            Some((p, buf)) if *p == el.page => {
                buf.push_str("\n\n");
                buf.push_str(&content);
            }
            _ => pages.push((el.page, content)),
        }
    }
    if pages.is_empty() {
        return Err("Upstage Document Parse 결과가 비어 있습니다 (추출 가능한 텍스트 없음).".to_string());
    }
    // Assemble full_text + char-offset page ranges (extractor::ExtractedText 규약).
    let mut full_text = String::new();
    let mut ranges: Vec<(usize, usize, usize)> = Vec::new();
    let mut char_pos = 0usize;
    let total = pages.len();
    for (i, (page_no, text)) in pages.into_iter().enumerate() {
        let start = char_pos;
        let n_chars = text.chars().count();
        full_text.push_str(&text);
        char_pos += n_chars;
        ranges.push((page_no, start, char_pos));
        if i + 1 < total {
            full_text.push_str("\n\x0c\n");
            char_pos += 3;
        }
    }
    Ok((full_text, Some(ranges)))
}
