//! lang server-side default — vault `system:ui-lang` setting 을 server 부팅 시점에 단일 lookup.
//!
//! ## 정공 path (단일 사용자 환경)
//!
//! 옛 multi-user 시나리오의 매 RPC metadata propagation 은 도입하지 않음 (tower middleware 등 복잡함).
//! 사용자 단일 환경 — vault interfaceLang setting 으로 단일 default lang 결정. 매 i18n::t() 호출
//! 시점 자동 read.
//!
//! 사용자가 SettingsModal 에서 lang 변경 시점 — `firebat_core::i18n::set_default_lang(lang)` 직접
//! 호출로 즉시 반영 (server 재부팅 X). settings RPC handler 에서 호출.

use std::sync::Arc;
use firebat_core::ports::IVaultPort;
use firebat_core::vault_keys::VK_SYSTEM_UI_LANG;

/// server 부팅 시점 단일 vault lookup 결과의 default lang.
/// 매 i18n::t() 호출 시점 fallback.
pub fn resolve_default_lang(vault: &Arc<dyn IVaultPort>) -> String {
    vault
        .get_secret(VK_SYSTEM_UI_LANG)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "ko".to_string())
}
