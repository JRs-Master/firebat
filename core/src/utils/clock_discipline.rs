//! A test that fails when someone reads the host's clock.
//!
//! The rule — instants in UTC, a calendar resolved in the owner's zone, a venue's schedule in the
//! venue's zone — has been written down three times and broken three times, by me, in files I had
//! just finished editing. A note in a document does not survive the next session; a red test does.
//! So the rule lives here as something that breaks the build.
//!
//! What is banned is narrow and specific: asking the *process* what time it is locally. That is the
//! one question whose answer has nothing to do with the answer anybody wants, because a module is a
//! fresh process on a host whose zone is an accident of deployment. `Date.now()` and
//! `SystemTime::now()` are fine — an instant has no zone to get wrong.

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    /// The primitives that read the process's own zone, and what to use instead.
    const BANNED: &[(&str, &str)] = &[
        (".getHours()", "tz.parts(ms).hour, or tz.partsIn('<zone>', ms) for a venue's clock"),
        (".getMinutes()", "tz.parts(ms).minute"),
        (".getFullYear()", "tz.parts(ms).year / tz.todayYmd(ms)"),
        (".getMonth()", "tz.parts(ms).month"),
        (".getDate()", "tz.parts(ms).day"),
        ("time.localtime(", "tz.local(ms) — the owner's zone, not the host's"),
        ("time.mktime(", "tz.parse_day_ms(text) / tz.day_start_ms(ms)"),
        ("datetime.now()", "tz.now_ms() for an instant, tz.local() for a wall clock"),
        ("date.today()", "tz.today_ymd()"),
        ("Local::now()", "utils::timezone — resolve_tz(vault, owner) then render()"),
    ];

    /// Files allowed to say these words: the helpers themselves, and this test.
    fn is_the_helper(path: &Path) -> bool {
        let p = path.to_string_lossy().replace('\\', "/");
        p.ends_with("_runtime/tz.mjs")
            || p.ends_with("_runtime/tz.py")
            || p.ends_with("core/src/utils/timezone.rs")
            || p.ends_with("core/src/utils/clock_discipline.rs")
    }

    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                // Nothing we wrote lives in these, and their contents are not ours to fix.
                if matches!(name.as_str(), "node_modules" | ".git" | "target" | "__pycache__"
                    | ".next" | "venv" | ".venv" | "playwright_browsers") {
                    continue;
                }
                walk(&path, out);
            } else if matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("mjs") | Some("py") | Some("rs")
            ) {
                out.push(path);
            }
        }
    }

    /// The repo root, found by walking up from this crate rather than assumed.
    fn workspace_root() -> PathBuf {
        let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        while !dir.join("system").join("modules").is_dir() {
            if !dir.pop() {
                panic!("could not find the workspace root from CARGO_MANIFEST_DIR");
            }
        }
        dir
    }

    /// A `//` or `#` or `*` comment line, or a line that quotes the banned name inside a string.
    ///
    /// A comment explaining why something is banned has to be allowed to name it, or the
    /// explanation cannot be written where it belongs.
    fn is_prose(line: &str) -> bool {
        let t = line.trim_start();
        t.starts_with("//") || t.starts_with('#') || t.starts_with('*') || t.starts_with("/*")
            || t.starts_with("\"\"\"")
    }

    #[test]
    fn nothing_reads_the_hosts_clock() {
        let root = workspace_root();
        let mut files = Vec::new();
        walk(&root.join("system").join("modules"), &mut files);
        walk(&root.join("core").join("src"), &mut files);
        walk(&root.join("infra").join("src"), &mut files);

        let mut found: Vec<String> = Vec::new();
        for path in files {
            if is_the_helper(&path) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            for (n, line) in text.lines().enumerate() {
                if is_prose(line) {
                    continue;
                }
                for (needle, instead) in BANNED {
                    if line.contains(needle) {
                        let rel = path.strip_prefix(&root).unwrap_or(&path);
                        found.push(format!(
                            "{}:{} reads the host's clock via `{}` — use {}",
                            rel.to_string_lossy().replace('\\', "/"),
                            n + 1,
                            needle,
                            instead
                        ));
                    }
                }
            }
        }
        assert!(
            found.is_empty(),
            "the host's zone is an accident of deployment; a wall clock belongs to an owner or to \
             a venue.\n{}",
            found.join("\n")
        );
    }

    /// The ban is worth nothing if it cannot fire. A green test that could never go red is
    /// indistinguishable from no test, which is how a `cargo test` job watched nothing for months.
    #[test]
    fn the_ban_would_catch_a_violation() {
        let sample = "  const h = new Date().getHours();";
        assert!(!is_prose(sample));
        assert!(BANNED.iter().any(|(needle, _)| sample.contains(needle)));
        // And prose naming it is not a violation, so the reason can be written next to the rule.
        assert!(is_prose("  // never call .getHours() here"));
    }
}
