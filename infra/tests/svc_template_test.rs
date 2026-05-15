//! TemplateService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::tempdir;
use tonic::Request;

use firebat_core::managers::template::{TemplateBlock, TemplateConfig, TemplateManager, TemplateSpec};
use firebat_core::ports::IStoragePort;
use firebat_core::proto::{
    template_service_server::TemplateService, TemplateDeleteRequest, TemplateGetRequest,
    TemplateListRequest, TemplateSaveRequest,
};
use firebat_core::services::template::TemplateServiceImpl;
use firebat_infra::adapters::storage::LocalStorageAdapter;

fn make_template(name: &str) -> TemplateConfig {
    TemplateConfig {
        name: name.to_string(),
        description: "test".to_string(),
        tags: vec![],
        spec: TemplateSpec {
            head: serde_json::json!({}),
            body: vec![TemplateBlock {
                block_type: "Text".to_string(),
                props: serde_json::json!({"content": "hi"}),
            }],
        },
    }
}

#[tokio::test]
async fn service_save_list_get_delete_roundtrip() {
    let tmp = tempdir().unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(tmp.path()));
    let manager = Arc::new(TemplateManager::new(storage));
    let service = TemplateServiceImpl::new(manager);

    // Save — 응답 빈 struct.
    let cfg = make_template("주간 시황");
    service
        .save(Request::new(TemplateSaveRequest {
            slug: "weekly".to_string(),
            config_json: serde_json::to_string(&cfg).unwrap(),
        }))
        .await
        .unwrap();

    // List
    let resp = service
        .list(Request::new(TemplateListRequest {}))
        .await
        .unwrap();
    let raw = resp.into_inner().raw_json;
    let entries: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["slug"], "weekly");

    // Get
    let resp = service
        .get(Request::new(TemplateGetRequest {
            slug: "weekly".to_string(),
        }))
        .await
        .unwrap();
    let got: Option<TemplateConfig> = serde_json::from_str(&resp.into_inner().raw_json).unwrap();
    assert!(got.is_some());
    assert_eq!(got.unwrap().name, "주간 시황");

    // Delete
    service
        .delete(Request::new(TemplateDeleteRequest {
            slug: "weekly".to_string(),
        }))
        .await
        .unwrap();

    // Verify deleted
    let resp = service
        .list(Request::new(TemplateListRequest {}))
        .await
        .unwrap();
    let entries: Vec<serde_json::Value> =
        serde_json::from_str(&resp.into_inner().raw_json).unwrap();
    assert_eq!(entries.len(), 0);
}

#[tokio::test]
async fn service_save_invalid_args_returns_error_status() {
    let tmp = tempdir().unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(tmp.path()));
    let manager = Arc::new(TemplateManager::new(storage));
    let service = TemplateServiceImpl::new(manager);

    let err = service
        .save(Request::new(TemplateSaveRequest {
            slug: "broken".to_string(),
            config_json: "{ not valid json".to_string(),
        }))
        .await
        .err()
        .expect("save invalid config_json 시 에러 응답 기대");
    assert_eq!(err.code(), tonic::Code::InvalidArgument);
    assert!(err.message().contains("파싱") || err.message().contains("config_json"));
}
