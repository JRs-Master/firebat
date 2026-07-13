//! SkillFileManager — on-demand case manuals backed by `*/skills/` files.
//!
//! Each skill is one `<slug>.md` file with YAML frontmatter (name/kind/description) plus a
//! free-form markdown body (the manual: how to use tools/templates for a case). Mirrors
//! `MemoryFileManager` — the difference is *loading*: Memory is always-injected, a skill's
//! index is always-injected but its body is loaded on demand (`get_skill`).
//!
//! Storage (3 scopes, like modules system/ + user/):
//!   - system (shipped, repo): `system/skills/<slug>.md`  — read-only here, edited in repo/IDE.
//!   - user   (admin):         `user/skills/<slug>.md`
//!   - hub    (per session):   `user/hub/<inst>/<sid>/skills/<slug>.md`
//! `list`/`get_index` MERGE system ∪ owner (user overrides system on slug collision), so the
//! AI sees shipped + own skills. `save`/`delete` only touch the writable owner dir (never system).
//!
//! The index (always-injected `<SKILLS_AVAILABLE>`) is built dynamically from the files grouped
//! by `kind`, so add/delete/edit auto-reflects (no separate index to maintain).

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::ports::{IHubPort, IStoragePort, InfraResult};

/// Canonical kinds, in index display order. Unknown kinds land under "other" (extensible).
pub const SKILL_KINDS: [&str; 5] = ["design", "tool-usage", "procedure", "persona", "policy"];

/// One skill entry. `source` = system|user (derived from which dir; not in frontmatter).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SkillEntry {
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub content: String,
    /// "system" (shipped) or "user" (admin/hub authored). Derived on list/read.
    #[serde(default)]
    pub source: String,
    /// true when this user entry shadows a shipped system skill of the same slug —
    /// deleting the user file then restores the system base (Monaco "복원" button).
    #[serde(default)]
    pub overrides_system: bool,
}

/// One grep hit — identity + matching body lines (empty if matched on name/description only).
#[derive(Debug, Clone, serde::Serialize)]
pub struct SkillGrepHit {
    pub slug: String,
    pub name: String,
    pub kind: String,
    pub description: String,
    pub matches: Vec<String>,
}

pub struct SkillFileManager {
    storage: Arc<dyn IStoragePort>,
    /// Shipped skills (read-only via this manager).
    system_dir: PathBuf,
    /// Writable base — admin owner. Hub owners nest under `user/hub/<inst>/<sid>/skills`.
    user_dir: PathBuf,
    /// Hub instance lookup (port, not a manager) — lets this leaf resolve a hub owner's
    /// `allowed_skills` allowlist by itself, so EVERY consumer (FC/MCP tools, index injection,
    /// grpc panel, search catalog) gets the admin-shared overlay through the one list()/read()
    /// choke point. None (tests / pre-wiring) = no sharing.
    hub: RwLock<Option<Arc<dyn IHubPort>>>,
}

impl SkillFileManager {
    pub fn new(storage: Arc<dyn IStoragePort>) -> Self {
        Self {
            storage,
            system_dir: PathBuf::from("system/skills"),
            user_dir: PathBuf::from("user/skills"),
            hub: RwLock::new(None),
        }
    }

    /// main.rs wiring — hub port injection (construction order free).
    pub fn set_hub_port(&self, port: Arc<dyn IHubPort>) {
        if let Ok(mut g) = self.hub.write() {
            *g = Some(port);
        }
    }

    /// hub owner → admin 이 그 인스턴스에 공유한 스킬 slugs (`HubInstance.allowed_skills`).
    /// admin/None owner 또는 hub port 미배선 = 빈 배열 (공유 0 = safe-closed).
    pub async fn shared_admin_slugs(&self, owner: Option<&str>) -> Vec<String> {
        let Some(o) = owner else { return Vec::new() };
        let Some(inst) = crate::utils::hub_context::hub_instance_id_of_owner(o) else {
            return Vec::new();
        };
        let inst = inst.to_string();
        let port = self.hub.read().ok().and_then(|g| g.clone());
        let Some(port) = port else { return Vec::new() };
        match port.get_instance(&inst).await {
            Ok(Some(i)) => i.allowed_skills,
            _ => Vec::new(),
        }
    }

