//! ProjectManager — 프로젝트 스캔 + visibility + config + 일괄 삭제.
//!
//! 옛 TS ProjectManager (`core/managers/project-manager.ts`) Rust 재구현.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::ports::{IDatabasePort, IStoragePort, IVaultPort, InfraResult};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProjectVisibility {
    Public,
    Password,
    Private,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub name: String,
    pub paths: Vec<String>,
    #[serde(rename = "pageSlugs")]
    pub page_slugs: Vec<String>,
    pub visibility: ProjectVisibility,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeleteResult {
    pub paths: Vec<String>,
    pub pages: Vec<String>,
}

fn vk_project_visibility(name: &str) -> String {
    format!("system:project:{}:visibility", name)
}

fn vk_project_password(name: &str) -> String {
    format!("system:project:{}:password", name)
}

fn is_safe_name(name: &str) -> bool {
    !name.is_empty() && !name.contains("..") && !name.contains('/') && !name.contains('\\')
}

pub struct ProjectManager {
    storage: Arc<dyn IStoragePort>,
    db: Arc<dyn IDatabasePort>,
    vault: Arc<dyn IVaultPort>,
}

impl ProjectManager {
    pub fn new(
        storage: Arc<dyn IStoragePort>,
        db: Arc<dyn IDatabasePort>,
        vault: Arc<dyn IVaultPort>,
    ) -> Self {
        Self { storage, db, vault }
    }

    /// 프로젝트 목록 스캔 — user/modules + DB pages + app/(user) manifest 통합.
    pub async fn scan(&self) -> Vec<ProjectEntry> {
        let mut map: HashMap<String, (Vec<String>, Vec<String>)> = HashMap::new();

        // user/modules/*/config.json
        if let Ok(entries) = self.storage.list_dir("user/modules").await {
            for entry in entries {
                if !entry.is_directory {
                    continue;
                }
                let path = format!("user/modules/{}/config.json", entry.name);
                let Ok(content) = self.storage.read(&path).await else { continue };
                let Ok(parsed): Result<serde_json::Value, _> = serde_json::from_str(&content)
                else { continue };
                if let Some(project) = parsed.get("project").and_then(|v| v.as_str()) {
                    map.entry(project.to_string())
                        .or_insert_with(|| (Vec::new(), Vec::new()))
                        .0
                        .push(format!("user/modules/{}", entry.name));
                }
            }
        }

        // DB pages — project 필드.
        // hub-scoped page (project='hub:<instance_id>') = root 사이트 catalog noindex —
        // 사용자 의도 "사이드바 안에서만 다룸". scanProjects 결과에서 자동 제외.
        for page in self.db.list_pages() {
            if let Some(project) = &page.project {
                if project.starts_with("hub:") {
                    continue;
                }
                map.entry(project.clone())
                    .or_insert_with(|| (Vec::new(), Vec::new()))
                    .1
                    .push(page.slug);
            }
        }

        let mut result: Vec<ProjectEntry> = map
            .into_iter()
            .map(|(name, (paths, page_slugs))| {
                let visibility = self.get_visibility(&name);
                ProjectEntry {
                    name,
                    paths,
                    page_slugs,
                    visibility,
                }
            })
            .collect();
        result.sort_by(|a, b| a.name.cmp(&b.name));
        result
    }

    /// hub-scoped 프로젝트 스캔 — `user/hub/<id>/modules/*/config.json` + DB pages 안 project=`hub:<id>` 매칭.
    /// admin 자료 노출 0 — visitor 자기 hub 영역만.
    pub async fn scan_for_hub(&self, hub_scope: &str) -> Vec<ProjectEntry> {
        if !is_safe_name(hub_scope) {
            return Vec::new();
        }
        // hub_scope = `<inst>` 또는 세션 `<inst>:<sid>`. 페이지 프로젝트 키 = **전체 스코프**(세션 격리).
        let hub_project_key = format!("hub:{}", hub_scope);
        // 모듈 fs 경로 = 세션 디렉토리 (콜론을 경로 구분자로: `<inst>/<sid>`). confine_hub_path 와 일관(STEP 2 — fs 세션화).
        let scope_path = hub_scope.replace(':', "/");
        let mut map: HashMap<String, (Vec<String>, Vec<String>)> = HashMap::new();

        // user/hub/<inst>/<sid>/modules/*/config.json
        let modules_dir = format!("user/hub/{}/modules", scope_path);
        if let Ok(entries) = self.storage.list_dir(&modules_dir).await {
            for entry in entries {
                if !entry.is_directory {
                    continue;
                }
                let path = format!("user/hub/{}/modules/{}/config.json", scope_path, entry.name);
                let Ok(content) = self.storage.read(&path).await else { continue };
                let Ok(parsed): Result<serde_json::Value, _> = serde_json::from_str(&content)
                else { continue };
                let project_name = parsed
                    .get("project")
                    .and_then(|v| v.as_str())
                    .unwrap_or(hub_project_key.as_str())
                    .to_string();
                map.entry(project_name)
                    .or_insert_with(|| (Vec::new(), Vec::new()))
                    .0
                    .push(format!("user/hub/{}/modules/{}", scope_path, entry.name));
            }
        }

        // DB pages — 본 hub 의 project 매칭만.
        for page in self.db.list_pages() {
            if page.project.as_deref() == Some(hub_project_key.as_str()) {
                map.entry(hub_project_key.clone())
                    .or_insert_with(|| (Vec::new(), Vec::new()))
                    .1
                    .push(page.slug);
            }
        }

        let mut result: Vec<ProjectEntry> = map
            .into_iter()
            .map(|(name, (paths, page_slugs))| {
                let visibility = self.get_visibility(&name);
                ProjectEntry { name, paths, page_slugs, visibility }
            })
            .collect();
        result.sort_by(|a, b| a.name.cmp(&b.name));
        result
    }

