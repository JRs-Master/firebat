//! ModuleManager — 시스템 / 사용자 모듈 목록 + 실행 + 설정.
//!
//! 옛 TS ModuleManager (`core/managers/module-manager.ts`) Rust 재구현 (Phase B core 부분).
//! 책임:
//!  - listSystem / listUserModules — Storage scan
//!  - run / execute — Sandbox spawn
//!  - getModuleConfig — config.json 직접 파싱
//!  - getSettings / setSettings / isEnabled / setEnabled — Vault
//!
//! 옛 TS 의 getCmsSettings (design tokens / cms layout) 영역은 별도 phase — 메인 cms 영역
//! 에서 처리. Phase B-8 minimum 은 위 5 책임만.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::ports::{
    ISandboxPort, IStoragePort, IVaultPort, InfraResult, ModuleOutput, PackageStatus,
    SandboxExecuteOpts,
};
use crate::vault_keys::vk_module_settings;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemEntry {
    pub name: String,
    pub description: String,
    pub runtime: String,
    #[serde(rename = "type")]
    pub entry_type: String, // 'service' | 'module'
    pub scope: String,      // 'system' | 'user'
    pub enabled: bool,
}

const ENTRY_FILES: &[&str] = &["main.py", "index.js", "index.mjs", "main.php", "main.sh"];

fn is_safe_name(name: &str) -> bool {
    !name.is_empty() && !name.contains("..") && !name.contains('/') && !name.contains('\\')
}

pub struct ModuleManager {
    sandbox: Arc<dyn ISandboxPort>,
    storage: Arc<dyn IStoragePort>,
    vault: Arc<dyn IVaultPort>,
}

impl ModuleManager {
    pub fn new(
        sandbox: Arc<dyn ISandboxPort>,
        storage: Arc<dyn IStoragePort>,
        vault: Arc<dyn IVaultPort>,
    ) -> Self {
        Self {
            sandbox,
            storage,
            vault,
        }
    }

    /// Vault 직접 접근 — 시크릿 fallback chain (CMS settings 가 비었을 때 모듈 시크릿) 같은
    /// 패턴에서 사용. 일반 모듈 흐름은 sandbox 가 자동 주입.
    pub fn vault(&self) -> &Arc<dyn IVaultPort> {
        &self.vault
    }

    /// 직접 경로 실행 (EXECUTE / 파이프라인 등).
    pub async fn execute(
        &self,
        target_path: &str,
        input_data: &serde_json::Value,
        opts: &SandboxExecuteOpts,
    ) -> InfraResult<ModuleOutput> {
        self.sandbox.execute(target_path, input_data, opts).await
    }

