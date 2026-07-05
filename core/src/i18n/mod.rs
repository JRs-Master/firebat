//! i18n loader + lookup — Firebat 의 통합 다국어 service.
//!
//! ## 영역 매핑
//!
//! | 영역 | path | namespace |
//! |---|---|---|
//! | Firebat 내부 (Rust core / frontend / 공통 error) | `{workspace}/language/{lang}.json` | `core.*` |
//! | 매 system module | `{workspace}/system/modules/{name}/lang/{lang}.json` | `module.{name}.*` |
//! | 매 system service | `{workspace}/system/services/{name}/lang/{lang}.json` | `service.{name}.*` |
//! | 매 system prompt | `{workspace}/system/prompts/{name}/lang/{lang}.md` | `prompt.{name}` (full text) |
//!
//! ## locality
//!
//! 새 module / service / prompt 추가 시 = 그 폴더 안 `lang/` 자체 추가. 단일 전역 영역 폐기.
//!
//! ## 사용
//!
//! ```rust,ignore
//! use firebat_core::i18n;
//!
//! // 매 서버 부팅 시 초기 로드 (또는 main.rs 의 init)
//! i18n::init(&workspace_root);
//!
//! // 매 RPC handler 시점
//! let msg = i18n::t("core.error.module_not_found", lang, &[("name", "yfinance")]);
//! let prompt_text = i18n::prompt("tool_system", lang);
//! ```

use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::path::Path;
use std::sync::RwLock;

tokio::task_local! {
    /// 매 RPC 진입 시점 tonic interceptor 가 설정한 사용자 lang 을 담는 task-local.
    /// `i18n::t(key, None, params)` 호출 시점에 자동 read — 명시 lang 인자가 없는 caller 의 ergonomic.
    static ACTIVE_LANG: String;
}

/// 매 lang 별 통합 lookup store.
///
/// 매 영역 (core / module / service / prompt) 의 i18n 데이터를 단일 nested object 안 namespace 로 통합.
/// 매 lookup 시점에 사용자 lang 으로 매 key path 를 조회.
#[derive(Debug, Default)]
struct I18nStore {
    /// `{lang: {core: {...}, module: {name: {...}}, service: {name: {...}}, prompt: {name: "..."}}}`
    by_lang: HashMap<String, JsonValue>,
    /// 사용자의 default lang — vault 의 interfaceLang setting 적용 후 server-side fallback.
    default_lang: String,
}

static STORE: RwLock<Option<I18nStore>> = RwLock::new(None);

/// 사용자 lang 의 server-side default — vault `system:ui:lang` setting 을 lookup 후 set.
/// 매 RPC 호출 시점 task-local ACTIVE_LANG 이 없는 경우 fallback.
pub fn set_default_lang(lang: impl Into<String>) {
    if let Ok(mut guard) = STORE.write() {
        if let Some(store) = guard.as_mut() {
            store.default_lang = lang.into();
        }
    }
}

/// 현재 default lang read — main.rs 또는 SettingsModal RPC 에서 사용.
pub fn current_default_lang() -> String {
    STORE
        .read()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.default_lang.clone()))
        .unwrap_or_else(|| "ko".to_string())
}

/// 서버 부팅 시 i18n 데이터 초기 로드.
///
/// `workspace_root` = `/opt/firebat/` 같은 운영 루트. 매 영역 의 lang 파일 자동 scan.
pub fn init(workspace_root: &Path) {
    let store = build_store(workspace_root);
    let lang_count = store.by_lang.len();
    *STORE.write().unwrap_or_else(|p| p.into_inner()) = Some(store);
    tracing::info!("i18n: {} lang(s) loaded", lang_count);
}

