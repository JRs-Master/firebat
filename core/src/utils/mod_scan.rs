//! 모듈 스캔 유틸 — `system/modules` + `user/modules` 의 config.json 일괄 read.
//!
//! 옛 패턴 (3 위치 중복):
//! - `core/src/managers/module.rs::scan_dir`
//! - `core/src/managers/capability.rs::get_providers`
//! - `core/src/managers/capability.rs::list_with_providers`
//!
//! 같은 흐름 — `list_dir` → directory filter → `read({loc}/{name}/config.json)`
//! → `from_str`. 후속 filter (capability 매칭, type/scope 결정 등) 는 호출자 책임.

use crate::ports::IStoragePort;

/// 단일 module 의 스캔 결과 — 호출자 후속 filter 의 입력 단위.
pub struct ModuleEntry {
    /// 디렉토리 prefix — `"system/modules"` 또는 `"user/modules"`.
    pub location: &'static str,
    /// 디렉토리 이름 — config.json 의 `name` 필드 보다 더 신뢰. (config.json 미존재 또는 파싱 실패 시 본 entry 자체가 반환 X)
    pub dir_name: String,
    /// 파싱된 config.json 본체.
    pub config: serde_json::Value,
}

/// `system/modules` + `user/modules` 의 모든 모듈 config 스캔.
///
/// 안전 동작:
/// - `list_dir` 실패 (디렉토리 미존재 등) — 해당 location skip, 빈 결과 반환 안 함
/// - directory 가 아닌 항목 skip
/// - config.json 미존재 또는 파싱 실패 — 그 모듈 skip (silent — 호출자가 별 로깅)
///
/// 정렬은 `list_dir` 자연 순서 유지 (옛 TS 와 동일 — sort 안 함).
pub async fn scan_module_configs(storage: &dyn IStoragePort) -> Vec<ModuleEntry> {
    let mut out = Vec::new();
    for location in ["system/modules", "user/modules"] {
        let Ok(entries) = storage.list_dir(location).await else {
            continue;
        };
        for entry in entries {
            if !entry.is_directory {
                continue;
            }
            let path = format!("{}/{}/config.json", location, entry.name);
            let Ok(content) = storage.read(&path).await else {
                continue;
            };
            let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) else {
                continue;
            };
            out.push(ModuleEntry {
                location,
                dir_name: entry.name,
                config,
            });
        }
    }
    out
}
