//! gRPC ModuleService impl — ModuleManager wrapping.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::module::ModuleManager;
use crate::proto::{
    module_service_server::ModuleService, BoolRequest, Empty, JsonArgs, JsonValue, Status,
    StringRequest,
};

pub struct ModuleServiceImpl {
    manager: Arc<ModuleManager>,
}

impl ModuleServiceImpl {
    pub fn new(manager: Arc<ModuleManager>) -> Self {
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
impl ModuleService for ModuleServiceImpl {
    async fn run(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            module: String,
            #[serde(default)]
            data: serde_json::Value,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("run args: {e}")))?;
        let result = self.manager.run(&args.module, &args.data).await;
        json_response(&result)
    }

    async fn list_system(&self, _req: Request<Empty>) -> Result<Response<JsonValue>, TonicStatus> {
        let entries = self.manager.list_system().await;
        json_response(&entries)
    }

    async fn list_user(&self, _req: Request<Empty>) -> Result<Response<JsonValue>, TonicStatus> {
        let entries = self.manager.list_user_modules().await;
        json_response(&entries)
    }

    async fn get_schema(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            scope: String,
            name: String,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("get_schema args: {e}")))?;
        let config = self.manager.get_module_config(&args.scope, &args.name).await;
        json_response(&config)
    }

    async fn get_settings(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let name = req.into_inner().value;
        let settings = self.manager.get_settings(&name);
        json_response(&settings)
    }

    async fn get_config(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // 호환 — getModuleConfig 의 user scope. Phase B-8 단순 구현.
        let name = req.into_inner().value;
        let config = self.manager.get_module_config("user", &name).await;
        json_response(&config)
    }

    async fn set_settings(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            name: String,
            settings: serde_json::Value,
        }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("set_settings args: {e}"))),
        };
        if self.manager.set_settings(&args.name, &args.settings) {
            Ok(ok_status())
        } else {
            Ok(err_status("set_settings 실패"))
        }
    }

    async fn is_enabled(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let name = req.into_inner().value;
        Ok(Response::new(BoolRequest {
            value: self.manager.is_enabled(&name),
        }))
    }

    async fn set_enabled(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            name: String,
            enabled: bool,
        }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("set_enabled args: {e}"))),
        };
        if self.manager.set_enabled(&args.name, args.enabled) {
            Ok(ok_status())
        } else {
            Ok(err_status("set_enabled 실패"))
        }
    }

    async fn get_cms_settings(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // CMS module settings — Vault `system:module:cms:settings` 위에 default 박은 객체 merge.
        // 새 서버 / Vault 빈 시점에도 모든 필드 보장 (frontend 가 `seo.layout.header.navLinks` 같이
        // 깊은 path 접근 시 undefined crash 회피).
        let stored = self.manager.get_settings("cms");
        let merged = merge_with_defaults(stored);
        json_response(&merged)
    }

    async fn get_kakao_map_js_key(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // CMS settings 안의 kakaoMapJsKey 필드 — render_map (Kakao Map) 위젯이 사용.
        let settings = self.manager.get_settings("cms");
        let key = settings
            .get("kakaoMapJsKey")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        json_response(&serde_json::json!({"key": key}))
    }
}

/// CMS settings default 객체 + Vault 저장값 merge.
/// 옛 TS `getCmsSettings` 의 default 형태 1:1 port — 새 서버 빈 데이터 시점도 모든 필드 보장.
fn merge_with_defaults(stored: serde_json::Value) -> serde_json::Value {
    let defaults = cms_defaults();
    deep_merge(defaults, stored)
}

fn cms_defaults() -> serde_json::Value {
    serde_json::json!({
        "enabled": true,
        "siteTitle": "Firebat",
        "siteDescription": "",
        "siteUrl": "",
        "siteLang": "ko",
        "favicon": "",
        "jsonLdEnabled": true,
        "jsonLdOrganization": "",
        "jsonLdLogoUrl": "",
        "sitemapEnabled": true,
        "rssEnabled": true,
        "robotsTxt": "User-agent: *\nAllow: /\n",
        "ogBgColor": "#0f172a",
        "ogAccentColor": "#f59e0b",
        "ogDomain": "",
        "twitterCard": "summary_large_image",
        "twitterSite": "",
        "autoCanonical": true,
        "customCss": "",
        "customFontUrls": [],
        "headScripts": "",
        "bodyScripts": "",
        "verifications": [],
        "kakaoMapJsKey": "",
        "tagAliases": {},
        "imageWebp": true,
        "imageAvif": false,
        "imageThumbnail": true,
        "imageBlurhash": true,
        "imageVariants": "480, 768, 1024",
        "imageDefaultQuality": 80,
        "imageDefaultSize": "1024x1024",
        "imageStripExif": true,
        "imageProgressive": true,
        "imageKeepOriginal": false,
        "adsense": {
            "publisherId": "",
            "autoAds": false,
            "slotHeaderBottom": "",
            "slotPostTop": "",
            "slotPostBottom": "",
            "slotFooterTop": "",
            "slotCardFeed": ""
        },
        "theme": {
            "preset": "slate-pro",
            "colors": {
                "primary": "#0f172a",
                "accent": "#f59e0b",
                "up": "#ef4444",
                "down": "#3b82f6",
                "text": "#0f172a",
                "textMuted": "#64748b",
                "bg": "#ffffff",
                "bgCard": "#f8fafc",
                "border": "#e2e8f0"
            },
            "fonts": {
                "body": "'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, sans-serif",
                "heading": "'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, sans-serif",
                "mono": "'JetBrains Mono', 'Fira Code', Consolas, monospace"
            },
            "layout": {
                "contentMaxWidth": "1200px",
                "paddingMobile": "16px",
                "paddingTablet": "24px",
                "paddingDesktop": "32px",
                "radius": "8px"
            },
            "heading": {
                "h1": "plain",
                "h2": "border-left",
                "h3": "plain"
            },
            "typography": {
                "baseFontSize": "16px",
                "scaleRatio": 1.25,
                "bodyLineHeight": 1.7,
                "headingLineHeight": 1.25,
                "headingLetterSpacing": "-0.01em",
                "bodyLetterSpacing": "normal"
            }
        },
        "layout": {
            "mode": "full",
            "showReadingProgress": false,
            "header": {
                "show": true,
                "logoUrl": "",
                "siteName": "",
                "navLinks": [],
                "sticky": false,
                "transparentOnTop": false,
                "mobileDrawerIncludeSidebar": false,
                "rows": []
            },
            "sidebar": {
                "show": false,
                "widgets": []
            },
            "footer": {
                "show": true,
                "text": "",
                "columns": []
            },
            "pageList": {
                "variant": "list",
                "showFeaturedImage": true,
                "showExcerpt": true,
                "showReadingTime": false,
                "pagination": "numbered",
                "perPage": 10
            }
        }
    })
}

/// 두 JSON 객체 deep merge — overlay 가 base 위에 박힘. array 는 overlay 우선 (replace 아님 X).
fn deep_merge(base: serde_json::Value, overlay: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match (base, overlay) {
        (Value::Object(mut base_obj), Value::Object(overlay_obj)) => {
            for (k, v) in overlay_obj {
                let merged = match base_obj.remove(&k) {
                    Some(base_val) => deep_merge(base_val, v),
                    None => v,
                };
                base_obj.insert(k, merged);
            }
            Value::Object(base_obj)
        }
        // overlay 가 object 가 아니면 그대로 (array / primitive 모두 overlay 우선)
        (_, overlay) if !matches!(overlay, Value::Null) => overlay,
        // overlay 가 null 이면 base 유지
        (base, _) => base,
    }
}
