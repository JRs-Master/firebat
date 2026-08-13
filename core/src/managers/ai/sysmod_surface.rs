//! One derivation of the `sysmod_*` tool surface, for both transports.
//!
//! A system module reaches a model over two transports — the FC registry
//! (`dynamic_tools.rs`) and the MCP server (`infra/src/mcp_server.rs`) — and each used to derive
//! the same four things from `config.json` on its own: the tool name, the description (module
//! text + declared tags), the thin parameter schema (params hidden behind the discovery
//! procedure), whether the module really has an `action` selector, and the L1 grounding
//! declaration. Two derivations means every new gate had to be planted twice, and the measured
//! result was drift: the selector gate, the key canonicalisation and the discovery-gate notice
//! each shipped as two separate edits, and the two notices still disagree today.
//!
//! So the derivation lives here once and both transports consume it. This module is pure — config
//! in, surface out, no I/O, no manager handles — so it is testable without a running module tree
//! and cannot acquire a transport-specific branch by accident.
//!
//! Canonical variant = the FC path's, byte for byte (this extraction is a refactor, not a
//! behaviour change). Where the MCP path differs today the difference is recorded at the site so
//! the MCP wiring task can reconcile it deliberately:
//!
//! 1. **tool_name** — FC keeps the module name verbatim (`sysmod_kakao-map`); MCP replaces `-`
//!    with `_` (`sysmod_kakao_map`) and undoes that on dispatch.
//! 2. **description** — FC = module description + tags. MCP additionally prefixes
//!    `[시스템 모듈] ` and appends `capability:` and a required-secrets line
//!    (`build_sysmod_description`).
//! 3. **discovery-gate notice** — reconciled in wave 2. The gate is one store now
//!    (`utils::conversation_scope`: conversation scope, 30-minute sliding window) on both
//!    transports, so the notice states that window instead of the two texts it used to have
//!    ("THIS TURN" on FC, "in this session window" on MCP).
//! 4. **module set** — FC registers `list_system_modules()`, MCP `list_system()` (modules +
//!    services). That is the caller's loop, not this derivation.

use crate::utils::grounding::{parse_grounding, GroundedParam};

/// Everything needed to build the step-three form, kept small enough to hold for every module:
/// the declared property schemas, and which of them each action uses.
///
/// `per_action` is empty for a module whose catalog lives in a separate file (the big brokers) —
/// those fall back to the whole property set, which for them is a handful of envelope params.
#[derive(Debug, Clone, Default)]
pub struct ActionForm {
    pub props: serde_json::Map<String, serde_json::Value>,
    pub per_action: std::collections::HashMap<String, Vec<String>>,
    /// `cacheInputs` verbatim — plain param names and nested `"<list>.*.<field>"` paths alike.
    /// The key/window siblings are framework convention, so nobody declares them and the form
    /// has to derive them (see `cache_inputs::sibling_schemas`).
    pub cache_params: Vec<String>,
}

/// Everything a transport needs to expose one system module as one tool.
#[derive(Debug, Clone)]
pub struct SysmodSurface {
    /// Registered tool name (`sysmod_<module>`).
    pub tool_name: String,
    /// Module name as declared — what the dispatcher hands to `ModuleManager::run`.
    pub module: String,
    /// Tool description: what the module is (module selection = step 1 of the procedure) plus its
    /// declared `tags`.
    pub description: String,
    /// The thin parameter schema — see `thin_parameters`.
    pub thin_parameters: serde_json::Value,
    /// Whether the module's input declares an `action` selector, i.e. whether the discovery-first
    /// gate applies at all.
    pub has_action_selector: bool,
    /// L1 grounding requirements parsed from `config.grounding` (empty when undeclared).
    pub grounding: Vec<GroundedParam>,
    /// Material for the step-three form, once the conversation has discovered an action.
    pub form: ActionForm,
}

/// Reads the form material out of a module config: declared property schemas, plus the catalog's
/// per-action parameter names when they are inline.
pub fn build_action_form(config: &serde_json::Value) -> ActionForm {
    let props = config
        .get("input")
        .and_then(|i| i.get("properties"))
        .and_then(|p| p.as_object())
        .cloned()
        .unwrap_or_default();
    let mut per_action: std::collections::HashMap<String, Vec<String>> = Default::default();
    if let Some(list) = config
        .get("actionCatalog")
        .and_then(|c| c.get("actions"))
        .and_then(|a| a.as_array())
    {
        for entry in list {
            let (Some(id), Some(params)) = (
                entry.get("id").and_then(|v| v.as_str()),
                entry.get("params").and_then(|p| p.as_object()),
            ) else {
                continue;
            };
            per_action.insert(id.to_string(), params.keys().cloned().collect());
        }
    }
    ActionForm { props, per_action, cache_params: crate::utils::cache_inputs::declared(config) }
}

