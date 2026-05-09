//! TemplateService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::tempdir;
use tonic::Request;

use firebat_core::managers::template::{TemplateBlock, TemplateConfig, TemplateManager, TemplateSpec};
use firebat_core::ports::IStoragePort;
use firebat_core::proto::{template_service_server::TemplateService, Empty, JsonArgs, StringRequest};
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

    // Save
    let cfg = make_template("주간 시황");
    let save_args = serde_json::json!({ "slug": "weekly", "config": cfg });
    let resp = service
        .save(Request::new(JsonArgs {
            raw: save_args.to_string(),
        }))
        .await
        .unwrap();
    assert!(resp.into_inner().ok);

    // List
    let resp = service.list(Request::new(Empty {})).await.unwrap();
    let raw = resp.into_inner().raw_json;
    let entries: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["slug"], "weekly");

    // Get
    let resp = service
        .get(Request::new(StringRequest {
            value: "weekly".to_string(),
        }))
        .await
        .unwrap();
    let got: Option<TemplateConfig> = serde_json::from_str(&resp.into_inner().raw_json).unwrap();
    assert!(got.is_some());
    assert_eq!(got.unwrap().name, "주간 시황");

    // Delete
    let resp = service
        .delete(Request::new(StringRequest {
            value: "weekly".to_string(),
        }))
        .await
        .unwrap();
    assert!(resp.into_inner().ok);

    // Verify deleted
    let resp = service.list(Request::new(Empty {})).await.unwrap();
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

    let resp = service
        .save(Request::new(JsonArgs {
            raw: "{ not valid json".to_string(),
        }))
        .await
        .unwrap();
    let status = resp.into_inner();
    assert!(!status.ok);
    assert!(status.error.contains("파싱 실패"));
}
