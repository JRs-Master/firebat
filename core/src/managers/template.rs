//! TemplateManager — 사용자 정의 페이지 템플릿 CRUD.
//!
//! 위치: `user/templates/{slug}/template.json`
//! cron-agent 가 prompt 에 템플릿 목록 주입 → AI 가 매칭 시 spec.body 그대로 사용 (일관 발행).
//!
//! 옛 TS TemplateManager (`core/managers/template-manager.ts`) Rust 재구현.
//! Phase B 변환 룰 (1:1 매핑 X) 적용 — slug 검증, JSON parse 견고성, 일반 로직 유지.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::ports::{IStoragePort, InfraResult};

/// 템플릿 spec — 페이지 발행 시 spec.body 의 backbone.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateConfig {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub spec: TemplateSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSpec {
    #[serde(default)]
    pub head: serde_json::Value,
    pub body: Vec<TemplateBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    pub props: serde_json::Value,
}

/// 어드민 UI / cron-agent 가 보는 entry — config 전체 X, 메타만.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateEntry {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
}

pub struct TemplateManager {
    storage: Arc<dyn IStoragePort>,
}

impl TemplateManager {
    pub fn new(storage: Arc<dyn IStoragePort>) -> Self {
        Self { storage }
    }

    /// 템플릿 목록 — `user/templates/` 안 디렉토리 스캔. 잘못된 JSON 은 silent skip.
    pub async fn list(&self) -> Vec<TemplateEntry> {
        let Ok(entries) = self.storage.list_dir("user/templates").await else {
            return vec![];
        };
        let mut out = Vec::new();
        for e in entries {
            if !e.is_directory {
                continue;
            }
            let slug = e.name.clone();
            let path = format!("user/templates/{}/template.json", slug);
            let Ok(json) = self.storage.read(&path).await else {
                continue;
            };
            let Ok(t): Result<TemplateConfig, _> = serde_json::from_str(&json) else {
                continue;
            };
            out.push(TemplateEntry {
                slug,
                name: t.name,
                description: t.description,
                tags: t.tags,
            });
        }
        out
    }

    /// 템플릿 1건 조회 — 없으면 None.
    pub async fn get(&self, slug: &str) -> Option<TemplateConfig> {
        if !is_safe_slug(slug) {
            return None;
        }
        let path = format!("user/templates/{}/template.json", slug);
        let json = self.storage.read(&path).await.ok()?;
        serde_json::from_str(&json).ok()
    }

    /// 템플릿 저장 — upsert. spec.body 검증.
    pub async fn save(&self, slug: &str, config: &TemplateConfig) -> InfraResult<()> {
        if !is_safe_slug(slug) {
            return Err(crate::i18n::t("core.error.template.invalid_slug", None, &[]));
        }
        if config.name.is_empty() {
            return Err(crate::i18n::t("core.error.template.name_required", None, &[]));
        }
        if config.spec.body.is_empty() {
            return Err(crate::i18n::t("core.error.template.body_empty", None, &[]));
        }
        let json = serde_json::to_string_pretty(config).map_err(|e| {
            crate::i18n::t(
                "core.error.template.serialize_failed",
                None,
                &[("detail", &e.to_string())],
            )
        })?;
        let path = format!("user/templates/{}/template.json", slug);
        self.storage.write(&path, &json).await
    }

    /// 템플릿 삭제 — 폴더 통째 제거.
    pub async fn delete(&self, slug: &str) -> InfraResult<()> {
        if !is_safe_slug(slug) {
            return Err(crate::i18n::t("core.error.template.invalid_slug", None, &[]));
        }
        let path = format!("user/templates/{}", slug);
        self.storage.delete(&path).await
    }
}

/// path traversal 차단 — slug 는 영숫자 / 하이픈 / 언더스코어만.
/// 옛 TS 의 `/^[a-zA-Z0-9_-]+$/` 그대로.
fn is_safe_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}


// Tests 이관 — `infra/tests/template_manager_test.rs` (integration test).
