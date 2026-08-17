//! Where a module's per-action declarations live, and how to read one row out of them.
//!
//! Two readers now: the action catalog builds the discovery ladder from these rows, and dispatch
//! looks up the single row belonging to the action in flight. Both had to agree on where the rows
//! are, so the answer lives here rather than once per caller — the audit already learned that
//! lesson the expensive way, having kept a more permissive copy of `rows` that let a module lose
//! all 39 of its actions while CI stayed green.

use std::collections::HashMap;

/// The rows out of an `actionCatalog` value, in either shape it is written in.
///
/// A bare list, or an object with an `actions` list. Both are documented; a module wrote the
/// documented object shape into its file and lost all 39 actions to a reader that only understood
/// the list (measured live 2026-08-14 — every `get_action_schema` answered `derived: true` with
/// the module blurb where the action's own description belonged). Every other module happened to
/// write the bare list, which is why one module was broken and the shape looked fine.
///
/// `None` means the value is neither shape — a different failure from an empty list, and the
/// callers say so differently.
pub fn catalog_rows(v: &serde_json::Value) -> Option<Vec<serde_json::Value>> {
    if let Some(arr) = v.as_array() {
        return Some(arr.clone());
    }
    v.get("actions").and_then(|a| a.as_array()).cloned()
}

/// The file a module's `actionCatalog` names, when it names one instead of inlining the rows.
pub fn catalog_file(config: &serde_json::Value) -> Option<&str> {
    config
        .get("actionCatalog")?
        .get("file")
        .and_then(|v| v.as_str())
}

/// The rows inlined directly in `actionCatalog`, when no file is named.
pub fn inline_catalog_rows(config: &serde_json::Value) -> Option<Vec<serde_json::Value>> {
    let decl = config.get("actionCatalog")?;
    if decl.get("file").is_some() {
        return None;
    }
    catalog_rows(decl)
}

/// `action id → _call` out of catalog rows.
///
/// `_call` is whatever that action needs to be issued — a method and a path for one vendor, a
/// frame name for another. **Nothing here reads inside it.** The framework's job is that the row
/// travels with the call; interpreting it is the module's, and the moment core starts knowing
/// what a `trId` is, every new venue becomes a core deploy.
///
/// The leading underscore is the boundary, not decoration: it is the same mark the injected keys
/// carry (`_recall`, `_cacheKey`), and the catalog loader skips every underscored field when it
/// builds what the model reads. A declaration has two audiences; this one is not the model's.
///
/// Rows without a `_call` contribute nothing, which is most of them — a module whose endpoints
/// are a rule rather than a table has nothing to hand over and should not be made to invent one.
pub fn action_calls(rows: &[serde_json::Value]) -> HashMap<String, serde_json::Value> {
    let mut out = HashMap::new();
    for row in rows {
        let (Some(id), Some(call)) = (row.get("id").and_then(|v| v.as_str()), row.get("_call"))
        else {
            continue;
        };
        if id.is_empty() || call.is_null() {
            continue;
        }
        out.insert(id.to_string(), call.clone());
    }
    out
}

/// Action-axis gate declarations, read off a row about ITSELF.
///
/// These used to live at module top level as parallel lists keyed by action id
/// (`requiresApproval` / `uiOnly` / `unsupportedActions`) — one action's truth spread over
/// several hand-lists that could disagree, which is what the four-direction audit existed to
/// catch. A row that says `"approval": true`, `"uiOnly": true` or `"unsupported": true|"reason"`
/// moves with its action. During migration the readers take row ∨ legacy list (OR — a live
/// trading system's gate must never loosen mid-migration).
#[derive(Debug, Default, Clone)]
pub struct ActionGates {
    pub approval: std::collections::HashSet<String>,
    pub ui_only: std::collections::HashSet<String>,
    /// action id → reason ("" when declared as a bare `true`).
    pub unsupported: HashMap<String, String>,
}

/// The gate sets out of catalog rows. Rows without gate fields contribute nothing.
pub fn action_gates(rows: &[serde_json::Value]) -> ActionGates {
    let mut out = ActionGates::default();
    for row in rows {
        let Some(id) = row.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
            continue;
        };
        let truthy = |k: &str| row.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
        if truthy("approval") {
            out.approval.insert(id.to_string());
        }
        if truthy("uiOnly") {
            out.ui_only.insert(id.to_string());
        }
        match row.get("unsupported") {
            Some(serde_json::Value::Bool(true)) => {
                out.unsupported.insert(id.to_string(), String::new());
            }
            Some(serde_json::Value::String(reason)) => {
                out.unsupported.insert(id.to_string(), reason.clone());
            }
            _ => {}
        }
    }
    out
}

