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

    /// 디렉토리형 스킬의 참조 파일 하나를 읽는다 — `<slug>/references/<name>.md`.
    /// owner-writable 우선, 없으면 shipped system.
    pub async fn read_reference(
        &self,
        owner: Option<&str>,
        slug: &str,
        name: &str,
    ) -> InfraResult<String> {
        let user_path = resolve_reference_path(&owner_dir(&self.user_dir, owner)?, slug, name)?;
        if let Ok(raw) = self.storage.read(&user_path).await {
            return Ok(raw);
        }
        let sys_path = resolve_reference_path(&self.system_dir, slug, name)?;
        self.storage.read(&sys_path).await.map_err(|_| {
            format!("skill reference not found: {slug}/{name}. Call get_skill(\"{slug}\") first — its body lists the available references.")
        })
    }

    /// 그 스킬이 가진 참조 파일 이름들(확장자 제외). 단일 파일 스킬이면 빈 벡터.
    async fn reference_names(&self, base: &Path, slug: &str) -> Vec<String> {
        let s = slug.trim().trim_end_matches(".md");
        if s.is_empty() || s.contains("..") || s.contains('/') || s.contains('\\') {
            return Vec::new();
        }
        let dir = base.join(s).join("references").to_string_lossy().to_string();
        let mut names: Vec<String> = self
            .storage
            .list_dir(&dir)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|e| !e.is_directory && e.name.ends_with(".md"))
            .map(|e| e.name.trim_end_matches(".md").to_string())
            .collect();
        names.sort();
        names
    }

    /// Read a single skill (owner-writable first, then shipped system). Errors if missing in both.
    /// 단일 파일(`<slug>.md`)과 디렉토리(`<slug>/SKILL.md`) 두 형태를 모두 받는다. 디렉토리형이면
    /// 본문 끝에 **가진 참조 목록을 자동으로 덧붙인다** — 저작자가 목록 갱신을 잊어도 모델이 뭘
    /// 더 읽을 수 있는지 항상 보이게(선언은 있는데 발견 표면이 비어 기능이 죽는 클래스 방지).
    pub async fn read(&self, owner: Option<&str>, slug: &str) -> InfraResult<SkillEntry> {
        let stem = slug.trim().trim_end_matches(".md");
        let user_base = owner_dir(&self.user_dir, owner)?;
        // 디렉토리형 우선 조회(같은 slug 가 둘 다 있으면 디렉토리형이 상세판이므로 그쪽).
        for (base, source) in [(&user_base, "user"), (&self.system_dir, "system")] {
            let p = resolve_dir_path(base, slug)?;
            if let Ok(raw) = self.storage.read(&p).await {
                let mut e = parse_entry(stem, &raw, source);
                let refs = self.reference_names(base, slug).await;
                if !refs.is_empty() {
                    e.content.push_str(&format!(
                        "\n\n---\n## 이 스킬의 참조 문서 (필요할 때만 읽기)\n\
                         `get_skill(slug: \"{stem}\", reference: \"<이름>\")` 로 한 편씩 불러온다. \
                         본문에 없는 상세는 여기 있다 — 추측하지 말고 읽을 것.\n{}\n",
                        refs.iter()
                            .map(|r| format!("- `{r}`"))
                            .collect::<Vec<_>>()
                            .join("\n")
                    ));
                }
                if source == "user" {
                    e.overrides_system = self
                        .storage
                        .read(&resolve_dir_path(&self.system_dir, slug)?)
                        .await
                        .is_ok()
                        || self.storage.read(&resolve_path(&self.system_dir, slug)?).await.is_ok();
                }
                return Ok(e);
            }
        }
        let user_path = resolve_path(&user_base, slug)?;
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
        // A missing slug used to surface as the storage adapter's raw error ("read 실패
        // (system/skills/math.md): No such file or directory") — an OS detail where the model
        // needs its next move (measured 2026-08-09: a guessed 'math' slug). Name the refusal,
        // show what actually exists, and point at the discovery surface.
        let raw = match self.storage.read(&sys_path).await {
            Ok(r) => r,
            Err(_) => {
                let slugs: Vec<String> = self
                    .list(owner)
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .map(|e| e.slug)
                    .take(20)
                    .collect();
                let listing = if slugs.is_empty() {
                    String::new()
                } else {
                    format!(" Existing slugs: {}.", slugs.join(", "))
                };
                return Err(format!(
                    "skill '{stem}' does not exist — do not invent slugs.{listing} \
                     Or find one with search_skills(query)."
                ));
            }
        };
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
            // 디렉토리형 스킬 — `<slug>/SKILL.md`. 색인에 안 실으면 존재 자체가 안 보인다.
            if e.is_directory {
                let p = dir_buf.join(&e.name).join("SKILL.md").to_string_lossy().to_string();
                if let Ok(raw) = self.storage.read(&p).await {
                    out.push(parse_entry(&e.name, &raw, source));
                }
                continue;
            }
            if !e.name.ends_with(".md") {
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
    // Same grammar as every other owned store — see `core::utils::owner`. The nesting differs:
    // a non-admin owner sits with the rest of that owner's data (`user/hub/<inst>/<sid>/skills`)
    // rather than under the skills root, so one owner's things stay in one place.
    let segments = crate::utils::owner::path_segments(owner)?;
    if segments.is_empty() {
        return Ok(base.to_path_buf());
    }
    let leaf = base
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "skills".to_string());
    let mut dir = base.parent().map(Path::to_path_buf).unwrap_or_default();
    for part in segments {
        dir = dir.join(part);
    }
    Ok(dir.join(leaf))
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

/// 디렉토리형 스킬의 본문 경로 — `<dir>/<slug>/SKILL.md`.
/// 단일 파일(`<slug>.md`)로 담기엔 큰 매뉴얼(거대 API 치트시트 등)을 색인 + 온디맨드 참조로
/// 쪼개기 위한 형태. 색인만 get_skill 로 오고 상세는 필요할 때 reference 로 따로 읽는다 —
/// 스킬 **안쪽에도** progressive disclosure 를 적용하는 것(도구·컴포넌트엔 이미 적용돼 있다).
fn resolve_dir_path(dir: &Path, slug: &str) -> InfraResult<String> {
    let trimmed = slug.trim().trim_end_matches(".md");
    if trimmed.is_empty() {
        return Err("skill slug required".to_string());
    }
    if trimmed.contains("..") || trimmed.contains('/') || trimmed.contains('\\') {
        return Err(format!("invalid skill slug: {slug}"));
    }
    Ok(dir.join(trimmed).join("SKILL.md").to_string_lossy().to_string())
}

/// 참조 파일 경로 — `<dir>/<slug>/references/<name>.md`. slug·name 둘 다 탈출 차단.
fn resolve_reference_path(dir: &Path, slug: &str, name: &str) -> InfraResult<String> {
    let s = slug.trim().trim_end_matches(".md");
    let n = name.trim().trim_end_matches(".md");
    if s.is_empty() || n.is_empty() {
        return Err("skill slug and reference name required".to_string());
    }
    for seg in [s, n] {
        if seg.contains("..") || seg.contains('/') || seg.contains('\\') {
            return Err(format!("invalid skill reference: {slug}/{name}"));
        }
    }
    Ok(dir
        .join(s)
        .join("references")
        .join(format!("{n}.md"))
        .to_string_lossy()
        .to_string())
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
    fn resolve_dir_and_reference_paths_block_traversal() {
        let dir = Path::new("user/skills");
        // 디렉토리형 본문 — `<slug>/SKILL.md`
        assert!(resolve_dir_path(dir, "big-api").unwrap().ends_with("SKILL.md"));
        assert!(resolve_dir_path(dir, "../secret").is_err());
        assert!(resolve_dir_path(dir, "a/b").is_err());
        // 참조 — slug·name 두 세그먼트 다 탈출 차단(둘 중 하나만 막으면 구멍).
        assert!(resolve_reference_path(dir, "big-api", "orders").unwrap().ends_with("orders.md"));
        assert!(resolve_reference_path(dir, "big-api", "../../etc/passwd").is_err());
        assert!(resolve_reference_path(dir, "..", "orders").is_err());
        assert!(resolve_reference_path(dir, "big-api", "").is_err());
        // ".md" 를 붙여 불러도 같은 경로(모델이 확장자를 붙이는 경우 흡수).
        assert_eq!(
            resolve_reference_path(dir, "big-api", "orders.md").unwrap(),
            resolve_reference_path(dir, "big-api", "orders").unwrap()
        );
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
