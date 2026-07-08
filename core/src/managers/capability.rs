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
#[serde(rename_all = "camelCase")]
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

    /// dynamic registry 잠금 — Mutex poison 자동 회복 (panic 후에도 데이터 사용 가능).
    fn lock_dynamic(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, CapabilityDef>> {
        self.dynamic.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 전체 capability 목록 (빌트인 + 동적 등록).
    pub fn list(&self) -> BTreeMap<String, CapabilityDef> {
        let mut map = builtin_capabilities();
        let dynamic = self.lock_dynamic();
        for (k, v) in dynamic.iter() {
            map.entry(k.clone()).or_insert_with(|| v.clone());
        }
        map
    }

    /// 새 capability 수동 등록.
    pub fn register(&self, id: &str, label: &str, description: &str) {
        let mut dynamic = self.lock_dynamic();
        dynamic.insert(
            id.to_string(),
            CapabilityDef {
                label: label.to_string(),
                description: description.to_string(),
            },
        );
        self.log
            .info(&format!("[Capability] registered: {} ({})", id, label));
    }

    /// capability 별 provider 목록. 모듈 스캔 — system/modules + user/modules.
    pub async fn get_providers(&self, cap_id: &str) -> Vec<CapabilityProvider> {
        let mut providers = Vec::new();
        for entry in crate::utils::mod_scan::scan_module_configs(&*self.storage).await {
            let Some(capability) = entry.config.get("capability").and_then(|v| v.as_str()) else {
                continue;
            };
            if capability != cap_id {
                continue;
            }
            let module_name = entry
                .config
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&entry.dir_name)
                .to_string();
            if !self.is_module_enabled(&module_name) {
                continue;
            }
            let provider_type = match entry.config.get("providerType").and_then(|v| v.as_str()) {
                Some("api") => ProviderType::Api,
                _ => ProviderType::Local,
            };
            let description = entry
                .config
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let location = if entry.location.starts_with("system/") {
                ProviderLocation::System
            } else {
                ProviderLocation::User
            };

            // 미등록 capability 자동 등록
            if !builtin_capabilities().contains_key(cap_id) {
                let mut dynamic = self.lock_dynamic();
                if !dynamic.contains_key(cap_id) {
                    dynamic.insert(
                        cap_id.to_string(),
                        CapabilityDef {
                            label: cap_id.to_string(),
                            description: description.clone(),
                        },
                    );
                    self.log.warn(&format!(
                        "[Capability] auto-registered unknown capability: {}",
                        cap_id
                    ));
                }
            }

            providers.push(CapabilityProvider {
                module_name,
                provider_type,
                location,
                description,
            });
        }
        providers
    }

    /// 전체 capability 별 provider 수 요약 — 어드민 UI 용.
    pub async fn list_with_providers(&self) -> Vec<CapabilitySummary> {
        // 모든 모듈 1차 스캔 — 미등록 capability 자동 등록
        for entry in crate::utils::mod_scan::scan_module_configs(&*self.storage).await {
            let Some(capability) = entry.config.get("capability").and_then(|v| v.as_str()) else {
                continue;
            };
            if !builtin_capabilities().contains_key(capability) {
                let mut dynamic = self.lock_dynamic();
                if !dynamic.contains_key(capability) {
                    let description = entry
                        .config
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

    /// capability 설정 조회 (Vault). 미존재 또는 파싱 실패 시 default.
    pub fn get_settings(&self, cap_id: &str) -> CapabilitySettings {
        crate::utils::vault_json::vault_get_json::<CapabilitySettings>(
            &*self.vault,
            &vk_capability_settings(cap_id),
        )
    }

    /// capability 설정 저장 (Vault).
    pub fn set_settings(&self, cap_id: &str, settings: &CapabilitySettings) -> bool {
        crate::utils::vault_json::vault_set_json(
            &*self.vault,
            &vk_capability_settings(cap_id),
            settings,
        )
        .is_ok()
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
        {
            let dyn_map = self.lock_dynamic();
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

    /// 모듈 활성화 여부 — Vault 의 module settings 의 `enabled` 필드. 미설정 시 default 활성.
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


// Tests 이관 — `infra/tests/capability_manager_test.rs` (integration test).
