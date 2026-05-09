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

use crate::ports::{ISandboxPort, IStoragePort, IVaultPort, InfraResult, ModuleOutput, SandboxExecuteOpts};
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
            return Err("잘못된 모듈 이름입니다.".into());
        }
        let dir_path = format!("user/modules/{}", module_name);
        let entries = self
            .storage
            .list_dir(&dir_path)
            .await
            .map_err(|_| format!("모듈을 찾을 수 없습니다: {}", module_name))?;
        let files: Vec<String> = entries
            .iter()
            .filter(|e| !e.is_directory)
            .map(|e| e.name.clone())
            .collect();
        let entry = ENTRY_FILES
            .iter()
            .find(|f| files.contains(&f.to_string()))
            .ok_or_else(|| format!("모듈 entry 파일을 찾을 수 없습니다: {}", module_name))?;

        // Pre-spawn input validation — config.json 의 input schema 기준
        if let Some(config) = self.get_module_config("user", module_name).await {
            if let Some(input_schema) = config.get("input") {
                validate_value(input_data, input_schema)
                    .map_err(|e| format!("[{}] 입력 검증 실패: {}", module_name, e))?;
            }
        }

        let target = format!("{}/{}", dir_path, entry);
        let result = self
            .sandbox
            .execute(&target, input_data, &SandboxExecuteOpts::default())
            .await?;

        // Post-spawn output validation — config.json 의 output schema 설정되어 있으면 검사 (선택)
        if let Some(config) = self.get_module_config("user", module_name).await {
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

    /// 모듈 settings (Vault).
    pub fn get_settings(&self, module_name: &str) -> serde_json::Value {
        let raw = self.vault.get_secret(&vk_module_settings(module_name));
        match raw {
            Some(json) => serde_json::from_str(&json).unwrap_or(serde_json::json!({})),
            None => serde_json::json!({}),
        }
    }

    pub fn set_settings(&self, module_name: &str, settings: &serde_json::Value) -> bool {
        let Ok(json) = serde_json::to_string(settings) else {
            return false;
        };
        self.vault.set_secret(&vk_module_settings(module_name), &json)
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

/// JSON Schema 기준 단일 value 검증. 첫 에러만 사용자에게 노출 (스키마 전체 dump 회피).
pub(crate) fn validate_value(
    value: &serde_json::Value,
    schema: &serde_json::Value,
) -> Result<(), String> {
    let compiled = jsonschema::JSONSchema::options()
        .with_draft(jsonschema::Draft::Draft7)
        .compile(schema)
        .map_err(|e| format!("schema 자체 형식 오류: {}", e))?;
    if let Err(errors) = compiled.validate(value) {
        let first = errors
            .into_iter()
            .next()
            .map(|e| format!("{} (path: {})", e, e.instance_path))
            .unwrap_or_else(|| "알 수 없는 검증 실패".to_string());
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
            .map_err(|e| format!("input schema 형식 오류: {}", e))?;
    }
    if let Some(output_schema) = config.get("output") {
        jsonschema::JSONSchema::options()
            .with_draft(jsonschema::Draft::Draft7)
            .compile(output_schema)
            .map_err(|e| format!("output schema 형식 오류: {}", e))?;
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
            return Err("잘못된 모듈 이름입니다.".into());
        }
        let config = self
            .get_module_config(scope, module_name)
            .await
            .ok_or_else(|| format!("모듈 config.json 찾을 수 없습니다: {}/{}", scope, module_name))?;
        validate_module_definition(&config)?;
        if let Some(input_schema) = config.get("input") {
            validate_value(input_data, input_schema)
                .map_err(|e| format!("[{}/{}] 입력 검증 실패: {}", scope, module_name, e))?;
        }
        Ok(())
    }
}


// Tests 이관 — `infra/tests/module_manager_test.rs` (integration test).
