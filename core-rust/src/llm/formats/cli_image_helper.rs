//! CLI 어댑터 공통 — `opts.image` (base64) → 임시 파일 저장 헬퍼.
//!
//! 옛 TS `infra/llm/formats/cli-image-helper.ts` 1:1 port.
//!
//! 사용 패턴 (Codex / Gemini CLI):
//! ```ignore
//! let tmp = write_image_temp_file(opts.image.as_deref(), opts.image_mime_type.as_deref(), None);
//! if let Some(t) = &tmp {
//!     args.push("--image".to_string());     // Codex
//!     args.push(t.path.clone());
//! }
//! if let Some(t) = &tmp {
//!     final_prompt = format!("@{}\n\n{}", t.path, final_prompt);  // Gemini
//! }
//! // 종료 후
//! cleanup_temp_file(tmp.as_ref().map(|t| t.path.as_str()));
//! ```
//!
//! Claude Code 는 stream-json input 으로 base64 직접 전달 (이 헬퍼 미사용 — extract_image_base64 만).

use base64::Engine;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// 임시 파일 정보 — path + 추론된 mime_type. 종료 시 cleanup_temp_file 호출.
#[derive(Debug, Clone)]
pub struct TempImageFile {
    pub path: String,
    pub mime_type: String,
}

/// 이미지 임시 파일 저장 — 옛 TS writeImageTempFile 1:1.
///
/// `image` 인자 형식:
/// - `data:image/png;base64,iVBORw0KGgo=` (data URL)
/// - `iVBORw0KGgo=` (raw base64 — mimeType 명시 또는 default png)
///
/// `dir_override` — 저장 디렉토리 지정. None 이면 std::env::temp_dir() (Codex).
/// Gemini CLI 는 workspace 제약 회피용 — workspace 안 경로 명시.
pub fn write_image_temp_file(
    image: Option<&str>,
    mime_type: Option<&str>,
    dir_override: Option<&str>,
) -> Option<TempImageFile> {
    let image = image?;
    if image.is_empty() {
        return None;
    }
    // data: URL 형태이면 prefix 제거. raw base64 면 그대로.
    let data = if let Some(idx) = image.find(',') {
        &image[(idx + 1)..]
    } else {
        image
    };
    // mime_type 결정 — 인자 명시 → data: URL 의 mime → png default
    let mt: String = if let Some(m) = mime_type {
        m.to_string()
    } else if let Some(stripped) = image.strip_prefix("data:") {
        stripped
            .split(';')
            .next()
            .unwrap_or("image/png")
            .to_string()
    } else {
        "image/png".to_string()
    };
    // 확장자 추론 — 옛 TS 1:1 (png / jpg / webp / gif / bin)
    let ext = if mt.contains("png") {
        "png"
    } else if mt.contains("jpeg") || mt.contains("jpg") {
        "jpg"
    } else if mt.contains("webp") {
        "webp"
    } else if mt.contains("gif") {
        "gif"
    } else {
        "bin"
    };
    let dir = match dir_override {
        Some(p) => PathBuf::from(p),
        None => std::env::temp_dir(),
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // base36 random suffix 흉내 — opt TS Math.random().toString(36).slice(2,8) 등가성.
    use rand::RngCore;
    let mut buf = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut buf);
    let rand_suffix = hex::encode(buf);
    let filename = format!("firebat-attached-{}-{}.{}", now_ms, &rand_suffix[..6], ext);
    let tmp_path = dir.join(filename);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    if std::fs::write(&tmp_path, &bytes).is_err() {
        return None;
    }
    Some(TempImageFile {
        path: tmp_path.to_string_lossy().to_string(),
        mime_type: mt,
    })
}

/// 임시 파일 정리 — 종료 시 호출. 이미 삭제됐거나 권한 부족이면 silent.
/// 옛 TS cleanupTempFile 1:1.
pub fn cleanup_temp_file(path: Option<&str>) {
    if let Some(p) = path {
        let _ = std::fs::remove_file(p);
    }
}

