//! CapabilityManager — Provider 해석 + 설정 관리.
//!
//! 옛 TS CapabilityManager (`core/managers/capability-manager.ts`) Rust 재구현.
//!
//! 책임:
//!  - capability 목록 (빌트인 + 동적 등록)
//!  - 모듈 스캔 → capability 별 provider 수집
//!  - 사용자 정의 우선순위 (Vault 저장) 기반 provider 해석
//!  - 비활성화 모듈 자동 제외

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use crate::capabilities::{
    builtin_capabilities, CapabilityDef, CapabilityProvider, CapabilitySettings, ProviderLocation,
    ProviderType,
};
use crate::ports::{ILogPort, IStoragePort, IVaultPort};
use crate::vault_keys::{vk_capability_settings, vk_module_settings};

#[derive(Debug, Serialize, Deserialize)]
pub struct CapabilitySummary {
    pub id: String,
    pub label: String,
    pub description: String,
    #[serde(rename = "providerCount")]
    pub provider_count: usize,
}

pub struct CapabilityManager {
    storage: Arc<dyn IStoragePort>,
    vault: Arc<dyn IVaultPort>,
    log: Arc<dyn ILogPort>,
    /// 동적 등록 capability — 모듈 스캔 시 미등록 capability 자동 등록.
    dynamic: Mutex<BTreeMap<String, CapabilityDef>>,
}

impl CapabilityManager {
    pub fn new(
        storage: Arc<dyn IStoragePort>,
        vault: Arc<dyn IVaultPort>,
        log: Arc<dyn ILogPort>,
    ) -> Self {
        Self {
            storage,
            vault,
            log,
            dynamic: Mutex::new(BTreeMap::new()),
        }
    }

    /// 전체 capability 목록 (빌트인 + 동적 등록).
    pub fn list(&self) -> BTreeMap<String, CapabilityDef> {
        let mut map = builtin_capabilities();
        let dynamic = match self.dynamic.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        for (k, v) in dynamic.iter() {
            map.entry(k.clone()).or_insert_with(|| v.clone());
        }
        map
    }

    /// 새 capability 수동 등록.
    pub fn register(&self, id: &str, label: &str, description: &str) {
        let mut dynamic = match self.dynamic.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        dynamic.insert(
            id.to_string(),
            CapabilityDef {
                label: label.to_string(),
                description: description.to_string(),
            },
        );
        self.log
            .info(&format!("[Capability] 등록: {} ({})", id, label));
    }

