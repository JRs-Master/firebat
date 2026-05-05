//! gRPC MediaService impl — MediaManager wrapping.
//!
//! Phase B-15 minimum: Read / List / Remove / Save / IsReady 활성.
//! Generate / Regenerate / StartGeneration / 모델 설정 RPC 는 Phase B-16+ stub
//! (AiManager + IImageGenPort 박힌 후).

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::media::{GenerateImageInput, MediaManager};
use crate::ports::{MediaListOpts, MediaSaveOptions};
use crate::proto::{
    media_service_server::MediaService, BoolRequest, Empty, JsonArgs, JsonValue, Status,
    StringRequest,
};

pub struct MediaServiceImpl {
    manager: Arc<MediaManager>,
}

impl MediaServiceImpl {
    pub fn new(manager: Arc<MediaManager>) -> Self {
        Self { manager }
    }
}

fn json_response<T: serde::Serialize>(value: &T) -> Result<Response<JsonValue>, TonicStatus> {
    let raw = serde_json::to_string(value)
        .map_err(|e| TonicStatus::internal(format!("JSON 직렬화 실패: {e}")))?;
    Ok(Response::new(JsonValue { raw }))
}

fn ok_status() -> Response<Status> {
    Response::new(Status {
        ok: true,
        error: String::new(),
        error_code: String::new(),
    })
}

fn err_status(msg: impl Into<String>) -> Response<Status> {
    Response::new(Status {
        ok: false,
        error: msg.into(),
        error_code: String::new(),
    })
}

#[tonic::async_trait]
impl MediaService for MediaServiceImpl {
    async fn read(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let slug = req.into_inner().value;
        match self.manager.read(&slug).await {
            Ok(Some((binary, content_type, record))) => {
                let b64 = base64_simple_encode(&binary);
                json_response(&serde_json::json!({
                    "binaryBase64": b64,
                    "contentType": content_type,
                    "record": record,
                }))
            }
            Ok(None) => json_response(&serde_json::Value::Null),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn list(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        let opts: MediaListOpts = if raw.trim().is_empty() {
            MediaListOpts::default()
        } else {
            serde_json::from_str(&raw)
                .map_err(|e| TonicStatus::invalid_argument(format!("list args: {e}")))?
        };
        match self.manager.list(opts).await {
            Ok(result) => json_response(&result),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn remove(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let slug = req.into_inner().value;
        match self.manager.remove(&slug).await {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn is_ready(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let slug = req.into_inner().value;
        // 미디어 slug 이 아닌 외부 URL 이면 true 반환 (옛 TS isMediaReady 동등) — 단, 매니저는 stat 만.
        // 외부 URL 검증은 Core facade 차원 (Phase B-16+).
        Ok(Response::new(BoolRequest {
            value: self.manager.is_ready(&slug).await,
        }))
    }

    async fn save(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            #[serde(rename = "binaryBase64")]
            binary_base64: String,
            #[serde(rename = "contentType")]
            content_type: String,
            #[serde(default, flatten)]
            opts: MediaSaveOptions,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("save args: {e}")))?;
        let binary = base64_simple_decode(&args.binary_base64).map_err(|e| {
            TonicStatus::invalid_argument(format!("base64 decode 실패: {e}"))
        })?;
        match self.manager.save(&binary, &args.content_type, args.opts).await {
            Ok(result) => json_response(&result),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    // ── Image generation / 모델 설정 — MediaManager 위임 ──

    async fn start_generation(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        let input: GenerateImageInput = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("input 파싱: {e}")))?;
        match self.manager.start_generate(input).await {
            Ok((slug, url)) => json_response(&serde_json::json!({"slug": slug, "url": url})),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn generate(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        let input: GenerateImageInput = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("input 파싱: {e}")))?;
        match self.manager.generate_image(input, None).await {
            Ok(result) => json_response(&result),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn regenerate(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let slug = req.into_inner().value;
        match self.manager.regenerate_image_by_slug(&slug).await {
            Ok((result, _new_slug)) => json_response(&result),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn get_image_model(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<StringRequest>, TonicStatus> {
        Ok(Response::new(StringRequest {
            value: self.manager.get_image_model(),
        }))
    }

    async fn set_image_model(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let model_id = req.into_inner().value;
        match self.manager.set_image_model(&model_id) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn get_available_image_models(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        json_response(&self.manager.list_image_models())
    }

    async fn get_image_default_size(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        json_response(&serde_json::json!({"size": self.manager.get_image_default_size()}))
    }

    async fn set_image_default_size(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let size = req.into_inner().value;
        let arg = if size.is_empty() { None } else { Some(size.as_str()) };
        match self.manager.set_image_default_size(arg) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn get_image_default_quality(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        json_response(&serde_json::json!({"quality": self.manager.get_image_default_quality()}))
    }

    async fn set_image_default_quality(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let q = req.into_inner().value;
        let arg = if q.is_empty() { None } else { Some(q.as_str()) };
        match self.manager.set_image_default_quality(arg) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn get_image_settings(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        json_response(&self.manager.get_image_settings())
    }
}

// 의존성 0 base64 — std::base64 미지원이라 직접 구현. binary 가 있는 read/save 에만 사용.
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

fn base64_simple_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("invalid base64 char: {}", c as char)),
        }
    }
    let bytes: Vec<u8> = s
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .collect();
    if bytes.len() % 4 == 1 {
        return Err("invalid base64 length".to_string());
    }
    let mut out: Vec<u8> = Vec::with_capacity((bytes.len() * 3) / 4);
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let v1 = val(bytes[i])?;
        let v2 = val(bytes[i + 1])?;
        let v3 = val(bytes[i + 2])?;
        let v4 = val(bytes[i + 3])?;
        out.push((v1 << 2) | (v2 >> 4));
        out.push((v2 << 4) | (v3 >> 2));
        out.push((v3 << 6) | v4);
        i += 4;
    }
    let rem = bytes.len() - i;
    if rem == 2 {
        let v1 = val(bytes[i])?;
        let v2 = val(bytes[i + 1])?;
        out.push((v1 << 2) | (v2 >> 4));
    } else if rem == 3 {
        let v1 = val(bytes[i])?;
        let v2 = val(bytes[i + 1])?;
        let v3 = val(bytes[i + 2])?;
        out.push((v1 << 2) | (v2 >> 4));
        out.push((v2 << 4) | (v3 >> 2));
    }
    Ok(out)
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::media::LocalMediaAdapter;
    use crate::ports::IMediaPort;
    use tempfile::tempdir;

    fn service() -> (MediaServiceImpl, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let port: Arc<dyn IMediaPort> = Arc::new(LocalMediaAdapter::new(dir.path()));
        let mgr = Arc::new(MediaManager::new(port));
        (MediaServiceImpl::new(mgr), dir)
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
        let parsed: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert!(parsed["slug"].as_str().is_some());

        let list = svc
            .list(Request::new(JsonArgs {
                raw: "{}".to_string(),
            }))
            .await
            .unwrap();
        let l: serde_json::Value = serde_json::from_str(&list.into_inner().raw).unwrap();
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

    #[test]
    fn base64_roundtrip() {
        let encoded = base64_simple_encode(b"hello world");
        let decoded = base64_simple_decode(&encoded).unwrap();
        assert_eq!(decoded, b"hello world");
    }
}
