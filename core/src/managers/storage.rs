//! StorageManager — 파일 시스템 CRUD + 트리 조회.
//!
//! 옛 TS `core/managers/storage-manager.ts` (96 LOC) Rust 1:1 port.
//!
//! 인프라: IStoragePort 만 의존.
//! SSE 발행: 하지 않음 (Core 파사드에서 처리 — BIBLE 준수).
//!
//! BIBLE 준수: Core 가 storage adapter 를 직접 호출하지 않고 본 매니저 경유.
//!
//! `get_file_tree` — 재귀 디렉토리 트리 빌더. 사이드바 file tree UI 에 사용.
//! `glob` / `grep` / `read_binary` / `write_cache` / `delete_cache` 는 IStoragePort 확장 후
//! 활성 (현재 list_dir / read / write / delete / exists 만 활용).

use std::sync::Arc;

use crate::ports::{
    BinaryReadResult, DirEntry, GrepMatch, GrepOpts, IStoragePort, InfraResult,
};

/// 재귀 디렉토리 트리 노드. 옛 TS `TreeNode` 1:1.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
    /// 디렉토리만 children 설정. 파일은 빈 배열.
    pub children: Vec<TreeNode>,
}

pub struct StorageManager {
    storage: Arc<dyn IStoragePort>,
}

impl StorageManager {
    pub fn new(storage: Arc<dyn IStoragePort>) -> Self {
        Self { storage }
    }

    /// 텍스트 파일 read — 옛 TS 1:1.
    pub async fn read(&self, path: &str) -> InfraResult<String> {
        self.storage.read(path).await
    }

    /// 텍스트 파일 write — 디렉토리 자동 생성. 옛 TS 1:1.
    pub async fn write(&self, path: &str, content: &str) -> InfraResult<()> {
        self.storage.write(path, content).await
    }

    /// 파일 또는 디렉토리 delete (recursive). 옛 TS 1:1.
    pub async fn delete(&self, path: &str) -> InfraResult<()> {
        self.storage.delete(path).await
    }

    /// 디렉토리 안 entry 나열. 옛 TS 1:1.
    pub async fn list_dir(&self, path: &str) -> InfraResult<Vec<DirEntry>> {
        self.storage.list_dir(path).await
    }

    /// 파일 존재 여부 — IStoragePort 직접 노출 (옛 TS 의 list 헬퍼 등가성 위해).
    pub async fn exists(&self, path: &str) -> bool {
        self.storage.exists(path).await
    }

    /// 바이너리 파일 read — base64 + mimeType + size. 옛 TS readBinary 1:1.
    pub async fn read_binary(&self, path: &str) -> InfraResult<BinaryReadResult> {
        self.storage.read_binary(path).await
    }

    /// 디렉토리 안 파일 이름만 — list_dir 와 다름 (디렉토리 제외). 옛 TS list 1:1.
    pub async fn list(&self, path: &str) -> InfraResult<Vec<String>> {
        self.storage.list(path).await
    }

    /// glob 패턴 매칭 — 옛 TS glob 1:1. AI 도구 (glob_files) 가 의존.
    pub async fn glob(&self, pattern: &str, limit: Option<usize>) -> InfraResult<Vec<String>> {
        self.storage.glob(pattern, limit).await
    }

    /// 콘텐츠 grep — 옛 TS grep 1:1. AI 도구 (grep_code) 가 의존.
    pub async fn grep(
        &self,
        pattern: &str,
        opts: &GrepOpts<'_>,
    ) -> InfraResult<Vec<GrepMatch>> {
        self.storage.grep(pattern, opts).await
    }

    /// Internal cache write — Core.cacheData 만 호출. AI 도구 우회 차단.
    /// 옛 TS writeCache 1:1.
    pub async fn write_cache(&self, path: &str, content: &str) -> InfraResult<()> {
        self.storage.write_cache(path, content).await
    }

    /// Internal cache delete — Core.cacheDrop 만 호출. 옛 TS deleteCache 1:1.
    pub async fn delete_cache(&self, path: &str) -> InfraResult<()> {
        self.storage.delete_cache(path).await
    }

    /// 재귀 디렉토리 트리 빌더 — 옛 TS `getFileTree(root)` 1:1.
    ///
    /// 룰:
    /// - `.` 으로 시작하는 hidden 제외
    /// - `[...]` 로 감싸진 special entry 제외 (Next.js dynamic route 등)
    /// - 디렉토리 우선, 같은 종류면 이름 사전순 정렬
    /// - root 가 단일이면 단일 root TreeNode 반환, 배열이면 각 root 의 트리 누적
    pub async fn get_file_tree(&self, root: &str) -> Vec<TreeNode> {
        let children = self.build_tree_recursive(root).await;
        vec![TreeNode {
            name: root.to_string(),
            path: root.to_string(),
            is_directory: true,
            children,
        }]
    }

    /// 여러 root 한꺼번에 트리 빌드 — 옛 TS `Array.isArray(root)` 분기 1:1.
    pub async fn get_file_trees(&self, roots: &[&str]) -> Vec<TreeNode> {
        let mut tree = Vec::new();
        for r in roots {
            let children = self.build_tree_recursive(r).await;
            tree.push(TreeNode {
                name: (*r).to_string(),
                path: (*r).to_string(),
                is_directory: true,
                children,
            });
        }
        tree
    }

    /// 재귀 핸들러 — async 재귀라 Box::pin 필요.
    fn build_tree_recursive<'a>(
        &'a self,
        dir: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<TreeNode>> + Send + 'a>> {
        Box::pin(async move {
            let entries = match self.storage.list_dir(dir).await {
                Ok(e) => e,
                Err(_) => return Vec::new(),
            };

            let mut nodes: Vec<TreeNode> = Vec::new();
            for entry in entries {
                // hidden entry 제외 — 옛 TS `.startsWith('.')` 1:1
                if entry.name.starts_with('.') {
                    continue;
                }
                // Next.js dynamic route bracket entry 제외 — 옛 TS `[` ... `]` 1:1
                if entry.name.starts_with('[') && entry.name.ends_with(']') {
                    continue;
                }
                let rel_path = format!("{}/{}", dir, entry.name);
                let children = if entry.is_directory {
                    self.build_tree_recursive(&rel_path).await
                } else {
                    Vec::new()
                };
                nodes.push(TreeNode {
                    name: entry.name,
                    path: rel_path,
                    is_directory: entry.is_directory,
                    children,
                });
            }
            // 디렉토리 우선, 같은 종류 안에서 이름 사전순 — 옛 TS 1:1
            nodes.sort_by(|a, b| match (a.is_directory, b.is_directory) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.cmp(&b.name),
            });
            nodes
        })
    }
}


// Tests 이관 — `infra/tests/storage_manager_test.rs` (integration test).
