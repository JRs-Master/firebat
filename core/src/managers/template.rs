//! TemplateManager — 사용자 정의 페이지 템플릿 CRUD.
//!
//! 위치: `user/templates/{slug}/template.json`
//! AI 에 템플릿 목록 주입 → 매칭 시 get_template 으로 spec.body(스켈레톤) 받아 구조 유지 + 동적 컨텐츠 채움.
//! `{date}` 류 시간 토큰은 apply_placeholders 가 서버측 치환. 블록 props 의 `_fill` 힌트(per-섹션 수집·작성
//! 지시)는 AI 가 따라 채우고 save_page 전 제거(프롬프트 규약 — props free-form 이라 저장은 보존, render sanitizer strip).
//!
//! 옛 TS TemplateManager (`core/managers/template-manager.ts`) Rust 재구현.
//! Phase B 변환 룰 (1:1 매핑 X) 적용 — slug 검증, JSON parse 견고성, 일반 로직 유지.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::ports::{IStoragePort, InfraResult};
use chrono::{DateTime, Datelike, Timelike};
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
    /// Some(scope) = `<inst>` → `user/hub/<inst>/templates/`, 세션 `<inst>:<sid>` → `user/hub/<inst>/<sid>/templates/`.
    /// 각 part path traversal 검증. 세션 스코프 격리 = 같은 위젯 다른 세션끼리 템플릿 안 보임.
    fn base_path(owner: Option<&str>) -> InfraResult<String> {
        match owner {
            None => Ok("user/templates".to_string()),
            Some(scope) => {
                // scope 콜론 split — 각 part 안전성 검증(콜론을 경로에 직접 쓰면 깨짐). 형식 오류 = deny(admin 폴백 없음).
                let parts: Vec<&str> = scope.split(':').collect();
                if parts.is_empty() || parts.len() > 2 || !parts.iter().all(|p| is_safe_slug(p)) {
                    return Err(crate::i18n::t("core.error.template.invalid_slug", None, &[]));
                }
                Ok(format!("user/hub/{}/templates", parts.join("/")))
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

/// 템플릿 placeholder 치환 — head + body 의 모든 문자열을 now(사용자 tz) 기준으로.
/// (1) 단축형: `{date}` YYYY-MM-DD / `{time}` HH:MM / `{datetime}` / `{year}` / `{month}`(2자리) / `{day}`(2자리).
/// (2) 자유 포맷: `{date:FORMAT}` — 토큰 YYYY·YY·MM·M·DD·D·HH·mm. 예: `{date:YYYY년 M월 D일}` → 2026년 6월 7일.
/// 템플릿을 페이지로 적용하는 시점에 호출 → 그날 값으로 고정 (렌더 때 매번 바뀌지 않음).
pub fn apply_placeholders(config: &mut TemplateConfig, now: DateTime<Tz>) {
    subst_value(&mut config.spec.head, &now);
    for block in &mut config.spec.body {
        subst_value(&mut block.props, &now);
    }
}

/// JSON 값 안의 모든 문자열에 치환 적용 (객체·배열 재귀).
fn subst_value(v: &mut serde_json::Value, now: &DateTime<Tz>) {
    match v {
        serde_json::Value::String(s) => {
            if s.contains('{') {
                let replaced = substitute_str(s.as_str(), now);
                *s = replaced;
            }
        }
        serde_json::Value::Array(arr) => arr.iter_mut().for_each(|x| subst_value(x, now)),
        serde_json::Value::Object(obj) => obj.values_mut().for_each(|x| subst_value(x, now)),
        _ => {}
    }
}

/// 한 문자열 치환 — `{date:FORMAT}` 자유 포맷 먼저, 그다음 단축형 6개.
/// (`{date}` 단축형은 `{date:` 에 안 걸림 — `:` 가 구분.)
fn substitute_str(s: &str, now: &DateTime<Tz>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("{date:") {
        out.push_str(&rest[..start]);
        let after = &rest[start + "{date:".len()..];
        match after.find('}') {
            Some(end) => {
                out.push_str(&format_date(now, &after[..end]));
                rest = &after[end + 1..];
            }
            None => {
                // 닫는 `}` 없음 — 남은 부분 그대로 두고 종료.
                out.push_str(&rest[start..]);
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);

    let date = now.format("%Y-%m-%d").to_string();
    let time = now.format("%H:%M").to_string();
    let datetime = now.format("%Y-%m-%d %H:%M").to_string();
    let year = format!("{:04}", now.year());
    let month = format!("{:02}", now.month());
    let day = format!("{:02}", now.day());
    for (k, val) in [
        ("{date}", date.as_str()),
        ("{datetime}", datetime.as_str()),
        ("{time}", time.as_str()),
        ("{year}", year.as_str()),
        ("{month}", month.as_str()),
        ("{day}", day.as_str()),
    ] {
        if out.contains(k) {
            out = out.replace(k, val);
        }
    }
    out
}

/// 자유 포맷 — 친화 토큰 → 값. 긴 토큰부터 치환 (YYYY 전 YY, MM 전 M 충돌 방지).
fn format_date(now: &DateTime<Tz>, fmt: &str) -> String {
    let mut out = fmt.to_string();
    out = out.replace("YYYY", &format!("{:04}", now.year()));
    out = out.replace("YY", &format!("{:02}", now.year().rem_euclid(100)));
    out = out.replace("MM", &format!("{:02}", now.month()));
    out = out.replace("DD", &format!("{:02}", now.day()));
    out = out.replace("HH", &format!("{:02}", now.hour()));
    out = out.replace("mm", &format!("{:02}", now.minute()));
    out = out.replace('M', &now.month().to_string());
    out = out.replace('D', &now.day().to_string());
    out
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