/// Adds the cache-key vocabulary to a published property set.
///
/// A declared `cacheInputs` param gets `<param>CacheKey` / `<param>Limit` / `<param>Range` beside
/// it; a nested `"<list>.*.<field>"` declaration gets them inside that list's item schema, where
/// the model actually writes them. An author who declared the sibling explicitly keeps their own
/// wording — this fills gaps, it does not overwrite declarations.
fn add_cache_siblings(
    out: &mut serde_json::Map<String, serde_json::Value>,
    declared_props: &serde_json::Map<String, serde_json::Value>,
    cache_params: &[String],
) {
    use crate::utils::cache_inputs::{parse_nested, sibling_schemas};
    for entry in cache_params {
        match parse_nested(entry) {
            None => {
                if !out.contains_key(entry) {
                    continue; // not part of this action's form
                }
                for (name, schema) in sibling_schemas(entry) {
                    let schema = declared_props.get(&name).cloned().unwrap_or(schema);
                    out.entry(name).or_insert(schema);
                }
            }
            Some(spec) => {
                let Some(list) = out.get_mut(&spec.list) else { continue };
                let Some(items) = list.get_mut("items") else { continue };
                let Some(props) = items.get_mut("properties").and_then(|p| p.as_object_mut())
                else {
                    continue;
                };
                if !props.contains_key(&spec.field) {
                    continue;
                }
                for (name, schema) in sibling_schemas(&spec.field) {
                    props.entry(name).or_insert(schema);
                }
            }
        }
    }
}

/// Thin tool parameters (Part 1-B): the full input schema is NOT exposed — the model must discover
/// params via search_module_actions → get_action_schema (the uniform 4-step procedure).
/// `additionalProperties:true` lets it pass the discovered flat params; module.rs still validates
/// against config.input. This forces procedure compliance (no direct-call shortcut) and shrinks the
/// tool-list prefix (cached; peak context ↓, 128K overflow ↓).
///
/// Constant across modules, so it is built from nothing: a per-module schema here would be the
/// direct-call shortcut this design removes.
pub fn thin_parameters() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": true,
        "description": "Parameters are not listed here. Discover them first: search_module_actions(query) to find the action, then get_action_schema(module, action) for exact params + call envelope; then call with those params at the top level (include \"action\" if the module uses one). Enforced: a multi-action call whose schema was not fetched via get_action_schema within the last 30 minutes in this conversation is rejected before dispatch — fetch schemas first, several in one round is fine, and a schema you keep using stays valid."
    })
}

/// The filled-in form for the actions this conversation has already discovered.
///
/// The standard procedure is **pick the tool → pick the action → supply the parameters**, and a
/// schema is the FORM you fill at each step. Steps one and two get their forms (the tool list, the
/// action catalog); step three got prose — `get_action_schema` returns per-action parameter
/// *descriptions*, while the tool's own `parameters` stayed thin forever, so the API contract never
/// learned the shape. The model rebuilt it from memory and serialized containers as strings
/// (measured 2026-08-12: same prompt and payload, thin schema → `sheets` arrives as a string twice,
/// typed schema → a real 40-row array). Withholding the form was never part of the procedure.
///
/// The typed form is derived, not newly declared: the parameter NAMES of an action come from the
/// action catalog, their TYPES from `config.input.properties` — the same schema validation already
/// enforces, so the tool contract and the validator cannot disagree. Modules with no catalog fall
/// back to the whole property set.
///
/// `required` stays `["action"]` and `additionalProperties` stays true: this form guides, it does
/// not narrow what may be sent (validation is still module.rs's job, against the real schema).
/// Returns `None` when nothing has been discovered — the thin form stands until the ladder is
/// walked, so the gate keeps its teeth.
pub fn typed_parameters(form: &ActionForm, actions: &[String]) -> Option<serde_json::Value> {
    if actions.is_empty() || form.props.is_empty() {
        return None;
    }
    let props = &form.props;

    // Names first: the action's own params when the catalog names them, else every declared
    // property (a derived-catalog module has no per-action list, and the whole set is honest).
    let mut names: Vec<String> = Vec::new();
    for action in actions {
        match form.per_action.get(action) {
            Some(list) => names.extend(list.iter().cloned()),
            None => names.extend(props.keys().cloned()),
        }
    }
    names.sort();
    names.dedup();

    let mut out = serde_json::Map::new();
    // The selector keeps its own declaration (enum included) — picking the action is still step 2.
    if let Some(action_prop) = props.get("action") {
        out.insert("action".to_string(), action_prop.clone());
    }
    for name in names {
        if name == "action" {
            continue;
        }
        if let Some(schema) = props.get(&name) {
            out.insert(name, schema.clone());
        }
    }
    if out.is_empty() {
        return None;
    }
    // The convention the expander reads, published where the model writes. Without this the
    // vocabulary lived only in prose and in error text, and a model holding the right key spent
    // seven rounds guessing its shape (2026-08-13, fa `ratios`).
    add_cache_siblings(&mut out, props, &form.cache_params);
    let discovered = actions.join(", ");
    Some(serde_json::json!({
        "type": "object",
        "additionalProperties": true,
        "required": ["action"],
        "properties": out,
        "description": format!(
            "Parameters below are the form for the action(s) whose schema this conversation \
             already fetched ({discovered}) — send them as declared, at the top level, with \
             \"action\". Any OTHER action of this module still needs get_action_schema first: a \
             multi-action call whose schema was not fetched within the last 30 minutes in this \
             conversation is rejected before dispatch."
        ),
    }))
}

