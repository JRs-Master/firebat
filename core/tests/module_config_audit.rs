//! Module-config audit — a declaration that names nothing is a declaration that does nothing.
//!
//! A system module is a config file plus a script: `cacheInputs`, `grounding`, `requiresApproval`,
//! `timeseries`, `pageBinding`, `uiOnly`, `accounts` are all declarative, and the framework reads
//! them by exact key and exact value. Which means a typo is not an error — it is SILENCE. A
//! misspelled `cacheInput` never expands a key; a `requiresApproval` naming an action that was
//! renamed stops gating it; a `grounding` on a param the schema no longer declares stops guarding
//! it. Nothing fails, nothing logs, and the module keeps working in the one way nobody wanted.
//!
//! So this walks every module config and checks two things a human cannot hold in their head:
//!   1. every top-level key is one the framework actually reads (`_`-prefixed keys are the
//!      established comment convention and are skipped);
//!   2. every declaration that NAMES something — a param, an action, a file — names something
//!      that exists.
//!
//! Adding a declarative key means adding it here, which is the point: the list below is the
//! written-down answer to "what may a module declare?", a question that previously had no answer
//! outside MODULE_BIBLE prose.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Top-level keys the framework reads. Each was verified against a reader in core/ or infra/.
const KNOWN_KEYS: &[&str] = &[
    // identity / packaging
    "name", "type", "scope", "version", "runtime", "capability", "description", "providerType",
    "aliases", "tags", "packages", "hubSafe", "timeoutMs",
    // I/O contract
    "input", "output",
    // credentials
    "secrets", "accounts", "credentialScope", "accountFrom",
    // behaviour declarations
    "actionCatalog", "cacheInputs", "autoCacheWhole", "grounding", "requiresApproval", "uiOnly",
    "timeseries", "ws", "pageBinding", "recall", "schedules", "settings_fields", "editorSchema",
    "unsupportedActions", "notify", "notifyJob",
];

/// Field types the settings UI can render — READ OUT OF THE RENDERER, not listed here. A
/// hand-kept list is the same drift this whole file exists to catch (my first draft guessed, and
/// flagged five perfectly good fields). Returns `None` when the file cannot be found or the
/// derivation looks implausible, in which case the check is skipped rather than lying.
fn settings_field_types() -> Option<BTreeSet<String>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../app/admin/components/SystemModuleSettings.tsx");
    let src = fs::read_to_string(path).ok()?;
    let mut out: BTreeSet<String> = BTreeSet::new();
    let mut rest = src.as_str();
    // `type === 'x'` / `type !== 'x'` — the renderer's own dispatch.
    while let Some(i) = rest.find("type ==") {
        rest = &rest[i..];
        if let Some(q) = rest.find('\'') {
            if let Some(e) = rest[q + 1..].find('\'') {
                let t = &rest[q + 1..q + 1 + e];
                if !t.is_empty() && t.len() < 24 && t.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
                    out.insert(t.to_string());
                }
            }
        }
        rest = &rest[3..];
    }
    // The renderer's final `else` is a plain text input, so `text` is the documented default and
    // never appears in a `type ===` branch. Everything else must be a branch it knows: an
    // unrecognised type does not fail, it silently degrades to that same text box — which is how a
    // `structured-list` typo becomes an empty-looking field nobody can explain.
    out.insert("text".to_string());
    (out.len() >= 5).then_some(out)
}

fn modules_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../system/modules")
}

fn declared_actions(config: &Value) -> Option<BTreeSet<String>> {
    let e = config.pointer("/input/properties/action/enum")?.as_array()?;
    Some(e.iter().filter_map(|v| v.as_str()).map(str::to_string).collect())
}

fn declared_params(config: &Value) -> BTreeSet<String> {
    config
        .pointer("/input/properties")
        .and_then(|p| p.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}

/// Closest known key by a cheap common-prefix score — enough to turn "unknown key" into a
/// suggestion, which is the difference between a puzzle and a fix.
fn nearest(key: &str) -> &'static str {
    let lower = key.to_ascii_lowercase();
    KNOWN_KEYS
        .iter()
        .max_by_key(|k| {
            let kl = k.to_ascii_lowercase();
            kl.chars()
                .zip(lower.chars())
                .take_while(|(a, b)| a == b)
                .count()
        })
        .copied()
        .unwrap_or("input")
}

