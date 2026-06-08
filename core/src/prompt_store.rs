//! Single-file system prompts — `system/prompts/{name}.md` (English-only, no language dimension).
//!
//! System prompts are **AI instructions**, not user-facing copy, so they are NOT in the i18n (lang-keyed)
//! store — they live here as a plain name→text cache. User-facing UI/error strings stay in i18n
//! (`language/{lang}.json`), and the admin's custom user-prompt carries the user's language separately.
//!
//! The ko/en prompt split was dropped 2026-06-08 — splitting AI-instruction prompts by language was
//! over-engineering (the AI follows English instructions and replies in the user's language anyway).

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

static PROMPTS: OnceLock<HashMap<String, String>> = OnceLock::new();

/// Load `{root}/*.md` into the cache once (key = file stem, e.g. "tool_system"). Call at startup after the
/// workspace root is known. Idempotent (OnceLock) — only the first call populates.
pub fn init(root: &Path) {
    PROMPTS.get_or_init(|| {
        let mut map = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                if let (Some(name), Ok(text)) = (
                    path.file_stem().and_then(|s| s.to_str()),
                    std::fs::read_to_string(&path),
                ) {
                    map.insert(name.to_string(), text);
                }
            }
        }
        tracing::info!("prompt_store: {} system prompt(s) loaded", map.len());
        map
    });
}

/// System prompt full text by name (e.g. "tool_system"). Empty string if missing (logged).
pub fn get(name: &str) -> String {
    match PROMPTS.get().and_then(|m| m.get(name)) {
        Some(t) => t.clone(),
        None => {
            tracing::warn!("prompt_store: missing system prompt '{}'", name);
            String::new()
        }
    }
}
