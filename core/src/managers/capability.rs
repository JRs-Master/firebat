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
    CapabilityDef, CapabilityProvider, CapabilitySettings, ProviderLocation,
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
    /// The capabilities that exist, which is decided by the modules.
    ///
    /// Derived rather than listed: a capability exists because some enabled module declares it.
    /// `system/capabilities.json` supplies the label and nothing else, so the two cannot disagree
    /// — an id with no label shows as its id, and a label with no module simply does not appear.
    /// The hand-written list this replaces had drifted both ways (2026-08-14 audit of 35 modules:
    /// fifteen module capabilities never reached the settings screen, four screen entries had no
    /// module behind them).
    pub async fn list(&self) -> BTreeMap<String, CapabilityDef> {
        let labels = self.labels().await;
        let mut map = BTreeMap::new();
        for entry in crate::utils::mod_scan::scan_module_configs(&*self.storage).await {
            let Some(id) = entry.config.get("capability").and_then(|v| v.as_str()) else {
                continue;
            };
            let module_name = entry
                .config
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&entry.dir_name);
            if !self.is_module_enabled(module_name) {
                continue;
            }
            map.entry(id.to_string()).or_insert_with(|| {
                labels.get(id).cloned().unwrap_or(CapabilityDef {
                    label: id.to_string(),
                    description: String::new(),
                })
            });
        }
        // Manually registered capabilities keep working — they have no module to be derived from.
        let dynamic = self.lock_dynamic();
        for (k, v) in dynamic.iter() {
            map.entry(k.clone()).or_insert_with(|| v.clone());
        }
        map
    }

    /// Labels from `system/capabilities.json`. Absent or unreadable = every id shows as itself,
    /// which is worse-looking and still correct.
    async fn labels(&self) -> BTreeMap<String, CapabilityDef> {
        match self.storage.read("system/capabilities.json").await {
            Ok(raw) => crate::capabilities::capability_labels(&raw),
            Err(_) => BTreeMap::new(),
        }
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
        let all = self.list().await;
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

    /// The order a capability's providers are tried in — the single answer to "which one first".
    ///
    /// `resolve`, `fallback_modules` and the prompt label all read this, so what the screen shows,
    /// what the model is told, and what a retry actually does cannot drift apart.
    ///
    /// There is no "unset" state. An empty saved order used to mean *something different happens*,
    /// which is the trap: the screen still had to show some order, the retry path used another,
    /// and neither was written down. The order is always defined, in three steps:
    ///
    /// 1. the order the user saved, for the modules that still exist
    /// 2. api before local — an unranked local provider is usually the stub, and this is what the
    ///    old `resolve` default did, so nothing silently reroutes
    /// 3. name (0-9 then a-z), so the tail is stable instead of "whatever the directory scan
    ///    happened to return"
    ///
    /// Names in the saved order that no longer resolve to a live module are ignored rather than
    /// held open — a renamed or disabled module leaves no gap.
    pub async fn ordered_providers(&self, cap_id: &str) -> Vec<CapabilityProvider> {
        let settings = self.get_settings(cap_id);
        let mut providers = self.get_providers(cap_id).await;
        providers.sort_by(|a, b| {
            let rank = |p: &CapabilityProvider| {
                settings
                    .providers
                    .iter()
                    .position(|n| n == &p.module_name)
                    .unwrap_or(usize::MAX)
            };
            let api_first = |p: &CapabilityProvider| {
                if p.provider_type == ProviderType::Api {
                    0
                } else {
                    1
                }
            };
            rank(a)
                .cmp(&rank(b))
                .then(api_first(a).cmp(&api_first(b)))
                .then(a.module_name.cmp(&b.module_name))
        });
        providers
    }

    /// That order, as a rank per module: `module → (rank, out of)`.
    ///
    /// The setting existed and reached nothing the model could see — it was read only by
    /// `fallback_modules`, for pipeline retries, so a capability with a chosen order behaved
    /// identically in chat to one without (measured 2026-08-15: the screen said naver 1 / daum 2,
    /// the prompt listed them alphabetically with no mark, and the model picked by name).
    ///
    /// A capability with one provider is left out: "1순위/1" is not a preference, it is a count.
    pub async fn preference_ranks(&self) -> BTreeMap<String, (usize, usize)> {
        let mut ranks = BTreeMap::new();
        for cap_id in self.list().await.keys() {
            let ordered = self.ordered_providers(cap_id).await;
            if ordered.len() < 2 {
                continue;
            }
            let total = ordered.len();
            for (i, p) in ordered.into_iter().enumerate() {
                ranks.insert(p.module_name, (i + 1, total));
            }
        }
        ranks
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

    /// 설정 기준 provider 해석 — 1순위를 고른다. 순서 규칙 = `ordered_providers`.
    pub async fn resolve(&self, cap_id: &str) -> Option<CapabilityProvider> {
        self.ordered_providers(cap_id).await.into_iter().next()
    }

    /// 같은 capability 의 다른 활성 provider — pipeline EXECUTE 실패 시 자동 폴백 list.
    /// 옛 TS task-manager.ts:373-420 tryFallbackProvider Rust port. 실패 module 자체 제외.
    /// 순서 규칙 = `ordered_providers` — 라벨·resolve 와 같은 함수라 어긋날 수 없다.
    ///
    /// 매 capability 마다 스캔 — failed_module 매칭되는 capability 찾을 때까지.
    pub async fn fallback_modules(&self, failed_module: &str) -> Vec<CapabilityProvider> {
        // Every capability that exists — derived from the modules, same as `list`.
        let cap_ids: Vec<String> = self.list().await.keys().cloned().collect();

        for cap_id in cap_ids {
            let ordered = self.ordered_providers(&cap_id).await;
            if !ordered.iter().any(|p| p.module_name == failed_module) {
                continue;
            }
            return ordered
                .into_iter()
                .filter(|p| p.module_name != failed_module)
                .collect();
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
