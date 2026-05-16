//! Library Phase 1 — Source 추출 영역 (infra-side).
//!
//! 매 Source 형식 영역 추출 path:
//! - PDF — pdf-extract crate (텍스트 영역만, 스캔 PDF Phase 2 영역)
//! - TXT / MD — 직접 read
//! - URL — sysmod_firecrawl 또는 ReqwestNetworkAdapter 통한 HTTP fetch + HTML strip
//! - 직접 입력 — frontend 영역 textarea 영역 받음 (추출 영역 0 — 직접 저장)

pub mod extractor;
