//! Module-config audit — a declaration that names nothing is a declaration that does nothing.
//!
//! A system module is a config file plus a script: `cacheInputs`, `needs`, `requiresApproval`,
//! `timeseries`, `pageBinding`, `uiOnly`, `accounts` are all declarative, and the framework reads
//! them by exact key and exact value. Which means a typo is not an error — it is SILENCE. A
//! misspelled `cacheInput` never expands a key; a `requiresApproval` naming an action that was
//! renamed stops gating it; a `needs` naming a module that does not exist blocks its action
//! forever. Nothing fails, nothing logs, and the module keeps working in the one way nobody wanted.
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
    "actionCatalog", "cacheInputs", "autoCacheWhole", "requiresApproval", "uiOnly",
    "timeseries", "ws", "pageBinding", "recall", "schedules", "schedulesFrom", "settings_fields",
    "editorSchema", "unsupportedActions", "notify", "notifyJob", "paramSource",
    // inbound webhook (reader: ModuleManager::webhook_decl + grpc ModuleService Webhook*)
    "webhook",
    // page -> document export offer (reader: /api/settings/modules/page-exports route -> Sidebar)
    "pageExport",
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
        // The same dual-home reader the server uses — an audit that read only the legacy list
        // went to zero the day the data moved onto the param specs.
        let cache_inputs: Vec<String> = firebat_core::utils::cache_inputs::declared(&config);
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
    for def in components().iter() {
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

        // 1b. Action-axis gates live on rows where rows exist (v2). The dual-home OR keeps a
        // half-migrated module safe, but one home is the standard — this line is what lets the
        // legacy reader retire without a hand-kept list of who migrated.
        let rows = catalog_rows_of(&module_dir, &config);
        if !rows.is_empty() {
            for legacy in ["requiresApproval", "uiOnly"] {
                if config.get(legacy).is_some() {
                    say(format!(
                        "`{legacy}` is a top-level list, but this module's catalog rows can carry \
                         it — declare `\"approval\": true` / `\"uiOnly\": true` on the rows instead"
                    ));
                }
            }
            // 원본 하나, 두 모양 (2026-08-25): enum 이 없으면 선언 모드 — 행이 집합의
            // 원본이고 런타임이 검증 enum 을 파생한다. enum 이 있으면 merge 모드 — enum 이
            // 집합의 원본이고 행은 그 안의 id 를 주석한다(파생 모듈이 게이트 하나를 행
            // 한 줄로 다는 자리). 그 모드에서 enum 밖의 행 id 는 아무것도 주석하지 못한다.
            if let Some(enum_ids) = declared_actions(&config) {
                for row in &rows {
                    if let Some(id) = row.get("id").and_then(|v| v.as_str()) {
                        if !enum_ids.contains(id) {
                            say(format!(
                                "row `{id}` is not in the action enum — with an enum present \
                                 (merge mode) the enum is the original of the action set and \
                                 this row annotates nothing"
                            ));
                        }
                    }
                }
            }
            // Same rule one level down: a row param whose prose is a verbatim copy of the input
            // schema's description is the drift seed the list form exists to prevent — declare
            // `params: [\"name\", …]` and the docs ride in from the schema.
            for row in &rows {
                let Some(id) = row.get("id").and_then(|v| v.as_str()) else { continue };
                let Some(pm) = row.get("params").and_then(|v| v.as_object()) else { continue };
                for (pn, pv) in pm {
                    let Some(prose) = pv.as_str().filter(|t| !t.trim().is_empty()) else {
                        continue;
                    };
                    let input_doc = config
                        .pointer(&format!("/input/properties/{pn}/description"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if !input_doc.trim().is_empty() && input_doc.trim() == prose.trim() {
                        say(format!(
                            "row `{id}` param `{pn}` repeats the input schema's description \
                             verbatim — use the list form (`params: [\"{pn}\", …]`); the schema \
                             prose rides in on its own"
                        ));
                    }
                }
            }
        }

        let params = declared_params(&config);
        // 원본 하나: 집합의 원본은 merge 모드(enum 잔존)에선 enum, 선언 모드에선 행이다.
        let actions = declared_actions(&config).or_else(|| {
            let row_ids: BTreeSet<String> = rows
                .iter()
                .filter_map(|r| r.get("id").and_then(|v| v.as_str()).map(str::to_string))
                .collect();
            if row_ids.is_empty() { None } else { Some(row_ids) }
        });
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
        // needs → 존재: a prerequisite a row names must be a module that exists, or the gate
        // refuses forever with a name nothing can satisfy.
        for (aid, mods) in
            firebat_core::utils::action_decl::action_gates(&catalog_rows_of(&module_dir, &config))
                .needs
        {
            for m in mods {
                // Two grains (424f3ba8): "module" or "module:action" — the same split
                // canon_run_key makes at the gate. Each half must name something real.
                let (module_half, action_half) = match m.split_once(':') {
                    Some((mm, aa)) => (mm, Some(aa)),
                    None => (m.as_str(), None),
                };
                let target_path = modules_dir().join(module_half).join("config.json");
                if !target_path.is_file() {
                    say(format!(
                        "action `{aid}` needs `{m}`, but `{module_half}` is not an installed                          module — the declaration would block the action forever"
                    ));
                    continue;
                }
                let Some(action) = action_half else { continue };
                let declares = fs::read_to_string(&target_path)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .map(|cfg| declared_actions(&cfg).is_none_or(|set| set.contains(action)))
                    .unwrap_or(false);
                if !declares {
                    say(format!(
                        "action `{aid}` needs `{m}`, but module `{module_half}` does not                          declare action `{action}` — the gate could never be satisfied"
                    ));
                }
            }
        }
        // collection → 존재: a param's `"collection"` names a settings field; a typo here is
        // not an error at runtime, it is a silently-dead semantic lane (부재는 동의가 아니다).
        let setting_keys: std::collections::BTreeSet<String> = config
            .get("settings_fields")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|f| f.get("key").and_then(|k| k.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        if let Some(props) = config.pointer("/input/properties").and_then(|p| p.as_object()) {
            for (pname, decl) in props {
                if let Some(coll) = decl.get("collection").and_then(|v| v.as_str()) {
                    if !setting_keys.contains(coll) {
                        say(format!(
                            "param `{pname}` declares collection `{coll}`, which is not a                              settings field — the semantic-match lane would be silently dead"
                        ));
                    }
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
//   system/components.json               the render catalog — where every component's FORM lives
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

/// The other direction: an action the module can RUN must be one discovery offers.
///
/// 원본 하나 (2026-08-25) made the forgotten-row version of this failure structurally impossible:
/// in declare mode the runnable set IS the rows (the validation enum derives from them), and in
/// merge mode discovery derives its entries from the enum itself — run and discovery read the same
/// original either way, so nothing runnable can be silently unpublished. The deliberate exceptions
/// are declarations now: `hidden: true` keeps a row runnable and unpublished, and `aliases` folds
/// a vendor word into a visible row's search text (binance `klines` uses both — a hidden row for
/// dispatch, an alias for search).
///
/// What is left to audit is the precondition dispatch fail-closes on: a module that declares a
/// catalog whose rows do not load has runnable actions nobody can run OR discover — every call is
/// refused (부재는 동의가 아니다). Both catalog shapes are audited here; the file shape's content
/// rules live in `every_action_catalog_file_names_runnable_actions` above.
#[test]
fn every_runnable_action_is_discoverable() {
    let mut problems = Vec::new();
    let mut audited = 0usize;
    for entry in fs::read_dir(modules_dir()).unwrap().filter_map(Result::ok) {
        let dir = entry.path();
        let Ok(raw) = fs::read_to_string(dir.join("config.json")) else { continue };
        let Ok(config) = serde_json::from_str::<Value>(&raw) else { continue };
        let name = dir.file_name().unwrap().to_string_lossy().to_string();

        if config.get("actionCatalog").is_none() {
            // No catalog: entries derive from the enum, or the module is a single action —
            // discovery and dispatch already share a source.
            continue;
        }
        audited += 1;
        let rows = catalog_rows_of(&dir, &config);
        if rows.is_empty() {
            problems.push(format!(
                "{name}: declares actionCatalog but zero rows load — dispatch fail-closes on \
                 this, so every action the module could run is refused and undiscoverable"
            ));
            continue;
        }
        // The inline shape has no other auditor; a row without an id registers nothing and
        // publishes nothing, silently.
        for (i, row) in rows.iter().enumerate() {
            if row.get("id").and_then(|v| v.as_str()).map_or(true, |s| s.trim().is_empty()) {
                problems.push(format!("{name}: catalog row {i} has no `id`"));
            }
        }
    }
    assert!(audited >= 8, "only {audited} catalogs audited — the path drifted");
    assert!(problems.is_empty(), "{} problem(s):\n  {}", problems.len(), problems.join("\n  "));
}

/// The last direction: a param the schema declares must be one the module's code reads.
///
/// The two checks above compare declarations with declarations. This one crosses to the
/// implementation, which is where the remaining silence lives: an input schema is a promise about
/// what the module accepts, and nothing has ever checked that the module does anything with it.
/// browser-scrape offered a screenshot, a viewport, a locale, custom headers and a JavaScript
/// toggle — eight options its 114-line implementation never mentions (measured 2026-08-16). A
/// model reading that schema is told about capabilities that do not exist, and no error will ever
/// say otherwise: the call succeeds and the option is dropped on the floor.
///
/// The test is a NAME search over every source file in the module directory plus the shared
/// `_runtime` helpers, so a param read through destructuring, `input["x"]`, or a helper still
/// counts. Only a name that appears NOWHERE is reported — 13 of 783 params when this was written,
/// and after the cacheKey exemption below, ten, all of them real.
///
/// `<base>CacheKey` / `Limit` / `Range` are exempt, derived from the module's own `cacheInputs`:
/// core expands them into the base param BEFORE the module runs, so the module is not supposed to
/// know their names.
#[test]
fn every_declared_param_is_read_by_the_module() {
    let runtime_src = {
        let mut s = String::new();
        if let Ok(rd) = fs::read_dir(modules_dir().join("_runtime")) {
            for e in rd.filter_map(Result::ok) {
                if let Ok(t) = fs::read_to_string(e.path()) {
                    s.push_str(&t);
                }
            }
        }
        s
    };

    let mut problems = Vec::new();
    let mut audited = 0usize;
    for entry in fs::read_dir(modules_dir()).unwrap().filter_map(Result::ok) {
        let dir = entry.path();
        let Ok(raw) = fs::read_to_string(dir.join("config.json")) else { continue };
        let Ok(config) = serde_json::from_str::<Value>(&raw) else { continue };
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let Some(props) = config.pointer("/input/properties").and_then(|v| v.as_object()) else {
            continue;
        };

        let mut src = String::new();
        if let Ok(rd) = fs::read_dir(&dir) {
            for e in rd.filter_map(Result::ok) {
                let p = e.path();
                let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
                if matches!(ext, "mjs" | "js" | "cjs" | "py" | "ts") {
                    if let Ok(t) = fs::read_to_string(&p) {
                        src.push_str(&t);
                    }
                }
            }
        }
        if src.is_empty() {
            continue; // nothing to read it in — a config-only entry, not this test's business
        }
        src.push_str(&runtime_src);
        audited += 1;

        // Names core fills in before the module sees them.
        let expanded: BTreeSet<String> = cache_key_siblings(&config);

        // Names the shared dialect reads INDIRECTLY: a `_call.by` axis is consumed as
        // `data[call.by]`, so the axis name never appears in code as a literal — the declaration
        // itself is the reader contract. Without this, enabling the audit flagged korea-invest's
        // eight axes as unread the first time it ever ran (2026-08-17).
        let by_axes: BTreeSet<String> = call_by_axes(&dir, &config);

        let unread: Vec<&str> = props
            .keys()
            .map(|s| s.as_str())
            .filter(|k| *k != "action")
            .filter(|k| !expanded.contains(*k))
            .filter(|k| !by_axes.contains(*k))
            .filter(|k| !mentions_word(&src, k))
            .collect();
        if !unread.is_empty() {
            problems.push(format!(
                "{name}: declares {} param(s) its code never mentions — {}. Implement them or drop \
                 the declaration; as written the schema promises what the module cannot do.",
                unread.len(),
                unread.iter().map(|s| format!("`{s}`")).collect::<Vec<_>>().join(", ")
            ));
        }
    }
    assert!(audited >= 25, "only {audited} modules audited — the path drifted");
    assert!(problems.is_empty(), "{} problem(s):\n  {}", problems.len(), problems.join("\n  "));
}

/// A module's catalog rows, file or inline — the same two documented shapes the loader reads.
fn catalog_rows_of(dir: &Path, config: &Value) -> Vec<Value> {
    if let Some(file) =
        config.get("actionCatalog").and_then(|c| c.get("file")).and_then(|v| v.as_str())
    {
        fs::read_to_string(dir.join(file))
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| {
                v.as_array().cloned().or_else(|| {
                    v.get("actions").and_then(|a| a.as_array()).cloned()
                })
            })
            .unwrap_or_default()
    } else {
        config
            .get("actionCatalog")
            .and_then(|v| {
                v.as_array().cloned().or_else(|| {
                    v.get("actions").and_then(|a| a.as_array()).cloned()
                })
            })
            .unwrap_or_default()
    }
}

/// Every `_call.by` axis name in a module's action rows (file or inline). These params are read
/// by the shared dialect (`data[call.by]`), never as a literal in module code.
fn call_by_axes(dir: &Path, config: &Value) -> BTreeSet<String> {
    catalog_rows_of(dir, config)
        .iter()
        .filter_map(|r| r.get("_call"))
        .filter_map(|c| c.get("by"))
        .filter_map(|b| b.as_str())
        .map(str::to_string)
        .collect()
}

/// `<param>CacheKey` / `Limit` / `Range` for every `cacheInputs` entry — core expands these into
/// the base param before the sandbox runs, so the module never names them.
fn cache_key_siblings(config: &Value) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for entry in firebat_core::utils::cache_inputs::declared(config) {
        let base = match firebat_core::utils::cache_inputs::parse_nested(&entry) {
            Some(spec) => spec.field,
            None => entry,
        };
        for suffix in ["CacheKey", "Limit", "Range"] {
            out.insert(format!("{base}{suffix}"));
        }
    }
    out
}

/// Whole-word search — `id` must not match `valid`, and a param is "read" wherever its name shows
/// up: destructured, indexed, or handed to a helper.
fn mentions_word(src: &str, word: &str) -> bool {
    let w: Vec<char> = word.chars().collect();
    let s: Vec<char> = src.chars().collect();
    let boundary = |c: char| !(c.is_alphanumeric() || c == '_');
    let mut i = 0;
    while i + w.len() <= s.len() {
        if s[i..i + w.len()] == w[..] {
            let before_ok = i == 0 || boundary(s[i - 1]);
            let after_ok = i + w.len() == s.len() || boundary(s[i + w.len()]);
            if before_ok && after_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// A module's cron files run UNATTENDED — the autotrade ones place real orders. Their steps are
/// PipelineStep values, so the executor's own parser is the only honest validator: if serde
/// cannot read a step here, the scheduler could not have run it there.

/// A module that hands its endpoints over hands over ALL of them.
///
/// Dispatch injects `_call` — the row for the action in flight — so a module never has to carry a
/// table of everyone else's endpoints. That only holds if the declaration is complete. Declare
/// `_call` on some actions and not others and the dialect has to keep both paths alive: the
/// injected row for the ones that have it, its own lookup for the rest. Which is worse than
/// either, because the half without a row fails only for the actions nobody exercised — silence
/// again, and this time shaped like a migration that finished.
///
/// Modules whose endpoints are a rule rather than a table declare no `_call` at all and are not
/// asked to invent one; dart resolves `/api/<name>.json` from the action name itself.
#[test]
fn a_module_that_declares_a_call_declares_it_for_every_runnable_action() {
    let mut problems = Vec::new();
    let (mut examined, mut with_calls) = (0usize, 0usize);
    for entry in fs::read_dir(modules_dir()).unwrap().filter_map(Result::ok) {
        let dir = entry.path();
        let Ok(raw) = fs::read_to_string(dir.join("config.json")) else { continue };
        let Ok(config) = serde_json::from_str::<Value>(&raw) else { continue };
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        examined += 1;
        // Read the rows the way the loader and dispatch do, not with a third copy of the logic.
        let rows = match config.pointer("/actionCatalog/file").and_then(|v| v.as_str()) {
            Some(file) => fs::read_to_string(dir.join(file))
                .ok()
                .and_then(|c| serde_json::from_str::<Value>(&c).ok())
                .and_then(|v| firebat_core::utils::action_decl::catalog_rows(&v)),
            None => config
                .get("actionCatalog")
                .and_then(firebat_core::utils::action_decl::catalog_rows),
        };
        let Some(rows) = rows else { continue };
        let calls = firebat_core::utils::action_decl::action_calls(&rows);
        if calls.is_empty() {
            continue;
        }
        with_calls += 1;
        let Some(runnable) = declared_actions(&config) else { continue };
        let mut missing: Vec<&String> = runnable.iter().filter(|a| !calls.contains_key(*a)).collect();
        if missing.is_empty() {
            continue;
        }
        let total = missing.len();
        missing.truncate(5);
        problems.push(format!(
            "{name}: declares `_call` for {} of {} runnable actions — {} without one ({}{})",
            calls.len(),
            runnable.len(),
            total,
            missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "),
            if total > 5 { ", …" } else { "" }
        ));
    }
    // A sweep that examined nothing reports the same "no problems" as one that examined
    // everything, so say which happened.
    assert!(examined >= 20, "only {examined} module configs examined — the path drifted");
    assert!(
        problems.is_empty(),
        "{} problem(s) across {with_calls} module(s) declaring `_call`:\n  {}",
        problems.len(),
        problems.join("\n  ")
    );
}

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
        // Which files can actually be reached: the static list, plus whatever the rows a module
        // derives from name. The old check ran the other way — every present file had to be
        // registered or excused in a hand-kept list — and that premise dissolved when schedules
        // began following the trades. A file nobody points at no longer implies a job somebody
        // believes in; it is a template waiting for a trade. What still bites is the reverse: a
        // row naming a loop that is not there registers nothing, silently.
        let mut reachable: BTreeSet<String> = registered.clone();
        if let Some(spec) = config.get("schedulesFrom") {
            let sget = |k: &str| spec.get(k).and_then(|v| v.as_str());
            if let (Some(setting), Some(field)) = (sget("setting"), sget("field")) {
                let rows = config
                    .get("settings_fields")
                    .and_then(|v| v.as_array())
                    .and_then(|fs| fs.iter().find(|f| f.get("key").and_then(|k| k.as_str()) == Some(setting)))
                    .and_then(|f| f.get("defaultValue"))
                    .and_then(|v| match v {
                        Value::Array(a) => Some(a.clone()),
                        Value::String(t) => serde_json::from_str::<Value>(t).ok().and_then(|p| p.as_array().cloned()),
                        _ => None,
                    })
                    .unwrap_or_default();
                for row in rows {
                    if let Some(f) = row.get(field).and_then(|v| v.as_str()) {
                        reachable.insert(f.to_string());
                    }
                }
            }
        }
        for f in &reachable {
            if !present.contains(f) {
                problems.push(format!(
                    "{name}: a schedule names `{f}`, which is not in the module directory — it                      registers nothing and says nothing"
                ));
            }
        }
        for f in &present {
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
    let path = repo_root().join("system/components.json");
    let raw = fs::read_to_string(&path).expect("the render catalog file exists on the pull channel");
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
