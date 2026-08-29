//! What a page says it is — `kind`, `source`, `needs`.
//!
//! Everything a page needed used to be inferred from the shape of its body: one `Html` block with a
//! script meant "full-bleed app", a `dependencies` name meant a CDN tag, and anything the framework
//! had not hardcoded silently did nothing. Inference is what made an app with two blocks
//! un-fixable — you had to restructure the page until the guess came out right, which is the
//! opposite of the rule this project holds modules to: if it does not work, you fix it in its own
//! declaration, with no framework change.
//!
//! So the page declares, and the framework translates. This module is only the reading half: it
//! parses the declaration out of a spec, and out of the header an author writes at the top of the
//! app's own entry file. Nothing here decides policy — the translation to sandbox tokens and CSP
//! lives with the renderer, and the storage and module permissions live with the app manager.
//!
//! The file header exists because the file is the original. Writing the page's identity into a
//! separate record would mean two homes for one fact, and the copy always drifts (2026-08-29: the
//! same drift lost 11 pages' `project`). It is an HTML comment so the file still opens and runs on
//! its own:
//!
//! ```html
//! <!--firebat
//! slug: carom
//! kind: app
//! title: 당구
//! needs: { storage: true, fullscreen: true }
//! -->
//! <!doctype html>
//! ```

use serde::{Deserialize, Serialize};

/// What the page is. The default is `Post` — a page is a document unless it says otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PageKind {
    /// Site chrome: header, footer, sidebar, ads, reading progress. Body is the block array.
    #[default]
    Post,
    /// The page IS the app: no chrome, viewport locked, body comes from the source files.
    App,
}

impl PageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PageKind::Post => "post",
            PageKind::App => "app",
        }
    }
}

/// What an app asks the framework for. Absent means not granted — an undeclared capability is not
/// a missing convenience, it is a refusal, because the alternative is that the most permissive
/// thing happens by default for the pages that said the least.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageNeeds {
    /// Persistent storage for this page, provided by the app manager.
    #[serde(default)]
    pub storage: bool,
    /// Modules this app may call through the bridge. Anything not listed is refused.
    #[serde(default)]
    pub modules: Vec<String>,
    /// Extra hosts for the app's CSP `script-src`. https only — see `is_grantable_script_host`.
    #[serde(default)]
    pub scripts: Vec<String>,
    #[serde(default)]
    pub worker: bool,
    #[serde(default)]
    pub fullscreen: bool,
    #[serde(default)]
    pub modals: bool,
    #[serde(default)]
    pub pointer_lock: bool,
    #[serde(default)]
    pub popups: bool,
    #[serde(default)]
    pub downloads: bool,
}

/// The declaration as read off a page.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDeclaration {
    pub kind: PageKind,
    /// Source directory for an app (`user/pages/<slug>/`). `None` = the body is the content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default)]
    pub needs: PageNeeds,
}

/// A script host the framework will put in an app's CSP.
///
/// https only, and never our own origin: the app runs on an opaque origin precisely so it cannot
/// act as the signed-in admin, and handing it back our host as a script source is the first step
/// of undoing that. Measured 2026-08-29 — a sandboxed frame's own subresource requests carry no
/// cookies, which is the property being protected here.
pub fn is_grantable_script_host(host: &str) -> bool {
    let h = host.trim();
    h.starts_with("https://")
        && !h.contains(' ')
        && !h.contains('\'')
        && !h.contains(';')
        && h.len() > "https://".len()
}

/// Read the declaration out of a PageSpec's `head`.
///
/// Unknown `kind` values fall back to `post` rather than failing the page: a spec written against a
/// newer vocabulary should still render as a document, not 500.
pub fn parse_declaration(spec: &serde_json::Value) -> PageDeclaration {
    let head = spec.get("head").unwrap_or(&serde_json::Value::Null);
    let kind = match head.get("kind").and_then(|v| v.as_str()) {
        Some("app") => PageKind::App,
        _ => PageKind::Post,
    };
    let source = head
        .get("source")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let needs = head
        .get("needs")
        .and_then(|v| serde_json::from_value::<PageNeeds>(v.clone()).ok())
        .unwrap_or_default();
    PageDeclaration { kind, source, needs }
}

/// The `<!--firebat … -->` header at the top of an app's entry file, if it has one.
///
/// Returns the parsed head object — the caller merges it into a spec. Only the first comment is
/// considered and only when it starts the file (after optional whitespace and a BOM), so a
/// `firebat` mention further down a document cannot become a declaration.
///
/// The body is deliberately forgiving about JSON: an author writes `needs: { storage: true }` by
/// hand, so bare keys and trailing commas are normal. Anything that will not parse is reported
/// rather than dropped — a header that silently does nothing is the failure this whole redesign
/// exists to remove.
pub fn parse_file_header(content: &str) -> Result<Option<serde_json::Value>, String> {
    let trimmed = content.trim_start_matches('\u{feff}').trim_start();
    let Some(rest) = trimmed.strip_prefix("<!--") else {
        return Ok(None);
    };
    let rest = rest.trim_start();
    let Some(body) = rest.strip_prefix("firebat") else {
        return Ok(None);
    };
    let Some(end) = body.find("-->") else {
        return Err("firebat header is not closed — add `-->` after the declaration".to_string());
    };
    let inner = body[..end].trim();
    if inner.is_empty() {
        return Err("firebat header is empty".to_string());
    }
    let json = relaxed_to_json(inner);
    serde_json::from_str::<serde_json::Value>(&json)
        .map(Some)
        .map_err(|e| {
            format!(
                "firebat header did not parse ({e}). Write `key: value` lines, e.g. \
                 `slug: carom` / `kind: app` / `needs: {{ storage: true }}`."
            )
        })
}

