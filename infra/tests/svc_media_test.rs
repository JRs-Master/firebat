//! MediaService gRPC integration test — 옛 core inline tests 이관.
//!
//! `base64_roundtrip` 테스트는 private fn 사용이라 inline 유지 (core 측 mod tests 잔존).

use std::sync::Arc;
use tempfile::tempdir;
use tonic::Request;

use firebat_core::managers::media::MediaManager;
use firebat_core::ports::IMediaPort;
use firebat_core::proto::{media_service_server::MediaService, JsonArgs, StringRequest};
use firebat_core::services::media::MediaServiceImpl;
use firebat_infra::adapters::media::LocalMediaAdapter;

fn service() -> (MediaServiceImpl, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let port: Arc<dyn IMediaPort> = Arc::new(LocalMediaAdapter::new(dir.path()));
    let mgr = Arc::new(MediaManager::new(port));
    (MediaServiceImpl::new(mgr), dir)
}

/// 의존성 0 base64 — std::base64 미지원이라 직접 구현 (core 의 private fn 과 동일 알고리즘).
fn base64_simple_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let b1 = bytes[i];
        let b2 = bytes[i + 1];
        let b3 = bytes[i + 2];
        out.push(CHARS[(b1 >> 2) as usize] as char);
        out.push(CHARS[(((b1 & 0x03) << 4) | (b2 >> 4)) as usize] as char);
        out.push(CHARS[(((b2 & 0x0f) << 2) | (b3 >> 6)) as usize] as char);
        out.push(CHARS[(b3 & 0x3f) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let b1 = bytes[i];
        out.push(CHARS[(b1 >> 2) as usize] as char);
        out.push(CHARS[((b1 & 0x03) << 4) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let b1 = bytes[i];
        let b2 = bytes[i + 1];
        out.push(CHARS[(b1 >> 2) as usize] as char);
        out.push(CHARS[(((b1 & 0x03) << 4) | (b2 >> 4)) as usize] as char);
        out.push(CHARS[((b2 & 0x0f) << 2) as usize] as char);
        out.push('=');
    }
    out
}

#[tokio::test]
async fn save_then_list_via_grpc() {
    let (svc, _dir) = service();
    let body = serde_json::json!({
        "binaryBase64": base64_simple_encode(b"hello"),
        "contentType": "image/png",
        "filenameHint": "h"
    });
    let resp = svc
        .save(Request::new(JsonArgs {
            raw: body.to_string(),
        }))
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&resp.into_inner().raw_json).unwrap();
    assert!(parsed["slug"].as_str().is_some());

    let list = svc
        .list(Request::new(JsonArgs {
            raw: "{}".to_string(),
        }))
        .await
        .unwrap();
    let l: serde_json::Value = serde_json::from_str(&list.into_inner().raw_json).unwrap();
    assert_eq!(l["total"], 1);
}

#[tokio::test]
async fn is_ready_for_unknown_slug_false() {
    let (svc, _dir) = service();
    let resp = svc
        .is_ready(Request::new(StringRequest {
            value: "missing".to_string(),
        }))
        .await
        .unwrap();
    assert!(!resp.into_inner().value);
}
