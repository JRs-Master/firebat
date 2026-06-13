//! MemoryFileManager — operational memory backed by `data/memory/` files.
//!
//! Each entry is one `<name>.md` file with YAML frontmatter (name/category/description)
//! plus a free-form body. The index (the MEMORY.md equivalent) is built dynamically from
//! the entries so it never goes stale. Shared by the gRPC MemoryService (admin tab) and the
//! `memory_*` AI tools (owner-scoped).
//!
//! Owner scoping: None / "admin" -> `data/memory/`. "hub:<inst>:<sid>" ->
//! `data/memory/hub/<inst>/<sid>/` (coded but currently exercised by admin only — hub
//! injection/extraction is gated off in AiManager). Mirrors the Recall owner convention.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::ports::{IStoragePort, InfraResult};

/// Canonical categories, in index display order.
pub const MEMORY_CATEGORIES: [&str; 4] = ["user", "feedback", "project", "reference"];

/// One memory entry. JSON keys intentionally match the admin tab `MemoryItem`
/// (`{category, name, description, content}`).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MemoryEntry {
    pub category: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub content: String,
}

/// One grep hit — entry identity + matching body lines (empty if matched on name/description only).
#[derive(Debug, Clone, serde::Serialize)]
pub struct MemoryGrepHit {
    pub name: String,
    pub category: String,
    pub description: String,
    pub matches: Vec<String>,
}

pub struct MemoryFileManager {
    storage: Arc<dyn IStoragePort>,
    /// Workspace-relative base directory — default `data/memory`.
    base_dir: PathBuf,
}

impl MemoryFileManager {
    pub fn new(storage: Arc<dyn IStoragePort>) -> Self {
        Self {
            storage,
            base_dir: PathBuf::from("data/memory"),
        }
    }

    /// Create or overwrite an entry. Same `name` overwrites — dedup by name.
    pub async fn save(&self, owner: Option<&str>, entry: &MemoryEntry) -> InfraResult<()> {
        let path = resolve_path(&self.base_dir, owner, &entry.name)?;
        self.storage.write(&path, &serialize_entry(entry)).await
    }

    /// Read a single entry (parsed). Errors if missing.
    pub async fn read(&self, owner: Option<&str>, name: &str) -> InfraResult<MemoryEntry> {
        let path = resolve_path(&self.base_dir, owner, name)?;
        let raw = self.storage.read(&path).await?;
        Ok(parse_entry(name.trim().trim_end_matches(".md"), &raw))
    }

    pub async fn delete(&self, owner: Option<&str>, name: &str) -> InfraResult<()> {
        let path = resolve_path(&self.base_dir, owner, name)?;
        self.storage.delete(&path).await
    }

    /// All entries for an owner (parsed, with content). MEMORY.md is excluded.
    pub async fn list(&self, owner: Option<&str>) -> InfraResult<Vec<MemoryEntry>> {
        let dir_buf = owner_dir(&self.base_dir, owner)?;
        let dir = dir_buf.to_string_lossy().to_string();
        // Missing directory => no entries (list_dir errors with ENOENT on a fresh owner).
        let entries = self.storage.list_dir(&dir).await.unwrap_or_default();
        let mut out = Vec::new();
        for e in entries {
            if e.is_directory || !e.name.ends_with(".md") || e.name == "MEMORY.md" {
                continue;
            }
            let stem = e.name.trim_end_matches(".md").to_string();
            let file_path = dir_buf.join(&e.name).to_string_lossy().to_string();
            if let Ok(raw) = self.storage.read(&file_path).await {
                out.push(parse_entry(&stem, &raw));
            }
        }
        Ok(out)
    }

    /// Dynamic index (the MEMORY.md equivalent) — one line per entry, grouped by category.
    /// Built from the entries on every call so it never goes stale. Empty string when no
    /// entries (caller skips injection).
    pub async fn get_index(&self, owner: Option<&str>) -> InfraResult<String> {
        let entries = self.list(owner).await?;
        Ok(build_index(&entries))
    }