    /// slug 가 이 owner 의 공유 allowlist 에 있으면 admin(user/skills) 파일 경로.
    async fn shared_admin_path(&self, owner: Option<&str>, slug: &str) -> Option<String> {
        let stem = slug.trim().trim_end_matches(".md");
        let shared = self.shared_admin_slugs(owner).await;
        if !shared.iter().any(|s| s == stem) {
            return None;
        }
        resolve_path(&self.user_dir, slug).ok()
    }

    /// Create or overwrite a skill in the writable owner dir (never system). Same slug overwrites.
    pub async fn save(&self, owner: Option<&str>, entry: &SkillEntry) -> InfraResult<()> {
        let path = resolve_path(&owner_dir(&self.user_dir, owner)?, &entry.slug)?;
        self.storage.write(&path, &serialize_entry(entry)).await
    }

    /// Read a single skill (owner-writable first, then shipped system). Errors if missing in both.
    pub async fn read(&self, owner: Option<&str>, slug: &str) -> InfraResult<SkillEntry> {
        let stem = slug.trim().trim_end_matches(".md");
        let user_path = resolve_path(&owner_dir(&self.user_dir, owner)?, slug)?;
        let sys_path = resolve_path(&self.system_dir, slug)?;
        if let Ok(raw) = self.storage.read(&user_path).await {
            let mut e = parse_entry(stem, &raw, "user");
            // shared(admin allowlist) 베이스를 가리는 own 파일도 override — 삭제 = 베이스 복원.
            e.overrides_system = self.storage.read(&sys_path).await.is_ok()
                || self.shared_admin_path(owner, slug).await.is_some();
            return Ok(e);
        }
        // hub 공유 베이스 (admin 스킬 ∩ allowlist) — own 파일 없을 때 system 보다 우선
        // (admin 이 system slug 를 자기 버전으로 덮은 뒤 공유한 경우 그 버전이 보여야 함).
        if let Some(p) = self.shared_admin_path(owner, slug).await {
            if let Ok(raw) = self.storage.read(&p).await {
                return Ok(parse_entry(stem, &raw, "system"));
            }
        }
        let raw = self.storage.read(&sys_path).await?;
        Ok(parse_entry(stem, &raw, "system"))
    }

    /// Delete from the writable owner dir. System skills are repo-managed (error if only system).
    pub async fn delete(&self, owner: Option<&str>, slug: &str) -> InfraResult<()> {
        let path = resolve_path(&owner_dir(&self.user_dir, owner)?, slug)?;
        self.storage.delete(&path).await
    }

    /// All skills for an owner = system ∪ owner-writable (user overrides system on slug). Parsed.
    pub async fn list(&self, owner: Option<&str>) -> InfraResult<Vec<SkillEntry>> {
        // System (shipped) first, then overlay owner entries so user can override a shipped slug.
        let mut by_slug: std::collections::BTreeMap<String, SkillEntry> =
            std::collections::BTreeMap::new();
        for e in self.read_dir_entries(&self.system_dir, "system").await {
            by_slug.insert(e.slug.clone(), e);
        }
        // hub 공유 오버레이 — admin(user/skills) 스킬 중 인스턴스 allowlist(allowed_skills)에 든 것.
        // 위젯 시점에선 system 과 같은 read-only 베이스라 source="system" 으로 합류(삭제 차단·
        // override 뱃지·복원이 기존 system 규칙 그대로). admin/None owner = shared 빈 배열 → 무변.
        let shared = self.shared_admin_slugs(owner).await;
        if !shared.is_empty() {
            for mut e in self.read_dir_entries(&self.user_dir, "system").await {
                if !shared.iter().any(|s| s == &e.slug) {
                    continue;
                }
                e.overrides_system = false;
                by_slug.insert(e.slug.clone(), e);
            }
        }
        let owner_buf = owner_dir(&self.user_dir, owner)?;
        for mut e in self.read_dir_entries(&owner_buf, "user").await {
            // A user entry replacing a shipped slug = override (delete restores the base).
            e.overrides_system = by_slug.get(&e.slug).is_some_and(|prev| prev.source == "system");
            by_slug.insert(e.slug.clone(), e);
        }
        Ok(by_slug.into_values().collect())
    }

