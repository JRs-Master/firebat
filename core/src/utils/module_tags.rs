//! Declared `tags` on a module config — the words a model can use to pick that module.
//!
//! A single reader for both transports, because a tag list that is not an array used to be dropped
//! in silence: `upstage-ie` declared its tags as one space-separated STRING, `as_array()` returned
//! None, and the module went to the model with no tags at all for as long as that file existed
//! (found 2026-07-31). A declaration that cannot be read is a defect, and a defect that says
//! nothing is the expensive kind.

/// Tags to append to a tool description. A wrong type is logged and treated as empty — the tool
/// still registers, because losing the tool would be worse than losing its tags.
pub fn read_tags(module: &str, config: &serde_json::Value) -> Vec<String> {
    match config.get("tags") {
        None => Vec::new(),
        Some(serde_json::Value::Array(list)) => list
            .iter()
            .filter_map(|t| t.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
        Some(other) => {
            tracing::warn!(
                target: "module",
                module,
                found = %match other {
                    serde_json::Value::String(_) => "string",
                    serde_json::Value::Object(_) => "object",
                    _ => "scalar",
                },
                "config `tags` must be an array of strings — ignoring it, so this module is \
                 discoverable only by its description"
            );
            Vec::new()
        }
    }
}

/// `desc · Tags: a, b, c` — the form both transports append.
pub fn append_tags(desc: String, module: &str, config: &serde_json::Value) -> String {
    let tags = read_tags(module, config);
    if tags.is_empty() {
        return desc;
    }
    format!("{} · Tags: {}", desc.trim(), tags.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn array_of_strings_is_appended() {
        let cfg = serde_json::json!({"tags": ["주가", "backtest"]});
        assert_eq!(append_tags("desc".into(), "m", &cfg), "desc · Tags: 주가, backtest");
    }

    #[test]
    fn a_string_is_not_silently_split_into_letters() {
        // The bug this file exists for: one string must not become tags, and must not vanish
        // without a word either.
        let cfg = serde_json::json!({"tags": "영수증 receipt"});
        assert!(read_tags("m", &cfg).is_empty());
        assert_eq!(append_tags("desc".into(), "m", &cfg), "desc");
    }

    #[test]
    fn absent_or_empty_leaves_the_description_alone() {
        assert_eq!(append_tags("desc".into(), "m", &serde_json::json!({})), "desc");
        assert_eq!(append_tags("desc".into(), "m", &serde_json::json!({"tags": []})), "desc");
        assert_eq!(append_tags("desc".into(), "m", &serde_json::json!({"tags": ["  "]})), "desc");
    }
}