    /// Substring search over entry bodies (+ name/description), case-insensitive. Returns
    /// matching entries with only the matching body lines — the relevant snippet, not full
    /// bodies. "Know what exists from the index, dig with grep" (mirrors how Claude works).
    pub async fn grep(&self, owner: Option<&str>, query: &str) -> InfraResult<Vec<MemoryGrepHit>> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let mut hits = Vec::new();
        for e in self.list(owner).await? {
            let lines: Vec<String> = e
                .content
                .lines()
                .filter(|l| l.to_lowercase().contains(&q))
                .map(|l| l.trim().to_string())
                .collect();
            let meta_match =
                e.name.to_lowercase().contains(&q) || e.description.to_lowercase().contains(&q);
            if lines.is_empty() && !meta_match {
                continue;
            }
            hits.push(MemoryGrepHit {
                name: e.name,
                category: e.category,
                description: e.description,
                matches: lines,
            });
        }
        Ok(hits)
    }
}

/// Resolve the directory for an owner. None/"admin" => base; "hub:<inst>:<sid>" => nested.
/// Free fn (no `&self`) so path logic is unit-testable without a storage mock.
fn owner_dir(base: &Path, owner: Option<&str>) -> InfraResult<PathBuf> {
    match owner {
        None | Some("") | Some("admin") => Ok(base.to_path_buf()),
        Some(o) => {
            let rest = o
                .strip_prefix("hub:")
                .ok_or_else(|| format!("invalid memory owner: {o}"))?;
            let mut dir = base.join("hub");
            for part in rest.split(':') {
                if part.is_empty()
                    || part.contains("..")
                    || part.contains('/')
                    || part.contains('\\')
                {
                    return Err(format!("invalid memory owner segment: {o}"));
                }
                dir = dir.join(part);
            }
            Ok(dir)
        }
    }
}

/// Sanitized `<name>.md` path under the owner dir. Blocks path traversal.
fn resolve_path(base: &Path, owner: Option<&str>, name: &str) -> InfraResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("memory file name required".to_string());
    }
    if trimmed.contains("..") || trimmed.contains('/') || trimmed.contains('\\') {
        return Err(format!("invalid memory file name: {name}"));
    }
    let file = if trimmed.ends_with(".md") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.md")
    };
    Ok(owner_dir(base, owner)?
        .join(file)
        .to_string_lossy()
        .to_string())
}

fn serialize_entry(e: &MemoryEntry) -> String {
    let category = if e.category.trim().is_empty() {
        "reference"
    } else {
        e.category.trim()
    };
    format!(
        "---\nname: {}\ncategory: {}\ndescription: {}\n---\n{}",
        e.name.trim(),
        category,
        e.description.trim(),
        e.content
    )
}

/// Parse a file into an entry. Tolerates missing/partial frontmatter — a legacy file
/// without frontmatter becomes body-only with the filename as its name.
fn parse_entry(file_stem: &str, raw: &str) -> MemoryEntry {
    let mut category = String::from("reference");
    let mut name = file_stem.to_string();
    let mut description = String::new();
    let content;
    if let Some(body) = raw.strip_prefix("---\n") {
        if let Some(idx) = body.find("\n---\n") {
            let fm = &body[..idx];
            content = body[idx + "\n---\n".len()..].to_string();
            for line in fm.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let v = v.trim();
                    match k.trim() {
                        "name" if !v.is_empty() => name = v.to_string(),
                        "category" if !v.is_empty() => category = v.to_string(),
                        "description" => description = v.to_string(),
                        _ => {}
                    }
                }
            }
        } else {
            content = raw.to_string();
        }
    } else {
        content = raw.to_string();
    }
    MemoryEntry {
        category,
        name,
        description,
        content,
    }
}