    /// 프로젝트 일괄 삭제 — 모든 path + DB pages.
    pub async fn delete(&self, project: &str) -> InfraResult<ProjectDeleteResult> {
        let entry = self.find_in_scope(project, None).await?;
        self.delete_entry(project, &entry).await
    }

    /// hub 격리 삭제 — hub_id 지정 시 그 hub 자료(scan_for_hub)에서만 찾아 삭제.
    /// 미소유 = not_found (존재 여부 노출 방지). admin(None) 은 delete 와 동일 동작.
    pub async fn delete_owned(
        &self,
        project: &str,
        hub_id: Option<&str>,
    ) -> InfraResult<ProjectDeleteResult> {
        let entry = self.find_in_scope(project, hub_id).await?;
        self.delete_entry(project, &entry).await
    }

    /// hub_id scope 안에서 project entry 조회. hub_id=None 이면 admin scope(scan).
    /// 못 찾으면 not_found — hub 격리 + 빈 프로젝트 가드 단일 지점.
    async fn find_in_scope(
        &self,
        project: &str,
        hub_id: Option<&str>,
    ) -> InfraResult<ProjectEntry> {
        if !is_safe_name(project) {
            return Err(crate::i18n::t("core.error.project.name_invalid", None, &[]));
        }
        let projects = match hub_id.filter(|s| !s.is_empty()) {
            Some(id) => self.scan_for_hub(id).await,
            None => self.scan().await,
        };
        let entry = projects.into_iter().find(|p| p.name == project);
        let Some(entry) = entry else {
            return Err(crate::i18n::t("core.error.project.not_found", None, &[]));
        };
        if entry.paths.is_empty() && entry.page_slugs.is_empty() {
            return Err(crate::i18n::t("core.error.project.not_found", None, &[]));
        }
        Ok(entry)
    }

    /// scope 검증을 통과한 entry 실제 삭제 — path + DB pages.
    async fn delete_entry(
        &self,
        project: &str,
        entry: &ProjectEntry,
    ) -> InfraResult<ProjectDeleteResult> {
        for p in &entry.paths {
            let _ = self.storage.delete(p).await;
        }
        let deleted_pages = if !entry.page_slugs.is_empty() {
            self.db.delete_pages_by_project(project)
        } else {
            Vec::new()
        };

        Ok(ProjectDeleteResult {
            paths: entry.paths.clone(),
            pages: deleted_pages,
        })
    }

    /// hub_id 가 project 를 소유하는지 — set_visibility 등 mutate 전 hub 격리 가드.
    /// 소유권은 **canonical hub project 키(`hub:<id>`)로만** 판정. 옛 코드는 scan_for_hub 가 읽는
    /// config.json 의 `project` 필드(방문자가 fs write 로 조작 가능)로 판정 → 'blog' 등 admin/타 인스턴스
    /// 프로젝트 이름을 심어 visibility/비번 탈취(PROJ-VIS-1). hub 인스턴스는 자기 'hub:<id>' 만 소유한다.
    pub async fn hub_owns_project(&self, hub_id: &str, project: &str) -> bool {
        if !is_safe_name(hub_id) {
            return false;
        }
        project == format!("hub:{}", hub_id)
    }

    pub fn get_visibility(&self, project: &str) -> ProjectVisibility {
        let raw = self.vault.get_secret(&vk_project_visibility(project));
        match raw.as_deref() {
            Some("private") => ProjectVisibility::Private,
            Some("password") => ProjectVisibility::Password,
            _ => ProjectVisibility::Public,
        }
    }

    pub fn set_visibility(
        &self,
        project: &str,
        visibility: ProjectVisibility,
        password: Option<&str>,
    ) -> bool {
        let value = match visibility {
            ProjectVisibility::Public => "public",
            ProjectVisibility::Password => "password",
            ProjectVisibility::Private => "private",
        };
        self.vault.set_secret(&vk_project_visibility(project), value);
        match (visibility, password) {
            (ProjectVisibility::Password, Some(pw)) => {
                self.vault.set_secret(&vk_project_password(project), pw);
            }
            _ => {
                self.vault.delete_secret(&vk_project_password(project));
            }
        }
        true
    }

    pub fn verify_password(&self, project: &str, password: &str) -> bool {
        let stored = self.vault.get_secret(&vk_project_password(project));
        stored.as_deref() == Some(password)
    }

    /// `user/projects/{name}/config.json` 의 theme override / customCss / layoutOverride 등.
    pub async fn get_config(&self, name: &str) -> Option<serde_json::Value> {
        if !is_safe_name(name) {
            return None;
        }
        let path = format!("user/projects/{}/config.json", name);
        let raw = self.storage.read(&path).await.ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub async fn set_config(&self, name: &str, config: &serde_json::Value) -> InfraResult<()> {
        if !is_safe_name(name) {
            return Err(crate::i18n::t("core.error.project.name_invalid", None, &[]));
        }
        let json = serde_json::to_string_pretty(config).map_err(|e| {
            crate::i18n::t(
                "core.error.project.config_serialize_failed",
                None,
                &[("detail", &e.to_string())],
            )
        })?;
        let path = format!("user/projects/{}/config.json", name);
        self.storage.write(&path, &json).await
    }
}


// Tests 이관 — `infra/tests/project_manager_test.rs` (integration test).