#[test]
fn every_module_declaration_names_something_that_exists() {
    let dir = modules_dir();
    let mut problems: Vec<String> = Vec::new();
    let mut audited = 0usize;
    let renderable = settings_field_types();

    let mut entries: Vec<_> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .filter_map(Result::ok)
        .map(|e| e.path())
        .collect();
    entries.sort();

    for module_dir in entries {
        let config_path = module_dir.join("config.json");
        if !config_path.is_file() {
            continue;
        }
        let name = module_dir.file_name().unwrap().to_string_lossy().to_string();
        let raw = fs::read_to_string(&config_path).expect("config readable");
        let config: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                problems.push(format!("{name}: config.json does not parse — {e}"));
                continue;
            }
        };
        audited += 1;
        let mut say = |m: String| problems.push(format!("{name}: {m}"));

        // 1. unknown top-level keys — a typo here is silence, not an error.
        if let Some(obj) = config.as_object() {
            for key in obj.keys() {
                if key.starts_with('_') || KNOWN_KEYS.contains(&key.as_str()) {
                    continue;
                }
                say(format!(
                    "unknown top-level key `{key}` — nothing reads it (did you mean `{}`? or add \
                     it to KNOWN_KEYS with its reader)",
                    nearest(key)
                ));
            }
        }

        let params = declared_params(&config);
        let actions = declared_actions(&config);
        let check_action = |decl: &str, action: &str, say: &mut dyn FnMut(String)| {
            if let Some(known) = &actions {
                if !known.contains(action) {
                    say(format!(
                        "{decl} names action `{action}`, which the input schema does not declare \
                         — this declaration is dead"
                    ));
                }
            }
        };

        // 2. declarations that name a PARAM
        for entry in config.get("cacheInputs").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
            let Some(spec) = entry.as_str() else { continue };
            let head = spec.split(".*.").next().unwrap_or(spec);
            if !params.contains(head) {
                say(format!("cacheInputs `{spec}` names param `{head}`, which is not declared"));
            }
        }
        // A grounded param may sit inside a declared object container (kiwoom's `params`,
        // korea-invest's `query`/`body`) — `check_grounding` walks nested args, so "is it a
        // top-level property" is the wrong question for a module that has a container.
        let has_container = config
            .pointer("/input/properties")
            .and_then(|p| p.as_object())
            .is_some_and(|o| {
                o.values().any(|v| {
                    matches!(v.get("type"), Some(Value::String(t)) if t == "object")
                })
            });
        if let Some(g) = config.get("grounding").and_then(|v| v.as_object()) {
            for key in g.keys() {
                if !params.contains(key) && !has_container {
                    say(format!("grounding names param `{key}`, which is not declared"));
                }
            }
        }
        if let Some(field) = config.get("accountFrom").and_then(|v| v.as_str()) {
            if !params.contains(field) {
                say(format!("accountFrom names field `{field}`, which is not declared"));
            }
        }

        // 3. declarations that name an ACTION
        for key in ["requiresApproval", "uiOnly", "unsupportedActions"] {
            for a in config.get(key).and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                if let Some(a) = a.as_str() {
                    check_action(key, a, &mut say);
                }
            }
        }
        for key in ["timeseries", "autoCacheWhole"] {
            if let Some(map) = config.get(key).and_then(|v| v.as_object()) {
                for a in map.keys() {
                    check_action(key, a, &mut say);
                }
            }
            // autoCacheWhole also takes the list form.
            if let Some(list) = config.get(key).and_then(|v| v.as_array()) {
                for a in list.iter().filter_map(|v| v.as_str()) {
                    check_action(key, a, &mut say);
                }
            }
        }
        if let Some(pb) = config.get("pageBinding").and_then(|v| v.as_object()) {
            if let Some(a) = pb.get("action").and_then(|v| v.as_str()) {
                check_action("pageBinding.action", a, &mut say);
            }
            for a in pb.get("actions").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                if let Some(a) = a.as_str() {
                    check_action("pageBinding.actions", a, &mut say);
                }
            }
        }
        if let Some(list) = config.pointer("/actionCatalog/actions").and_then(|v| v.as_array()) {
            for e in list {
                if let Some(id) = e.get("id").and_then(|v| v.as_str()) {
                    check_action("actionCatalog", id, &mut say);
                }
            }
        }

        // 4. declarations that name a FILE
        if let Some(file) = config.pointer("/actionCatalog/file").and_then(|v| v.as_str()) {
            if !module_dir.join(file).is_file() {
                say(format!("actionCatalog.file `{file}` does not exist"));
            }
        }
        for f in config.get("schedules").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
            if let Some(f) = f.as_str() {
                if !module_dir.join(f).is_file() {
                    say(format!("schedules names `{f}`, which does not exist"));
                }
            }
        }

        // 5. settings the UI has to render
        for (i, f) in config
            .get("settings_fields")
            .and_then(|v| v.as_array())
            .unwrap_or(&vec![])
            .iter()
            .enumerate()
        {
            let Some(o) = f.as_object() else {
                say(format!("settings_fields[{i}] is not an object"));
                continue;
            };
            if !o.contains_key("key") {
                say(format!("settings_fields[{i}] has no `key`"));
            }
            match (o.get("type").and_then(|v| v.as_str()), &renderable) {
                (Some(t), Some(known)) if !known.contains(t) => say(format!(
                    "settings_fields[{i}] type `{t}` is not one SystemModuleSettings renders                      ({})",
                    known.iter().cloned().collect::<Vec<_>>().join(", ")
                )),
                (None, _) => say(format!("settings_fields[{i}] has no `type`")),
                _ => {}
            }
        }
    }

    assert!(audited >= 30, "only {audited} module configs were audited — the path drifted");
    assert!(
        problems.is_empty(),
        "{} module declaration(s) name nothing that exists (a silent no-op, not an error):\n  {}",
        problems.len(),
        problems.join("\n  ")
    );
}
