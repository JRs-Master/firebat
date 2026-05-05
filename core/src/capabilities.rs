//! Capability Registry — 빌트인 기능 목록 + types.
//!
//! 옛 TS `core/capabilities.ts` Rust port.
//! 새 기능 추가 시 BUILTIN_CAPABILITIES 에 등록 (또는 모듈 스캔 시 자동 등록).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityDef {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
pub struct CapabilityProvider {
    #[serde(rename = "moduleName")]
    pub module_name: String,
    #[serde(rename = "providerType")]
    pub provider_type: ProviderType,
    pub location: ProviderLocation,
    pub description: String,
}

/// 빌트인 capability list — 옛 TS BUILTIN_CAPABILITIES 와 동등.
/// BTreeMap 사용 — list 시 안정 ordering (사용자 UI 일관).
pub fn builtin_capabilities() -> BTreeMap<String, CapabilityDef> {
    let mut map = BTreeMap::new();
    let entries: &[(&str, &str, &str)] = &[
        ("web-scrape", "웹 스크래핑", "URL → 텍스트/링크 추출"),
        ("email-send", "이메일 발송", "이메일 전송"),
        ("image-gen", "이미지 생성", "텍스트 → 이미지"),
        ("translate", "번역", "텍스트 번역"),
        ("notification", "알림", "슬랙/텔레그램/카톡 알림"),
        ("pdf-gen", "PDF 생성", "HTML/마크다운 → PDF"),
        ("web-search", "웹 검색", "키워드 → 검색 결과 목록 (제목, URL, 설명)"),
        ("keyword-analytics", "키워드 분석", "키워드 검색량, CPC, 경쟁도 등 광고/SEO 지표 조회"),
        ("stock-trading", "주식 거래", "시세 조회, 매수/매도 주문, 잔고 조회"),
        ("crypto-trading", "암호화폐 거래", "암호화폐 시세 조회, 매수/매도 주문, 잔고/입출금 관리"),
        ("law-search", "법령 검색", "국가법령정보 검색 — 법령/판례/행정규칙/헌재결정례 조회"),
    ];
    for (id, label, desc) in entries {
        map.insert(
            id.to_string(),
            CapabilityDef {
                label: label.to_string(),
                description: desc.to_string(),
            },
        );
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_capabilities_has_known_ids() {
        let caps = builtin_capabilities();
        assert!(caps.contains_key("web-scrape"));
        assert!(caps.contains_key("notification"));
        assert!(caps.contains_key("stock-trading"));
        assert_eq!(caps.len(), 11);
    }
}
