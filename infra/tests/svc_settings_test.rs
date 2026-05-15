//! SettingsService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::tempdir;
use tonic::Request;

use firebat_core::ports::IVaultPort;
use firebat_core::proto::{
    settings_service_server::SettingsService, SettingsGetAnthropicCacheEnabledRequest,
    SettingsGetTimezoneRequest, SettingsSetAnthropicCacheEnabledRequest,
    SettingsSetTimezoneRequest, SettingsSetUserPromptRequest,
};
use firebat_core::services::settings::SettingsServiceImpl;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

fn service() -> (SettingsServiceImpl, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    (SettingsServiceImpl::new(vault), dir)
}

#[tokio::test]
async fn timezone_default_and_set() {
    let (svc, _dir) = service();
    let resp = svc
        .get_timezone(Request::new(SettingsGetTimezoneRequest {}))
        .await
        .unwrap();
    assert_eq!(resp.into_inner().timezone, "Asia/Seoul");

    svc.set_timezone(Request::new(SettingsSetTimezoneRequest {
        timezone: "UTC".to_string(),
    }))
    .await
    .unwrap();
    let resp = svc
        .get_timezone(Request::new(SettingsGetTimezoneRequest {}))
        .await
        .unwrap();
    assert_eq!(resp.into_inner().timezone, "UTC");
}

#[tokio::test]
async fn user_prompt_2000_chars_limit() {
    let (svc, _dir) = service();
    let too_long: String = "a".repeat(2001);
    let resp = svc
        .set_user_prompt(Request::new(SettingsSetUserPromptRequest {
            prompt: too_long,
        }))
        .await
        .unwrap();
    assert!(!resp.into_inner().ok); // 거부
}

#[tokio::test]
async fn anthropic_cache_toggle() {
    let (svc, _dir) = service();
    let resp = svc
        .get_anthropic_cache_enabled(Request::new(SettingsGetAnthropicCacheEnabledRequest {}))
        .await
        .unwrap();
    assert!(!resp.into_inner().enabled); // default false

    svc.set_anthropic_cache_enabled(Request::new(
        SettingsSetAnthropicCacheEnabledRequest { enabled: true },
    ))
    .await
    .unwrap();
    let resp = svc
        .get_anthropic_cache_enabled(Request::new(SettingsGetAnthropicCacheEnabledRequest {}))
        .await
        .unwrap();
    assert!(resp.into_inner().enabled);
}
