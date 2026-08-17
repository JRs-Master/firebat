//! `render_*` tool name → component type.
//!
//! Derived from `components.json`, which is the one place a component exists. The map used to be
//! thirty hand-written inserts kept "in sync" with that file by a test that counted them, and it
//! had drifted: the catalog held 44 components and this map named 30, so the fourteen newest —
//! every study card, every live component, `function_plot` — resolved to nothing on the CLI
//! adapters that read it. A list copied from reality diverges from it; the fix is to stop copying
//! ([[feedback_derive_dont_maintain_lists]]).
//!
//! Consumers: `result_processor` (both directions), the three CLI adapters (claude-code / codex /
//! gemini) resolving a pending tool call, and `ai.rs`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// The one entry that is NOT a component: `render_alert` is the old name for `render_callout`,
/// whose renderer is still `AlertComp` on the frontend. An alias has to be declared because
/// nothing derives it — but it is one line, not thirty.
const ALIASES: &[(&str, &str)] = &[("render_alert", "Alert")];

/// Both maps under the catalog fingerprint they were derived from.
///
/// The catalog reloads when its file changes, so these maps rebuild on the same trigger. Their
/// strings are leaked to keep every consumer's `&'static` signature (the CLI adapters store the
/// keys); a rebuild leaks a couple of KB and happens as often as a human edits the declaration
/// file — bounded by hands, not by traffic.
struct Maps {
    fingerprint: String,
    forward: &'static HashMap<&'static str, &'static str>,
    inverse: &'static HashMap<&'static str, &'static str>,
}

fn maps() -> (&'static HashMap<&'static str, &'static str>, &'static HashMap<&'static str, &'static str>) {
    static CACHE: OnceLock<Mutex<Option<Maps>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let fp = crate::managers::ai::component_registry::fingerprint();
    let mut guard = match cache.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(m) = guard.as_ref() {
        if m.fingerprint == fp {
            return (m.forward, m.inverse);
        }
    }
    let mut forward: HashMap<&'static str, &'static str> = HashMap::new();
    for c in crate::managers::ai::component_registry::components().iter() {
        let key: &'static str = Box::leak(format!("render_{}", c.name).into_boxed_str());
        let val: &'static str = Box::leak(c.component_type.clone().into_boxed_str());
        forward.insert(key, val);
    }
    for (alias, component_type) in ALIASES {
        forward.insert(*alias, *component_type);
    }
    // Canonical names first, aliases only where they answer for nothing — HashMap iteration
    // order is arbitrary, so "whichever came last" is not an answer.
    let mut inverse: HashMap<&'static str, &'static str> = HashMap::new();
    let alias_names: Vec<&str> = ALIASES.iter().map(|(a, _)| *a).collect();
    for (tool, component_type) in &forward {
        if !alias_names.contains(tool) {
            inverse.insert(*component_type, *tool);
        }
    }
    for (alias, component_type) in ALIASES {
        inverse.entry(*component_type).or_insert(*alias);
    }
    let forward: &'static HashMap<&'static str, &'static str> = Box::leak(Box::new(forward));
    let inverse: &'static HashMap<&'static str, &'static str> = Box::leak(Box::new(inverse));
    *guard = Some(Maps { fingerprint: fp, forward, inverse });
    (forward, inverse)
}

/// `render_*` tool name → component type (PascalCase), one entry per catalog component.
pub fn render_tool_map() -> &'static HashMap<&'static str, &'static str> {
    maps().0
}

/// `Component → render_<tool>` — used where a result names the component and the caller needs the
/// tool name back. Components sharing a type (the alias) collapse; the canonical name wins.
pub fn render_tool_inverse_map() -> &'static HashMap<&'static str, &'static str> {
    maps().1
}

/// Tolerant lookup — the model may write the name three ways:
///   - `"render_table"` (exact)      → `Some("render_table")`
///   - `"render-table"` (kebab)      → `Some("render_table")`
///   - `"table"` (prefix omitted)    → `Some("render_table")`
///
/// A Gemini-CLI prefix like `mcp_firebat_render_table` is stripped by the caller beforehand.
pub fn normalize_render_name(name: &str) -> Option<&'static str> {
    let stripped = name.trim();
    if stripped.is_empty() {
        return None;
    }
    let map = render_tool_map();
    let hit = |candidate: &str| map.get_key_value(candidate).map(|(k, _)| *k);

    hit(stripped)
        .or_else(|| hit(&stripped.replace('-', "_")))
        .or_else(|| hit(&format!("render_{}", stripped.replace('-', "_"))))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The map IS the catalog — not a copy of it that a number has to police.
    #[test]
    fn render_map_covers_every_catalog_component() {
        let map = render_tool_map();
        for c in crate::managers::ai::component_registry::components().iter() {
            let key = format!("render_{}", c.name);
            assert_eq!(
                map.get(key.as_str()),
                Some(&c.component_type.as_str()),
                "{key} missing or wrong — the map no longer derives from the catalog"
            );
        }
        let expected = crate::managers::ai::component_registry::components().len() + ALIASES.len();
        assert_eq!(map.len(), expected, "map holds entries no component declares");
    }

    #[test]
    fn render_map_known_components() {
        let m = render_tool_map();
        assert_eq!(m.get("render_table"), Some(&"Table"));
        assert_eq!(m.get("render_chart"), Some(&"Chart"));
        assert_eq!(m.get("render_stock_chart"), Some(&"StockChart"));
        assert_eq!(m.get("render_alert"), Some(&"Alert"));
        assert_eq!(m.get("render_image"), Some(&"Image"));
    }

    /// The components the hand-written map had been missing since they were added.
    #[test]
    fn render_map_reaches_the_components_the_copy_had_dropped() {
        let m = render_tool_map();
        for name in ["render_vocab", "render_passage", "render_function_plot", "render_live_chart"] {
            assert!(m.contains_key(name), "{name} unresolvable");
        }
    }

    #[test]
    fn inverse_map_roundtrip() {
        let inv = render_tool_inverse_map();
        assert_eq!(inv.get("Table"), Some(&"render_table"));
        assert_eq!(inv.get("StockChart"), Some(&"render_stock_chart"));
        assert_eq!(inv.get("Map"), Some(&"render_map"));
        // Callout owns its type; the `render_alert` alias must not claim it.
        assert_eq!(inv.get("Callout"), Some(&"render_callout"));
    }

    #[test]
    fn normalize_exact_match() {
        assert_eq!(normalize_render_name("render_table"), Some("render_table"));
        assert_eq!(normalize_render_name("render_chart"), Some("render_chart"));
    }

    #[test]
    fn normalize_kebab_to_snake() {
        assert_eq!(normalize_render_name("render-table"), Some("render_table"));
        assert_eq!(normalize_render_name("render-stock-chart"), Some("render_stock_chart"));
    }

    #[test]
    fn normalize_missing_prefix() {
        assert_eq!(normalize_render_name("table"), Some("render_table"));
        assert_eq!(normalize_render_name("chart"), Some("render_chart"));
        assert_eq!(normalize_render_name("stock-chart"), Some("render_stock_chart"));
    }

    #[test]
    fn normalize_unknown_returns_none() {
        assert_eq!(normalize_render_name("not_a_render_tool"), None);
        assert_eq!(normalize_render_name(""), None);
        assert_eq!(normalize_render_name("   "), None);
    }
}
