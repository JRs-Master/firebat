//! gRPC ProjectService impl — ProjectManager wrapping.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::project::{ProjectManager, ProjectVisibility};
use crate::proto::{
    project_service_server::ProjectService, BoolRequest, Empty, JsonArgs, JsonValue, Status,
    StringRequest,
};

pub struct ProjectServiceImpl {
    manager: Arc<ProjectManager>,
}

impl ProjectServiceImpl {
    pub fn new(manager: Arc<ProjectManager>) -> Self {
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
impl ProjectService for ProjectServiceImpl {
    async fn scan(&self, _req: Request<Empty>) -> Result<Response<JsonValue>, TonicStatus> {
        let projects = self.manager.scan().await;
        json_response(&projects)
    }

    async fn set_visibility(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            project: String,
            visibility: ProjectVisibility,
            #[serde(default)]
            password: Option<String>,
        }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("set_visibility args: {e}"))),
        };
        self.manager
            .set_visibility(&args.project, args.visibility, args.password.as_deref());
        Ok(ok_status())
    }

    async fn get_visibility(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let project = req.into_inner().value;
        let visibility = self.manager.get_visibility(&project);
        json_response(&visibility)
    }

    async fn get_config(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let name = req.into_inner().value;
        let config = self.manager.get_config(&name).await;
        json_response(&config)
    }

    async fn set_config(&self, req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            name: String,
            config: serde_json::Value,
        }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("set_config args: {e}"))),
        };
        match self.manager.set_config(&args.name, &args.config).await {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn verify_password(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            project: String,
            password: String,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("verify args: {e}")))?;
        Ok(Response::new(BoolRequest {
            value: self.manager.verify_password(&args.project, &args.password),
        }))
    }

    async fn delete(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let project = req.into_inner().value;
        match self.manager.delete(&project).await {
            Ok(_) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn rename(&self, _req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        // Phase B-8 미구현 — Phase B-9 PageManager (DB) 와 함께 박힘 (slug rename + redirect).
        Ok(err_status("rename — Phase B-9 와 같이 박힘"))
    }
}