/// `opts.image` → `(base64_raw, media_type)` 추출. data: prefix 제거. Claude Code stream-json input 용.
/// 옛 TS extractImageBase64 1:1.
pub fn extract_image_base64(
    image: Option<&str>,
    mime_type: Option<&str>,
) -> Option<(String, String)> {
    let image = image?;
    if image.is_empty() {
        return None;
    }
    let data = if let Some(idx) = image.find(',') {
        &image[(idx + 1)..]
    } else {
        image
    };
    let mt: String = if let Some(m) = mime_type {
        m.to_string()
    } else if let Some(stripped) = image.strip_prefix("data:") {
        stripped
            .split(';')
            .next()
            .unwrap_or("image/png")
            .to_string()
    } else {
        "image/png".to_string()
    };
    Some((data.to_string(), mt))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 빨간 1×1 PNG base64 (옛 TS 테스트 픽스처와 동일)
    const TINY_PNG_B64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

    #[test]
    fn write_image_temp_file_basic() {
        let dir = tempfile::tempdir().unwrap();
        let tmp = write_image_temp_file(
            Some(TINY_PNG_B64),
            Some("image/png"),
            Some(dir.path().to_string_lossy().as_ref()),
        )
        .unwrap();
        assert!(tmp.path.ends_with(".png"));
        assert_eq!(tmp.mime_type, "image/png");
        // 파일 박힘 확인
        let bytes = std::fs::read(&tmp.path).unwrap();
        // PNG magic header
        assert_eq!(&bytes[..4], &[0x89, 0x50, 0x4E, 0x47]);
    }

    #[test]
    fn write_image_temp_file_data_url_strips_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let data_url = format!("data:image/jpeg;base64,{}", TINY_PNG_B64);
        let tmp = write_image_temp_file(
            Some(&data_url),
            None, // mime_type 미지정 → data: URL 에서 jpeg 추론
            Some(dir.path().to_string_lossy().as_ref()),
        )
        .unwrap();
        // data: URL 에서 image/jpeg 추론 → .jpg 확장자
        assert!(tmp.path.ends_with(".jpg"));
        assert_eq!(tmp.mime_type, "image/jpeg");
    }

    #[test]
    fn write_image_temp_file_none_input() {
        assert!(write_image_temp_file(None, None, None).is_none());
        assert!(write_image_temp_file(Some(""), None, None).is_none());
    }

    #[test]
    fn cleanup_temp_file_removes() {
        let dir = tempfile::tempdir().unwrap();
        let tmp = write_image_temp_file(
            Some(TINY_PNG_B64),
            Some("image/png"),
            Some(dir.path().to_string_lossy().as_ref()),
        )
        .unwrap();
        assert!(std::path::Path::new(&tmp.path).exists());
        cleanup_temp_file(Some(&tmp.path));
        assert!(!std::path::Path::new(&tmp.path).exists());
    }

    #[test]
    fn cleanup_temp_file_silent_on_missing() {
        // 이미 없는 파일도 panic 없이 silent 종료
        cleanup_temp_file(Some("/nonexistent/path/to/file"));
        cleanup_temp_file(None);
    }

    #[test]
    fn extract_image_base64_data_url() {
        let data_url = format!("data:image/webp;base64,{}", TINY_PNG_B64);
        let (data, mt) = extract_image_base64(Some(&data_url), None).unwrap();
        assert_eq!(data, TINY_PNG_B64);
        assert_eq!(mt, "image/webp");
    }

    #[test]
    fn extract_image_base64_raw() {
        let (data, mt) =
            extract_image_base64(Some(TINY_PNG_B64), Some("image/png")).unwrap();
        assert_eq!(data, TINY_PNG_B64);
        assert_eq!(mt, "image/png");
    }

    #[test]
    fn extract_image_base64_default_mime() {
        // mime 미지정 + raw → default png
        let (_, mt) = extract_image_base64(Some(TINY_PNG_B64), None).unwrap();
        assert_eq!(mt, "image/png");
    }

    #[test]
    fn extension_inference_for_each_mime() {
        let dir = tempfile::tempdir().unwrap();
        let cases = [
            ("image/png", "png"),
            ("image/jpeg", "jpg"),
            ("image/webp", "webp"),
            ("image/gif", "gif"),
            ("application/octet-stream", "bin"),
        ];
        for (mime, expected_ext) in cases {
            let tmp = write_image_temp_file(
                Some(TINY_PNG_B64),
                Some(mime),
                Some(dir.path().to_string_lossy().as_ref()),
            )
            .unwrap();
            assert!(tmp.path.ends_with(expected_ext), "mime {mime} → ext {expected_ext}");
        }
    }
}
