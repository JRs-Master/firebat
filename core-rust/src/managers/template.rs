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

/// 템플릿 spec — 페이지 발행 시 spec.body 의 backbone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateConfig {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub spec: TemplateSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateSpec {
    #[serde(default)]
    pub head: serde_json::Value,
    pub body: Vec<TemplateBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    pub props: serde_json::Value,
}

/// 어드민 UI / cron-agent 가 보는 entry — config 전체 X, 메타만.
#[derive(Debug, Clone, Serialize, Deserialize)]
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

    /// 템플릿 목록 — `user/templates/` 안 디렉토리 스캔. 잘못된 JSON 은 silent skip.
    pub async fn list(&self) -> Vec<TemplateEntry> {
        let Ok(entries) = self.storage.list_dir("user/templates").await else {
            return vec![];
        };
        let mut out = Vec::new();
        for e in entries {
            if !e.is_directory {
                continue;
            }
            let slug = e.name.clone();
            let path = format!("user/templates/{}/template.json", slug);
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
    pub async fn get(&self, slug: &str) -> Option<TemplateConfig> {
        if !is_safe_slug(slug) {
            return None;
        }
        let path = format!("user/templates/{}/template.json", slug);
        let json = self.storage.read(&path).await.ok()?;
        serde_json::from_str(&json).ok()
    }

    /// 템플릿 저장 — upsert. spec.body 검증.
    pub async fn save(&self, slug: &str, config: &TemplateConfig) -> InfraResult<()> {
        if !is_safe_slug(slug) {
            return Err("잘못된 템플릿 slug 입니다.".into());
        }
        if config.name.is_empty() {
            return Err("name 필수입니다.".into());
        }
        if config.spec.body.is_empty() {
            return Err("spec.body 비어있을 수 없습니다.".into());
        }
        let json = serde_json::to_string_pretty(config)
            .map_err(|e| format!("template JSON 직렬화 실패: {e}"))?;
        let path = format!("user/templates/{}/template.json", slug);
        self.storage.write(&path, &json).await
    }

    /// 템플릿 삭제 — 폴더 통째 제거.
    pub async fn delete(&self, slug: &str) -> InfraResult<()> {
        if !is_safe_slug(slug) {
            return Err("잘못된 템플릿 slug 입니다.".into());
        }
        let path = format!("user/templates/{}", slug);
        self.storage.delete(&path).await
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::storage::LocalStorageAdapter;
    use tempfile::tempdir;

    fn make_template(name: &str) -> TemplateConfig {
        TemplateConfig {
            name: name.to_string(),
            description: "test template".to_string(),
            tags: vec!["test".to_string()],
            spec: TemplateSpec {
                head: serde_json::json!({}),
                body: vec![TemplateBlock {
                    block_type: "Text".to_string(),
                    props: serde_json::json!({"content": "hello"}),
                }],
            },
        }
    }

    #[tokio::test]
    async fn save_then_get_then_list_then_delete() {
        let tmp = tempdir().unwrap();
        let storage: Arc<dyn IStoragePort> =
            Arc::new(LocalStorageAdapter::new(tmp.path()));
        let mgr = TemplateManager::new(storage);

        // empty list
        assert_eq!(mgr.list().await.len(), 0);

        // save
        mgr.save("stock-weekly", &make_template("주간 시황")).await.unwrap();

        // get
        let got = mgr.get("stock-weekly").await.unwrap();
        assert_eq!(got.name, "주간 시황");
        assert_eq!(got.spec.body.len(), 1);

        // list
        let list = mgr.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].slug, "stock-weekly");
        assert_eq!(list[0].name, "주간 시황");

        // delete
        mgr.delete("stock-weekly").await.unwrap();
        assert!(mgr.get("stock-weekly").await.is_none());
        assert_eq!(mgr.list().await.len(), 0);
    }

    #[tokio::test]
    async fn unsafe_slug_rejected() {
        let tmp = tempdir().unwrap();
        let storage: Arc<dyn IStoragePort> =
            Arc::new(LocalStorageAdapter::new(tmp.path()));
        let mgr = TemplateManager::new(storage);

        assert!(mgr.save("../etc/passwd", &make_template("evil")).await.is_err());
        assert!(mgr.save("foo/bar", &make_template("evil")).await.is_err());
        assert!(mgr.save("foo bar", &make_template("evil")).await.is_err());
        assert!(mgr.save("", &make_template("evil")).await.is_err());

        assert!(mgr.get("../etc/passwd").await.is_none());
        assert!(mgr.delete("../etc/passwd").await.is_err());
    }

    #[tokio::test]
    async fn empty_body_rejected() {
        let tmp = tempdir().unwrap();
        let storage: Arc<dyn IStoragePort> =
            Arc::new(LocalStorageAdapter::new(tmp.path()));
        let mgr = TemplateManager::new(storage);

        let mut bad = make_template("empty");
        bad.spec.body.clear();
        assert!(mgr.save("empty", &bad).await.is_err());
    }

    #[tokio::test]
    async fn list_silent_skips_invalid_json() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        // 잘못된 JSON 직접 박음 — list 가 silent skip 해야
        storage
            .write("user/templates/broken/template.json", "{ not valid json")
            .await
            .unwrap();
        // 정상 템플릿도 같이 박음
        let valid_json = serde_json::to_string_pretty(&make_template("valid")).unwrap();
        storage
            .write("user/templates/valid/template.json", &valid_json)
            .await
            .unwrap();

        let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
        let mgr = TemplateManager::new(storage_arc);

        let list = mgr.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].slug, "valid");
    }
}
