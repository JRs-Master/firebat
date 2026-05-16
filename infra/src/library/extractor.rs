//! Source 텍스트 추출 영역 (infra-side).
//!
//! 매 Source 형식 영역 추출 path:
//! - PDF — pdf-extract crate (텍스트 영역만, 스캔 PDF Phase 2 영역)
//! - TXT / MD — 직접 read (UTF-8 영역만, BOM 영역 제거)
//! - HTML — strip tags + 단순 text 영역 추출 (옛 sysmod_firecrawl / browser-scrape 영역 자연 활용 가능)
//! - 직접 입력 — frontend textarea 영역 받음 (추출 영역 0, 직접 저장 영역)
//!
//! 반환 영역 — `ExtractedText { full_text, pages? }`. pages 영역 = PDF 영역만 매 영역 (page_num, start_char, end_char).

use std::path::Path;

#[derive(Debug, Clone)]
pub struct ExtractedText {
    pub full_text: String,
    /// PDF 영역만 — 매 page 영역 의 char offset 범위. citation 시점 매 chunk → page 매핑 영역.
    /// 형식 = `[(page_num_1based, start_char, end_char), ...]`
    pub pages: Option<Vec<(usize, usize, usize)>>,
}

/// PDF 영역 추출 — pdf-extract crate (텍스트 영역만).
/// 스캔 PDF (이미지 영역) = Phase 2 영역 OCR 영역 박은 후 자연 영역.
/// 매 page 영역 boundary 영역 = `\x0c` (form feed) 영역 박은 영역 (pdf-extract 영역 자연).
pub fn extract_pdf(path: &Path) -> Result<ExtractedText, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("PDF read 실패: {e}"))?;
    let full_text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| format!("PDF text 추출 실패: {e}"))?;

    // 매 page 영역 boundary 영역 — pdf-extract 영역 = page 영역 마다 `\x0c` (form feed) 영역.
    let mut pages = Vec::new();
    let mut start = 0usize;
    let mut page_num = 1usize;
    for (idx, ch) in full_text.char_indices() {
        if ch == '\x0c' {
            pages.push((page_num, start, idx));
            start = idx + 1;
            page_num += 1;
        }
    }
    // 마지막 page 영역 (form feed 영역 박지 X 영역)
    if start < full_text.chars().count() {
        pages.push((page_num, start, full_text.chars().count()));
    }

    Ok(ExtractedText {
        full_text,
        pages: if pages.is_empty() { None } else { Some(pages) },
    })
}

/// TXT / MD 영역 추출 — 직접 read (UTF-8 + BOM 영역 제거).
pub fn extract_text_file(path: &Path) -> Result<ExtractedText, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("TXT/MD read 실패: {e}"))?;
    // BOM 영역 제거 (UTF-8 BOM `\u{FEFF}`)
    let cleaned = raw.trim_start_matches('\u{FEFF}').to_string();
    Ok(ExtractedText {
        full_text: cleaned,
        pages: None,
    })
}

/// HTML 영역 추출 — 단순 tag strip 영역 (script / style 영역 제거 + text node 영역 추출).
/// 정공 영역 = sysmod_firecrawl 영역 호출 영역 (Phase 1 영역 = HTML 영역도 자연 추출).
/// 본 영역 = fallback (HTML 영역 직접 박힌 영역).
pub fn extract_html(html: &str) -> Result<ExtractedText, String> {
    // 매 영역 단순 tag strip — script / style 영역 제거 + tag 영역 제거.
    let mut output = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut in_script = false;
    let mut in_style = false;
    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !in_tag && bytes[i..].starts_with(b"<script") {
            in_script = true;
            in_tag = true;
            i += 1;
            continue;
        }
        if !in_tag && bytes[i..].starts_with(b"<style") {
            in_style = true;
            in_tag = true;
            i += 1;
            continue;
        }
        if in_script && bytes[i..].starts_with(b"</script>") {
            in_script = false;
            in_tag = true;
            i += 9;
            continue;
        }
        if in_style && bytes[i..].starts_with(b"</style>") {
            in_style = false;
            in_tag = true;
            i += 8;
            continue;
        }
        if in_script || in_style {
            i += 1;
            continue;
        }
        if bytes[i] == b'<' {
            in_tag = true;
            i += 1;
            continue;
        }
        if bytes[i] == b'>' {
            in_tag = false;
            i += 1;
            continue;
        }
        if !in_tag {
            output.push(bytes[i] as char);
        }
        i += 1;
    }
    // 매 연속 영역 whitespace 영역 단순 normalize 영역 (` ` * N → ` `)
    let normalized: String = output.split_whitespace().collect::<Vec<_>>().join(" ");
    Ok(ExtractedText {
        full_text: normalized,
        pages: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_text_file_bom_stripped() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), "\u{FEFF}hello world").unwrap();
        let result = extract_text_file(tmp.path()).unwrap();
        assert_eq!(result.full_text, "hello world");
        assert!(result.pages.is_none());
    }

    #[test]
    fn extract_html_strips_tags() {
        let html = "<html><body><h1>Title</h1><p>Hello <b>world</b></p></body></html>";
        let result = extract_html(html).unwrap();
        assert_eq!(result.full_text, "Title Hello world");
    }

    #[test]
    fn extract_html_strips_script_style() {
        let html = "<style>body { color: red; }</style><script>alert(1)</script><p>Visible</p>";
        let result = extract_html(html).unwrap();
        assert_eq!(result.full_text, "Visible");
    }

    #[test]
    fn extract_html_korean() {
        let html = "<p>안녕하세요 <b>세계</b></p>";
        let result = extract_html(html).unwrap();
        assert_eq!(result.full_text, "안녕하세요 세계");
    }
}
