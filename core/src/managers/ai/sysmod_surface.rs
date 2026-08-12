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

/// Everything a transport needs to expose one system module as one thin tool.
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
}
