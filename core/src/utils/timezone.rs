//! Timezone resolution helper — Vault 우선 + `Asia/Seoul` 폴백 일반 로직.
//!
//! 옛 cost.rs + ai/prompt_builder.rs 가 자체 설정한 동일 패턴 (`VK_TIMEZONE` const + 4-line
//! resolve fn) 을 single source 로 통합. 사용자 룰 (CLAUDE.md `feedback_no_hardcoding_cases.md`):
//! "주변 코드 grep — 같은 패턴 발견 시 같이 일반화".
//!
//! Vault key single source — `vault_keys.rs::VK_SYSTEM_TIMEZONE`.

use chrono_tz::Tz;
use std::sync::Arc;

use crate::ports::IVaultPort;
use crate::vault_keys::VK_SYSTEM_TIMEZONE;

/// 사용자 timezone resolve — Vault `system:timezone` 우선, 없거나 잘못된 IANA 문자열이면
/// `Asia/Seoul` 폴백 (옛 TS 동등). 외부 호출자는 두 단계 폴백 신경 안 써도 됨.
pub fn resolve_user_tz(vault: &Arc<dyn IVaultPort>) -> Tz {
    let tz_str = vault
        .get_secret(VK_SYSTEM_TIMEZONE)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Asia/Seoul".to_string());
    tz_str.parse::<Tz>().unwrap_or(Tz::Asia__Seoul)
}
