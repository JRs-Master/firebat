//! The success envelope a module hands back, shaped for whoever called it.
//!
//! Three call sites build `{success, data}` by hand (core `run_module_action`, MCP's module and
//! module-path handlers). They now share this one function so a declaration read in one place is
//! read in all three — the alternative is the drift that
//! [[feedback_home_moves_take_every_reader]] keeps catching.

use serde_json::{json, Value};

/// `data._render = {component, props?}` → the tool-result contract every renderer already speaks.
///
/// A module knows what its output IS; only it can say that a track plus its lyric file is a
/// karaoke stage. What it cannot do is reach the chat: `component`/`props` are read at the TOP of
/// a tool result (FC `ai.rs`, and both CLI adapters), and a module only ever writes inside `data`.
/// So the module declares and the framework lifts — the same shape as `_mediaImport`, underscore
/// and all (the catalog loader keeps `_`-fields off the model's surface).
///
/// 실측 (2026-08-19): sing rendered the backing track AND the synced .lrc in one call, the
/// `karaoke` component was declared and ranked first in component search — and the answer was two
/// markdown links, because nothing at that moment said a component existed. The model never
/// searched; it had no reason to.
pub fn success_envelope(mut data: Value) -> Value {
    let decl = data
        .as_object_mut()
        .and_then(|o| o.remove("_render"))
        .filter(|d| d.get("component").and_then(Value::as_str).is_some());
    let Some(decl) = decl else {
        return json!({ "success": true, "data": data });
    };
    let mut props = decl.get("props").cloned().unwrap_or_else(|| json!({}));
    resolve_media_refs(&mut props, data.get("media"));
    json!({
        "success": true,
        "data": data,
        "component": decl.get("component").and_then(Value::as_str).unwrap_or_default(),
        "props": props,
    })
}

/// `{"$media": N}` → the Nth carried file's URL.
///
/// A module cannot know these addresses: it declares `_mediaImport` and the framework decides
/// where the bytes land, so by the time there is a URL the module has already returned. The
/// declaration therefore points at its own import BY POSITION — the same order it declared them
/// in, which is the order `data.media` comes back in. An index with no file resolves to null
/// rather than to a broken address.
fn resolve_media_refs(v: &mut Value, media: Option<&Value>) {
    match v {
        Value::Object(map) => {
            if let Some(idx) = map.get("$media").and_then(Value::as_u64) {
                if map.len() == 1 {
                    *v = media_url_at(media, idx as usize);
                    return;
                }
            }
            for (_, item) in map.iter_mut() {
                resolve_media_refs(item, media);
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                resolve_media_refs(item, media);
            }
        }
        _ => {}
    }
}

fn media_url_at(media: Option<&Value>, idx: usize) -> Value {
    let rec = match media {
        Some(Value::Array(rows)) => rows.get(idx),
        Some(one @ Value::Object(_)) if idx == 0 => Some(one),
        _ => None,
    };
    rec.and_then(|r| r.get("url")).cloned().unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::success_envelope;
    use serde_json::json;

    #[test]
    fn a_declared_component_rides_at_the_top_where_renderers_read_it() {
        let env = success_envelope(json!({
            "outPath": "data/sing/x.wav",
            "_render": { "component": "karaoke", "props": { "audioUrl": "/user/media/x.wav" } }
        }));
        assert_eq!(env["component"], "karaoke");
        assert_eq!(env["props"]["audioUrl"], "/user/media/x.wav");
        assert!(env["data"].get("_render").is_none(), "the declaration is consumed, not echoed");
        assert_eq!(env["data"]["outPath"], "data/sing/x.wav");
    }

    #[test]
    fn without_the_declaration_the_envelope_is_exactly_what_it_always_was() {
        let env = success_envelope(json!({ "rows": [1, 2] }));
        assert_eq!(env, json!({ "success": true, "data": { "rows": [1, 2] } }));
    }

    #[test]
    fn props_point_at_the_carried_files_by_position() {
        let env = success_envelope(json!({
            "media": [
                { "url": "/user/media/a.wav" },
                { "url": "/user/media/a.lrc" }
            ],
            "_render": { "component": "karaoke", "props": {
                "audioUrl": { "$media": 0 },
                "lrcUrl": { "$media": 1 },
                "missing": { "$media": 7 },
                "title": "아로하"
            } }
        }));
        assert_eq!(env["props"]["audioUrl"], "/user/media/a.wav");
        assert_eq!(env["props"]["lrcUrl"], "/user/media/a.lrc");
        assert!(env["props"]["missing"].is_null(), "an index with no file is null, not a broken url");
        assert_eq!(env["props"]["title"], "아로하");
    }

    #[test]
    fn a_single_carried_file_is_index_zero() {
        let env = success_envelope(json!({
            "media": { "url": "/user/media/only.wav" },
            "_render": { "component": "karaoke", "props": { "audioUrl": { "$media": 0 } } }
        }));
        assert_eq!(env["props"]["audioUrl"], "/user/media/only.wav");
    }

    #[test]
    fn a_malformed_declaration_is_dropped_rather_than_drawn() {
        // No component name = nothing to render. It still must not survive into `data`, where a
        // stray `_render` would read as output the caller should care about.
        let env = success_envelope(json!({ "_render": { "props": { "a": 1 } } }));
        assert!(env.get("component").is_none());
        assert!(env["data"].get("_render").is_none());
    }
}