/// internal — workspace 주어진 후 매 영역 scan + I18nStore 빌드. test 에서는 자체 store 인스턴스 사용.
fn build_store(workspace_root: &Path) -> I18nStore {
    let mut store = I18nStore::default();
    store.default_lang = "ko".to_string();

    // 1. 전역 — language/{lang}.json
    let lang_dir = workspace_root.join("language");
    if let Ok(entries) = std::fs::read_dir(&lang_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(lang) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Ok(raw) = std::fs::read_to_string(&path) else { continue };
            let Ok(parsed) = serde_json::from_str::<JsonValue>(&raw) else { continue };
            let entry = store
                .by_lang
                .entry(lang.to_string())
                .or_insert_with(|| serde_json::json!({}));
            if let Some(obj) = entry.as_object_mut() {
                obj.insert("core".to_string(), parsed);
            }
        }
    }

    // 2. 매 system module — system/modules/{name}/lang/{lang}.json
    scan_namespaced_dir(
        &workspace_root.join("system").join("modules"),
        "module",
        &mut store,
    );

    // 3. 매 system service — system/services/{name}/lang/{lang}.json
    scan_namespaced_dir(
        &workspace_root.join("system").join("services"),
        "service",
        &mut store,
    );

    // System prompts (AI instructions) live in firebat_core::prompt_store (single-file English,
    // system/prompts/{name}.md) — NOT i18n. i18n = user-facing lang-keyed strings only.

    store
}

/// `{root}/{name}/lang/{lang}.json` 패턴 scan — module / service 영역.
fn scan_namespaced_dir(root: &Path, ns: &str, store: &mut I18nStore) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let module_dir = entry.path();
        if !module_dir.is_dir() {
            continue;
        }
        let Some(name) = module_dir.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let lang_dir = module_dir.join("lang");
        let Ok(lang_files) = std::fs::read_dir(&lang_dir) else { continue };
        for lang_entry in lang_files.flatten() {
            let lang_path = lang_entry.path();
            if lang_path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(lang) = lang_path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Ok(raw) = std::fs::read_to_string(&lang_path) else { continue };
            let Ok(parsed) = serde_json::from_str::<JsonValue>(&raw) else { continue };
            insert_namespaced(store, lang, ns, name, parsed);
        }
    }
}

fn insert_namespaced(store: &mut I18nStore, lang: &str, ns: &str, name: &str, value: JsonValue) {
    let entry = store
        .by_lang
        .entry(lang.to_string())
        .or_insert_with(|| serde_json::json!({}));
    let Some(obj) = entry.as_object_mut() else { return };
    let ns_obj = obj
        .entry(ns.to_string())
        .or_insert_with(|| serde_json::json!({}));
    if let Some(ns_map) = ns_obj.as_object_mut() {
        ns_map.insert(name.to_string(), value);
    }
}

/// i18n 키 lookup. fallback chain: lang 인자 → task-local ACTIVE_LANG → default_lang ("ko") → 키 자체 raw.
///
/// **key 형식** — dot-notation namespace path:
///  - `core.error.module_not_found` → `language/{lang}.json` 의 `error.module_not_found`
///  - `module.yfinance.error.api_key_missing` → `system/modules/yfinance/lang/{lang}.json` 의 `error.api_key_missing`
///  - `service.cms.title` → `system/services/cms/lang/{lang}.json` 의 `title`
///  - `prompt.tool_system` → `system/prompts/tool_system/lang/{lang}.md` 의 full text
///
/// **params** — `{{name}}` 같은 placeholder 치환. `&[("name", "yfinance")]` 형태의 단순 string replace.
pub fn t(key: &str, lang: Option<&str>, params: &[(&str, &str)]) -> String {
    let guard = STORE.read().ok();
    let Some(Some(store)) = guard.as_deref().map(Option::as_ref) else {
        return key.to_string();
    };
    // 명시 lang → task-local → default 순 fallback.
    let resolved_lang = lang.map(String::from).or_else(active_lang);
    lookup_in_store(store, key, resolved_lang.as_deref(), params)
}


