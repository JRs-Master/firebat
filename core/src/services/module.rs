//! gRPC ModuleService impl — ModuleManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 박혀 core managers struct ↔ proto generated struct 변환.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::module::{ModuleManager, SystemEntry};
use crate::ports::ModuleOutput;
use crate::proto::{
    module_service_server::ModuleService, BoolRequest, Empty, JsonArgs, ModuleEntryPb,
    ModuleListPb, ModuleOutputPb, RawJsonPb, Status, StringRequest,
};

pub struct ModuleServiceImpl {
    manager: Arc<ModuleManager>,
}

impl ModuleServiceImpl {
    pub fn new(manager: Arc<ModuleManager>) -> Self {
        Self { manager }
    }
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

fn raw_json(value: &impl serde::Serialize) -> RawJsonPb {
    RawJsonPb {
        raw_json: serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

// ─── proto ↔ core managers struct 변환 ────────────────────────────────────────

impl From<SystemEntry> for ModuleEntryPb {
    fn from(e: SystemEntry) -> Self {
        ModuleEntryPb {
            name: e.name,
            description: e.description,
            runtime: e.runtime,
            entry_type: e.entry_type,
            scope: e.scope,
            enabled: e.enabled,
        }
    }
}

impl From<ModuleOutput> for ModuleOutputPb {
    fn from(o: ModuleOutput) -> Self {
        ModuleOutputPb {
            success: o.success,
            data_json: if o.data.is_null() {
                None
            } else {
                serde_json::to_string(&o.data).ok()
            },
            error: o.error,
            stderr: o.stderr,
            exit_code: o.exit_code,
            protocol_version: o.protocol_version,
        }
    }
}

#[tonic::async_trait]
impl ModuleService for ModuleServiceImpl {
    async fn run(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<ModuleOutputPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            module: String,
            #[serde(default)]
            data: serde_json::Value,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("run args: {e}")))?;
        match self.manager.run(&args.module, &args.data).await {
            Ok(output) => Ok(Response::new(output.into())),
            Err(e) => Ok(Response::new(ModuleOutputPb {
                success: false,
                data_json: None,
                error: Some(e),
                stderr: None,
                exit_code: None,
                protocol_version: "1.0".to_string(),
            })),
        }
    }

    async fn list_system(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<ModuleListPb>, TonicStatus> {
        let entries = self
            .manager
            .list_system()
            .await
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Response::new(ModuleListPb { entries }))
    }

    async fn list_user(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<ModuleListPb>, TonicStatus> {
        let entries = self
            .manager
            .list_user_modules()
            .await
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Response::new(ModuleListPb { entries }))
    }

    async fn get_schema(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            scope: String,
            name: String,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("get_schema args: {e}")))?;
        let config = self.manager.get_module_config(&args.scope, &args.name).await;
        Ok(Response::new(raw_json(&config)))
    }

    async fn get_settings(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let name = req.into_inner().value;
        let settings = self.manager.get_settings(&name);
        Ok(Response::new(raw_json(&settings)))
    }

    async fn get_config(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        // 옛 TS `Core.getModuleConfig(name)` 1:1 — `ModuleManager.getConfig(name)` 호출.
        // system/modules → system/services → user/modules 순서. 호출자 (e.g. /api/settings/modules)
        // 가 scope 모를 때 첫 hit 반환. 옛 코드 user scope 만 시도해 system 모듈 (browser-scrape /
        // kakao-talk / kiwoom 등) 의 secrets 자동 UI 생성 안 되던 버그 (2026-05-10 발견 후 fix).
        let name = req.into_inner().value;
        let config = self.manager.get_config_any_scope(&name).await;
        Ok(Response::new(raw_json(&config)))
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
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let stored = self.manager.get_settings("cms");
        let merged = merge_with_defaults(stored);
        Ok(Response::new(raw_json(&merged)))
    }

    async fn get_kakao_map_js_key(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<StringRequest>, TonicStatus> {
        let settings = self.manager.get_settings("cms");
        let key = settings
            .get("kakaoMapJsKey")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Ok(Response::new(StringRequest { value: key }))
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
        "siteDescription": "Just Imagine. Firebat Runs.",
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
                "rows": [],
                "widgets": {
                    "left": [{"type": "site-name", "props": {}}],
                    "center": [],
                    "right": []
                }
            },
            "sidebar": {
                "show": false,
                "widgets": []
            },
            "footer": {
                "show": true,
                "text": "© Firebat. All rights reserved.",
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

/// 두 JSON 객체 deep merge — overlay 가 base 위에 설정. array 는 overlay 우선 (replace 아님 X).
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
