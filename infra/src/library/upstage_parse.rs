//! Upstage Document Parse client — the "solar" library parse provider.
//!
//! Live-verified contract (2026-07-13, server key against the real API — never trust docs)
//! + official doc reconciliation (2026-07-13, user-pasted spec):
//! `POST https://api.upstage.ai/v1/document-digitization`, multipart form
//! `document=@file` + `model=document-parse` + `output_formats=["markdown","text"]` → 200 with
//! `{ elements: [{ page, category, content: { markdown, text } }], usage: { pages } }`.
//! Elements carry a 1-based `page`, so per-page text is reconstructible — the library chunker
//! uses that for page mapping, same shape as `extractor::extract_pdf`.
//!
//! Doc-driven behaviors:
//! - `ocr` defaults to "auto" = OCR only for image files; a **scanned (non digital-born) PDF
//!   yields no text under auto** → on an empty first pass we retry once with `ocr=force`
//!   (converts pages to images + always OCR — the official example itself uses `ocr=force`).
//!   Digital-born docs never pay the retry.
//! - `usage.pages` = chargeable page count → logged for billing visibility.
//! - Server-side request timeout is 5 minutes; our LLM http_client (600s) covers it.
//! - Categories include `equation` (LaTeX in markdown) — formulas are parsed, not Gemini-only.
//! - `mode` (standard|enhanced|auto, document-parse-260128+) is left at the default `standard` —
//!   enhanced pages bill at a different (higher) rate; revisit if complex-visual docs underparse.
//!
//! Sync API only. Oversized documents fail with the API's own error (413 = >50MB) — explicit
//! error > silent partial parse. **Async API (deferred, contract captured 2026-07-13)**:
//! `POST /v1/document-digitization/async` (same form fields) → `{request_id}`; input is split
//! into 10-page batches (max 1000 pages / 50MB); poll `GET /v1/document-digitization/requests/
//! {request_id}` until `status=completed`, download each `batches[].download_url` (pre-signed,
//! 15-min validity — re-fetch the request for fresh URLs; results kept 30 days), each batch JSON
//! = this sync response shape for pages start_page..end_page, concatenate by batch id. Needs a
//! background-job flow (upload RPC can't block minutes) — wire when a real doc hits sync limits.
//! **Document OCR API (`model=ocr`) = not adopted**: word-level boxes only, no layout/markdown —
//! DP is a superset for text extraction, and DP already OCRs images under `ocr=auto`.

use serde::Deserialize;

const ENDPOINT: &str = "https://api.upstage.ai/v1/document-digitization";

#[derive(Deserialize)]
struct DpResponse {
    #[serde(default)]
    elements: Vec<DpElement>,
    #[serde(default)]
    usage: DpUsage,
}

#[derive(Deserialize, Default)]
struct DpUsage {
    #[serde(default)]
    pages: usize,
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

/// One API round trip. `force_ocr` maps to `ocr=force` (rasterize + always OCR — the scanned-PDF
/// path); default is the API's `auto`.
async fn request_parse(
    api_key: &str,
    bytes: &[u8],
    file_name: &str,
    force_ocr: bool,
) -> Result<DpResponse, String> {
    let part = reqwest::multipart::Part::bytes(bytes.to_vec()).file_name(file_name.to_string());
    let mut form = reqwest::multipart::Form::new()
        .part("document", part)
        .text("model", "document-parse")
        .text("output_formats", r#"["markdown","text"]"#)
        .text("coordinates", "false");
    if force_ocr {
        form = form.text("ocr", "force");
    }
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
    serde_json::from_str(&body).map_err(|e| format!("Upstage Document Parse 응답 파싱 실패: {e}"))
}

/// Group element text by page (elements arrive in reading order). Empty = no extractable text.
fn pages_from(parsed: DpResponse) -> Vec<(usize, String)> {
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
    pages
}

/// Parse a document file into markdown. Returns `(full_text, pages)` where `pages` mirrors the
/// local extractor's shape — `[(page_num_1based, start_char, end_char)]` char offsets into
/// `full_text` — so the chunk→page citation mapping works unchanged. Errors are surfaced with
/// the API's own message (no silent fallback — the user picked this provider).
pub async fn parse_document(
    api_key: &str,
    file_path: &str,
) -> Result<(String, Option<Vec<(usize, usize, usize)>>), String> {
    let bytes = std::fs::read(file_path).map_err(|e| format!("파일 read 실패: {e}"))?;
    let file_name = std::path::Path::new(file_path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "document".to_string());

    let parsed = request_parse(api_key, &bytes, &file_name, false).await?;
    let billed = parsed.usage.pages;
    let mut pages = pages_from(parsed);
    if pages.is_empty() {
        // ocr=auto found nothing — the scanned-PDF signature (non digital-born file has no text
        // layer, and auto skips OCR for non-image formats). One forced-OCR retry recovers it.
        tracing::info!(
            category = "library",
            "document parse empty under ocr=auto — retrying with ocr=force (scanned document?)"
        );
        let forced = request_parse(api_key, &bytes, &file_name, true).await?;
        tracing::info!(category = "library", pages = forced.usage.pages, "document parse billed pages (ocr=force)");
        pages = pages_from(forced);
    } else {
        tracing::info!(category = "library", pages = billed, "document parse billed pages");
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