/// task-local ACTIVE_LANG read — tonic interceptor 가 설정한 사용자 lang.
/// task-local 이 없는 시점 (예: 비동기 spawn 한 context 가 없을 때) None 반환.
pub fn active_lang() -> Option<String> {
    ACTIVE_LANG.try_with(|v| v.clone()).ok()
}

/// 지정 lang context 로 async fn 실행 — tonic interceptor / test 에서 사용.
///
/// ```rust,ignore
/// i18n::with_lang("en", async {
///     let msg = i18n::t("core.error.module_not_found", None, &[]);
/// }).await;
/// ```
pub async fn with_lang<F, T>(lang: impl Into<String>, fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    ACTIVE_LANG.scope(lang.into(), fut).await
}

/// internal — store lookup. test 에서는 자체 store 인스턴스 사용 가능 (STORE static race 회피).
fn lookup_in_store(store: &I18nStore, key: &str, lang: Option<&str>, params: &[(&str, &str)]) -> String {
    let active_lang = lang.unwrap_or(&store.default_lang);
    let raw = lookup_in_lang(store, active_lang, key)
        .or_else(|| lookup_in_lang(store, &store.default_lang, key))
        .unwrap_or_else(|| key.to_string());
    apply_params(&raw, params)
}

fn lookup_in_lang(store: &I18nStore, lang: &str, key: &str) -> Option<String> {
    let mut node = store.by_lang.get(lang)?;
    for segment in key.split('.') {
        node = node.get(segment)?;
    }
    node.as_str().map(String::from)
}

fn apply_params(template: &str, params: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (key, value) in params {
        out = out.replace(&format!("{{{{{key}}}}}"), value);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // 매 test 가 자체 store 인스턴스를 사용 — STORE static race 회피 (parallel cargo test 호환).

    #[test]
    fn lookup_global_core_namespace() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        std::fs::create_dir_all(workspace.join("language")).unwrap();
        std::fs::write(
            workspace.join("language/ko.json"),
            r#"{"error": {"module_not_found": "모듈을 찾을 수 없습니다: {{name}}"}}"#,
        )
        .unwrap();
        let store = build_store(workspace);
        let msg = lookup_in_store(&store, "core.error.module_not_found", Some("ko"), &[("name", "yfinance")]);
        assert_eq!(msg, "모듈을 찾을 수 없습니다: yfinance");
    }

    #[test]
    fn lookup_module_namespace() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        let mod_lang = workspace.join("system/modules/yfinance/lang");
        std::fs::create_dir_all(&mod_lang).unwrap();
        std::fs::write(
            mod_lang.join("ko.json"),
            r#"{"error": {"api_key_missing": "API 키 미등록"}}"#,
        )
        .unwrap();
        let store = build_store(workspace);
        let msg = lookup_in_store(&store, "module.yfinance.error.api_key_missing", Some("ko"), &[]);
        assert_eq!(msg, "API 키 미등록");
    }

    #[test]
    fn prompt_full_text() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        let prompt_dir = workspace.join("system/prompts/tool_system/lang");
        std::fs::create_dir_all(&prompt_dir).unwrap();
        std::fs::write(prompt_dir.join("ko.md"), "# 한국어 prompt\n본문").unwrap();
        let store = build_store(workspace);
        let text = lookup_in_store(&store, "prompt.tool_system", Some("ko"), &[]);
        assert!(text.contains("한국어 prompt"));
    }

    #[test]
    fn fallback_to_default_lang() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        std::fs::create_dir_all(workspace.join("language")).unwrap();
        std::fs::write(
            workspace.join("language/ko.json"),
            r#"{"key1": "한국어"}"#,
        )
        .unwrap();
        let store = build_store(workspace);
        // en lookup 실패 → ko fallback
        let msg = lookup_in_store(&store, "core.key1", Some("en"), &[]);
        assert_eq!(msg, "한국어");
    }
}
