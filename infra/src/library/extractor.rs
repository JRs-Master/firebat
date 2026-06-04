//! Source 텍스트 추출 영역 (infra-side).
//!
//! 매 Source 형식 영역 추출 path:
//! - PDF — pdf-extract crate (텍스트 영역만, 스캔 PDF Phase 2 영역)
//! - TXT / MD — 직접 read (UTF-8 영역만, BOM 영역 제거)
//! - URL — Phase 1.5 영역 = sysmod_firecrawl 영역 frontend 영역 fetch + HTML strip
//!   → backend 는 inline_text 로 받음. backend extract_html 도입 X.
//! - 직접 입력 — frontend textarea 영역 받음 (추출 영역 0, 직접 저장 영역)
//!
//! 반환 영역 — `ExtractedText { full_text, pages? }`. pages 영역 = PDF 영역만 매 영역 (page_num, start_char, end_char).

use std::io::Read;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

#[derive(Debug, Clone)]
pub struct ExtractedText {
    pub full_text: String,
    /// PDF 영역만 — 매 page 영역 의 char offset 범위. citation 시점 매 chunk → page 매핑 영역.
    /// 형식 = `[(page_num_1based, start_char, end_char), ...]`
    pub pages: Option<Vec<(usize, usize, usize)>>,
}

/// PDF 영역 추출 — pdf-extract crate (텍스트 영역만).
/// 스캔 PDF (이미지) = Phase 2 OCR 도입 후 자연 처리.
/// 매 page boundary = `\x0c` (form feed) 문자 (pdf-extract 자연 동작).
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
    // 마지막 page (form feed 가 없는 부분)
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

// ── Office / OpenDocument / 한글신형 (ZIP + XML) ──────────────────────────────
// docx/pptx/hwpx/odt/odp 는 모두 ZIP 안 XML. zip 으로 풀어 XML 텍스트만 추출.
// 포맷별 문단 태그가 조금씩 달라도 공통 union 으로 흡수 (텍스트는 보존, 문단 구분만 약해짐).

/// XML → 텍스트 — 문단/줄바꿈 태그는 개행, 나머지 태그 제거 + 엔티티 디코드.
fn xml_to_text(xml: &str) -> String {
    static PARA_RE: OnceLock<Regex> = OnceLock::new();
    static TAG_RE: OnceLock<Regex> = OnceLock::new();
    static BLANK_RE: OnceLock<Regex> = OnceLock::new();
    let para = PARA_RE.get_or_init(|| {
        Regex::new(r"(?i)</(w:p|a:p|text:p|text:h|hp:p|p)>|<(w:br|a:br|text:line-break|hp:lineBreak)\s*/?>").unwrap()
    });
    let s = para.replace_all(xml, "\n");
    let tag = TAG_RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let no_tags = tag.replace_all(&s, "");
    let decoded = decode_xml_entities(&no_tags);
    let trimmed: String = decoded.lines().map(|l| l.trim_end()).collect::<Vec<_>>().join("\n");
    let blank = BLANK_RE.get_or_init(|| Regex::new(r"\n{3,}").unwrap());
    blank.replace_all(&trimmed, "\n\n").trim().to_string()
}

fn decode_xml_entities(s: &str) -> String {
    let mut out = s
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'");
    static NUM_RE: OnceLock<Regex> = OnceLock::new();
    let re = NUM_RE.get_or_init(|| Regex::new(r"&#(x?[0-9a-fA-F]+);").unwrap());
    out = re
        .replace_all(&out, |c: &regex::Captures| {
            let raw = &c[1];
            let code = if let Some(hex) = raw.strip_prefix('x').or_else(|| raw.strip_prefix('X')) {
                u32::from_str_radix(hex, 16).ok()
            } else {
                raw.parse::<u32>().ok()
            };
            code.and_then(char::from_u32).map(|ch| ch.to_string()).unwrap_or_default()
        })
        .to_string();
    out.replace("&amp;", "&") // &amp; 는 다른 엔티티 복원 후 마지막
}

fn open_zip(path: &Path) -> Result<zip::ZipArchive<std::fs::File>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("파일 열기 실패: {e}"))?;
    zip::ZipArchive::new(file).map_err(|e| format!("ZIP 열기 실패: {e}"))
}

