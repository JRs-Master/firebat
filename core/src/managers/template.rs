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
use std::sync::{Arc, RwLock};

use crate::ports::{IHubPort, IStoragePort, InfraResult};
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
    /// "system" (shipped 또는 hub 에 공유된 admin 템플릿 = read-only 베이스) | "user" (owner 작성).
    /// 옛 데이터/호출 호환 — serde default 빈 문자열.
    #[serde(default)]
    pub source: String,
}

/// shipped(repo) 템플릿 베이스 — 스킬 system/skills 미러. 없으면 빈 목록(디렉토리 자체가 옵션).
const SYSTEM_TEMPLATES_DIR: &str = "system/templates";
/// admin 작성 템플릿 베이스 (hub 공유 오버레이의 소스).
const ADMIN_TEMPLATES_DIR: &str = "user/templates";

pub struct TemplateManager {
    storage: Arc<dyn IStoragePort>,
    /// Hub instance lookup — hub owner 의 `allowed_templates`(admin 공유 allowlist)를 이 leaf 가
    /// 스스로 해석해, 모든 소비처(AI 도구·grpc 패널·검색 카탈로그)가 list()/get() 한 지점에서
    /// 공유 오버레이를 받게 한다 (skill_file 미러). None = 공유 0.
    hub: RwLock<Option<Arc<dyn IHubPort>>>,
}

impl TemplateManager {
    pub fn new(storage: Arc<dyn IStoragePort>) -> Self {
        Self {
            storage,
            hub: RwLock::new(None),
        }
    }

    /// main.rs wiring — hub port injection (construction order free).
    pub fn set_hub_port(&self, port: Arc<dyn IHubPort>) {
        if let Ok(mut g) = self.hub.write() {
            *g = Some(port);
        }
    }

    /// hub owner scope(`<inst>[:<sid>]`) → admin 이 그 인스턴스에 공유한 템플릿 slugs.
    /// admin(None) 또는 port 미배선 = 빈 배열 (공유 0 = safe-closed).
    pub async fn shared_admin_slugs(&self, owner: Option<&str>) -> Vec<String> {
        let Some(o) = owner else { return Vec::new() };
        let Some(inst) = crate::utils::hub_context::hub_instance_id_of_owner(o) else {
            return Vec::new();
        };
        let inst = inst.to_string();
        let port = self.hub.read().ok().and_then(|g| g.clone());
        let Some(port) = port else { return Vec::new() };
        match port.get_instance(&inst).await {
            Ok(Some(i)) => i.allowed_templates,
            _ => Vec::new(),
        }
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

    /// 한 base 디렉토리 스캔 — `{base}/{slug}/template.json` 파싱. 잘못된 JSON silent skip.
    async fn scan_entries(&self, base: &str, source: &str) -> Vec<TemplateEntry> {
        let Ok(entries) = self.storage.list_dir(base).await else {
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
                source: source.to_string(),
            });
        }
        out
    }

    /// 템플릿 목록 = system(shipped) ∪ [hub 공유(admin ∩ allowlist)] ∪ owner — 뒤가 같은 slug 를
    /// 덮음(스킬 list 미러: owner 버전이 베이스를 override, 삭제 시 베이스 복원). system/공유는
    /// source="system"(read-only 베이스), owner 작성분 = "user". 잘못된 JSON silent skip.
    pub async fn list(&self, owner: Option<&str>) -> Vec<TemplateEntry> {
        let mut by_slug: std::collections::BTreeMap<String, TemplateEntry> =
            std::collections::BTreeMap::new();
        for e in self.scan_entries(SYSTEM_TEMPLATES_DIR, "system").await {
            by_slug.insert(e.slug.clone(), e);
        }
        let shared = self.shared_admin_slugs(owner).await;
        if !shared.is_empty() {
            for e in self.scan_entries(ADMIN_TEMPLATES_DIR, "system").await {
                if !shared.iter().any(|s| s == &e.slug) {
                    continue;
                }
                by_slug.insert(e.slug.clone(), e);
            }
        }
        let Ok(base) = Self::base_path(owner) else {
            return by_slug.into_values().collect();
        };
        for e in self.scan_entries(&base, "user").await {
            by_slug.insert(e.slug.clone(), e);
        }
        by_slug.into_values().collect()
    }

    /// 템플릿 1건 조회 — owner 작성분 → hub 공유(admin ∩ allowlist) → system(shipped) 순.
    pub async fn get(&self, owner: Option<&str>, slug: &str) -> Option<TemplateConfig> {
        if !is_safe_slug(slug) {
            return None;
        }
        if let Ok(base) = Self::base_path(owner) {
            let path = format!("{}/{}/template.json", base, slug);
            if let Ok(json) = self.storage.read(&path).await {
                if let Ok(t) = serde_json::from_str(&json) {
                    return Some(t);
                }
            }
        }
        if self.shared_admin_slugs(owner).await.iter().any(|s| s == slug) {
            let path = format!("{}/{}/template.json", ADMIN_TEMPLATES_DIR, slug);
            if let Ok(json) = self.storage.read(&path).await {
                if let Ok(t) = serde_json::from_str(&json) {
                    return Some(t);
                }
            }
        }
        let path = format!("{}/{}/template.json", SYSTEM_TEMPLATES_DIR, slug);
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

/// 자유 포맷 — 친화 토큰 → 값. 단일 패스 스캐너(긴 토큰 우선). 옛 replace 체인은 단일 `M`/`D`
/// 가 영단어 리터럴("Monday" → "7onday") 안까지 치환됐음 — 단일 문자 토큰은 앞뒤가 영문자가
/// 아닐 때만 토큰으로 인정(한국어 "M월 D일", 구두점 "M/D" 는 그대로 동작).
fn format_date(now: &DateTime<Tz>, fmt: &str) -> String {
    let year4 = format!("{:04}", now.year());
    let year2 = format!("{:02}", now.year().rem_euclid(100));
    let month2 = format!("{:02}", now.month());
    let day2 = format!("{:02}", now.day());
    let hour2 = format!("{:02}", now.hour());
    let min2 = format!("{:02}", now.minute());
    let month1 = now.month().to_string();
    let day1 = now.day().to_string();
    // 긴 토큰 우선 — YYYY 전에 YY 가 먹으면 안 됨.
    let multi: [(&str, &str); 6] = [
        ("YYYY", &year4),
        ("YY", &year2),
        ("MM", &month2),
        ("DD", &day2),
        ("HH", &hour2),
        ("mm", &min2),
    ];
    let chars: Vec<char> = fmt.chars().collect();
    let starts_with_at = |i: usize, pat: &str| -> bool {
        pat.chars().enumerate().all(|(k, p)| chars.get(i + k) == Some(&p))
    };
    let is_alpha = |c: Option<&char>| c.is_some_and(|c| c.is_ascii_alphabetic());
    let mut out = String::with_capacity(fmt.len() + 8);
    let mut i = 0;
    'outer: while i < chars.len() {
        for (pat, val) in &multi {
            if starts_with_at(i, pat) {
                out.push_str(val);
                i += pat.len();
                continue 'outer;
            }
        }
        let c = chars[i];
        if (c == 'M' || c == 'D')
            && !is_alpha(if i == 0 { None } else { chars.get(i - 1) })
            && !is_alpha(chars.get(i + 1))
        {
            out.push_str(if c == 'M' { &month1 } else { &day1 });
        } else {
            out.push(c);
        }
        i += 1;
    }
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
