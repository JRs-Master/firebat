//! Structured extraction adapter — `IStructuredExtractPort` over Upstage Information Extraction.
//! Reads the Upstage key from vault at call time (same key as Document Parse) and delegates to the
//! `library::upstage_ie` client. Key absent → explicit error (no silent fallback).

use std::sync::Arc;

use firebat_core::ports::{IStructuredExtractPort, IVaultPort, InfraResult};

pub struct UpstageIeAdapter {
    vault: Arc<dyn IVaultPort>,
}

impl UpstageIeAdapter {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self { vault }
    }
}

#[async_trait::async_trait]
impl IStructuredExtractPort for UpstageIeAdapter {
    async fn extract_structured(
        &self,
        file_path: &str,
        schema_json: Option<&str>,
    ) -> InfraResult<String> {
        let key = self.vault.get_secret("system:upstage:api-key").ok_or_else(|| {
            "Upstage API 키가 설정되지 않았습니다 (설정 > AI > 어시스턴트에서 등록).".to_string()
        })?;
        crate::library::upstage_ie::extract_structured(&key, file_path, schema_json).await
    }
}
