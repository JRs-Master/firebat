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

/// `action id → call` out of catalog rows.
///
/// `call` is whatever that action needs to be issued — a method and a path for one vendor, a
/// frame name for another. **Nothing here reads inside it.** The framework's job is that the row
/// travels with the call; interpreting it is the module's, and the moment core starts knowing
/// what a `trId` is, every new venue becomes a core deploy.
///
/// Rows without a `call` contribute nothing, which is most of them — a module whose endpoints are
/// a rule rather than a table has nothing to hand over and should not be made to invent one.
pub fn action_calls(rows: &[serde_json::Value]) -> HashMap<String, serde_json::Value> {
    let mut out = HashMap::new();
    for row in rows {
        let (Some(id), Some(call)) = (row.get("id").and_then(|v| v.as_str()), row.get("call"))
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
    fn only_rows_that_declare_a_call_hand_one_over() {
        let rows = vec![
            json!({ "id": "with", "call": { "method": "GET", "path": "/x" } }),
            json!({ "id": "without" }),
            json!({ "id": "null", "call": null }),
            json!({ "call": { "method": "GET" } }),
        ];
        let calls = action_calls(&rows);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls["with"]["path"], json!("/x"));
    }
}
