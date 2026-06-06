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
use chrono::{DateTime, Datelike};
use chrono_tz::Tz;

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

    /// owner 기준 base path — None = admin (`user/templates/`),
    /// Some(hub_id) = `user/hub/<id>/templates/` (hub 방문자 격리).
    /// hub_id 가 path traversal 안전한 형태인지 검증.
    fn base_path(owner: Option<&str>) -> InfraResult<String> {
        match owner {
            None => Ok("user/templates".to_string()),
            Some(hub_id) => {
                if !is_safe_slug(hub_id) {
                    return Err(crate::i18n::t("core.error.template.invalid_slug", None, &[]));
                }
                Ok(format!("user/hub/{}/templates", hub_id))
            }
        }
    }

    /// 템플릿 목록 — owner 기준 디렉토리 스캔. None = admin, Some(hub_id) = 해당 hub.
    /// 잘못된 JSON 은 silent skip.
    pub async fn list(&self, owner: Option<&str>) -> Vec<TemplateEntry> {
        let Ok(base) = Self::base_path(owner) else { return vec![]; };
        let Ok(entries) = self.storage.list_dir(&base).await else {
            return vec![];
        };
        let mut out = Vec::new();
        for e in entries {
            if !e.is_directory {
                continue;
            }
            let slug = e.name.clone();
            let path = format!("{}/{}/template.json", base, slug);
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
    pub async fn get(&self, owner: Option<&str>, slug: &str) -> Option<TemplateConfig> {
        if !is_safe_slug(slug) {
            return None;
        }
        let base = Self::base_path(owner).ok()?;
        let path = format!("{}/{}/template.json", base, slug);
        let json = self.storage.read(&path).await.ok()?;
        serde_json::from_str(&json).ok()
    }

    /// 템플릿 저장 — upsert. spec.body 검증.
    pub async fn save(
        &self,
        owner: Option<&str>,
        slug: &str,
        config: &TemplateConfig,
    ) -> InfraResult<()> {
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
        let base = Self::base_path(owner)?;
        let path = format!("{}/{}/template.json", base, slug);
        self.storage.write(&path, &json).await
    }

    /// 템플릿 삭제 — 폴더 통째 제거.
    pub async fn delete(&self, owner: Option<&str>, slug: &str) -> InfraResult<()> {
        if !is_safe_slug(slug) {
            return Err(crate::i18n::t("core.error.template.invalid_slug", None, &[]));
        }
        let base = Self::base_path(owner)?;
        let path = format!("{}/{}", base, slug);
        self.storage.delete(&path).await
    }
}

/// 템플릿 placeholder 치환 — head + body 의 모든 문자열에서 동적 토큰을 now(사용자 tz) 기준 값으로.
/// 지원: `{date}` (YYYY-MM-DD) / `{time}` (HH:MM) / `{datetime}` / `{year}` / `{month}` / `{day}`.
/// 템플릿을 페이지로 적용하는 시점에 호출 → 그날 값으로 고정 (렌더 때 매번 바뀌지 않음).
pub fn apply_placeholders(config: &mut TemplateConfig, now: DateTime<Tz>) {
    let date = now.format("%Y-%m-%d").to_string();
    let time = now.format("%H:%M").to_string();
    let datetime = now.format("%Y-%m-%d %H:%M").to_string();
    let year = format!("{:04}", now.year());
    let month = format!("{:02}", now.month());
    let day = format!("{:02}", now.day());
    // `{date}` 가 `{datetime}` 안에 부분 매치되지 않음(닫는 `}` 가 구분) → 순서 무관.
    let subs: [(&str, &str); 6] = [
        ("{date}", &date),
        ("{datetime}", &datetime),
        ("{time}", &time),
        ("{year}", &year),
        ("{month}", &month),
        ("{day}", &day),
    ];
    subst_value(&mut config.spec.head, &subs);
    for block in &mut config.spec.body {
        subst_value(&mut block.props, &subs);
    }
}

/// JSON 값 안의 모든 문자열에 치환 적용 (객체·배열 재귀).
fn subst_value(v: &mut serde_json::Value, subs: &[(&str, &str)]) {
    match v {
        serde_json::Value::String(s) => {
            if s.contains('{') {
                let mut out = std::mem::take(s);
                for (k, val) in subs {
                    if out.contains(k) {
                        out = out.replace(k, val);
                    }
                }
                *s = out;
            }
        }
        serde_json::Value::Array(arr) => arr.iter_mut().for_each(|x| subst_value(x, subs)),
        serde_json::Value::Object(obj) => obj.values_mut().for_each(|x| subst_value(x, subs)),
        _ => {}
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
