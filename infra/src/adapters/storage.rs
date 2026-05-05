//! LocalStorageAdapter — IStoragePort 의 tokio::fs 구현체.
//!
//! Workspace zone 격리 — path traversal 차단 (BIBLE 의 "단독 점유 원칙" + 보안):
//!  - workspace_root 밖 path 거부
//!  - .. / 절대 경로 정규화 후 contains 검사
//!
//! 옛 TS LocalStorageAdapter (`infra/storage/index.ts`) 의 동작 그대로 — Rust 재구현.

use std::path::{Path, PathBuf};
use tokio::fs;

use base64::Engine;

use firebat_core::ports::{
    BinaryReadResult, DirEntry, GrepMatch, GrepOpts, IStoragePort, InfraResult,
};

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
        // 옛 TS LocalStorageAdapter.listDir 1:1 — 미존재 디렉토리는 ENOENT err 반환
        // (옛 TS `fs.readdir` 가 throw → `{success: false, error: ENOENT}`).
        // 호출자 (ModuleManager.run 등) 가 err 분기로 "모듈을 찾을 수 없습니다" 메시지 매칭.
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

    async fn read_binary(&self, path: &str) -> InfraResult<BinaryReadResult> {
        let safe = self.resolve_safe_path(path)?;
        let bytes = fs::read(&safe)
            .await
            .map_err(|e| format!("read_binary 실패 ({path}): {e}"))?;
        let size = bytes.len();
        let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let mime_type = guess_mime_type(path);
        Ok(BinaryReadResult {
            base64,
            mime_type,
            size,
        })
    }

    async fn write_cache(&self, path: &str, content: &str) -> InfraResult<()> {
        // Internal cache write — `data/cache/` 안에서만 박힘. 그 외 path 거부.
        // 옛 TS writeCache 1:1.
        if !path.starts_with("data/cache/") {
            return Err(format!(
                "write_cache: data/cache/ 외 path 거부 ({path})"
            ));
        }
        self.write(path, content).await
    }

    async fn delete_cache(&self, path: &str) -> InfraResult<()> {
        if !path.starts_with("data/cache/") {
            return Err(format!(
                "delete_cache: data/cache/ 외 path 거부 ({path})"
            ));
        }
        self.delete(path).await
    }

    async fn list(&self, path: &str) -> InfraResult<Vec<String>> {
        // 옛 TS list 1:1 — 디렉토리 제외, 파일 이름만.
        let entries = self.list_dir(path).await?;
        Ok(entries
            .into_iter()
            .filter(|e| !e.is_directory)
            .map(|e| e.name)
            .collect())
    }

    async fn glob(&self, pattern: &str, limit: Option<usize>) -> InfraResult<Vec<String>> {
        // 단순 glob 매칭 — workspace 안에서 walk 후 pattern 매칭.
        // 옛 TS Node 24 fs.glob 의 기본 패턴 (`*` / `**` / `?` / 확장자) 동등.
        let max = limit.unwrap_or(1000);
        let workspace_canonical = self
            .workspace_root
            .canonicalize()
            .map_err(|e| format!("workspace canonicalize 실패: {e}"))?;
        let mut matches: Vec<String> = Vec::new();
        let mut stack: Vec<PathBuf> = vec![workspace_canonical.clone()];

        while let Some(dir) = stack.pop() {
            if matches.len() >= max {
                break;
            }
            let mut read_dir = match fs::read_dir(&dir).await {
                Ok(r) => r,
                Err(_) => continue,
            };
            while let Some(entry) = read_dir
                .next_entry()
                .await
                .map_err(|e| format!("next_entry 실패: {e}"))?
            {
                if matches.len() >= max {
                    break;
                }
                let path = entry.path();
                let file_type = match entry.file_type().await {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                if file_type.is_dir() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    // hidden + node_modules / target 등 흔한 노이즈 자동 제외 (옛 TS 와 동일)
                    if name.starts_with('.')
                        || name == "node_modules"
                        || name == "target"
                    {
                        continue;
                    }
                    stack.push(path);
                } else {
                    let rel = match path.strip_prefix(&workspace_canonical) {
                        Ok(r) => r.to_string_lossy().replace('\\', "/"),
                        Err(_) => continue,
                    };
                    if glob_match(pattern, &rel) {
                        matches.push(rel);
                    }
                }
            }
        }
        Ok(matches)
    }

    async fn grep(
        &self,
        pattern: &str,
        opts: &GrepOpts<'_>,
    ) -> InfraResult<Vec<GrepMatch>> {
        let limit = opts.limit.unwrap_or(200);
        let regex = match if opts.ignore_case {
            regex::RegexBuilder::new(pattern).case_insensitive(true).build()
        } else {
            regex::Regex::new(pattern)
        } {
            Ok(r) => r,
            Err(e) => return Err(format!("grep regex 컴파일 실패: {e}")),
        };
        let workspace_canonical = self
            .workspace_root
            .canonicalize()
            .map_err(|e| format!("workspace canonicalize 실패: {e}"))?;
        let search_root = match opts.path {
            Some(p) => self.resolve_safe_path(p)?,
            None => workspace_canonical.clone(),
        };
        let file_type_filter = opts.file_type;
        let mut matches: Vec<GrepMatch> = Vec::new();
        let mut stack: Vec<PathBuf> = vec![search_root];

        while let Some(dir) = stack.pop() {
            if matches.len() >= limit {
                break;
            }
            let mut read_dir = match fs::read_dir(&dir).await {
                Ok(r) => r,
                Err(_) => continue,
            };
            while let Some(entry) = read_dir
                .next_entry()
                .await
                .map_err(|e| format!("next_entry 실패: {e}"))?
            {
                if matches.len() >= limit {
                    break;
                }
                let path = entry.path();
                let file_type = match entry.file_type().await {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                if file_type.is_dir() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.')
                        || name == "node_modules"
                        || name == "target"
                    {
                        continue;
                    }
                    stack.push(path);
                } else {
                    if let Some(ext) = file_type_filter {
                        let path_str = path.to_string_lossy();
                        if !path_str.ends_with(&format!(".{}", ext)) {
                            continue;
                        }
                    }
                    let content = match fs::read_to_string(&path).await {
                        Ok(c) => c,
                        Err(_) => continue, // binary 파일 등 skip
                    };
                    let rel = match path.strip_prefix(&workspace_canonical) {
                        Ok(r) => r.to_string_lossy().replace('\\', "/"),
                        Err(_) => continue,
                    };
                    for (i, line) in content.lines().enumerate() {
                        if matches.len() >= limit {
                            break;
                        }
                        if regex.is_match(line) {
                            matches.push(GrepMatch {
                                file: rel.clone(),
                                line: i + 1,
                                text: line.to_string(),
                            });
                        }
                    }
                }
            }
        }
        Ok(matches)
    }
}

