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
        // Phase B-8 stub — CMS settings 영역은 별 phase (design tokens / cms layout 박힌 후).
        json_response(&serde_json::json!({"_phase": "B-8 stub — CMS 영역은 후속"}))
    }

    async fn get_kakao_map_js_key(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // Phase B-8 stub
        json_response(&serde_json::Value::Null)
    }
}
