//! Vault JSON 직렬화 헬퍼 — 타입 안전 get/set 단일 source.
//!
//! `IVaultPort` 에 저장된 JSON 문자열을 제네릭 타입으로 안전하게 역직렬화하고,
//! 직렬화해서 저장하는 반복 패턴을 한 곳에서 구현.
//!
//! 사용처: ModuleManager, CapabilityManager, AuthManager, SecretManager 등
//! 동일 `get_secret → from_str` / `to_string → set_secret` 패턴.

use crate::ports::IVaultPort;

/// Vault 에서 JSON 문자열 조회 후 `T` 로 역직렬화.
///
/// 키 미존재 또는 파싱 실패 시 `T::default()` 반환.
/// 특정 케이스 분기 없음 — `DeserializeOwned + Default` 제약으로 어떤 타입이든 동작.
pub fn vault_get_json<T>(vault: &dyn IVaultPort, key: &str) -> T
where
    T: serde::de::DeserializeOwned + Default,
{
    vault
        .get_secret(key)
        .and_then(|s| serde_json::from_str::<T>(&s).ok())
        .unwrap_or_default()
}

/// `T` 를 JSON 직렬화 후 Vault 에 저장.
///
/// 직렬화 실패 시 `Err(String)` 반환. 저장 성공 여부는 `IVaultPort::set_secret` 결과.
pub fn vault_set_json<T>(vault: &dyn IVaultPort, key: &str, value: &T) -> Result<(), String>
where
    T: serde::Serialize,
{
    let json =
        serde_json::to_string(value).map_err(|e| format!("vault_set_json 직렬화 오류: {e}"))?;
    vault.set_secret(key, &json);
    Ok(())
}