    /// 모듈명으로 실행 — entry 자동 탐색.
    /// 옛 TS `run(name, input)` 1:1 — listDir 실패 시 한국어 에러 명시.
    ///
    /// Track A6 (2026-05-07): config.json 의 input schema 설정되어 있으면 sandbox spawn 전 validation.
    /// 실패 시 InfraResult error — 모듈이 받지 못함 (silent corruption 방어).
    pub async fn run(
        &self,
        module_name: &str,
        input_data: &serde_json::Value,
    ) -> InfraResult<ModuleOutput> {
        if !is_safe_name(module_name) {
            return Err(crate::i18n::t("core.error.module.invalid_name", None, &[]));
        }
        // 전역 비활성 모듈은 **어느 실행 경로**(FC dispatch / cron / 파이프라인 / MCP)로 들어와도 차단 —
        // 단일 choke point. 옛엔 MCP handler 만 is_enabled 체크해 FC·cron·파이프라인이 꺼진 모듈(telegram 등)을
        // 그대로 실행하던 갭. 사용자가 끈 모듈은 어떤 경로든 돌지 않아야 한다.
        if !self.is_enabled(module_name) {
            return Err(crate::i18n::t(
                "core.error.module.disabled",
                None,
                &[("name", module_name)],
            ));
        }
        // user / system 모두 검색 — sysmod 도구는 system/modules/ 에 있음.
        let (scope, dir_path, files) = {
            let user_dir = format!("user/modules/{}", module_name);
            let system_dir = format!("system/modules/{}", module_name);
            let user_entries = self.storage.list_dir(&user_dir).await.ok();
            let system_entries = self.storage.list_dir(&system_dir).await.ok();
            let pick = |entries: Vec<crate::ports::DirEntry>| -> Vec<String> {
                entries
                    .iter()
                    .filter(|e| !e.is_directory)
                    .map(|e| e.name.clone())
                    .collect()
            };
            if let Some(e) = user_entries {
                ("user", user_dir, pick(e))
            } else if let Some(e) = system_entries {
                ("system", system_dir, pick(e))
            } else {
                return Err(crate::i18n::t(
                    "core.error.module.not_found",
                    None,
                    &[("name", module_name)],
                ));
            }
        };
        let entry = ENTRY_FILES
            .iter()
            .find(|f| files.contains(&f.to_string()))
            .ok_or_else(|| {
                crate::i18n::t(
                    "core.error.module.entry_missing",
                    None,
                    &[("name", module_name)],
                )
            })?;

        // Pre-spawn input validation — config.json 의 input schema 기준
        if let Some(config) = self.get_module_config(scope, module_name).await {
            if let Some(input_schema) = config.get("input") {
                validate_value(&input_for_validation(input_data), input_schema).map_err(|e| {
                    crate::i18n::t(
                        "core.error.module.input_validation_failed",
                        None,
                        &[("name", module_name), ("detail", &e)],
                    )
                })?;
            }
        }

        let target = format!("{}/{}", dir_path, entry);
        let result = self
            .sandbox
            .execute(&target, input_data, &SandboxExecuteOpts::default())
            .await?;

        // Post-spawn output validation — config.json 의 output schema 설정되어 있으면 검사 (선택).
        // success:false 응답 (outErr 호출 경로) = envelope `{success:false, errorKey, errorParams}`
        // 형태라 `data` field 가 없음 → sandbox.rs 에서 result.data = Value::Null 로 설정됨.
        // output schema 검증 = success 인 정상 응답의 data 만 검증하는 게 정공.
        // success:false 응답까지 검증하던 것 = 옛 kma-weather (API key 미설정) 에서
        // "null is not of type object" warning 이 나던 root cause.
        if result.success {
            if let Some(config) = self.get_module_config(scope, module_name).await {
                if let Some(output_schema) = config.get("output") {
                    if let Err(e) = validate_value(&result.data, output_schema) {
                        tracing::warn!(
                            module = module_name,
                            error = %e,
                            "[ModuleManager] 출력 schema 위반 — 모듈 stdout 이 config.output 어김"
                        );
                    }
                }
            }
        }

        Ok(result)
    }

    /// system/modules/ 시스템 모듈 list.
    pub async fn list_system_modules(&self) -> Vec<SystemEntry> {
        self.scan_dir("system/modules", "module", "system").await
    }

    /// system/services/ 시스템 서비스 list.
    pub async fn list_system_services(&self) -> Vec<SystemEntry> {
        self.scan_dir("system/services", "service", "system").await
    }

    /// 시스템 modules + services 통합.
    pub async fn list_system(&self) -> Vec<SystemEntry> {
        let mut services = self.list_system_services().await;
        let modules = self.list_system_modules().await;
        services.extend(modules);
        services
    }

    /// user/modules/ 사용자 모듈 list.
    pub async fn list_user_modules(&self) -> Vec<SystemEntry> {
        self.scan_dir("user/modules", "module", "user").await
    }