/// Group entries by canonical category, one line each: `- [name] description`.
fn build_index(entries: &[MemoryEntry]) -> String {
    if entries.is_empty() {
        return String::new();
    }
    let mut out = String::from("# Operational Memory\n");
    let line = |e: &MemoryEntry, out: &mut String| {
        let d = e.description.trim();
        if d.is_empty() {
            out.push_str(&format!("- [{}]\n", e.name));
        } else {
            out.push_str(&format!("- [{}] {}\n", e.name, d));
        }
    };
    for cat in MEMORY_CATEGORIES {
        let group: Vec<&MemoryEntry> = entries.iter().filter(|e| e.category == cat).collect();
        if group.is_empty() {
            continue;
        }
        out.push_str(&format!("\n## {cat}\n"));
        for e in group {
            line(e, &mut out);
        }
    }
    // Legacy entries with a non-canonical category land under "other".
    // `idea` is excluded entirely — those are developer-facing improvement suggestions
    // (the AI logs them while operating), not operational knowledge to inject into the AI.
    let other: Vec<&MemoryEntry> = entries
        .iter()
        .filter(|e| !MEMORY_CATEGORIES.contains(&e.category.as_str()) && e.category != "idea")
        .collect();
    if !other.is_empty() {
        out.push_str("\n## other\n");
        for e in other {
            line(e, &mut out);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(cat: &str, name: &str, desc: &str, content: &str) -> MemoryEntry {
        MemoryEntry {
            category: cat.to_string(),
            name: name.to_string(),
            description: desc.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn serialize_parse_roundtrip() {
        let e = entry("feedback", "no-purple", "avoid violet default", "Use blue.\nMultiline body.");
        let raw = serialize_entry(&e);
        let parsed = parse_entry("no-purple", &raw);
        assert_eq!(parsed.category, "feedback");
        assert_eq!(parsed.name, "no-purple");
        assert_eq!(parsed.description, "avoid violet default");
        assert_eq!(parsed.content, "Use blue.\nMultiline body.");
    }

    #[test]
    fn parse_tolerates_colon_in_description() {
        let e = entry("reference", "server", "host: root@rust", "body");
        let parsed = parse_entry("server", &serialize_entry(&e));
        assert_eq!(parsed.description, "host: root@rust");
    }

    #[test]
    fn parse_legacy_without_frontmatter() {
        let parsed = parse_entry("legacy", "just a plain body, no frontmatter");
        assert_eq!(parsed.name, "legacy");
        assert_eq!(parsed.category, "reference");
        assert_eq!(parsed.content, "just a plain body, no frontmatter");
    }

    #[test]
    fn parse_body_containing_triple_dash() {
        let e = entry("project", "x", "d", "section one\n---\nsection two");
        let parsed = parse_entry("x", &serialize_entry(&e));
        assert_eq!(parsed.content, "section one\n---\nsection two");
    }

    #[test]
    fn index_groups_by_category_and_skips_empty() {
        let entries = vec![
            entry("user", "lang", "Korean polite", ""),
            entry("feedback", "no-bak", "avoid the word", ""),
        ];
        let idx = build_index(&entries);
        assert!(idx.contains("## user"));
        assert!(idx.contains("- [lang] Korean polite"));
        assert!(idx.contains("## feedback"));
        assert!(!idx.contains("## project"));
        assert!(!idx.contains("## reference"));
    }

    #[test]
    fn index_empty_when_no_entries() {
        assert_eq!(build_index(&[]), "");
    }

    #[test]
    fn owner_dir_admin_vs_hub() {
        let base = Path::new("data/memory");
        assert_eq!(owner_dir(base, None).unwrap(), PathBuf::from("data/memory"));
        assert_eq!(
            owner_dir(base, Some("admin")).unwrap(),
            PathBuf::from("data/memory")
        );
        assert_eq!(
            owner_dir(base, Some("hub:abc:sess1")).unwrap(),
            PathBuf::from("data/memory").join("hub").join("abc").join("sess1")
        );
        assert!(owner_dir(base, Some("hub:../etc:x")).is_err());
        assert!(owner_dir(base, Some("garbage")).is_err());
    }

    #[test]
    fn resolve_path_blocks_traversal() {
        let base = Path::new("data/memory");
        assert!(resolve_path(base, None, "../secret").is_err());
        assert!(resolve_path(base, None, "a/b").is_err());
        assert!(resolve_path(base, None, "  ").is_err());
        assert!(resolve_path(base, None, "note").is_ok());
    }
}