    /// Parse every `<slug>.md` in a dir. Missing dir => empty (fresh owner / no shipped skills).
    async fn read_dir_entries(&self, dir_buf: &Path, source: &str) -> Vec<SkillEntry> {
        let dir = dir_buf.to_string_lossy().to_string();
        let entries = self.storage.list_dir(&dir).await.unwrap_or_default();
        let mut out = Vec::new();
        for e in entries {
            if e.is_directory || !e.name.ends_with(".md") {
                continue;
            }
            let stem = e.name.trim_end_matches(".md").to_string();
            let file_path = dir_buf.join(&e.name).to_string_lossy().to_string();
            if let Ok(raw) = self.storage.read(&file_path).await {
                out.push(parse_entry(&stem, &raw, source));
            }
        }
        out
    }

    /// Dynamic index (the `<SKILLS_AVAILABLE>` payload) — one line per skill, grouped by kind.
    /// Built from the files on every call so it never goes stale. Empty when no skills.
    pub async fn get_index(&self, owner: Option<&str>) -> InfraResult<String> {
        let entries = self.list(owner).await?;
        Ok(build_index(&entries))
    }

    /// Substring search over skill bodies (+ name/description), case-insensitive. Returns matching
    /// skills with only the matching body lines.
    pub async fn grep(&self, owner: Option<&str>, query: &str) -> InfraResult<Vec<SkillGrepHit>> {
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
            hits.push(SkillGrepHit {
                slug: e.slug,
                name: e.name,
                kind: e.kind,
                description: e.description,
                matches: lines,
            });
        }
        Ok(hits)
    }
}

/// Resolve the dir for an owner. None/"admin" => base; "hub:<inst>:<sid>" => base/hub/<inst>/<sid>.
/// Free fn so path logic is unit-testable without a storage mock. (base = system or user root.)
fn owner_dir(base: &Path, owner: Option<&str>) -> InfraResult<PathBuf> {
    match owner {
        None | Some("") | Some("admin") => Ok(base.to_path_buf()),
        Some(o) => {
            let rest = o
                .strip_prefix("hub:")
                .ok_or_else(|| format!("invalid skill owner: {o}"))?;
            // user/skills + hub/<inst>/<sid> -> user/hub/<inst>/<sid>/skills (mirror nesting under
            // the user root, not skills/hub, so it sits with the rest of a hub session's data).
            let mut dir = base
                .parent()
                .map(|p| p.join("hub"))
                .unwrap_or_else(|| PathBuf::from("hub"));
            for part in rest.split(':') {
                if part.is_empty()
                    || part.contains("..")
                    || part.contains('/')
                    || part.contains('\\')
                {
                    return Err(format!("invalid skill owner segment: {o}"));
                }
                dir = dir.join(part);
            }
            Ok(dir.join("skills"))
        }
    }
}

/// Sanitized `<slug>.md` path under a dir. Blocks path traversal.
fn resolve_path(dir: &Path, slug: &str) -> InfraResult<String> {
    let trimmed = slug.trim();
    if trimmed.is_empty() {
        return Err("skill slug required".to_string());
    }
    if trimmed.contains("..") || trimmed.contains('/') || trimmed.contains('\\') {
        return Err(format!("invalid skill slug: {slug}"));
    }
    let file = if trimmed.ends_with(".md") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.md")
    };
    Ok(dir.join(file).to_string_lossy().to_string())
}

fn serialize_entry(e: &SkillEntry) -> String {
    let kind = if e.kind.trim().is_empty() {
        "procedure"
    } else {
        e.kind.trim()
    };
    format!(
        "---\nname: {}\nkind: {}\ndescription: {}\n---\n{}",
        e.name.trim(),
        kind,
        e.description.trim(),
        e.content
    )
}

/// Parse a file into a skill. Tolerates missing/partial frontmatter (body-only fallback).
fn parse_entry(file_stem: &str, raw: &str, source: &str) -> SkillEntry {
    let mut kind = String::from("procedure");
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
                        "kind" if !v.is_empty() => kind = v.to_string(),
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
    SkillEntry {
        slug: file_stem.to_string(),
        name,
        kind,
        description,
        content,
        source: source.to_string(),
        overrides_system: false,
    }
}