    /// scope + name 으로 config.json 직접 파싱.
    pub async fn get_module_config(
        &self,
        scope: &str,
        name: &str,
    ) -> Option<serde_json::Value> {
        if !is_safe_name(name) {
            return None;
        }
        let candidates: Vec<String> = if scope == "user" {
            vec![format!("user/modules/{}/config.json", name)]
        } else {
            vec![
                format!("system/modules/{}/config.json", name),
                format!("system/services/{}/config.json", name),
            ]
        };
        for path in candidates {
            if let Ok(content) = self.storage.read(&path).await {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    return Some(parsed);
                }
            }
        }
        None
    }

    /// `getConfig(name)` 옛 TS 1:1 — scope 무관 system/modules → system/services → user/modules 순서로 첫 hit 반환.
    /// `/api/settings/modules?name=xxx` 같이 호출자가 scope 를 모를 때 사용. 옛 TS `ModuleManager.getConfig` 1:1.
    pub async fn get_config_any_scope(&self, name: &str) -> Option<serde_json::Value> {
        if !is_safe_name(name) {
            return None;
        }
        for path in [
            format!("system/modules/{}/config.json", name),
            format!("system/services/{}/config.json", name),
            format!("user/modules/{}/config.json", name),
        ] {
            if let Ok(content) = self.storage.read(&path).await {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    return Some(parsed);
                }
            }
        }
        None
    }

    /// 모듈의 lang/{lang}.json 직접 파싱 — scope 무관 (system/modules → system/services → user/modules 순서).
    /// 활성 lang 파일 미존재 시 영어 → 한국어 순으로 fallback. 모두 미존재 시 빈 object.
    ///
    /// 옵션 C 분리 패턴 (2026-05-16) — config.json 의 `settings_fields[].i18n` inline 영역을
    /// 별도 파일로 분리. settings.{field_key}.{label,description,placeholder,group,options[]} 구조.
    pub async fn get_module_lang(&self, name: &str, lang: &str) -> serde_json::Value {
        if !is_safe_name(name) {
            return serde_json::json!({});
        }
        // 안전 lang 만 허용 (path traversal 차단). 옛 i18n.tsx 와 동일 패턴.
        let safe_lang = match lang {
            "ko" | "en" => lang,
            _ => "en",
        };
        let candidates = [
            format!("system/modules/{}/lang/{}.json", name, safe_lang),
            format!("system/services/{}/lang/{}.json", name, safe_lang),
            format!("user/modules/{}/lang/{}.json", name, safe_lang),
            // fallback: 활성 lang 파일 없으면 영어 시도 → 그 후 한국어
            format!("system/modules/{}/lang/en.json", name),
            format!("system/services/{}/lang/en.json", name),
            format!("user/modules/{}/lang/en.json", name),
            format!("system/modules/{}/lang/ko.json", name),
            format!("system/services/{}/lang/ko.json", name),
            format!("user/modules/{}/lang/ko.json", name),
        ];
        for path in candidates {
            if let Ok(content) = self.storage.read(&path).await {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    return parsed;
                }
            }
        }
        serde_json::json!({})
    }

    /// 모듈 settings (Vault). 미존재 또는 파싱 실패 시 빈 object.
    pub fn get_settings(&self, module_name: &str) -> serde_json::Value {
        crate::utils::vault_json::vault_get_json::<serde_json::Value>(
            &*self.vault,
            &vk_module_settings(module_name),
        )
    }

    pub fn set_settings(&self, module_name: &str, settings: &serde_json::Value) -> bool {
        crate::utils::vault_json::vault_set_json(
            &*self.vault,
            &vk_module_settings(module_name),
            settings,
        )
        .is_ok()
    }

    /// 활성화 여부 — settings.enabled (default true).
    pub fn is_enabled(&self, module_name: &str) -> bool {
        let settings = self.get_settings(module_name);
        settings
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    pub fn set_enabled(&self, module_name: &str, enabled: bool) -> bool {
        let mut settings = self.get_settings(module_name);
        if !settings.is_object() {
            settings = serde_json::json!({});
        }
        settings["enabled"] = serde_json::Value::Bool(enabled);
        self.set_settings(module_name, &settings)
    }

    /// 모듈 이름 → 디스크 디렉토리 (system/modules → system/services → user/modules 순 첫 hit).
    /// 매 install / status 호출자가 공유.
    async fn resolve_module_dir(&self, module_name: &str) -> Option<String> {
        if !is_safe_name(module_name) {
            return None;
        }
        for candidate in [
            format!("system/modules/{}", module_name),
            format!("system/services/{}", module_name),
            format!("user/modules/{}", module_name),
        ] {
            if self.storage.list_dir(&candidate).await.is_ok() {
                return Some(candidate);
            }
        }
        None
    }

    /// config.json `packages` 배열 → background install. `upgrade=true` 시 `pip install --upgrade`.
    /// 반환값: spawn 한 StatusManager job_id 목록 (이미 설치 / 진행 중 패키지 제외).
    pub async fn install_packages(
        &self,
        module_name: &str,
        upgrade: bool,
    ) -> InfraResult<Vec<String>> {
        let dir = self.resolve_module_dir(module_name).await.ok_or_else(|| {
            crate::i18n::t(
                "core.error.module.not_found",
                None,
                &[("name", module_name)],
            )
        })?;
        self.sandbox.install_packages(&dir, upgrade).await
    }

    /// 매 패키지 status — 설정 화면 polling 입력.
    pub async fn get_package_status(
        &self,
        module_name: &str,
    ) -> InfraResult<Vec<PackageStatus>> {
        let dir = self.resolve_module_dir(module_name).await.ok_or_else(|| {
            crate::i18n::t(
                "core.error.module.not_found",
                None,
                &[("name", module_name)],
            )
        })?;
        self.sandbox.get_package_status(&dir).await
    }

    // ─── private helpers ───

    /// 디렉토리 스캔 — config.json 설정된 하위 디렉토리 → SystemEntry list.
    /// 옛 TS `scanDir(dir, defaultType, defaultScope)` 1:1:
    ///   - config.json 의 `type` / `scope` 설정되어 있으면 우선 (인자 default 는 fallback)
    ///   - config.json 안 설정된 디렉토리는 skip
    /// 정렬 — 옛 TS 는 자연 디렉토리 순서. Rust 도 sort 하지 않음 (silent behavior 차이 fix).
    async fn scan_dir(
        &self,
        dir: &str,
        default_type: &str,
        default_scope: &str,
    ) -> Vec<SystemEntry> {
        let Ok(entries) = self.storage.list_dir(dir).await else {
            return vec![];
        };
        let mut result = Vec::new();
        for entry in entries {
            if !entry.is_directory {
                continue;
            }
            let path = format!("{}/{}/config.json", dir, entry.name);
            let Ok(content) = self.storage.read(&path).await else { continue };
            let Ok(parsed): Result<serde_json::Value, _> = serde_json::from_str(&content) else {
                continue
            };
            let name = parsed
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&entry.name)
                .to_string();
            let description = parsed
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let runtime = parsed
                .get("runtime")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // 옛 TS `parsed.type || defaultType` / `parsed.scope || defaultScope` 1:1
            // (config.json 의 type / scope 가 우선 — 호출자 인자는 fallback)
            let entry_type = parsed
                .get("type")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(default_type)
                .to_string();
            let scope = parsed
                .get("scope")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(default_scope)
                .to_string();
            let enabled = self.is_enabled(&name);
            result.push(SystemEntry {
                name,
                description,
                runtime,
                entry_type,
                scope,
                enabled,
            });
        }
        result
    }
}