fn read_zip_entry(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<String, String> {
    let mut entry = zip.by_name(name).map_err(|e| format!("{name} 없음: {e}"))?;
    let mut buf = String::new();
    entry
        .read_to_string(&mut buf)
        .map_err(|e| format!("{name} read 실패: {e}"))?;
    Ok(buf)
}

/// 단일 XML 엔트리 (docx=word/document.xml, odt/odp=content.xml).
fn extract_zip_doc(path: &Path, entry: &str, label: &str) -> Result<ExtractedText, String> {
    let mut zip = open_zip(path)?;
    let xml = read_zip_entry(&mut zip, entry)?;
    let text = xml_to_text(&xml);
    if text.trim().is_empty() {
        return Err(format!("{label} 에서 텍스트를 추출하지 못했습니다."));
    }
    Ok(ExtractedText { full_text: text, pages: None })
}

/// 여러 XML 엔트리 (pptx=ppt/slides/slideN.xml, hwpx=Contents/sectionN.xml). 파일명 숫자 순.
fn extract_zip_glob(path: &Path, prefix: &str, suffix: &str, label: &str) -> Result<ExtractedText, String> {
    let mut zip = open_zip(path)?;
    let mut names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| n.starts_with(prefix) && n.ends_with(suffix))
        .collect();
    names.sort_by_key(|n| {
        n.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse::<u64>().unwrap_or(0)
    });
    let mut parts: Vec<String> = Vec::new();
    for name in &names {
        if let Ok(xml) = read_zip_entry(&mut zip, name) {
            let t = xml_to_text(&xml);
            if !t.trim().is_empty() {
                parts.push(t);
            }
        }
    }
    let text = parts.join("\n\n");
    if text.trim().is_empty() {
        return Err(format!("{label} 에서 텍스트를 추출하지 못했습니다."));
    }
    Ok(ExtractedText { full_text: text, pages: None })
}

pub fn extract_docx(path: &Path) -> Result<ExtractedText, String> {
    extract_zip_doc(path, "word/document.xml", "docx")
}
pub fn extract_odt(path: &Path) -> Result<ExtractedText, String> {
    extract_zip_doc(path, "content.xml", "odt")
}
pub fn extract_odp(path: &Path) -> Result<ExtractedText, String> {
    extract_zip_doc(path, "content.xml", "odp")
}
pub fn extract_pptx(path: &Path) -> Result<ExtractedText, String> {
    extract_zip_glob(path, "ppt/slides/slide", ".xml", "pptx")
}
pub fn extract_hwpx(path: &Path) -> Result<ExtractedText, String> {
    extract_zip_glob(path, "Contents/section", ".xml", "hwpx")
}

/// 스프레드시트 — calamine 으로 xlsx / xls / ods 통합. 시트별 셀 → tab / 개행.
pub fn extract_spreadsheet(path: &Path) -> Result<ExtractedText, String> {
    use calamine::{open_workbook_auto, Data, Reader};
    let mut wb = open_workbook_auto(path).map_err(|e| format!("스프레드시트 열기 실패: {e}"))?;
    let mut out = String::new();
    for name in wb.sheet_names().to_vec() {
        let range = match wb.worksheet_range(&name) {
            Ok(r) => r,
            Err(_) => continue,
        };
        out.push_str(&format!("# {name}\n"));
        for row in range.rows() {
            let cells: Vec<String> = row
                .iter()
                .map(|c| match c {
                    Data::Empty => String::new(),
                    Data::String(s) => s.clone(),
                    Data::Float(f) => f.to_string(),
                    Data::Int(i) => i.to_string(),
                    Data::Bool(b) => b.to_string(),
                    _ => String::new(),
                })
                .collect();
            let line = cells.join("\t");
            if !line.trim().is_empty() {
                out.push_str(&line);
                out.push('\n');
            }
        }
        out.push('\n');
    }
    if out.trim().is_empty() {
        return Err("스프레드시트에서 텍스트를 추출하지 못했습니다.".into());
    }
    Ok(ExtractedText { full_text: out, pages: None })
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
    fn xml_to_text_strips_tags_and_decodes() {
        let xml = r#"<w:document><w:body><w:p><w:r><w:t>안녕 &amp; 반가워</w:t></w:r></w:p><w:p><w:t>둘째 줄</w:t></w:p></w:body></w:document>"#;
        let text = xml_to_text(xml);
        assert!(text.contains("안녕 & 반가워"), "엔티티 디코드 + 텍스트 보존: {text:?}");
        assert!(text.contains("둘째 줄"));
        assert!(text.contains('\n'), "문단 분리 개행: {text:?}");
    }
}
