//! Capability Registry — 빌트인 기능 목록 + types.
//!
//! 옛 TS `core/capabilities.ts` Rust port.
//! 새 기능 추가 시 BUILTIN_CAPABILITIES 에 등록 (또는 모듈 스캔 시 자동 등록).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDef {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySettings {
    /// providers 배열 순서가 곧 실행 우선순위.
    #[serde(default)]
    pub providers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderType {
    Local,
    Api,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderLocation {
    System,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityProvider {
    #[serde(rename = "moduleName")]
    pub module_name: String,
    #[serde(rename = "providerType")]
    pub provider_type: ProviderType,
    pub location: ProviderLocation,
    pub description: String,
}

/// Human labels for capability ids, read from `system/capabilities.json`.
///
/// This file says how a capability is PRESENTED. What capabilities EXIST is derived from the
/// modules — see `CapabilityManager::list`. Keeping those two apart is what removes the drift:
/// the old hand-written Rust list was both at once, and it had gone wrong in both directions
/// (2026-08-14 audit of 35 modules — fifteen capabilities declared by modules never reached the
/// settings screen, four on the screen had no module behind them and rendered "0개").
///
/// A missing label is not an error: the id shows as-is, so a module introducing a new capability
/// is visible the moment it lands, and naming it is a separate, unhurried edit — one that ships by
/// `git pull` rather than a Rust build.
pub fn capability_labels(raw: &str) -> BTreeMap<String, CapabilityDef> {
    let mut map = BTreeMap::new();
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(raw) else {
        return map;
    };
    let Some(obj) = doc.get("capabilities").and_then(|v| v.as_object()) else {
        return map;
    };
    for (id, v) in obj {
        map.insert(
            id.clone(),
            CapabilityDef {
                label: v.get("label").and_then(|x| x.as_str()).unwrap_or(id).to_string(),
                description: v
                    .get("description")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string(),
            },
        );
    }
    map
}

#[cfg(test)]
mod tests {
    use super::capability_labels;

    /// A label file is presentation only, so a broken or absent one degrades to bare ids rather
    /// than emptying the settings screen — the screen's content comes from the modules.
    #[test]
    fn labels_load_and_missing_ones_are_not_fatal() {
        let raw = include_str!("../../system/capabilities.json");
        let caps = capability_labels(raw);
        assert!(caps.len() >= 20, "got {}", caps.len());
        assert_eq!(caps.get("stock-order").map(|c| c.label.as_str()), Some("주식 주문"));
        assert_eq!(caps.get("stock-quote").map(|c| c.label.as_str()), Some("주식 시세"));
        // Garbage in, empty out — never a panic.
        assert!(capability_labels("not json").is_empty());
        assert!(capability_labels("{}").is_empty());
    }
}