/// `param → issuer` out of a config's `paramSource` declaration.
///
/// Which action mints which opaque id used to live as a table inside one module's code (tago's
/// `ID_SOURCE`) — right behavior, wrong home: the next module would have had to reinvent it, and
/// the framework's own refusals (a missing required param, a grounding rejection) could not name
/// the issuer at all. Declared, both readers speak from the same rows.
///
/// The value is free text naming the issuing action(s) — one id, two alternatives, a format note
/// ("express-terminals-arr (a bare number like 010)"). The framework carries it into the refusal
/// verbatim and never interprets it; only the module knows what its own issuers are called.
pub fn param_source(config: &serde_json::Value) -> Vec<(String, String)> {
    let Some(obj) = config.get("paramSource").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    obj.iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
        .filter(|(k, s)| !k.is_empty() && !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rows_read_both_documented_shapes() {
        let bare = json!([{ "id": "a" }]);
        let wrapped = json!({ "actions": [{ "id": "a" }] });
        assert_eq!(catalog_rows(&bare).unwrap().len(), 1);
        assert_eq!(catalog_rows(&wrapped).unwrap().len(), 1);
        // Neither shape is not an empty catalog — the callers report it differently.
        assert!(catalog_rows(&json!({ "nope": 1 })).is_none());
    }

    #[test]
    fn a_named_file_and_inline_rows_are_exclusive() {
        let by_file = json!({ "actionCatalog": { "file": "actions.json" } });
        assert_eq!(catalog_file(&by_file), Some("actions.json"));
        assert!(inline_catalog_rows(&by_file).is_none());

        let inline = json!({ "actionCatalog": [{ "id": "a" }] });
        assert_eq!(catalog_file(&inline), None);
        assert_eq!(inline_catalog_rows(&inline).unwrap().len(), 1);
    }

    #[test]
    fn gates_come_off_the_row_itself() {
        let rows = vec![
            json!({"id": "order", "approval": true}),
            json!({"id": "screen", "uiOnly": true}),
            json!({"id": "old", "unsupported": "use the stream instead"}),
            json!({"id": "bare", "unsupported": true}),
            json!({"id": "plain"}),
        ];
        let g = action_gates(&rows);
        assert!(g.approval.contains("order"));
        assert!(g.ui_only.contains("screen"));
        assert_eq!(g.unsupported["old"], "use the stream instead");
        assert_eq!(g.unsupported["bare"], "");
        assert!(!g.approval.contains("plain") && !g.ui_only.contains("plain"));
    }

    #[test]
    fn dual_home_gate_is_an_or_never_a_replacement() {
        // The migration rule: a gate opened by EITHER home stays closed to a bare call.
        // Row-only, list-only, both, neither — four states, one truth table.
        let gates = action_gates(&[json!({"id": "row_gated", "approval": true})]);
        let cfg = json!({ "requiresApproval": ["list_gated"] });
        assert!(crate::utils::pending_tools::approval_gated(&cfg, &gates, "row_gated"));
        assert!(crate::utils::pending_tools::approval_gated(&cfg, &gates, "list_gated"));
        assert!(!crate::utils::pending_tools::approval_gated(&cfg, &gates, "open"));
        assert!(!crate::utils::pending_tools::approval_gated(&json!({}), &gates, "list_gated"));
    }

    #[test]
    fn param_source_reads_only_named_issuers() {
        let config = json!({ "paramSource": {
            "nodeId": "bus-stop-search or bus-stop-nearby",
            "empty": "",
            "notText": 3
        } });
        let rows = param_source(&config);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "nodeId");
        // Absent declaration = no rows, not an error — the pointer is opt-in.
        assert!(param_source(&json!({})).is_empty());
    }

    #[test]
    fn only_rows_that_declare_a_call_hand_one_over() {
        let rows = vec![
            json!({ "id": "with", "_call": { "method": "GET", "path": "/x" } }),
            json!({ "id": "without" }),
            json!({ "id": "null", "_call": null }),
            json!({ "_call": { "method": "GET" } }),
            // Without the underscore it is a field the model reads, not the framework's channel.
            json!({ "id": "unmarked", "call": { "method": "GET", "path": "/y" } }),
        ];
        let calls = action_calls(&rows);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls["with"]["path"], json!("/x"));
    }
}
