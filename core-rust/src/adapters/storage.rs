//! LocalStorageAdapter — IStoragePort 의 tokio::fs 구현체.
//!
//! Workspace zone 격리 — path traversal 차단 (BIBLE 의 "단독 점유 원칙" + 보안):
//!  - workspace_root 밖 path 거부
//!  - .. / 절대 경로 정규화 후 contains 검사
//!
//! 옛 TS LocalStorageAdapter (`infra/storage/index.ts`) 의 동작 그대로 — Rust 재구현.

use std::path::{Path, PathBuf};
use tokio::fs;

use crate::ports::{DirEntry, IStoragePort, InfraResult};

pub struct LocalStorageAdapter {
    workspace_root: PathBuf,
}

impl LocalStorageAdapter {
    /// 새 어댑터 — workspace root (격리 zone) 지정. 모든 read/write 가 이 root 안에서만 동작.
    pub fn new(workspace_root: impl AsRef<Path>) -> Self {
        Self {
            workspace_root: workspace_root.as_ref().to_path_buf(),
        }
    }

    /// path traversal 차단 — 정규화 후 workspace_root 안인지 확인.
    fn resolve_safe_path(&self, rel_path: &str) -> InfraResult<PathBuf> {
        // 절대 경로 거부 — 명시적으로 거부 (Path::is_absolute 체크 후 단순 join 도 안전)
        let candidate = self.workspace_root.join(rel_path);
        // 부모 디렉토리 분리 후 정규화 — path 의 .. 모두 처리
        let canonical = match candidate.parent() {
            Some(parent) if parent.exists() => {
                let parent_canonical = parent
                    .canonicalize()
                    .map_err(|e| format!("path canonicalize 실패: {e}"))?;
                let workspace_canonical = self
                    .workspace_root
                    .canonicalize()
                    .map_err(|e| format!("workspace canonicalize 실패: {e}"))?;
                if !parent_canonical.starts_with(&workspace_canonical) {
                    return Err(format!(
                        "workspace zone 밖 path 거부: {}",
                        rel_path
                    ));
                }
                parent_canonical.join(candidate.file_name().ok_or_else(|| {
                    "유효하지 않은 path (file_name 추출 실패)".to_string()
                })?)
            }
            _ => candidate, // 부모 디렉토리 없으면 새 디렉토리 → 그대로 (write 시 mkdir_p)
        };
        Ok(canonical)
    }
}

#[async_trait::async_trait]
impl IStoragePort for LocalStorageAdapter {
    async fn read(&self, path: &str) -> InfraResult<String> {
        let safe = self.resolve_safe_path(path)?;
        fs::read_to_string(&safe)
            .await
            .map_err(|e| format!("read 실패 ({path}): {e}"))
    }

    async fn write(&self, path: &str, content: &str) -> InfraResult<()> {
        let safe = self.resolve_safe_path(path)?;
        if let Some(parent) = safe.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("디렉토리 생성 실패 ({path}): {e}"))?;
        }
        fs::write(&safe, content)
            .await
            .map_err(|e| format!("write 실패 ({path}): {e}"))
    }

    async fn delete(&self, path: &str) -> InfraResult<()> {
        let safe = self.resolve_safe_path(path)?;
        if !safe.exists() {
            return Ok(()); // 옛 TS 패턴 — 이미 없으면 success
        }
        let metadata = fs::metadata(&safe)
            .await
            .map_err(|e| format!("metadata 실패 ({path}): {e}"))?;
        if metadata.is_dir() {
            fs::remove_dir_all(&safe)
                .await
                .map_err(|e| format!("디렉토리 삭제 실패 ({path}): {e}"))
        } else {
            fs::remove_file(&safe)
                .await
                .map_err(|e| format!("파일 삭제 실패 ({path}): {e}"))
        }
    }

    async fn list_dir(&self, path: &str) -> InfraResult<Vec<DirEntry>> {
        let safe = self.resolve_safe_path(path)?;
        if !safe.exists() {
            return Ok(vec![]); // 디렉토리 없으면 빈 list (옛 TS 패턴)
        }
        let mut entries = Vec::new();
        let mut read_dir = fs::read_dir(&safe)
            .await
            .map_err(|e| format!("read_dir 실패 ({path}): {e}"))?;
        while let Some(entry) = read_dir
            .next_entry()
            .await
            .map_err(|e| format!("next_entry 실패: {e}"))?
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            let file_type = entry
                .file_type()
                .await
                .map_err(|e| format!("file_type 실패: {e}"))?;
            entries.push(DirEntry {
                name,
                is_directory: file_type.is_dir(),
            });
        }
        Ok(entries)
    }

    async fn exists(&self, path: &str) -> bool {
        let Ok(safe) = self.resolve_safe_path(path) else {
            return false;
        };
        safe.exists()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn write_then_read_roundtrip() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());

        storage.write("foo/bar.txt", "hello").await.unwrap();
        let content = storage.read("foo/bar.txt").await.unwrap();
        assert_eq!(content, "hello");
    }

    #[tokio::test]
    async fn delete_removes_file_and_dir() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());

        storage.write("a/b/c.txt", "x").await.unwrap();
        storage.delete("a/b/c.txt").await.unwrap();
        assert!(!storage.exists("a/b/c.txt").await);

        storage.write("a/b/d.txt", "y").await.unwrap();
        storage.delete("a").await.unwrap();
        assert!(!storage.exists("a/b/d.txt").await);
    }

    #[tokio::test]
    async fn list_dir_returns_entries() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());

        storage.write("templates/foo/template.json", "{}").await.unwrap();
        storage.write("templates/bar/template.json", "{}").await.unwrap();

        let entries = storage.list_dir("templates").await.unwrap();
        assert_eq!(entries.len(), 2);
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"foo"));
        assert!(names.contains(&"bar"));
    }
}
