//! lang 박은 server-side default — vault `system:ui-lang` setting 박은 server 부팅 시점 단일 lookup.
//!
//! ## 정공 path (단일 사용자 환경)
//!
//! 옛 multi-user 박은 매 RPC metadata propagation 박지 마 (tower middleware 박은 복잡한 영역).
//! 사용자 단일 환경 — vault interfaceLang setting 박은 단일 default lang 박음. 매 i18n::t() 호출
//! 시점 자동 read.
//!
//! 사용자 가 SettingsModal 박은 lang 변경 시점 — `firebat_core::i18n::set_default_lang(lang)` 직접
//! 호출 박은 즉시 반영 (server 재부팅 X). settings RPC handler 박은 영역 박음.

use std::sync::Arc;
use firebat_core::ports::IVaultPort;
use firebat_core::vault_keys::VK_SYSTEM_UI_LANG;

/// server 부팅 시점 단일 vault lookup 박은 default lang.
/// 매 i18n::t() 호출 시점 fallback.
pub fn resolve_default_lang(vault: &Arc<dyn IVaultPort>) -> String {
    vault
        .get_secret(VK_SYSTEM_UI_LANG)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "ko".to_string())
}