    /// capability 별 provider 목록. 모듈 스캔 — system/modules + user/modules.
    pub async fn get_providers(&self, cap_id: &str) -> Vec<CapabilityProvider> {
        let mut providers = Vec::new();
        for loc in ["system/modules", "user/modules"] {
            let location = if loc.starts_with("system/") {
                ProviderLocation::System
            } else {
                ProviderLocation::User
            };
            let Ok(entries) = self.storage.list_dir(loc).await else {
                continue;
            };
            for entry in entries {
                if !entry.is_directory {
                    continue;
                }
                let path = format!("{}/{}/config.json", loc, entry.name);
                let Ok(content) = self.storage.read(&path).await else {
                    continue;
                };
                let Ok(parsed): Result<serde_json::Value, _> = serde_json::from_str(&content)
                else {
                    self.log
                        .debug(&format!("[Capability] config 파싱 실패 (silent): {}", path));
                    continue;
                };
                let Some(capability) = parsed.get("capability").and_then(|v| v.as_str()) else {
                    continue;
                };
                if capability != cap_id {
                    continue;
                }
                let module_name = parsed
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&entry.name)
                    .to_string();
                if !self.is_module_enabled(&module_name) {
                    continue;
                }
                let provider_type = match parsed.get("providerType").and_then(|v| v.as_str()) {
                    Some("api") => ProviderType::Api,
                    _ => ProviderType::Local,
                };
                let description = parsed
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                // 미등록 capability 자동 등록
                if !builtin_capabilities().contains_key(cap_id) {
                    let mut dynamic = match self.dynamic.lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    if !dynamic.contains_key(cap_id) {
                        dynamic.insert(
                            cap_id.to_string(),
                            CapabilityDef {
                                label: cap_id.to_string(),
                                description: description.clone(),
                            },
                        );
                        self.log.warn(&format!(
                            "[Capability] 미등록 capability 자동 등록: {}",
                            cap_id
                        ));
                    }
                }

                providers.push(CapabilityProvider {
                    module_name,
                    provider_type,
                    location: location.clone(),
                    description,
                });
            }
        }
        providers
    }

    /// 전체 capability 별 provider 수 요약 — 어드민 UI 용.
    pub async fn list_with_providers(&self) -> Vec<CapabilitySummary> {
        // 모든 모듈 1차 스캔 — 미등록 capability 자동 등록
        for loc in ["system/modules", "user/modules"] {
            let Ok(entries) = self.storage.list_dir(loc).await else {
                continue;
            };
            for entry in entries {
                if !entry.is_directory {
                    continue;
                }
                let path = format!("{}/{}/config.json", loc, entry.name);
                let Ok(content) = self.storage.read(&path).await else {
                    continue;
                };
                let Ok(parsed): Result<serde_json::Value, _> = serde_json::from_str(&content)
                else {
                    continue;
                };
                let Some(capability) = parsed.get("capability").and_then(|v| v.as_str()) else {
                    continue;
                };
                if !builtin_capabilities().contains_key(capability) {
                    let mut dynamic = match self.dynamic.lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    if !dynamic.contains_key(capability) {
                        let description = parsed
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        dynamic.insert(
                            capability.to_string(),
                            CapabilityDef {
                                label: capability.to_string(),
                                description,
                            },
                        );
                    }
                }
            }
        }

        let all = self.list();
        let mut result = Vec::new();
        for (id, def) in all.iter() {
            let providers = self.get_providers(id).await;
            result.push(CapabilitySummary {
                id: id.clone(),
                label: def.label.clone(),
                description: def.description.clone(),
                provider_count: providers.len(),
            });
        }
        result
    }

    /// capability 설정 조회 (Vault).
    pub fn get_settings(&self, cap_id: &str) -> CapabilitySettings {
        let raw = self.vault.get_secret(&vk_capability_settings(cap_id));
        let Some(json) = raw else {
            return CapabilitySettings::default();
        };
        serde_json::from_str(&json).unwrap_or_default()
    }

    /// capability 설정 저장 (Vault).
    pub fn set_settings(&self, cap_id: &str, settings: &CapabilitySettings) -> bool {
        let Ok(json) = serde_json::to_string(settings) else {
            return false;
        };
        self.vault.set_secret(&vk_capability_settings(cap_id), &json)
    }

    /// 설정 기준 provider 해석 — providers 배열 순서대로 시도. 미설정 시 api 우선.
    pub async fn resolve(&self, cap_id: &str) -> Option<CapabilityProvider> {
        let providers = self.get_providers(cap_id).await;
        if providers.is_empty() {
            return None;
        }
        if providers.len() == 1 {
            return providers.into_iter().next();
        }
        let settings = self.get_settings(cap_id);
        // 사용자 정의 순서
        if !settings.providers.is_empty() {
            for name in &settings.providers {
                if let Some(p) = providers.iter().find(|p| &p.module_name == name) {
                    return Some(p.clone());
                }
            }
        }
        // 기본: api provider 우선, 없으면 첫 번째
        providers
            .iter()
            .find(|p| p.provider_type == ProviderType::Api)
            .cloned()
            .or_else(|| providers.into_iter().next())
    }

    /// 같은 capability 의 다른 활성 provider — pipeline EXECUTE 실패 시 자동 폴백 list.
    /// 옛 TS task-manager.ts:373-420 tryFallbackProvider Rust port. 사용자 정의 순서 적용 +
    /// 실패 module 자체 제외. 활성 모듈만 (Vault 의 module settings.enabled).
    ///
    /// 매 capability 마다 get_providers 스캔 — failed_module 매칭되는 capability 찾을 때까지.
    pub async fn fallback_modules(&self, failed_module: &str) -> Vec<CapabilityProvider> {
        // 빌트인 + 동적 capability id 합집합
        let mut cap_ids: Vec<String> = builtin_capabilities().keys().cloned().collect();
        if let Ok(dyn_map) = self.dynamic.lock() {
            for id in dyn_map.keys() {
                if !cap_ids.contains(id) {
                    cap_ids.push(id.clone());
                }
            }
        }

        for cap_id in cap_ids {
            let providers = self.get_providers(&cap_id).await;
            if !providers.iter().any(|p| p.module_name == failed_module) {
                continue;
            }
            // 같은 capability 발견 — failed 제외 + 사용자 순서 정렬
            let mut others: Vec<CapabilityProvider> = providers
                .into_iter()
                .filter(|p| p.module_name != failed_module)
                .collect();
            let settings = self.get_settings(&cap_id);
            if !settings.providers.is_empty() {
                others.sort_by_key(|p| {
                    settings
                        .providers
                        .iter()
                        .position(|n| n == &p.module_name)
                        .unwrap_or(usize::MAX)
                });
            }
            return others;
        }
        Vec::new()
    }

    /// 모듈 활성화 여부 — Vault 의 module settings 의 `enabled` 필드. 미박힘 시 default 활성.
    /// 옛 TS isModuleEnabled 와 동일 로직 (ModuleManager 와 같은 source — Vault 직접 조회).
    fn is_module_enabled(&self, name: &str) -> bool {
        let Some(raw) = self.vault.get_secret(&vk_module_settings(name)) else {
            return true;
        };
        let Ok(parsed): Result<serde_json::Value, _> = serde_json::from_str(&raw) else {
            return true;
        };
        parsed
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::{
        log::ConsoleLogAdapter, storage::LocalStorageAdapter, vault::SqliteVaultAdapter,
    };
    use tempfile::tempdir;

    fn make_manager(workspace: &std::path::Path) -> CapabilityManager {
        let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(workspace));
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        CapabilityManager::new(storage, vault, log)
    }

    #[tokio::test]
    async fn list_returns_builtin_capabilities() {
        let tmp = tempdir().unwrap();
        let mgr = make_manager(tmp.path());
        let caps = mgr.list();
        assert!(caps.contains_key("web-scrape"));
        assert!(caps.contains_key("notification"));
        assert_eq!(caps.len(), 11);
    }

    #[tokio::test]
    async fn register_adds_dynamic_capability() {
        let tmp = tempdir().unwrap();
        let mgr = make_manager(tmp.path());
        mgr.register("custom-cap", "사용자 정의", "테스트");
        let caps = mgr.list();
        assert_eq!(caps.len(), 12);
        assert_eq!(caps.get("custom-cap").unwrap().label, "사용자 정의");
    }

    #[tokio::test]
    async fn get_providers_scans_modules() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        // capability=notification provider 2개
        storage
            .write(
                "system/modules/kakao-talk/config.json",
                r#"{"name":"kakao-talk","capability":"notification","providerType":"api","description":"카톡 알림"}"#,
            )
            .await
            .unwrap();
        storage
            .write(
                "user/modules/slack-webhook/config.json",
                r#"{"name":"slack-webhook","capability":"notification","providerType":"api","description":"슬랙 webhook"}"#,
            )
            .await
            .unwrap();
        // 다른 capability — 영향 X
        storage
            .write(
                "system/modules/firecrawl/config.json",
                r#"{"name":"firecrawl","capability":"web-scrape","providerType":"api","description":"firecrawl"}"#,
            )
            .await
            .unwrap();

        let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        let mgr = CapabilityManager::new(storage_arc, vault, log);

        let providers = mgr.get_providers("notification").await;
        assert_eq!(providers.len(), 2);
        assert!(providers.iter().any(|p| p.module_name == "kakao-talk"));
        assert!(providers.iter().any(|p| p.module_name == "slack-webhook"));

        let scrape = mgr.get_providers("web-scrape").await;
        assert_eq!(scrape.len(), 1);
        assert_eq!(scrape[0].module_name, "firecrawl");
    }

    #[tokio::test]
    async fn disabled_module_excluded_from_providers() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        storage
            .write(
                "system/modules/kakao-talk/config.json",
                r#"{"name":"kakao-talk","capability":"notification","providerType":"api"}"#,
            )
            .await
            .unwrap();

        let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        // 비활성화 설정
        vault.set_secret(
            &vk_module_settings("kakao-talk"),
            r#"{"enabled":false}"#,
        );
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        let mgr = CapabilityManager::new(storage_arc, vault, log);

        let providers = mgr.get_providers("notification").await;
        assert_eq!(providers.len(), 0);
    }

    #[tokio::test]
    async fn resolve_uses_user_settings_priority() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        storage
            .write(
                "system/modules/a/config.json",
                r#"{"name":"a","capability":"notification","providerType":"api"}"#,
            )
            .await
            .unwrap();
        storage
            .write(
                "system/modules/b/config.json",
                r#"{"name":"b","capability":"notification","providerType":"api"}"#,
            )
            .await
            .unwrap();

        let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        let mgr = CapabilityManager::new(storage_arc, vault, log);

        // 사용자 정의 순서: b 우선
        mgr.set_settings(
            "notification",
            &CapabilitySettings {
                providers: vec!["b".to_string(), "a".to_string()],
            },
        );
        let resolved = mgr.resolve("notification").await.unwrap();
        assert_eq!(resolved.module_name, "b");
    }

    #[tokio::test]
    async fn unknown_capability_auto_registered_on_scan() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        // 빌트인에 없는 capability
        storage
            .write(
                "user/modules/myapp/config.json",
                r#"{"name":"myapp","capability":"my-custom-thing","description":"custom"}"#,
            )
            .await
            .unwrap();

        let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        let mgr = CapabilityManager::new(storage_arc, vault, log);

        // get_providers 호출 후 dynamic 에 등록됨
        let providers = mgr.get_providers("my-custom-thing").await;
        assert_eq!(providers.len(), 1);
        assert!(mgr.list().contains_key("my-custom-thing"));
    }
}