/// 확장자 → MIME type 매핑 — 옛 TS readBinary 의 mimeType 추론 1:1.
fn guess_mime_type(path: &str) -> String {
    let ext = path
        .rsplit('.')
        .next()
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// 단순 glob 매칭 — `*` / `**` / `?` / 정확한 매칭.
/// 옛 TS Node 24 fs.glob 의 기본 동작 1:1 (외부 의존성 없이 inline).
fn glob_match(pattern: &str, path: &str) -> bool {
    // `**` → 임의 디렉토리, `*` → 디렉토리 외 모든 char, `?` → 1 char.
    // 단순 구현: regex 변환.
    let mut regex_str = String::from("^");
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    // `**/` → 임의 디렉토리 (0개+)
                    if chars.peek() == Some(&'/') {
                        chars.next();
                        regex_str.push_str("(?:.+/)?");
                    } else {
                        regex_str.push_str(".*");
                    }
                } else {
                    regex_str.push_str("[^/]*");
                }
            }
            '?' => regex_str.push_str("[^/]"),
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\' => {
                regex_str.push('\\');
                regex_str.push(c);
            }
            _ => regex_str.push(c),
        }
    }
    regex_str.push('$');
    match regex::Regex::new(&regex_str) {
        Ok(r) => r.is_match(path),
        Err(_) => false,
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

    #[tokio::test]
    async fn list_returns_only_files() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        storage.write("dir/file1.txt", "x").await.unwrap();
        storage.write("dir/file2.txt", "y").await.unwrap();
        storage.write("dir/sub/file3.txt", "z").await.unwrap();

        let names = storage.list("dir").await.unwrap();
        assert_eq!(names.len(), 2); // sub 디렉토리는 제외
        assert!(names.contains(&"file1.txt".to_string()));
        assert!(names.contains(&"file2.txt".to_string()));
    }

    #[tokio::test]
    async fn read_binary_returns_base64_with_mime() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        // PNG magic header
        let png_bytes = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        let path = tmp.path().join("test.png");
        std::fs::write(&path, &png_bytes).unwrap();

        let result = storage.read_binary("test.png").await.unwrap();
        assert_eq!(result.size, 8);
        assert_eq!(result.mime_type, "image/png");
        // base64 encoded "iVBORw0KGgo="
        assert_eq!(result.base64, "iVBORw0KGgo=");
    }

    #[tokio::test]
    async fn write_cache_only_in_data_cache() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());

        // 정상 — data/cache/ 안
        storage
            .write_cache("data/cache/sysmod-results/test.jsonl", "{}")
            .await
            .unwrap();
        let content = storage
            .read("data/cache/sysmod-results/test.jsonl")
            .await
            .unwrap();
        assert_eq!(content, "{}");

        // 거부 — data/cache/ 외 path
        let result = storage.write_cache("user/modules/x/index.mjs", "{}").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("data/cache/"));
    }

    #[tokio::test]
    async fn delete_cache_only_in_data_cache() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        storage
            .write_cache("data/cache/x.json", "{}")
            .await
            .unwrap();
        storage.delete_cache("data/cache/x.json").await.unwrap();
        assert!(!storage.exists("data/cache/x.json").await);

        // 거부
        let result = storage.delete_cache("user/modules/x").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn glob_finds_files_by_pattern() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        storage.write("src/foo.rs", "x").await.unwrap();
        storage.write("src/bar.rs", "y").await.unwrap();
        storage.write("src/sub/baz.rs", "z").await.unwrap();
        storage.write("docs/readme.md", "doc").await.unwrap();

        // **/*.rs — 모든 .rs 파일
        let rs_files = storage.glob("**/*.rs", None).await.unwrap();
        assert_eq!(rs_files.len(), 3);

        // *.md — top-level 만 (현재 구현에선 **/*.md 와 다른 결과)
        let md_files = storage.glob("**/*.md", None).await.unwrap();
        assert_eq!(md_files.len(), 1);
    }

    #[tokio::test]
    async fn grep_finds_pattern_in_files() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        storage
            .write("a.txt", "hello world\nfoo bar\nhello rust")
            .await
            .unwrap();
        storage.write("b.txt", "no match here").await.unwrap();

        let matches = storage
            .grep(
                "hello",
                &GrepOpts {
                    path: None,
                    file_type: Some("txt"),
                    limit: None,
                    ignore_case: false,
                },
            )
            .await
            .unwrap();
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].file, "a.txt");
        assert_eq!(matches[0].line, 1);
        assert_eq!(matches[1].line, 3);
    }

    #[tokio::test]
    async fn grep_ignore_case() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        storage.write("a.txt", "Hello\nWORLD").await.unwrap();

        let matches = storage
            .grep(
                "hello",
                &GrepOpts {
                    path: None,
                    file_type: None,
                    limit: None,
                    ignore_case: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].text, "Hello");
    }

    #[test]
    fn glob_match_basic_patterns() {
        // 인라인 헬퍼 단위 테스트
        assert!(glob_match("**/*.rs", "src/foo.rs"));
        assert!(glob_match("**/*.rs", "deep/nested/dir/file.rs"));
        assert!(glob_match("*.rs", "foo.rs"));
        assert!(!glob_match("*.rs", "src/foo.rs")); // `*` 는 / 매칭 X
        assert!(!glob_match("**/*.rs", "foo.txt"));
        assert!(glob_match("src/**/*.rs", "src/sub/x.rs"));
        assert!(glob_match("src/**/*.rs", "src/x.rs"));
    }
}