/// Group skills by kind, one line each: `- [name] (source) description`.
fn build_index(entries: &[SkillEntry]) -> String {
    if entries.is_empty() {
        return String::new();
    }
    // Header is load-bearing: descriptions must read as TRIGGERS, never as the manual.
    // A recipe-flavored description made even strong models skip get_skill ("이미 읽었다") and
    // render from the one-liner, missing every pitfall in the body (2026-07-08 태풍 실측).
    let mut out = String::from(
        "# Available Skills — index lines are TRIGGERS (when to use), NOT the manual.\n\
         When a skill matches the task, you MUST call get_skill(slug) and follow the full manual BEFORE acting — the body contains pitfalls and exact recipes that are never in this index.\n",
    );
    let line = |e: &SkillEntry, out: &mut String| {
        let d = e.description.trim();
        if d.is_empty() {
            out.push_str(&format!("- [{}]\n", e.slug));
        } else {
            out.push_str(&format!("- [{}] {}\n", e.slug, d));
        }
    };
    for kind in SKILL_KINDS {
        let group: Vec<&SkillEntry> = entries.iter().filter(|e| e.kind == kind).collect();
        if group.is_empty() {
            continue;
        }
        out.push_str(&format!("\n## {kind}\n"));
        for e in group {
            line(e, &mut out);
        }
    }
    let other: Vec<&SkillEntry> = entries
        .iter()
        .filter(|e| !SKILL_KINDS.contains(&e.kind.as_str()))
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

    fn entry(kind: &str, slug: &str, desc: &str, content: &str) -> SkillEntry {
        SkillEntry {
            slug: slug.to_string(),
            name: slug.to_string(),
            kind: kind.to_string(),
            description: desc.to_string(),
            content: content.to_string(),
            source: "user".to_string(),
            overrides_system: false,
        }
    }

    #[test]
    fn serialize_parse_roundtrip() {
        let e = entry("design", "bright-clean", "bright report theme", "Colors: blue.\nLayout: wide.");
        let raw = serialize_entry(&e);
        let parsed = parse_entry("bright-clean", &raw, "user");
        assert_eq!(parsed.kind, "design");
        assert_eq!(parsed.name, "bright-clean");
        assert_eq!(parsed.description, "bright report theme");
        assert_eq!(parsed.content, "Colors: blue.\nLayout: wide.");
        assert_eq!(parsed.source, "user");
    }

    #[test]
    fn parse_legacy_without_frontmatter() {
        let parsed = parse_entry("legacy", "just a body", "system");
        assert_eq!(parsed.name, "legacy");
        assert_eq!(parsed.kind, "procedure");
        assert_eq!(parsed.content, "just a body");
        assert_eq!(parsed.source, "system");
    }

    #[test]
    fn index_groups_by_kind_and_skips_empty() {
        let entries = vec![
            entry("design", "bright-clean", "report theme", ""),
            entry("tool-usage", "kr-stock-data", "fetch Korean stock data", ""),
        ];
        let idx = build_index(&entries);
        assert!(idx.contains("## design"));
        assert!(idx.contains("- [bright-clean] report theme"));
        assert!(idx.contains("## tool-usage"));
        assert!(!idx.contains("## procedure"));
    }

    #[test]
    fn index_empty_when_no_entries() {
        assert_eq!(build_index(&[]), "");
    }

    #[test]
    fn owner_dir_admin_vs_hub() {
        let user = Path::new("user/skills");
        assert_eq!(owner_dir(user, None).unwrap(), PathBuf::from("user/skills"));
        assert_eq!(owner_dir(user, Some("admin")).unwrap(), PathBuf::from("user/skills"));
        assert_eq!(
            owner_dir(user, Some("hub:abc:sess1")).unwrap(),
            PathBuf::from("user").join("hub").join("abc").join("sess1").join("skills")
        );
        assert!(owner_dir(user, Some("hub:../etc:x")).is_err());
        assert!(owner_dir(user, Some("garbage")).is_err());
    }

    #[test]
    fn resolve_path_blocks_traversal() {
        let dir = Path::new("user/skills");
        assert!(resolve_path(dir, "../secret").is_err());
        assert!(resolve_path(dir, "a/b").is_err());
        assert!(resolve_path(dir, "  ").is_err());
        assert!(resolve_path(dir, "note").is_ok());
    }
}