/// Whether this module's input declares an `action` selector — the discovery gate's applicability
/// test.
///
/// A stray `action` arg on a selector-less module is not a multi-action call, however much it looks
/// like one: a single-action module (stock-lookup) is exempt by design, and its grounding hint even
/// says "call directly" — but the gate used to key on the CALL carrying an `action` arg, so a model
/// that volunteered `action:"lookup"` was rejected by the very procedure the hint told it to skip
/// (2026-08-12 실측). The judgment therefore reads the module, never the call.
pub fn declares_action_selector(config: &serde_json::Value) -> bool {
    config
        .get("input")
        .and_then(|i| i.get("properties"))
        .and_then(|p| p.get("action"))
        .is_some()
}

/// Derive the whole `sysmod_<name>` surface from a module's `config.json`.
///
/// `module_name` is the declared module name (`config.name`, falling back to the directory name —
/// what `ModuleManager` reports as `SystemEntry.name`), and it is what the handler will dispatch on.
pub fn build_surface(module_name: &str, config: &serde_json::Value) -> SysmodSurface {
    // Description base = the module's own `description`. `SystemEntry.description` is read from the
    // same field with the same empty-string fallback, so this matches the FC path byte for byte
    // while removing its dependency on a scanned entry.
    let base = config
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let description = crate::utils::module_tags::append_tags(base, module_name, config);

    SysmodSurface {
        tool_name: format!("sysmod_{module_name}"),
        module: module_name.to_string(),
        description,
        thin_parameters: thin_parameters(),
        has_action_selector: declares_action_selector(config),
        // L1 grounding — the config declaration mapped onto this tool. Both transports gate with
        // the same pure `check_grounding`, so they must also parse with the same reader.
        grounding: parse_grounding(config),
        form: build_action_form(config),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn multi_action_config() -> serde_json::Value {
        json!({
            "name": "kiwoom",
            "description": "키움증권 국내주식 시세·주문",
            "tags": ["주식", "시세"],
            "input": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["ka10099", "ka10081"] },
                    "params": { "type": "object" }
                }
            },
            "grounding": {
                "stk_cd": { "resolveHint": "resolve via ka10099 first.", "exemptActions": ["ka10100"] }
            }
        })
    }

    fn single_action_config() -> serde_json::Value {
        json!({
            "name": "stock-lookup",
            "description": "종목명 → 종목코드 조회",
            "input": {
                "type": "object",
                "properties": { "query": { "type": "string" } }
            }
        })
    }

    /// Step three finally gets a form — and only for what the ladder actually reached.
    /// Regression target 2026-08-12: with no declared shape the model serialized `sheets` as a
    /// string twice in a row; with one, it sent a 40-row array.
    #[test]
    fn the_form_appears_for_the_discovered_action_and_only_for_it() {
        let config = json!({
            "input": {
                "type": "object",
                "required": ["action"],
                "properties": {
                    "action": {"type": "string", "enum": ["read", "make_xlsx"]},
                    "sheets": {"type": ["array", "null"], "description": "the sheets"},
                    "path":   {"type": ["string", "null"], "description": "the document"}
                }
            },
            "actionCatalog": {"actions": [
                {"id": "make_xlsx", "params": {"sheets": "…", "title": "…"}},
                {"id": "read", "params": {"path": "…"}}
            ]}
        });
        let form = build_action_form(&config);
        let p = typed_parameters(&form, &["make_xlsx".to_string()]).expect("a discovered action");
        assert_eq!(p["properties"]["sheets"]["type"][0], "array", "the TYPE is what was missing");
        assert!(p["properties"].get("action").is_some(), "picking the action is still step two");
        assert!(p["properties"].get("path").is_none(), "another action's params stay out");
        assert!(
            p["properties"].get("title").is_none(),
            "a catalog name with no declared schema has no type to publish"
        );
        assert_eq!(p["additionalProperties"], true, "the form guides; it does not narrow");
        assert_eq!(p["required"], json!(["action"]));
        assert!(p["description"].as_str().unwrap().contains("make_xlsx"));
        // Nothing discovered → the thin form stands and the gate keeps its teeth.
        assert!(typed_parameters(&form, &[]).is_none());
    }

    /// A module whose catalog lives in a separate file has no per-action list — publishing the
    /// whole declared set is honest there, and for those modules it is a handful of envelope
    /// params, not hundreds.
    #[test]
    fn a_module_without_an_inline_catalog_publishes_its_declared_properties() {
        let config = json!({
            "input": {"type": "object", "properties": {
                "action": {"type": "string"},
                "params": {"type": "object"}
            }},
            "actionCatalog": {"file": "actions.json"}
        });
        let form = build_action_form(&config);
        assert!(form.per_action.is_empty());
        let p = typed_parameters(&form, &["ka10081".to_string()]).unwrap();
        assert_eq!(p["properties"]["params"]["type"], "object");
    }

    #[test]
    fn multi_action_module_is_a_selector_and_hides_its_params() {
        let s = build_surface("kiwoom", &multi_action_config());
        assert_eq!(s.tool_name, "sysmod_kiwoom");
        assert_eq!(s.module, "kiwoom");
        assert!(s.has_action_selector);
        // Thin schema: the module's real input properties (params, action enum, …) must NOT leak —
        // discovery is the only route to them. Only `action` is named, and only in the prose that
        // tells the model where to put it.
        assert_eq!(s.thin_parameters["type"], "object");
        assert_eq!(s.thin_parameters["additionalProperties"], true);
        assert!(
            s.thin_parameters.get("properties").is_none(),
            "a thin tool declares no properties — listing them is the direct-call shortcut"
        );
        let desc = s.thin_parameters["description"].as_str().unwrap();
        assert!(desc.contains("get_action_schema"));
        assert!(desc.contains("\"action\""));
        // The discovery-gate notice travels with the schema (planting it once is the point), and
        // it has to state the window the gate actually enforces: conversation + 30 minutes
        // sliding, both transports. "THIS TURN" was true of neither path after wave 2.
        assert!(desc.contains("rejected before dispatch"));
        assert!(desc.contains("30 minutes"));
        assert!(desc.contains("this conversation"));
        assert!(
            !desc.contains("THIS TURN"),
            "the gate is no longer turn-local — a notice that says so trains the model to \
             re-fetch a schema it already holds"
        );
    }

    #[test]
    fn single_action_module_is_not_a_selector() {
        let s = build_surface("stock-lookup", &single_action_config());
        assert!(
            !s.has_action_selector,
            "a module without an `action` input is exempt from the discovery gate"
        );
        // Module name verbatim — the FC variant (MCP substitutes `_` for `-`; see module docs).
        assert_eq!(s.tool_name, "sysmod_stock-lookup");
        // Same thin schema regardless: the shape is a property of the procedure, not of the module.
        assert_eq!(s.thin_parameters, thin_parameters());
    }

    #[test]
    fn tags_land_in_the_description() {
        let s = build_surface("kiwoom", &multi_action_config());
        assert_eq!(s.description, "키움증권 국내주식 시세·주문 · Tags: 주식, 시세");
    }

    #[test]
    fn description_without_tags_is_the_module_text_alone() {
        let s = build_surface("stock-lookup", &single_action_config());
        assert_eq!(s.description, "종목명 → 종목코드 조회");
        // A config with no description at all still yields a tool (empty text, never a panic).
        let bare = build_surface("nameless", &json!({}));
        assert_eq!(bare.description, "");
        assert_eq!(bare.tool_name, "sysmod_nameless");
    }

    #[test]
    fn grounding_is_parsed_onto_the_surface() {
        let s = build_surface("kiwoom", &multi_action_config());
        assert_eq!(s.grounding.len(), 1);
        assert_eq!(s.grounding[0].param, "stk_cd");
        assert!(s.grounding[0].hint.contains("ka10099"));
        assert_eq!(s.grounding[0].exempt_actions, vec!["ka10100".to_string()]);
        // Undeclared → empty, never gated (opt-in).
        assert!(build_surface("stock-lookup", &single_action_config())
            .grounding
            .is_empty());
    }

    /// The form has to carry the vocabulary the expander accepts. fa declared
    /// `cacheInputs: ["statements"]` and its catalog listed `statements` alone, so the only
    /// surface the model reads never named `statementsCacheKey` — seven rounds of guessing
    /// followed (2026-08-13, turn 49).
    #[test]
    fn a_cache_input_param_publishes_its_key_and_window_siblings() {
        let cfg = json!({
            "name": "fa",
            "cacheInputs": ["statements"],
            "actionCatalog": {"actions": [
                {"id": "ratios", "params": {"statements": "DART rows", "shares": "count"}}
            ]},
            "input": {"properties": {
                "action": {"type": "string", "enum": ["ratios"]},
                "statements": {"type": ["array", "null"], "items": {"type": "object"}},
                "shares": {"type": "number"}
            }}
        });
        let form = build_action_form(&cfg);
        let published = typed_parameters(&form, &["ratios".to_string()]).unwrap();
        let props = published["properties"].as_object().unwrap();
        assert!(props.contains_key("statements"));
        assert!(
            props.contains_key("statementsCacheKey"),
            "the key the server reads must appear where the model writes: {published}"
        );
        assert!(props.contains_key("statementsLimit"));
        assert!(props.contains_key("statementsRange"));
        let desc = props["statementsCacheKey"]["description"].as_str().unwrap();
        assert!(desc.contains("top-level"), "the slot must be named, not implied: {desc}");
        // A param this action does not take gets no siblings — the catalog decides relevance.
        assert!(!props.contains_key("sharesCacheKey"));
    }

    /// A nested declaration's siblings belong inside the list's items, which is where the model
    /// writes them (`sheets[i].rowsCacheKey`).
    #[test]
    fn a_nested_cache_input_publishes_its_siblings_inside_the_item() {
        let cfg = json!({
            "name": "docs",
            "cacheInputs": ["sheets.*.rows"],
            "actionCatalog": {"actions": [{"id": "make_xlsx", "params": {"sheets": "the sheets"}}]},
            "input": {"properties": {
                "action": {"type": "string", "enum": ["make_xlsx"]},
                "sheets": {"type": "array", "items": {"type": "object", "properties": {
                    "name": {"type": "string"},
                    "rows": {"type": "array", "items": {"type": "object"}}
                }}}
            }}
        });
        let form = build_action_form(&cfg);
        let published = typed_parameters(&form, &["make_xlsx".to_string()]).unwrap();
        let item = &published["properties"]["sheets"]["items"]["properties"];
        assert!(item.get("rowsCacheKey").is_some(), "{published}");
        assert!(item.get("rowsLimit").is_some());
        assert!(item.get("rowsRange").is_some());
        assert!(
            published["properties"].get("rowsCacheKey").is_none(),
            "a nested key never belongs at the top level"
        );
    }

    /// An author who declared the sibling themselves keeps their own wording — this fills a gap,
    /// it does not overwrite a declaration.
    #[test]
    fn a_declared_sibling_is_left_exactly_as_declared() {
        let cfg = json!({
            "cacheInputs": ["statements"],
            "actionCatalog": {"actions": [{"id": "ratios", "params": {"statements": "rows"}}]},
            "input": {"properties": {
                "action": {"type": "string", "enum": ["ratios"]},
                "statements": {"type": ["array", "null"]},
                "statementsCacheKey": {"type": "string", "description": "author's own words"}
            }}
        });
        let published =
            typed_parameters(&build_action_form(&cfg), &["ratios".to_string()]).unwrap();
        assert_eq!(
            published["properties"]["statementsCacheKey"]["description"],
            "author's own words"
        );
    }
}