// ─── JSON Schema validation (Track A6, 2026-05-07) ──────────────────────────
//
// 시니어 audit 결과 설정된 module I/O contract 강제. config.json 의 input/output schema
// 형태가 JSON Schema 와 호환 (type/properties/required/enum/etc) 이므로 jsonschema
// crate 로 검증. 실패 시 명시 에러 (silent corruption 방어).

/// hub 프레임워크가 도구 호출 args 에 자동 주입하는 예약 메타 키 (owner/hubOwner/_hubScope/project).
/// 모듈 본체는 이 키들(특히 `_hubScope` = 데이터 디렉토리 hub-scope 분기)을 받아 쓰지만, config.json 의
/// input 스키마는 선언하지 않으므로(additionalProperties:false) **입력 검증에서만** 제거한다.
/// 검증 통과 후 모듈에는 원본(메타 포함)이 그대로 전달돼 `_hubScope` scope 분기가 정상 동작한다.
const RESERVED_HUB_META_KEYS: &[&str] = &["owner", "hubOwner", "_hubScope", "project"];

/// 입력값에 예약 메타 키가 있으면 제거한 사본을 반환 (검증 전용). 없으면 원본 차용 (clone 회피).
fn input_for_validation(input_data: &serde_json::Value) -> std::borrow::Cow<'_, serde_json::Value> {
    match input_data.as_object() {
        Some(obj) if RESERVED_HUB_META_KEYS.iter().any(|k| obj.contains_key(*k)) => {
            let mut cleaned = obj.clone();
            for k in RESERVED_HUB_META_KEYS {
                cleaned.remove(*k);
            }
            std::borrow::Cow::Owned(serde_json::Value::Object(cleaned))
        }
        _ => std::borrow::Cow::Borrowed(input_data),
    }
}

