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

        // DB pages — project 필드
        for page in self.db.list_pages() {
            if let Some(project) = &page.project {
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

    /// 프로젝트 일괄 삭제 — 모든 path + DB pages.
    pub async fn delete(&self, project: &str) -> InfraResult<ProjectDeleteResult> {
        if !is_safe_name(project) {
            return Err("잘못된 프로젝트 이름입니다.".into());
        }
        let projects = self.scan().await;
        let entry = projects.iter().find(|p| p.name == project);
        let Some(entry) = entry else {
            return Err("해당 프로젝트를 찾을 수 없습니다.".into());
        };
        if entry.paths.is_empty() && entry.page_slugs.is_empty() {
            return Err("해당 프로젝트를 찾을 수 없습니다.".into());
        }

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
            return Err("잘못된 프로젝트 이름입니다.".into());
        }
        let json = serde_json::to_string_pretty(config)
            .map_err(|e| format!("config 직렬화 실패: {e}"))?;
        let path = format!("user/projects/{}/config.json", name);
        self.storage.write(&path, &json).await
    }
}


// Tests 이관 — `infra/tests/project_manager_test.rs` (integration test).
