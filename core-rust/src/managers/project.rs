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
pub struct ProjectEntry {
    pub name: String,
    pub paths: Vec<String>,
    #[serde(rename = "pageSlugs")]
    pub page_slugs: Vec<String>,
    pub visibility: ProjectVisibility,
}

#[derive(Debug, Serialize, Deserialize)]
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::{
        database::SqliteDatabaseAdapter, storage::LocalStorageAdapter, vault::SqliteVaultAdapter,
    };
    use tempfile::tempdir;

    fn make_manager(workspace: &std::path::Path) -> ProjectManager {
        let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(workspace));
        let db: Arc<dyn IDatabasePort> = Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        ProjectManager::new(storage, db, vault)
    }

    #[tokio::test]
    async fn scan_collects_modules_and_pages() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        // 모듈 1개 (project=stock-blog)
        storage
            .write(
                "user/modules/scraper/config.json",
                r#"{"name":"scraper","project":"stock-blog"}"#,
            )
            .await
            .unwrap();
        let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
        let db: Arc<dyn IDatabasePort> = Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        // pages 2개 (같은 project)
        db.save_page("p1", r#"{"head":{},"body":[]}"#, "published", Some("stock-blog"), None, None);
        db.save_page("p2", r#"{"head":{},"body":[]}"#, "published", Some("stock-blog"), None, None);
        // 다른 project
        db.save_page("o1", r#"{"head":{},"body":[]}"#, "published", Some("other"), None, None);

        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        let mgr = ProjectManager::new(storage_arc, db, vault);

        let projects = mgr.scan().await;
        assert_eq!(projects.len(), 2);
        let stock = projects.iter().find(|p| p.name == "stock-blog").unwrap();
        assert_eq!(stock.paths.len(), 1);
        assert_eq!(stock.page_slugs.len(), 2);
    }

    #[tokio::test]
    async fn visibility_and_password() {
        let tmp = tempdir().unwrap();
        let mgr = make_manager(tmp.path());

        assert_eq!(mgr.get_visibility("stock"), ProjectVisibility::Public);

        mgr.set_visibility("stock", ProjectVisibility::Password, Some("secret"));
        assert_eq!(mgr.get_visibility("stock"), ProjectVisibility::Password);
        assert!(mgr.verify_password("stock", "secret"));
        assert!(!mgr.verify_password("stock", "wrong"));

        mgr.set_visibility("stock", ProjectVisibility::Private, None);
        assert_eq!(mgr.get_visibility("stock"), ProjectVisibility::Private);
        // password 자동 삭제됨
        assert!(!mgr.verify_password("stock", "secret"));
    }

    #[tokio::test]
    async fn config_roundtrip() {
        let tmp = tempdir().unwrap();
        let mgr = make_manager(tmp.path());

        let cfg = serde_json::json!({"theme": {"primary": "#ff0000"}});
        mgr.set_config("stock", &cfg).await.unwrap();
        let got = mgr.get_config("stock").await.unwrap();
        assert_eq!(got["theme"]["primary"], "#ff0000");
    }

    #[tokio::test]
    async fn unsafe_name_rejected() {
        let tmp = tempdir().unwrap();
        let mgr = make_manager(tmp.path());
        assert!(mgr.set_config("../etc", &serde_json::json!({})).await.is_err());
        assert!(mgr.delete("../etc").await.is_err());
    }
}