/// `key: value` lines (and inline `{…}` objects) into JSON.
///
/// This is the same tolerance the module dialect absorbers use: the author is writing by hand in a
/// comment, so quoting every key is not something to demand of them. Values keep their JSON meaning
/// when they look like JSON (`true`, `12`, `{…}`, `[…]`, `"…"`) and are treated as strings
/// otherwise, which is what makes `title: 당구` work without quotes.
fn relaxed_to_json(src: &str) -> String {
    let mut out = String::from("{");
    let mut first = true;
    for raw in split_top_level_lines(src) {
        let line = raw.trim().trim_end_matches(',');
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().trim_matches('"');
        let value = value.trim();
        if key.is_empty() {
            continue;
        }
        if !first {
            out.push(',');
        }
        first = false;
        out.push('"');
        out.push_str(&key.replace('"', "\\\""));
        out.push_str("\":");
        out.push_str(&value_to_json(value));
    }
    out.push('}');
    out
}

/// Split on newlines, but never inside a `{…}` / `[…]` / quoted run — an inline `needs: {a: 1}`
/// stays one entry even if the author wrapped it across lines.
fn split_top_level_lines(src: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut prev = '\0';
    for c in src.chars() {
        if in_str {
            cur.push(c);
            if c == '"' && prev != '\\' {
                in_str = false;
            }
            prev = c;
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                cur.push(c);
            }
            '{' | '[' => {
                depth += 1;
                cur.push(c);
            }
            '}' | ']' => {
                depth -= 1;
                cur.push(c);
            }
            '\n' if depth <= 0 => {
                lines.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
        prev = c;
    }
    if !cur.trim().is_empty() {
        lines.push(cur);
    }
    lines
}

fn value_to_json(v: &str) -> String {
    let t = v.trim();
    if t.is_empty() {
        return "\"\"".to_string();
    }
    let looks_json = t == "true"
        || t == "false"
        || t == "null"
        || t.starts_with('{')
        || t.starts_with('[')
        || t.starts_with('"')
        || t.parse::<f64>().is_ok();
    if looks_json {
        // A hand-written object still has bare keys inside it, so recurse through the same relaxer.
        if t.starts_with('{') {
            let inner = &t[1..t.len().saturating_sub(1)];
            return relaxed_to_json(&inner.replace(',', "\n"));
        }
        return t.to_string();
    }
    serde_json::Value::String(t.to_string()).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_is_a_document_unless_it_says_otherwise() {
        let d = parse_declaration(&serde_json::json!({"head": {"title": "x"}, "body": []}));
        assert_eq!(d.kind, PageKind::Post);
        assert!(d.source.is_none());
        assert_eq!(d.needs, PageNeeds::default());
    }

    #[test]
    fn an_app_declares_its_kind_source_and_needs() {
        let d = parse_declaration(&serde_json::json!({
            "head": {
                "kind": "app",
                "source": "user/pages/carom/",
                "needs": { "storage": true, "fullscreen": true, "modules": ["yfinance"] }
            }
        }));
        assert_eq!(d.kind, PageKind::App);
        assert_eq!(d.source.as_deref(), Some("user/pages/carom/"));
        assert!(d.needs.storage && d.needs.fullscreen);
        assert_eq!(d.needs.modules, vec!["yfinance"]);
        // Undeclared stays refused — absence is not consent.
        assert!(!d.needs.worker && !d.needs.popups && d.needs.scripts.is_empty());
    }

    #[test]
    fn an_unknown_kind_still_renders_as_a_document() {
        let d = parse_declaration(&serde_json::json!({"head": {"kind": "hologram"}}));
        assert_eq!(d.kind, PageKind::Post);
    }

    #[test]
    fn the_file_header_carries_the_declaration() {
        let file = "<!--firebat\nslug: carom\nkind: app\ntitle: 당구\nneeds: { storage: true, fullscreen: true }\n-->\n<!doctype html>";
        let head = parse_file_header(file).unwrap().expect("header");
        assert_eq!(head["slug"], "carom");
        assert_eq!(head["kind"], "app");
        assert_eq!(head["title"], "당구", "unquoted non-ASCII must survive");
        assert_eq!(head["needs"]["storage"], true);
        assert_eq!(head["needs"]["fullscreen"], true);
        // …and it reads back through the same parser the DB path uses.
        let d = parse_declaration(&serde_json::json!({ "head": head }));
        assert_eq!(d.kind, PageKind::App);
        assert!(d.needs.storage);
    }

    #[test]
    fn a_file_without_a_header_is_not_an_error() {
        assert_eq!(parse_file_header("<!doctype html><p>hi").unwrap(), None);
        assert_eq!(parse_file_header("<!-- just a comment -->").unwrap(), None);
    }

    #[test]
    fn a_broken_header_says_so_instead_of_doing_nothing() {
        // The whole point of declaring is that a mistake is visible. Silence here would put us back
        // where `dependencies` was: accepted, dropped, no trace.
        let err = parse_file_header("<!--firebat\nkind: app\n").unwrap_err();
        assert!(err.contains("not closed"), "{err}");
        let err = parse_file_header("<!--firebat\n-->").unwrap_err();
        assert!(err.contains("empty"), "{err}");
    }

    #[test]
    fn only_our_own_origin_and_plain_http_are_refused_as_script_hosts() {
        assert!(is_grantable_script_host("https://cdn.plot.ly"));
        assert!(!is_grantable_script_host("http://cdn.plot.ly"));
        assert!(!is_grantable_script_host("'self'"));
        assert!(!is_grantable_script_host("https://"));
        assert!(!is_grantable_script_host("https://x.com; script-src *"));
    }
}
