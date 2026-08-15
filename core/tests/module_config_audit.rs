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

/// The form a model is actually handed must carry everything the server accepts.
///
/// The existing form audit (`infra/tests/tool_registry_test.rs`) walks `tools.list()` — the static
/// registry — so the sysmod surface, which is derived per conversation, was never in scope. That
/// is exactly where the hole was: `statementsCacheKey` was declared in fa's input schema, absent
/// from its action catalog, and the published form intersects on catalog names, so the one surface
/// the model reads never named it. Nothing failed; a turn burned its budget guessing (2026-08-13,
/// turn 49).
///
/// So this builds the REAL surface from every module config and asserts the vocabulary is on it.
/// It fails if a future refactor goes back to publishing only what a hand-written catalog listed.
#[test]
fn the_published_form_names_every_key_the_expander_accepts() {
    use firebat_core::managers::ai::sysmod_surface::{build_action_form, typed_parameters};
    use firebat_core::utils::cache_inputs::{key_field, limit_field, parse_nested, range_field};

    let mut problems = Vec::new();
    let mut audited = 0usize;
    for entry in fs::read_dir(modules_dir()).unwrap().filter_map(Result::ok) {
        let dir = entry.path();
        let Ok(raw) = fs::read_to_string(dir.join("config.json")) else { continue };
        let Ok(config) = serde_json::from_str::<Value>(&raw) else { continue };
        let cache_inputs: Vec<String> = config
            .get("cacheInputs")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        if cache_inputs.is_empty() {
            continue;
        }
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let form = build_action_form(&config);
        // Every action this module declares — the form is published per discovered action, so an
        // action that takes the param must show its siblings.
        let actions: Vec<String> = declared_actions(&config)
            .map(|s| s.into_iter().collect())
            .unwrap_or_else(|| vec![String::new()]);
        for action in actions {
            let Some(published) = typed_parameters(&form, std::slice::from_ref(&action)) else {
                continue; // nothing discovered for this action — the thin form stands
            };
            let Some(props) = published.get("properties").and_then(|p| p.as_object()) else {
                continue;
            };
            audited += 1;
            for spec in &cache_inputs {
                match parse_nested(spec) {
                    None => {
                        if !props.contains_key(spec) {
                            continue; // this action does not take the param
                        }
                        for want in
                            [key_field(spec), limit_field(spec), range_field(spec)]
                        {
                            if !props.contains_key(&want) {
                                problems.push(format!(
                                    "{name}/{action}: form publishes `{spec}` but not `{want}` — \
                                     the server accepts it, the model cannot see it"
                                ));
                            }
                        }
                    }
                    Some(nested) => {
                        let Some(item) = props
                            .get(&nested.list)
                            .and_then(|l| l.get("items"))
                            .and_then(|i| i.get("properties"))
                            .and_then(|p| p.as_object())
                        else {
                            continue;
                        };
                        if !item.contains_key(&nested.field) {
                            continue;
                        }
                        for want in [
                            key_field(&nested.field),
                            limit_field(&nested.field),
                            range_field(&nested.field),
                        ] {
                            if !item.contains_key(&want) {
                                problems.push(format!(
                                    "{name}/{action}: `{}` items publish `{}` but not `{want}`",
                                    nested.list, nested.field
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    assert!(audited >= 5, "only {audited} forms audited — the derivation drifted");
    assert!(problems.is_empty(), "{} problem(s):\n  {}", problems.len(), problems.join("\n  "));
}

/// The render half of the same rule: `render_exec` resolves `dataCacheKey` / `dataLimit` /
/// `dataRange` generically — "no per-component branching" — on any component that reads
/// `props.data`. Of 44 components exactly one named the key (by hand), and two components that
/// take `data` did not, so the model's only route to the vocabulary was prose. Published from the
/// catalog now; this proves the publishing stayed wired.
#[test]
fn a_component_that_takes_data_publishes_the_injection_vocabulary() {
    use firebat_core::managers::ai::component_registry::{components, published_props_schema};
    let mut problems = Vec::new();
    let mut audited = 0usize;
    // Anchors: real catalog entries whose rows a model will want to hand over. Named here rather
    // than re-derived, so this test disagrees with the derivation instead of copying it.
    let anchors = [
        ("stock_chart", "data"),
        ("table", "rows"),
        ("timeline", "items"),
        ("key_value", "items"),
        ("live_stock_chart", "data"),
    ];
    for def in components() {
        let published = published_props_schema(def);
        let Some(props) = published.get("properties").and_then(|p| p.as_object()) else {
            continue;
        };
        for (name, prop) in anchors.iter().filter(|(n, _)| *n == def.name) {
            audited += 1;
            for suffix in ["CacheKey", "Limit", "Range"] {
                let want = format!("{prop}{suffix}");
                if !props.contains_key(&want) {
                    problems.push(format!(
                        "{name}: `{prop}` holds rows but the published schema does not name \
                         `{want}` — the server accepts it, the model cannot see it"
                    ));
                }
            }
        }
        // Whatever the derivation includes, it must be complete: a key without its window is a
        // half-published vocabulary.
        for key in props.keys().filter(|k| k.ends_with("CacheKey")) {
            let prop = key.trim_end_matches("CacheKey");
            for suffix in ["Limit", "Range"] {
                if !props.contains_key(&format!("{prop}{suffix}")) {
                    problems.push(format!("{}: `{key}` published without `{prop}{suffix}`", def.name));
                }
            }
        }
        // A rows-are-arrays prop needs the projection vocabulary or the key is unusable.
        if def.name == "table" && !props.contains_key("rowsColumns") {
            problems.push("table: `rows` holds arrays but `rowsColumns` is not published — a \
                           cached object record cannot become a row without it"
                .to_string());
        }
    }
    assert_eq!(audited, anchors.len(), "an anchor component vanished from the catalog");
    assert!(problems.is_empty(), "{} problem(s):\n  {}", problems.len(), problems.join("\n  "));
}

/// What the framework INJECTS, the schema must declare.
///
/// The mirror of the form audit above: there the framework accepts a key nobody declared, here it
/// *writes* one. `ModuleManager::run` inserts `account` into the input of every module that
/// declares `accounts`, before validation — so a module with `additionalProperties: false` that
/// does not declare `account` fails every account-resolved call, with an error about a key the
/// caller never sent. `mock` / `accountNo` / `market` guard themselves (they are injected only
/// where the schema declares them, by design); `account` does not, which is why it needs a net.
#[test]
fn a_module_that_declares_accounts_declares_the_key_the_framework_injects() {
    let mut problems = Vec::new();
    let mut audited = 0usize;
    for entry in fs::read_dir(modules_dir()).unwrap().filter_map(Result::ok) {
        let dir = entry.path();
        let Ok(raw) = fs::read_to_string(dir.join("config.json")) else { continue };
        let Ok(config) = serde_json::from_str::<Value>(&raw) else { continue };
        if config.get("accounts").is_none() {
            continue;
        }
        audited += 1;
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        if !declared_params(&config).contains("account") {
            let strict = config.pointer("/input/additionalProperties") == Some(&Value::Bool(false));
            problems.push(format!(
                "{name}: declares `accounts` but its input schema has no `account` — the \
                 framework injects it before validation{}",
                if strict {
                    ", and additionalProperties:false means every resolved call is refused"
                } else {
                    " and the model has no form to choose an account with"
                }
            ));
        }
    }
    assert!(audited >= 3, "only {audited} account modules audited — the path drifted");
    assert!(problems.is_empty(), "{} problem(s):\n  {}", problems.len(), problems.join("\n  "));
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
            // The `<param>CacheKey` sibling is framework convention, so a module need not declare
            // it at all — but one that DOES must not declare it narrower than the framework
            // accepts, or the published form tells the model less than the server will take. fa
            // declared it `string|null` on the day list-of-keys shipped; a model reading that form
            // would go on hand-joining keys into one string, which is the dialect this replaced.
            let field = spec.split(".*.").last().unwrap_or(spec).to_string() + "CacheKey";
            if let Some(decl) = config.pointer(&format!("/input/properties/{field}")) {
                let types: Vec<&str> = match decl.get("type") {
                    Some(Value::String(t)) => vec![t.as_str()],
                    Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str()).collect(),
                    _ => vec![],
                };
                if !types.is_empty() && !types.contains(&"array") {
                    say(format!(
                        "`{field}` is declared {types:?} but the expander also accepts a LIST of \
                         keys (rows concatenated) — add \"array\" so the published form says so"
                    ));
                }
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

// ── The rest of the authored declaration surfaces ─────────────────────────────────────────────
// Derived from the code rather than remembered: every declaration file core/ or infra/ reads
// (include_str! or by path) that a HUMAN OR MODEL authors, as opposed to runtime state the system
// writes for itself. config.json is audited above; these are the others.
//
//   system/modules/*/actions.json        the big brokers' action catalog (actionCatalog.file)
//   system/modules/*/cron-*.json         cron jobs a module registers when enabled
//   core/src/managers/ai/components.json the render catalog — where every component's FORM lives
//   language/{ko,en}.json                every user-visible string
//
// Runtime state (cron-jobs.json, auth.json, plan-store.json, pending-tools.json, mcp-servers.json,
// *.meta.json) is deliberately out of scope: nobody authors it, so there is no declaration to be
// wrong about.

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Every module declares `tags` — the words a question arrives in.
///
/// `tags` feeds the OOV gate, a string-membership test that runs BEFORE the embedding ranker: a
/// token in no module's vocabulary is dropped from the query outright. Action ids are English and
/// questions are Korean, so without tags a module is reachable only by whatever Korean happens to
/// sit in an action description. Measured 2026-08-14: kakao-map had three routing actions and no
/// tags, and "길찾기" — the word for exactly that — was dropped before ranking. Nine modules were
/// in that state, dart with 82 actions among them.
///
/// Since 2026-08-15 tags ARE part of the per-row semantic text — gate and ranker read one
/// document — so a tag is no longer free: a generic word like `조회` now pulls every action of
/// that module toward every query containing it. Aliases and capability words, not filler. There
/// is still no reason for a module to have none.
#[test]
fn every_module_declares_the_words_its_questions_arrive_in() {
    let mut missing = Vec::new();
    for entry in fs::read_dir(modules_dir()).unwrap().filter_map(Result::ok) {
        let dir = entry.path();
        let Ok(raw) = fs::read_to_string(dir.join("config.json")) else { continue };
        let Ok(config) = serde_json::from_str::<Value>(&raw) else { continue };
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let n = config
            .get("tags")
            .and_then(|t| t.as_array())
            .map(|a| a.iter().filter(|t| t.as_str().is_some_and(|s| !s.trim().is_empty())).count())
            .unwrap_or(0);
        if n == 0 {
            missing.push(name);
        }
    }
    assert!(
        missing.is_empty(),
        "these modules declare no `tags`, so a question worded in Korean loses those words at the \
         OOV gate before any ranking happens: {missing:?}"
    );
}

/// A catalog file's entries must name actions the module can actually run — the inline form of
/// this is checked above, and the file form is where the big brokers live (200+ actions each),
/// which is exactly where nobody would notice a stale id.
#[test]
fn every_action_catalog_file_names_runnable_actions() {
    let mut problems = Vec::new();
    let mut audited = 0usize;
    for entry in fs::read_dir(modules_dir()).unwrap().filter_map(Result::ok) {
        let dir = entry.path();
        let Ok(raw) = fs::read_to_string(dir.join("config.json")) else { continue };
        let Ok(config) = serde_json::from_str::<Value>(&raw) else { continue };
        let Some(file) = config.pointer("/actionCatalog/file").and_then(|v| v.as_str()) else {
            continue;
        };
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let Ok(craw) = fs::read_to_string(dir.join(file)) else { continue };
        let catalog: Value = match serde_json::from_str(&craw) {
            Ok(v) => v,
            Err(e) => {
                problems.push(format!("{name}/{file}: does not parse — {e}"));
                continue;
            }
        };
        audited += 1;
        // Read it the way the LOADER reads it. This audit used to accept both shapes through its
        // own inline logic while the loader's file branch parsed a bare list only — so tago's
        // documented `{"actions": [...]}` passed CI and yielded zero actions in production
        // (2026-08-14). A test more permissive than the code it guards is not a guard.
        let list = match firebat_core::managers::ai::action_catalog::catalog_rows(&catalog) {
            Some(l) => l,
            None => {
                problems.push(format!(
                    "{name}/{file}: holds neither a list nor an `actions` list — the loader reads \
                     zero actions from it and the module falls back to enum-derived entries"
                ));
                continue;
            }
        };
        if list.is_empty() {
            problems.push(format!(
                "{name}/{file}: declares a catalog that yields no actions — the module is \
                 discoverable only through the thin enum fallback"
            ));
            continue;
        }
        let known = declared_actions(&config);
        let mut missing = 0usize;
        for e in &list {
            let Some(id) = e.get("id").and_then(|v| v.as_str()) else {
                problems.push(format!("{name}/{file}: an entry has no `id`"));
                continue;
            };
            if let Some(known) = &known {
                if !known.contains(id) {
                    missing += 1;
                    if missing <= 5 {
                        problems.push(format!(
                            "{name}/{file}: catalog names `{id}`, which the input schema does not \
                             declare — searchable but not callable"
                        ));
                    }
                }
            }
        }
        if missing > 5 {
            problems.push(format!("{name}/{file}: and {} more unrunnable ids", missing - 5));
        }
    }
    assert!(audited >= 2, "no catalog files audited ({audited}) — the path drifted");
    assert!(problems.is_empty(), "{} problem(s):\n  {}", problems.len(), problems.join("\n  "));
}

/// A module's cron files run UNATTENDED — the autotrade ones place real orders. Their steps are
/// PipelineStep values, so the executor's own parser is the only honest validator: if serde
/// cannot read a step here, the scheduler could not have run it there.
/// Cron declarations that exist, are tested, and deliberately do NOT register yet. Stock trading
/// is not switched on — only the crypto loop runs live (CLAUDE.md tracker), so these four market
/// loops and two discovery jobs sit ready instead of firing at an account nobody armed.
const DORMANT_CRONS: &[&str] = &[
    "autotrade/cron-kiwoom-kr.json",
    "autotrade/cron-kiwoom-us.json",
    "autotrade/cron-kis-kr.json",
    "autotrade/cron-kis-us.json",
    "autotrade/cron-kiwoom-universe.json",
    "autotrade/cron-kiwoom-screen.json",
];

#[test]
fn every_declared_cron_job_parses_as_the_pipeline_the_scheduler_runs() {
    use firebat_core::managers::task::PipelineStep;
    let mut problems = Vec::new();
    let mut audited = 0usize;
    for entry in fs::read_dir(modules_dir()).unwrap().filter_map(Result::ok) {
        let dir = entry.path();
        let Ok(raw) = fs::read_to_string(dir.join("config.json")) else { continue };
        let Ok(config) = serde_json::from_str::<Value>(&raw) else { continue };
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let registered: BTreeSet<String> = config
            .get("schedules")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str()).map(str::to_string).collect())
            .unwrap_or_default();
        let mut present: Vec<String> = fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("cron-") && n.ends_with(".json"))
            .collect();
        present.sort();
        for f in &present {
            // A cron file the module does not list in `schedules` never registers. That can be
            // deliberate (a market not switched on yet) — but it must be SAID, or a job everyone
            // believes is running is a file nobody reads.
            if !registered.contains(f) && !DORMANT_CRONS.contains(&format!("{name}/{f}").as_str()) {
                problems.push(format!(
                    "{name}/{f}: present but not in `schedules` — it never registers. Add it, or                      list it in DORMANT_CRONS with the reason it is waiting"
                ));
            }
            let Ok(jraw) = fs::read_to_string(dir.join(f)) else { continue };
            let job: Value = match serde_json::from_str(&jraw) {
                Ok(v) => v,
                Err(e) => {
                    problems.push(format!("{name}/{f}: does not parse — {e}"));
                    continue;
                }
            };
            audited += 1;
            if job.get("title").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                problems.push(format!("{name}/{f}: no `title`"));
            }
            let has_trigger = ["cronTime", "runAt", "delaySec"]
                .iter()
                .any(|k| job.get(*k).is_some_and(|v| !v.is_null()));
            if !has_trigger {
                problems.push(format!("{name}/{f}: no trigger (cronTime / runAt / delaySec)"));
            }
            let mode = job.get("executionMode").and_then(|v| v.as_str()).unwrap_or("");
            match job.get("pipeline").and_then(|v| v.as_array()) {
                Some(steps) => {
                    if mode != "pipeline" {
                        problems.push(format!(
                            "{name}/{f}: carries a pipeline but executionMode is `{mode}`"
                        ));
                    }
                    for (i, step) in steps.iter().enumerate() {
                        if let Err(e) = serde_json::from_value::<PipelineStep>(step.clone()) {
                            problems.push(format!(
                                "{name}/{f}: step[{i}] is not a step the executor can run — {e}"
                            ));
                        }
                    }
                }
                None if mode == "pipeline" => {
                    problems.push(format!("{name}/{f}: executionMode=pipeline with no steps"))
                }
                None => {}
            }
        }
    }
    assert!(audited >= 9, "only {audited} cron declarations audited — the path drifted");
    assert!(problems.is_empty(), "{} problem(s):\n  {}", problems.len(), problems.join("\n  "));
}

/// The component catalog is where a fence block's FORM lives — `get_component_schema` hands one
/// over on request, and it is the only form the fence channel has. A component with no props
/// schema is a component the model must guess at.
#[test]
fn every_render_component_carries_a_props_form() {
    let path = repo_root().join("core/src/managers/ai/components.json");
    let raw = fs::read_to_string(&path).expect("the render catalog is baked into the binary");
    let catalog: Vec<Value> = serde_json::from_str(&raw).expect("catalog parses");
    let mut problems = Vec::new();
    for c in &catalog {
        let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("<unnamed>");
        for key in ["componentType", "description", "semanticText"] {
            if c.get(key).and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                problems.push(format!("{name}: `{key}` is empty — it is how the model FINDS this"));
            }
        }
        // An explicit empty `properties` IS an answer ("this component takes none" — divider).
        // A missing propsSchema is not: get_component_schema would have nothing to hand over.
        match c.get("propsSchema") {
            Some(s) if s.get("properties").and_then(|p| p.as_object()).is_some() => {}
            Some(_) => problems.push(format!("{name}: propsSchema has no `properties` object")),
            None => problems.push(format!("{name}: no propsSchema — nothing to answer with")),
        }
    }
    assert!(catalog.len() >= 20, "only {} components — the catalog drifted", catalog.len());
    assert!(problems.is_empty(), "{} problem(s):\n  {}", problems.len(), problems.join("\n  "));
}

/// Every user-visible string exists in both languages. A key present in one file and not the
/// other renders as the raw key to whoever picked the other language.
#[test]
fn the_two_language_files_declare_the_same_keys() {
    fn flatten(v: &Value, prefix: &str, out: &mut BTreeSet<String>) {
        match v {
            Value::Object(o) => {
                for (k, child) in o {
                    let p = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                    flatten(child, &p, out);
                }
            }
            _ => {
                out.insert(prefix.to_string());
            }
        }
    }
    let root = repo_root().join("language");
    let read = |name: &str| -> BTreeSet<String> {
        let raw = fs::read_to_string(root.join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
        let v: Value = serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{name}: {e}"));
        let mut out = BTreeSet::new();
        flatten(&v, "", &mut out);
        out
    };
    let ko = read("ko.json");
    let en = read("en.json");
    let only_ko: Vec<&String> = ko.difference(&en).collect();
    let only_en: Vec<&String> = en.difference(&ko).collect();
    assert!(ko.len() > 100, "only {} keys — the i18n files drifted", ko.len());
    assert!(
        only_ko.is_empty() && only_en.is_empty(),
        "language files disagree — {} ko-only, {} en-only:\n  ko-only: {:?}\n  en-only: {:?}",
        only_ko.len(),
        only_en.len(),
        only_ko.iter().take(12).collect::<Vec<_>>(),
        only_en.iter().take(12).collect::<Vec<_>>()
    );
}