/// JSON Schema 기준 단일 value 검증. 첫 에러만 사용자에게 노출 (스키마 전체 dump 회피).
pub fn validate_value(
    value: &serde_json::Value,
    schema: &serde_json::Value,
) -> Result<(), String> {
    let compiled = jsonschema::JSONSchema::options()
        .with_draft(jsonschema::Draft::Draft7)
        .compile(schema)
        .map_err(|e| {
            crate::i18n::t(
                "core.error.module.schema_format",
                None,
                &[("detail", &e.to_string())],
            )
        })?;
    if let Err(errors) = compiled.validate(value) {
        let first = errors
            .into_iter()
            .next()
            .map(|e| format!("{} (path: {})", e, e.instance_path))
            .unwrap_or_else(|| {
                crate::i18n::t("core.error.module.unknown_validation", None, &[])
            });
        return Err(first);
    }
    Ok(())
}

/// 모듈 config 자체 well-formedness 검증 — 등록 시점 (또는 dry-run) 호출용.
/// 실 실행 X — schema 컴파일만 시도해 형식 오류 즉시 catch.
pub fn validate_module_definition(config: &serde_json::Value) -> Result<(), String> {
    if let Some(input_schema) = config.get("input") {
        jsonschema::JSONSchema::options()
            .with_draft(jsonschema::Draft::Draft7)
            .compile(input_schema)
            .map_err(|e| {
                crate::i18n::t(
                    "core.error.module.input_schema_format",
                    None,
                    &[("detail", &e.to_string())],
                )
            })?;
    }
    if let Some(output_schema) = config.get("output") {
        jsonschema::JSONSchema::options()
            .with_draft(jsonschema::Draft::Draft7)
            .compile(output_schema)
            .map_err(|e| {
                crate::i18n::t(
                    "core.error.module.output_schema_format",
                    None,
                    &[("detail", &e.to_string())],
                )
            })?;
    }
    Ok(())
}

impl ModuleManager {
    /// Dry-run: 모듈 호출 시뮬레이션 — sandbox spawn 안 함.
    /// config.json 의 well-formedness + input schema 검증만. pipeline 등록 시점 호출 권장.
    pub async fn dry_run(
        &self,
        scope: &str,
        module_name: &str,
        input_data: &serde_json::Value,
    ) -> Result<(), String> {
        if !is_safe_name(module_name) {
            return Err(crate::i18n::t("core.error.module.invalid_name", None, &[]));
        }
        let config = self.get_module_config(scope, module_name).await.ok_or_else(|| {
            crate::i18n::t(
                "core.error.module.config_missing",
                None,
                &[("scope", scope), ("name", module_name)],
            )
        })?;
        validate_module_definition(&config)?;
        if let Some(input_schema) = config.get("input") {
            validate_value(&input_for_validation(input_data), input_schema).map_err(|e| {
                crate::i18n::t(
                    "core.error.module.input_validation_failed_scoped",
                    None,
                    &[("scope", scope), ("name", module_name), ("detail", &e)],
                )
            })?;
        }
        Ok(())
    }
}


// Tests 이관 — `infra/tests/module_manager_test.rs` (integration test).
