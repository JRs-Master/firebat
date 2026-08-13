//! ModuleActionCatalog — per-action semantic discovery for big sysmods (#search-tool S2).
//!
//! korea-invest (278 actions) / kiwoom (208) expose only cryptic action-ID enums; dumping
//! the enum steers weak models into wrong picks (observed: an ORDER API chosen for a chart).
//! This catalog gives the missing middle layer of progressive disclosure:
//!   `search_module_actions(query)` → ranked candidates (cross-module by default, so the
//!   "which broker" routing mistake is also softened) → `get_action_schema(module, action)`
//!   → exact params + call envelope → the model writes a correct call (no guessing).
//!
//! Declarative (zero hardcoding): a module opts in via config `actionCatalog`:
//! ```json
//! "actionCatalog": {
//!   "file": "actions.json",           // module-dir relative, OR inline:
//!   "actions": [ { "id", "name", "description", "domain"?, "params"?: {name: desc}, ... } ],
//!   "envelope": "{ \"action\": \"<id>\", \"params\": { ... } }"   // module call-shape hint
//! }
//! ```
//! Any extra per-action fields (method/path/trId/example …) ride along into
//! `get_action_schema` untouched. `requiresApproval` is NOT re-declared here — it is joined
//! from the module config's own declaration at load time (single source, no drift). Modules
//! without a catalog are simply not indexed (small enums are already self-correcting via
//! validation errors).

use std::sync::Arc;
use std::time::Duration;

use crate::managers::ai::semantic_catalog::{CatalogEntry, CatalogSource, RefreshingCatalog};
use crate::managers::module::ModuleManager;
use crate::ports::{IEmbedderCachePort, IEmbedderPort};
use crate::utils::pending_tools::requires_approval_value;

/// Rebuild TTL — config/actions.json changes land via git pull; embeddings are hash-cached so a
/// rebuild only re-reads JSON (re-embeds nothing when unchanged).
const REBUILD_TTL: Duration = Duration::from_secs(300);

/// What a module is actually CALLED — its name plus whatever people call it instead.
///
/// Recall solved this already: `entity_passage_text` embeds an entity's name together with its
/// aliases, which is why "삼성" and "SAMSUNG" both land on one company. A module needs the same
/// list and cannot derive it — "한투" is not a function of "korea-invest". It goes in the RANKER
/// text because naming the venue IS the routing signal, and it is safe there because it is short
/// and identical across that module's rows: it moves them together against OTHER modules without
/// separating them from each other.
fn module_identity(name: &str, config: &serde_json::Value) -> Vec<String> {
    let mut out = vec![name.to_string()];
    if let Some(list) = config.get("aliases").and_then(|v| v.as_array()) {
        out.extend(list.iter().filter_map(|v| v.as_str()).map(String::from));
    }
    out
}

/// Declared capability words — GATE ONLY.
///
/// `tags` is a word list, not prose, and repeating it on every row of a 233-action module would
/// blur rows that differ only by which action they are. In the gate it costs nothing: that is a
/// membership test, so a longer vocabulary is strictly better. Until now these were read only by
/// the module-selection index, so a declared tag never once helped an action search.
fn module_tags(config: &serde_json::Value) -> Vec<String> {
    config
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).map(String::from).collect())
        .unwrap_or_default()
}

struct ModuleActionSource {
    module: Arc<ModuleManager>,
}

impl ModuleActionSource {
    /// Load one module's catalog declaration → entries. Inline `actions` wins; else `file`
    /// (module-dir relative, read through ModuleManager storage).
    async fn module_entries(&self, scope: &str, name: &str) -> Vec<CatalogEntry> {
        let Some(config) = self.module.get_module_config(scope, name).await else {
            return Vec::new();
        };
        let approval_decl = config
            .get("requiresApproval")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let mut entries = self.action_entries(scope, name, &config, &approval_decl).await;
        // Page-binding eligibility is a DISCOVERABLE property, not lore. A live chart's
        // fresh-on-visit `seed` (and a page `module` block) only accepts a pageBinding-declared
        // action, but nothing told the model WHICH actions qualify — so it fell back to a static
        // snapshot and the published page froze at authoring time (2026-07-23 실측: 분봉 페이지가
        // 09:05 에 멈춤). Flag it on the row, same join-from-config shape as requiresApproval.
        if let Some(binding) = crate::utils::page_binding::parse_page_binding(&config) {
            for e in entries.iter_mut() {
                let Some(act) = e.extra.get("action").and_then(|v| v.as_str()).map(String::from) else {
                    continue;
                };
                if binding.allows(&act) {
                    if let Some(obj) = e.extra.as_object_mut() {
                        obj.insert("pageBinding".to_string(), serde_json::Value::Bool(true));
                    }
                }
            }
        }
        // F4 — realtime WS subscriptions are actions too, as far as discovery is concerned. Without
        // this a "실시간 차트" request can never reach `stream_watch_start`: search_module_actions
        // only indexed REST actions, so the model silently substituted a static snapshot
        // (2026-07-09 실측 — CoT: "real-time chart requires a real-time data stream" → 그런데 잡을
        // 도구가 없어 캔들로 대체). Streams ride the same catalog, tagged `kind: "stream"`.
        entries.extend(derive_stream_entries(name, &config));
        entries
    }

    /// REST action entries — explicit `actionCatalog` when declared, else derived from `input`.
    async fn action_entries(
        &self,
        scope: &str,
        name: &str,
        config: &serde_json::Value,
        approval_decl: &serde_json::Value,
    ) -> Vec<CatalogEntry> {
        let Some(decl) = config.get("actionCatalog") else {
            // No explicit catalog — derive per-action entries from the module's `input` schema so
            // EVERY module (usermods, small sysmods) is uniformly discoverable via
            // search_module_actions (Part 1-A: the 4-step tool procedure applies to all modules,
            // not just the 3 that hand-author actions.json). Zero authoring: the input schema the
            // module already ships for validation doubles as the discovery catalog.
            return derive_entries_from_input(name, config, approval_decl);
        };
        let envelope = decl.get("envelope").and_then(|v| v.as_str()).unwrap_or("");
        // Grounded params (config `grounding`) — surface the resolveHint PROACTIVELY in the
        // schema, not only on gate rejection. Observed (2026-07-11): a model that needed a
        // stock code hunted it through action-search/recall for 11 rounds because nothing on
        // the discovery surface said HOW to turn a name into the code; the hint existed but
        // only fired after a rejected call it never made. Declarative — no per-module logic.
        let grounded = crate::utils::grounding::parse_grounding(config);
        let ident = module_identity(name, config);
        let tag_words = module_tags(config);
        let actions: Vec<serde_json::Value> = if let Some(arr) = decl.as_array() {
            // The documented shape is `{"actions": [...]}`, but writing the list itself is the
            // obvious mistake to make, and it used to cost the whole module: no `actions` key
            // meant zero entries, and the key's mere presence skipped the derive-from-input
            // fallback below, so the module vanished from search_module_actions entirely
            // (2026-08-10 — binance shipped that way and answered 0 of 11 actions). Accept the
            // bare list; it says exactly the same thing.
            arr.clone()
        } else if let Some(arr) = decl.get("actions").and_then(|v| v.as_array()) {
            arr.clone()
        } else if let Some(file) = decl.get("file").and_then(|v| v.as_str()) {
            match self.module.read_module_file(scope, name, file).await {
                Some(raw) => serde_json::from_str::<Vec<serde_json::Value>>(&raw).unwrap_or_default(),
                None => Vec::new(),
            }
        } else {
            Vec::new()
        };
        let entries: Vec<CatalogEntry> = actions
            .into_iter()
            .filter_map(|a| {
                let id = a.get("id").and_then(|v| v.as_str())?.to_string();
                let a_name = a
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&id)
                    .to_string();
                let domain = a.get("domain").and_then(|v| v.as_str()).unwrap_or("");
                let desc = a.get("description").and_then(|v| v.as_str()).unwrap_or("");
                // Semantic text = domain + description + param labels — what a user query
                // should land on ("투자자 매매동향", "일봉", "잔고" …).
                let param_names: Vec<String> = a
                    .get("params")
                    .and_then(|v| v.as_object())
                    .map(|o| o.keys().cloned().collect())
                    .unwrap_or_default();
                let sem = format!(
                    "{} {} {} {}",
                    ident.join(" "),
                    domain,
                    desc,
                    a.get("params")
                        .and_then(|v| v.as_object())
                        .map(|o| {
                            o.values()
                                .filter_map(|d| d.as_str())
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .unwrap_or_default()
                );
                let approval = requires_approval_value(approval_decl, &id);
                let mut extra = serde_json::json!({
                    "module": name,
                    "action": id,
                    "paramNames": param_names,
                    "requiresApproval": approval,
                });
                // The structured `required` states the call contract — the explicit-catalog
                // twin of the derived-schema gap fixed the same day (2026-08-11: fa, an
                // explicit catalog, was called without `action` right after ta's derived
                // required was fixed — its schema response carried no required at all).
                // A per-action `required` declared in actions.json overrides this below.
                {
                    let has_selector = config
                        .get("input")
                        .and_then(|i| i.get("properties"))
                        .and_then(|p| p.get("action"))
                        .is_some();
                    let mut req: Vec<String> = Vec::new();
                    if has_selector {
                        req.push("action".to_string());
                    }
                    if let Some(list) = config
                        .get("input")
                        .and_then(|i| i.get("required"))
                        .and_then(|r| r.as_array())
                    {
                        req.extend(
                            list.iter()
                                .filter_map(|x| x.as_str())
                                .filter(|s| *s != "action")
                                .filter(|s| param_names.iter().any(|p| p == s))
                                .map(String::from),
                        );
                    }
                    if !req.is_empty() {
                        extra["required"] = serde_json::json!(req);
                    }
                }
                // See the note in `derive_entries_from_input` — discovery names the screen actions.
                if let Some(ui_decl) = config.get("uiOnly") {
                    if crate::utils::pending_tools::is_ui_only_value(ui_decl, &id) {
                        extra["uiOnly"] = serde_json::Value::Bool(true);
                    }
                }
                // Ride every declared field along (params/example/method/path/trId/domain …) —
                // get_action_schema returns them verbatim, so richer actions.json = richer detail
                // with zero loader changes.
                if let Some(obj) = a.as_object() {
                    for (k, v) in obj {
                        if matches!(k.as_str(), "id" | "name" | "description") {
                            continue;
                        }
                        extra[k] = v.clone();
                    }
                }
                if !envelope.is_empty() {
                    extra["envelope"] = serde_json::Value::String(envelope.to_string());
                }
                // The cache-key vocabulary belongs in the params the model reads, not only in the
                // hint it gets after a rejection. A hand-written catalog lists what its author
                // remembered, and `cacheInputs` is declared elsewhere in the same file: fa's
                // catalog named `statements` while its input schema declared
                // `statementsCacheKey`, so `get_action_schema` reported four params and the model
                // reasoned, verbatim, "the schema I got only shows 4 params" — then spent seven
                // rounds inventing shapes (2026-08-13, turn 49). Derived from the declaration, so
                // it cannot drift from what the expander accepts.
                add_cache_key_params(&mut extra, config);
                // Attach resolve guidance for grounded params this action actually takes —
                // the model reads it exactly where it reads the params (get_action_schema),
                // BEFORE its first call, instead of after a grounding rejection.
                if !grounded.is_empty() {
                    let mut resolve = serde_json::Map::new();
                    for g in &grounded {
                        if g.hint.is_empty() || g.exempt_actions.iter().any(|e| e == &id) {
                            continue;
                        }
                        let takes_param = param_names
                            .iter()
                            .any(|p| p.eq_ignore_ascii_case(&g.param));
                        if takes_param {
                            resolve.insert(g.param.clone(), serde_json::Value::String(g.hint.clone()));
                        }
                    }
                    if !resolve.is_empty() {
                        extra["resolveFirst"] = serde_json::Value::Object(resolve);
                    }
                }
                // Row prose = the action's own description; the embedded document also carries
                // the domain and every param blurb, which reads as run-on text in a list.
                if !desc.trim().is_empty() {
                    extra["display"] = serde_json::Value::String(desc.trim().to_string());
                }
                Some(CatalogEntry {
                    id: format!("{}:{}", name, id),
                    name: a_name,
                    description: sem.trim().to_string(),
                    extra,
                    vocab: tag_words
                        .iter()
                        .cloned()
                        .chain(std::iter::once(id.clone()))
                        .collect(),
                })
            })
            .collect::<Vec<_>>();

        // A declared catalog that produces nothing is a broken declaration, not a module with no
        // actions — and the cost of believing it is total: the module disappears from discovery
        // while every other surface still works, so it looks installed and is unreachable. Fall
        // back to the input schema (which every module ships) and say the module's name, because
        // a silent zero is the one outcome nobody goes looking for.
        if entries.is_empty() {
            tracing::warn!(
                target: "action_catalog",
                module = %name,
                "actionCatalog declared but yielded no actions — falling back to the input schema. \
                 Expected {{\"actions\": [...]}} or a bare [...] list, each item with an `id`."
            );
            return derive_entries_from_input(name, config, approval_decl);
        }
        entries
    }
}

/// F4 — one catalog entry per declared realtime WS subscription (`config.ws.streams.<key>`), so a
/// "실시간 / live" query surfaces `stream_watch_start` alongside REST actions. Entries are tagged
/// `kind: "stream"`; `get_action_schema(module, <key>)` returns the subscribe contract. Pure data —
/// the loader knows nothing about any provider.
/// Subscribe/unsubscribe 프레임의 `{name}` · `{name:default}` placeholder = 그 스트림이 받는 인자
/// 이름(선언이 유일한 소스 — 모듈별 하드코딩 0). `{TOKEN}` 은 인프라가 채우므로 제외.
fn stream_arg_names(decl: &serde_json::Value) -> Vec<(String, Option<String>)> {
    fn walk(v: &serde_json::Value, acc: &mut Vec<(String, Option<String>)>) {
        match v {
            serde_json::Value::String(s) => {
                let t = s.trim();
                if t.len() > 2 && t.starts_with('{') && t.ends_with('}') {
                    let inner = &t[1..t.len() - 1];
                    if inner == "TOKEN" || inner.contains(' ') {
                        return;
                    }
                    let (n, d) = match inner.split_once(':') {
                        Some((n, d)) => (n.to_string(), Some(d.to_string())),
                        None => (inner.to_string(), None),
                    };
                    if !n.is_empty() && !acc.iter().any(|(existing, _)| existing == &n) {
                        acc.push((n, d));
                    }
                }
            }
            serde_json::Value::Array(a) => a.iter().for_each(|x| walk(x, acc)),
            serde_json::Value::Object(m) => m.values().for_each(|x| walk(x, acc)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    for section in ["subscribe", "unsubscribe"] {
        if let Some(frame) = decl.get(section) {
            walk(frame, &mut out);
        }
    }
    out
}

fn derive_stream_entries(name: &str, config: &serde_json::Value) -> Vec<CatalogEntry> {
    let ident = module_identity(name, config);
    let tag_words = module_tags(config);
    let Some(streams) = config
        .get("ws")
        .and_then(|w| w.get("streams"))
        .and_then(|s| s.as_object())
    else {
        return Vec::new();
    };
    streams
        .iter()
        .map(|(key, decl)| {
            let desc = decl.get("desc").and_then(|v| v.as_str()).unwrap_or("");
            let key_desc = decl.get("keyDesc").and_then(|v| v.as_str()).unwrap_or("");
            // Transport vocabulary is baked in so "실시간 …" / "live …" rank a stream above the
            // snapshot REST action it would otherwise lose to, in either language. That much is
            // true of every stream there can be.
            //
            // What a stream carries is NOT baked in. `체결 틱 호가 시세 tick trade execution quote
            // orderbook` used to be appended here, to every stream of every module — so a weather
            // alert subscription advertised itself with trading words, and every stream's document
            // read alike, which is the homogenizing that `derive_entries_from_input` warns about a
            // few hundred lines down. The domain belongs to the declaration: each stream's `desc`
            // already names what it pushes. (Removing it surfaced two streams that had no `desc` at
            // all and were findable only through these borrowed words.)
            let sem = format!(
                "{key} {desc} {key_desc} 실시간 라이브 스트림 구독 realtime live stream subscribe push"
            );
            let mut extra = serde_json::json!({
                "module": name,
                "stream": key,
                "kind": "stream",
                "tool": "stream_watch_start",
                "requiresApproval": false,
                "envelope": "stream_watch_start({ module, stream, args }) — then render the returned topic with a live_chart / live_feed component. Stop it with stream_watch_stop.",
            });
            if !desc.is_empty() {
                extra["desc"] = serde_json::Value::String(desc.to_string());
            }
            if !key_desc.is_empty() {
                extra["keyDesc"] = serde_json::Value::String(key_desc.to_string());
            }
            // Name the subscribe args explicitly. The declaration already carries them as
            // `{name}` / `{name:default}` placeholders in the frame, but the catalog only exposed
            // `keyDesc` — a description with no NAME. So the model read the frame's wire field and
            // called with it (2026-07-23 실측: 한투 프레임의 `tr_key` → "required param missing:
            // key"). Derived from the declaration, so no per-module hardcode.
            let arg_names = stream_arg_names(decl);
            if !arg_names.is_empty() {
                let mut params = serde_json::Map::new();
                let mut example = serde_json::Map::new();
                for (n, default) in &arg_names {
                    let mut desc = if n == "key" && !key_desc.is_empty() {
                        key_desc.to_string()
                    } else {
                        format!("subscribe arg `{n}`")
                    };
                    if let Some(d) = default {
                        desc.push_str(&format!(" — optional, defaults to \"{d}\""));
                        example.insert(n.clone(), serde_json::Value::String(d.clone()));
                    } else {
                        desc.push_str(" — required");
                        example.insert(n.clone(), serde_json::Value::String(format!("<{n}>")));
                    }
                    params.insert(n.clone(), serde_json::Value::String(desc));
                }
                extra["params"] = serde_json::Value::Object(params);
                extra["example"] = serde_json::json!({
                    "module": name, "stream": key, "args": serde_json::Value::Object(example)
                });
            }
            for field in ["trId", "realtimeMatch", "typeCodes"] {
                if let Some(v) = decl.get(field) {
                    extra[field] = v.clone();
                }
            }
            CatalogEntry {
                // `stream:` keeps the id namespace disjoint from action ids.
                id: format!("{}:stream:{}", name, key),
                name: key.clone(),
                description: format!("{} {}", ident.join(" "), sem.trim()),
                extra,
                vocab: tag_words
                    .iter()
                    .cloned()
                    .chain(std::iter::once(key.clone()))
                    .collect(),
            }
        })
        .collect()
}

/// Every `[...]` group in a param description, split into tokens. Modules tag a param with the
/// actions it belongs to (`[short/ultra-*]`, `[medium-land] … [medium-ta] …`); a description may
/// carry several groups. Tokens keep `-`/`_`/`*` so wildcards and action ids survive the split.
fn tag_tokens(desc: &str) -> Vec<String> {
    let chars: Vec<char> = desc.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            if let Some(end) = (i + 1..chars.len()).find(|&j| chars[j] == ']') {
                let inner: String = chars[i + 1..end].iter().collect();
                for t in inner.split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_' || c == '*')) {
                    let t = t.trim();
                    if !t.is_empty() {
                        out.push(t.to_string());
                    }
                }
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Names the `<param>CacheKey` / `Limit` / `Range` siblings in an entry's `params`, for every
/// `cacheInputs` param the entry already lists.
///
/// Only params this action takes get siblings — the catalog decides relevance, this decides
/// completeness. A nested `"<list>.*.<field>"` declaration names the field, since that is the key
/// the model writes inside each element.
fn add_cache_key_params(extra: &mut serde_json::Value, config: &serde_json::Value) {
    use crate::utils::cache_inputs::{declared, parse_nested, sibling_schemas};
    let declared = declared(config);
    if declared.is_empty() {
        return;
    }
    let Some(params) = extra.get_mut("params").and_then(|p| p.as_object_mut()) else {
        return;
    };
    for entry in &declared {
        let (listed, param, nested) = match parse_nested(entry) {
            None => (entry.clone(), entry.clone(), false),
            Some(spec) => (spec.list.clone(), spec.field.clone(), true),
        };
        if !params.contains_key(&listed) {
            continue;
        }
        for (name, schema) in sibling_schemas(&param, nested) {
            let Some(desc) = schema.get("description").and_then(|d| d.as_str()) else { continue };
            params
                .entry(name)
                .or_insert_with(|| serde_json::Value::String(desc.to_string()));
        }
    }
}

/// `ultra-*` matches `ultra-short`; otherwise an exact action-id match.
fn token_matches(tok: &str, action: &str) -> bool {
    match tok.strip_suffix('*') {
        Some(prefix) => action.starts_with(prefix),
        None => tok == action,
    }
}

/// Does this param belong to `action`? A bracket group only counts as an action tag when at least
/// one of its tokens names a real action of the module — so an incidental `[필수]` never filters
/// anything out. Untagged params are module-wide and always apply.
fn param_applies(desc: &str, action: &str, all_actions: &[&str]) -> bool {
    let toks = tag_tokens(desc);
    let action_toks: Vec<&String> = toks
        .iter()
        .filter(|t| all_actions.iter().any(|a| token_matches(t, a)))
        .collect();
    if action_toks.is_empty() {
        return true;
    }
    action_toks.iter().any(|t| token_matches(t, action))
}

/// Scope the module-wide param map to one action. Falls back to the full map when the filter would
/// leave nothing (a module that tags every param but not this action — never hide everything).
fn filter_params_for_action(
    params: &serde_json::Value,
    action: &str,
    all_actions: &[&str],
) -> serde_json::Value {
    let Some(map) = params.as_object() else {
        return params.clone();
    };
    if all_actions.is_empty() {
        return params.clone();
    }
    let filtered: serde_json::Map<String, serde_json::Value> = map
        .iter()
        .filter(|(_, v)| {
            v.as_str()
                .map(|d| param_applies(d, action, all_actions))
                .unwrap_or(true)
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if filtered.is_empty() {
        return params.clone();
    }
    serde_json::Value::Object(filtered)
}

/// Derive catalog entries from a module's `input` JSON schema when it declares no explicit
/// `actionCatalog` (Part 1-A — uniform discovery for every module). A module with an
/// `input.properties.action.enum` yields one entry per action (params = the input properties, so
/// get_action_schema returns the real params); a module without an action enum yields a single
/// entry keyed by the module name. Pure — reads only the already-fetched config.
fn derive_entries_from_input(
    name: &str,
    config: &serde_json::Value,
    approval_decl: &serde_json::Value,
) -> Vec<CatalogEntry> {
    let props = config
        .get("input")
        .and_then(|i| i.get("properties"))
        .and_then(|p| p.as_object());
    // get_action_schema params = {param: description(+enum hint)}, excluding the `action` selector.
    let params: serde_json::Value = {
        let mut m = serde_json::Map::new();
        if let Some(props) = props {
            for (k, v) in props {
                if k == "action" {
                    continue;
                }
                let desc = v.get("description").and_then(|d| d.as_str()).unwrap_or("");
                let enum_hint = v
                    .get("enum")
                    .and_then(|e| e.as_array())
                    .map(|a| {
                        let vals: Vec<String> =
                            a.iter().filter_map(|x| x.as_str().map(String::from)).collect();
                        if vals.is_empty() {
                            String::new()
                        } else {
                            format!(" (enum: {})", vals.join(", "))
                        }
                    })
                    .unwrap_or_default();
                m.insert(
                    k.clone(),
                    serde_json::Value::String(format!("{}{}", desc, enum_hint).trim().to_string()),
                );
            }
        }
        serde_json::Value::Object(m)
    };
    // Short module blurb — first sentence / 120 chars, for the single-purpose fallback and as
    // semantic filler when an action has no per-action description fragment.
    let module_blurb: String = config
        .get("description")
        .and_then(|d| d.as_str())
        .unwrap_or("")
        .split(['\n', '.'])
        .next()
        .unwrap_or("")
        .chars()
        .take(120)
        .collect();
    let module_blurb = module_blurb.trim().to_string();
    let ident = module_identity(name, config);
    let tag_words = module_tags(config);

    let action_prop = props.and_then(|p| p.get("action"));
    let action_enum = action_prop.and_then(|a| a.get("enum")).and_then(|e| e.as_array());
    let action_desc_blob = action_prop
        .and_then(|a| a.get("description"))
        .and_then(|d| d.as_str())
        .unwrap_or("");
    let envelope = if action_enum.is_some() {
        "{ \"action\": \"<id>\", <params...> } — flat: action selector + params at the top level"
    } else {
        "{ <params...> } — flat: params at the top level (this module has no action selector)"
    };
    // All action ids of this module — needed to tell a real action tag (`[short/ultra-*]`) apart
    // from an incidental bracket in a description (`[필수]`), so the filter can't strip params.
    let all_actions: Vec<&str> = action_enum
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
        .unwrap_or_default();
    // Module-level required params (minus the `action` selector) — surfaced per action after the
    // same tag filter, so the model sees what it must supply.
    let module_required: Vec<String> = config
        .get("input")
        .and_then(|i| i.get("required"))
        .and_then(|r| r.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .filter(|s| *s != "action")
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    let make_extra = |action_id: &str| -> serde_json::Value {
        // F1 — params scoped to THIS action. The derived catalog used to hand every action the
        // module-wide union, so `get_action_schema(kma-weather, short)` listed 15+ params with no
        // way to tell that `short` needs lat+lon → the model called it without coords and the
        // 22:00 weather cron died on `coords_required` (2026-07-09 실측). Params whose description
        // carries an action tag (`[short/ultra-*]`, `[medium-ta]`, …) are kept only for the
        // actions they name; untagged params are module-wide and always kept.
        let scoped = filter_params_for_action(&params, action_id, &all_actions);
        // `required` must state the ACTUAL call contract. It used to list module params minus
        // the `action` selector — the envelope prose said "include action" but the structured
        // field denied it, and a model trusts the structured field over prose: ta was called
        // with bars-and-no-action six times across two measured turns (33/34, 2026-08-11),
        // each refusal burning a round. A selector module's first required param IS `action`.
        let mut required: Vec<String> = module_required
            .iter()
            .filter(|r| scoped.get(r.as_str()).is_some())
            .cloned()
            .collect();
        if !all_actions.is_empty() {
            required.insert(0, "action".to_string());
        }
        let mut extra = serde_json::json!({
            "module": name,
            "action": action_id,
            "params": scoped,
            "envelope": envelope,
            "requiresApproval": requires_approval_value(approval_decl, action_id),
            "derived": true,
        });
        // A screen action is refused on every surface a model can reach, so discovery has to say
        // so — otherwise the model finds it, calls it, reads the refusal and has spent a round
        // learning what the catalog already knew. Joined from the module config, same as approval.
        if let Some(ui_decl) = config.get("uiOnly") {
            if crate::utils::pending_tools::is_ui_only_value(ui_decl, action_id) {
                extra["uiOnly"] = serde_json::Value::Bool(true);
            }
        }
        if !required.is_empty() {
            extra["required"] = serde_json::json!(required);
        }
        extra
    };

    match action_enum {
        Some(actions) => actions
            .iter()
            .filter_map(|a| a.as_str())
            .map(|act| {
                let frag = derive_action_fragment(action_desc_blob, act, &all_actions);
                let extra = make_extra(act);
                // Semantic text = the action's OWN signal only. The module blurb used to become the
                // whole document whenever no fragment parsed — identical text across actions can't
                // discriminate, and worse, it drags every one of them toward whatever the blurb
                // enumerates (naver-search's blurb lists 뉴스·블로그 → shopping actions beat plain
                // `search` on a news query, 2026-07-28 실측). Only the module's identity clause is
                // kept as a last resort, never its type enumerations.
                let mut sem = if frag.is_empty() {
                    format!("{} {}", act, first_clause(&module_blurb))
                } else {
                    frag
                };
                // Enum values of THIS action's params are the sharpest declared signal for what it
                // covers — `search` carries type=[webkr, blog, news, image, shop, …], which is what
                // actually connects a news query to it. Declared data, no per-module wiring.
                // What a person reads is not what the index matches on. The enum soup below is
                // excellent retrieval signal and unreadable prose: a search row for upbit's
                // candle-days came back "업비트 **공개 시세** GET POST DELETE limit best
                // cancel_maker…" — the module blurb plus every enum any param declares, identical
                // in spirit across days/weeks/months, so the row could not tell them apart
                // (2026-08-06 실측). Keep the soup in `description` (the embedded document) and
                // hand the row a clean `display`.
                let display = if sem.trim().is_empty() {
                    first_clause(&module_blurb)
                } else {
                    sem.trim().to_string()
                };
                let mut extra = extra;
                if !display.is_empty() {
                    extra["display"] = serde_json::Value::String(display);
                }
                let vals = param_enum_values(&extra);
                if !vals.is_empty() {
                    sem.push(' ');
                    sem.push_str(&vals.join(" "));
                }
                CatalogEntry {
                    id: format!("{}:{}", name, act),
                    name: act.to_string(),
                    description: format!("{} {}", ident.join(" "), sem.trim()),
                    extra,
                    vocab: tag_words
                        .iter()
                        .cloned()
                        .chain(std::iter::once(act.to_string()))
                        .collect(),
                }
            })
            .collect(),
        None => vec![CatalogEntry {
            id: format!("{}:{}", name, name),
            name: name.to_string(),
            description: format!("{} {}", ident.join(" "), module_blurb),
            extra: make_extra(name),
            vocab: tag_words.clone(),
        }],
    }
}

/// Module blurb's identity clause — up to the first `—`/`(`/`.`/newline. The rest is usually a
/// type enumeration that homogenizes every action's document (see `derive_entries_from_input`).
fn first_clause(blurb: &str) -> String {
    let cut = blurb
        .char_indices()
        .find(|(_, c)| *c == '—' || *c == '(' || *c == '\n' || *c == '.')
        .map(|(i, _)| i)
        .unwrap_or(blurb.len());
    blurb[..cut].trim().to_string()
}

/// Enum values declared on this action's params, flattened for the search document. Reads the
/// `(enum: a, b, c)` hint the param map already carries, so there is one source of truth.
fn param_enum_values(extra: &serde_json::Value) -> Vec<String> {
    let Some(params) = extra.get("params").and_then(|p| p.as_object()) else { return Vec::new() };
    let mut out = Vec::new();
    for v in params.values() {
        let Some(desc) = v.as_str() else { continue };
        let Some(at) = desc.find("(enum: ") else { continue };
        let rest = &desc[at + "(enum: ".len()..];
        let Some(end) = rest.find(')') else { continue };
        for tok in rest[..end].split(',') {
            let t = tok.trim();
            if !t.is_empty() && out.len() < 40 && !out.iter().any(|x: &String| x == t) {
                out.push(t.to_string());
            }
        }
    }
    out
}

/// Action ids may contain '-'/'_' ("ultra-short" vs "short") — a token boundary must treat
/// them as id chars, or "short" matches inside "ultra-short=" (2026-07-11 실측: kma-weather
/// `short` picked up the wrong fragment).
fn is_id_char(c: char) -> bool {
    c.is_alphanumeric() || c == '-' || c == '_'
}

/// One-line search-row description — trigger-level (what the action is), never params.
/// Char-boundary safe cap so a long authored desc doesn't bloat the discovery rows.
fn clip_row_desc(s: &str) -> String {
    const CAP: usize = 140;
    let t = s.trim();
    if t.chars().count() <= CAP {
        return t.to_string();
    }
    let cut: String = t.chars().take(CAP).collect();
    format!("{}…", cut.trim_end())
}

/// Where `action`'s marker sits in `blob`, as (key_start, desc_start). Marker dialects:
/// - plain:    `action=desc` / `action:desc`
/// - compound: `a/b/c=desc` — every slash-joined action in the key shares the description.
/// Both sides token-boundary checked with [`is_id_char`].
fn find_action_marker(blob: &str, action: &str) -> Option<(usize, usize)> {
    // Wildcard markers — a blob often documents a family once (`shopping-*=쇼핑인사이트`) instead of
    // listing every id. Without this, every member fell through to the module blurb, so five naver
    // shopping actions were indexed with the module's news/blog-heavy text and outranked plain
    // `search` on a NEWS query (2026-07-28 실측: 정답이 7위). Longest prefix wins so `a-b-*` beats `a-*`.
    if !action.is_empty() {
        let mut best: Option<(usize, usize, usize)> = None; // (prefix_len, key_start, desc_start)
        let mut from = 0usize;
        while let Some(rel) = blob[from..].find('*') {
            let star = from + rel;
            from = star + 1;
            // The prefix is the id-chars immediately before `*`, and it must prefix this action.
            let key_start = key_true_start(blob, star);
            let prefix = &blob[key_start..star];
            if prefix.is_empty() || !action.starts_with(prefix) || prefix == action {
                continue;
            }
            // Only a real marker — `prefix*` must be followed by a separator (`=` or `:`).
            let after = blob[star + 1..].trim_start();
            let Some(c) = after.chars().next() else { continue };
            if c != '=' && c != ':' {
                continue;
            }
            let desc_start = blob.len() - after.len() + c.len_utf8();
            if best.map(|(l, _, _)| prefix.len() > l).unwrap_or(true) {
                best = Some((prefix.len(), key_start, desc_start));
            }
        }
        if let Some((_, k, d)) = best {
            return Some((k, d));
        }
    }
    find_exact_action_marker(blob, action)
}

fn find_exact_action_marker(blob: &str, action: &str) -> Option<(usize, usize)> {
    let mut search_from = 0;
    while let Some(rel) = blob[search_from..].find(action) {
        let pos = search_from + rel;
        search_from = pos + action.len().max(1);
        let ok_before =
            pos == 0 || !blob[..pos].chars().last().map(is_id_char).unwrap_or(false);
        if !ok_before {
            continue;
        }
        let after = &blob[pos + action.len()..];
        match after.chars().next() {
            Some(c @ ('=' | ':')) => {
                return Some((key_true_start(blob, pos), pos + action.len() + c.len_utf8()));
            }
            Some('/') => {
                // compound key — walk forward over id chars and '/' to the '='/':'.
                let mut idx = pos + action.len();
                for c in after.chars() {
                    if is_id_char(c) || c == '/' {
                        idx += c.len_utf8();
                        continue;
                    }
                    if c == '=' || c == ':' {
                        return Some((key_true_start(blob, pos), idx + c.len_utf8()));
                    }
                    break;
                }
            }
            _ => {}
        }
    }
    None
}

/// Walk back from a matched action token to the true start of its (possibly compound) key —
/// clipping a fragment at a mid-key position would leave a dangling "medium-land/" tail.
fn key_true_start(blob: &str, mut pos: usize) -> usize {
    while pos > 0 {
        let Some(prev) = blob[..pos].chars().last() else { break };
        if is_id_char(prev) || prev == '/' {
            pos -= prev.len_utf8();
        } else {
            break;
        }
    }
    pos
}

/// Best-effort per-action description from an enum-description blob like
/// "quote=current price / history=OHLCV time series" or
/// "short/ultra-now/ultra-short=단기예보, fcst-version=…" (compound keys, comma separation).
/// The fragment runs from the action's marker to the next OTHER action's marker (blobs
/// separate entries with ", " as often as " / ", so a fixed separator under-splits), then
/// trailing separators are trimmed. "" when the blob has no marker for this action.
fn derive_action_fragment(blob: &str, action: &str, all_actions: &[&str]) -> String {
    let Some((_, desc_start)) = find_action_marker(blob, action) else {
        return String::new();
    };
    let rest = &blob[desc_start..];
    let mut end = rest.len();
    if let Some(p) = rest.find(" / ") {
        end = end.min(p);
    }
    for other in all_actions {
        if *other == action {
            continue;
        }
        if let Some((key_start, _)) = find_action_marker(rest, other) {
            end = end.min(key_start);
        }
    }
    rest[..end]
        .trim()
        .trim_end_matches([',', '.', ';', '·', ' '])
        .to_string()
}

#[async_trait::async_trait]
impl CatalogSource for ModuleActionSource {
    async fn load(&self) -> Vec<CatalogEntry> {
        let mut entries: Vec<CatalogEntry> = Vec::new();
        for m in self.module.list_system_modules().await {
            entries.extend(self.module_entries("system", &m.name).await);
        }
        for m in self.module.list_user_modules().await {
            entries.extend(self.module_entries("user", &m.name).await);
        }
        entries
    }
}

/// 모듈명 → 실제로 노출되는 sysmod 도구 이름. `mcp_server` 등록 규칙(`sysmod_<name>`, dash→
/// underscore)의 단일 소스를 발견 응답 쪽에서도 그대로 쓴다 — 두 곳이 어긋나면 모델이 없는
/// 도구를 부른다.
pub(crate) fn sysmod_tool_name(module: &str) -> String {
    format!("sysmod_{}", module.replace('-', "_"))
}

pub struct ModuleActionCatalog {
    catalog: RefreshingCatalog,
    /// Kept for read-time detail the index must not freeze — registered accounts change with a
    /// vault write, while the catalog rebuilds on a TTL.
    module: Arc<ModuleManager>,
}

impl ModuleActionCatalog {
    pub fn new(
        module: Arc<ModuleManager>,
        embedder: Arc<dyn IEmbedderPort>,
        cache_port: Arc<dyn IEmbedderCachePort>,
    ) -> Self {
        Self {
            catalog: RefreshingCatalog::new(
                "module-actions",
                embedder,
                cache_port,
                Arc::new(ModuleActionSource {
                    module: module.clone(),
                }),
                REBUILD_TTL,
            ),
            module,
        }
    }

    /// Local fallback embedder passthrough (dual-embed) — primary(remote) 장애 시 로컬 세트로
    /// 통째 폴백 (see `SemanticCatalog::with_secondary`).
    pub fn with_secondary(
        mut self,
        secondary: Arc<dyn IEmbedderPort>,
    ) -> Self {
        self.catalog = self.catalog.with_secondary(secondary);
        self
    }

    /// Boot-time warm-up (see RefreshingCatalog::warm) — main.rs spawns this so an API
    /// embedder's first full build doesn't stall the first search_module_actions call.
    pub async fn warm(&self) {
        self.catalog.warm().await;
    }

    /// Primary embedder version label — S0 섀도우 로그에 어느 임베더의 shortlist 인지 태그.
    pub fn embedder_label(&self) -> &str {
        self.catalog.embedder_label()
    }

    /// Cross-module (default) or per-module semantic action search. Returns DISCOVERY rows
    /// only — id/name/domain/one-line desc/approval flag, deliberately NO param information:
    /// an index line must be a trigger, never enough to act on, or models guess the call
    /// instead of loading the detail (get_action_schema). Same principle as the skills index
    /// (2026-07-08: "인덱스만 보고 다 봤다고 생각" — 사용자 진단). The one-line `desc` IS
    /// trigger-level and required: derived modules' rows were bare cryptic ids ("short",
    /// "pwn-code") with nothing to tell them apart, so the model round-tripped
    /// get_action_schema per candidate and burned its per-turn cap (2026-07-11 날씨 cron 실측).
    pub async fn search(
        &self,
        query: &str,
        module: Option<&str>,
        limit: usize,
    ) -> Result<Vec<serde_json::Value>, String> {
        Ok(self.search_analyzed(query, module, limit).await?.0)
    }

    /// `search` + the OOV analysis (rows, all_oov, dropped_tokens, searched_with, embedder) — the handler
    /// uses `all_oov` to answer a zero-signal query (bare subject name) with a teaching hint
    /// instead of confident junk rows.
    pub async fn search_analyzed(
        &self,
        query: &str,
        module: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<serde_json::Value>, bool, Vec<String>, String, String), String> {
        let scopes: Option<Vec<String>> = module.map(|m| vec![format!("{}:", m)]);
        let outcome = self
            .catalog
            .query_analyzed(query, limit, scopes.as_deref())
            .await
            .map_err(|e| e.to_string())?;
        let all_oov = outcome.all_oov;
        let dropped = outcome.dropped_tokens;
        let searched_with = outcome.searched_with;
        let embedder = outcome.embedder;
        let rows = outcome
            .matches
            .into_iter()
            .map(|m| {
                // Streams (F4) carry `stream`/`kind` instead of `action` — the row tells the model
                // which tool to reach for (stream_watch_start vs the module tool).
                // 3-decimal score — the raw f32 (0.8196595907211304) is token noise with false
                // precision a model can't calibrate anyway.
                let score = (m.score * 1000.0).round() / 1000.0;
                let is_stream = m.extra.get("kind").and_then(|v| v.as_str()) == Some("stream");
                if is_stream {
                    return serde_json::json!({
                        "module": m.extra.get("module").cloned().unwrap_or_default(),
                        "stream": m.extra.get("stream").cloned().unwrap_or_default(),
                        "kind": "stream",
                        "name": m.name,
                        "desc": m.extra.get("desc").cloned().unwrap_or_default(),
                        "tool": "stream_watch_start",
                        // Streams DO have a discoverable contract — get_action_schema accepts the
                        // stream key (F4). Without this pointer models assume "no schema for
                        // streams" and invent subscribe args (9차 실측: quotes 에 stk_cd/interval
                        // 발명 — 실제 키움 quotes args 는 item/type).
                        "next": "subscribe args are NOT guessable — call get_action_schema(module, stream) first; it returns the subscribe contract (arg names + type codes), then stream_watch_start({module, stream, args}).",
                        "score": score,
                    });
                }
                let module_name = m.extra.get("module").cloned().unwrap_or_default();
                let mut row = serde_json::json!({
                    "module": module_name,
                    "action": m.extra.get("action").cloned().unwrap_or_default(),
                    "kind": "action",
                    // 호출할 도구 이름 — 모듈명(`kma-weather`)과 노출 도구명(`sysmod_kma_weather`)이
                    // 달라서, 이게 없으면 모델이 자기 도구 목록을 뒤져 이름을 맞춘다(2026-07-27 실측:
                    // 두 턴 모두 `ALL_TOOLS.filter(x => x.name.includes("sysmod_..."))` 로 한 라운드
                    // 소모). stream 행은 이미 `tool` 을 주고 있었는데 action 행에만 없었다.
                    "tool": sysmod_tool_name(module_name.as_str().unwrap_or_default()),
                    "name": m.name,
                    "domain": m.extra.get("domain").cloned().unwrap_or_default(),
                    "requiresApproval": m.extra.get("requiresApproval").cloned().unwrap_or(serde_json::Value::Bool(false)),
                    "score": score,
                });
                // `display` when the entry has one — see the note where it is built. Falls back to
                // the embedded document for entries that predate it.
                let source = m
                    .extra
                    .get("display")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&m.description);
                let desc = clip_row_desc(source);
                if !desc.is_empty() && desc != m.name {
                    row["desc"] = serde_json::Value::String(desc);
                }
                // Param names + what is required, in the row. A search hit that names neither
                // leaves the model no choice but a get_action_schema round for every candidate
                // it is weighing — and the round budget is what ran out on 2026-08-06 (13 calls,
                // no answer). Names only: the descriptions stay behind get_action_schema, which
                // keeps the disclosure progressive without making discovery a guessing game.
                let param_names: Vec<String> = m
                    .extra
                    .get("params")
                    .and_then(|p| p.as_object())
                    .map(|o| o.keys().cloned().collect())
                    .or_else(|| {
                        m.extra.get("paramNames").and_then(|v| v.as_array()).map(|a| {
                            a.iter().filter_map(|x| x.as_str().map(String::from)).collect()
                        })
                    })
                    .unwrap_or_default();
                if !param_names.is_empty() {
                    const PARAM_CAP: usize = 12;
                    let shown: Vec<String> = param_names.iter().take(PARAM_CAP).cloned().collect();
                    // `paramNames`, not `params`: the field name has to say what it is, because a
                    // bare `params` list reads as THE FORM. Measured 2026-08-13 (turn 57): the row
                    // showed `limit`/`tmFc`, the model reasoned "I already have enough info" and
                    // skipped get_action_schema, and the gate spent a round teaching it otherwise.
                    // The response-level `next` already said to fetch the schema; an instruction
                    // one level away does not survive a field that looks complete.
                    row["paramNames"] = serde_json::json!(shown);
                    if param_names.len() > PARAM_CAP {
                        row["paramNamesMore"] = serde_json::json!(param_names.len() - PARAM_CAP);
                    }
                }
                if let Some(req) = m.extra.get("required") {
                    row["required"] = req.clone();
                }
                if m.extra.get("uiOnly").and_then(|v| v.as_bool()) == Some(true) {
                    row["uiOnly"] = serde_json::Value::Bool(true);
                    row["uiOnlyNote"] = serde_json::Value::String(
                        "screen action — not callable here. Tell the user to run it from the module's settings screen; use the read-only actions to explain the situation."
                            .to_string(),
                    );
                }
                // Only surface the flag when true — a `false` on every other row is noise.
                if m.extra.get("pageBinding").and_then(|v| v.as_bool()) == Some(true) {
                    row["pageBinding"] = serde_json::Value::Bool(true);
                    row["pageBindingNote"] = serde_json::Value::String(
                        "usable as a page binding: a published page can re-run this per visit — live chart `seed` {module,action,args} or a `module` block."
                            .to_string(),
                    );
                }
                row
            })
            .collect();
        Ok((rows, all_oov, dropped, searched_with, embedder))
    }

    /// Full detail for one action — params with descriptions + example + call envelope +
    /// any extra declared fields (method/path/trId …).
    pub async fn schema(&self, module: &str, action: &str) -> Option<serde_json::Value> {
        // Streams live under a `stream:` id namespace (F4) — accept the bare key the search row
        // handed the model (`get_action_schema(kiwoom, quotes)`) as well as the qualified id.
        let entry = match self.catalog.get(&format!("{}:{}", module, action)).await {
            Some(e) => e,
            None => {
                self.catalog
                    .get(&format!("{}:stream:{}", module, action))
                    .await?
            }
        };
        let mut out = serde_json::json!({
            "module": module,
            "action": action,
            "name": entry.name,
            // 검색 행과 동일 — 스키마만 보고 바로 호출할 수 있게 도구 이름을 함께 준다.
            "tool": sysmod_tool_name(module),
        });
        if let Some(obj) = entry.extra.as_object() {
            for (k, v) in obj {
                if matches!(k.as_str(), "module" | "action" | "paramNames") {
                    continue;
                }
                out[k] = v.clone();
            }
        }
        // Some source API docs carry no param table (KIS: 41 actions) — silence here sent
        // models on an endless param hunt (search loop). Say it explicitly + point at the
        // definitive next step instead.
        let params_empty = out
            .get("params")
            .map(|p| p.as_object().map(|o| o.is_empty()).unwrap_or(true))
            .unwrap_or(true);
        if params_empty {
            out["paramsNote"] = serde_json::Value::String(
                "Parameter docs are NOT available for this action — searching again will not \
                 reveal them. Construct the call from the envelope hint (+ method/path/trId) and \
                 the module input schema (get_module_config); the module's validation errors will \
                 name any missing field."
                    .to_string(),
            );
        }
        // Registered accounts belong with the params the model is reading right now — they are
        // what "조회는 주계좌, 주문은 이 계좌" turns into on the wire, and they change without a
        // catalog rebuild, so they are resolved per call rather than indexed.
        if let Some(doc) = self.module.account_param_doc(module).await {
            match out.get_mut("params").and_then(|p| p.as_object_mut()) {
                Some(p) => {
                    p.insert("account".to_string(), serde_json::Value::String(doc));
                }
                None => out["params"] = serde_json::json!({ "account": doc }),
            }
        }
        Some(out)
    }

    /// Whether any catalog entries exist for this module — error-hint branching (S3).
    pub async fn has_module(&self, module: &str) -> bool {
        self.catalog.has_prefix(&format!("{}:", module)).await
    }

    /// Distinct cataloged module names — lets search/schema responses say definitively
    /// which modules are indexed (uncataloged module = call it directly, stop searching).
    pub async fn cataloged_modules(&self) -> Vec<String> {
        self.catalog.id_prefixes().await
    }

    /// 한 모듈의 액션 **목록**(순위 없음, params 없음) — 의미검색이 아니라 색인 열람.
    ///
    /// 왜: reasoning 실측(2026-07-27)에서 모델이 `sysmod_yfinance {action:"noop"}` 처럼 **일부러
    /// 틀린 값**을 넣어 검증 에러가 뱉는 enum 으로 액션 목록을 얻어냈다. "이 모듈에 뭐가 있나"를
    /// 물을 통로가 없어서 에러를 발견 채널로 쓴 것이다. 정직한 통로를 준다.
    ///
    /// params·envelope 은 넣지 않는다 — 인덱스는 트리거만(상세는 get_action_schema). 옛 enum
    /// 통째 덤프로 되돌아가면 약한 모델 오선택이 재발한다.
    pub async fn list_module_actions(
        &self,
        module: &str,
        domain: Option<&str>,
    ) -> Vec<serde_json::Value> {
        let tool = sysmod_tool_name(module);
        self.catalog
            .entries_with_prefix(&format!("{}:", module))
            .await
            .into_iter()
            .filter(|e| match domain {
                Some(d) => e.extra.get("domain").and_then(|v| v.as_str()) == Some(d),
                None => true,
            })
            .map(|e| {
                let is_stream = e.extra.get("kind").and_then(|v| v.as_str()) == Some("stream");
                let mut row = serde_json::json!({
                    "module": module,
                    "kind": if is_stream { "stream" } else { "action" },
                    "name": e.name,
                    "tool": if is_stream { "stream_watch_start".to_string() } else { tool.clone() },
                });
                let key = if is_stream { "stream" } else { "action" };
                if let Some(v) = e.extra.get(key) {
                    row[key] = v.clone();
                }
                for k in ["domain", "requiresApproval", "pageBinding"] {
                    if let Some(v) = e.extra.get(k) {
                        row[k] = v.clone();
                    }
                }
                row["desc"] = serde_json::json!(clip_row_desc(&e.description));
                row
            })
            .collect()
    }

    /// 그 모듈의 도메인별 액션 수 — 액션이 너무 많은 모듈(한투 280)의 1단 색인.
    /// 280 개를 통째로 주면 우리가 없앤 enum 덤프로 되돌아간다. 도메인 → 액션 2단으로 좁힌다.
    pub async fn module_domains(&self, module: &str) -> Vec<serde_json::Value> {
        let mut counts: std::collections::BTreeMap<String, usize> = Default::default();
        for e in self.catalog.entries_with_prefix(&format!("{}:", module)).await {
            let d = e
                .extra
                .get("domain")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            *counts.entry(d).or_insert(0) += 1;
        }
        counts
            .into_iter()
            .map(|(domain, count)| serde_json::json!({ "domain": domain, "actions": count }))
            .collect()
    }
}

#[cfg(test)]
mod f1_param_scope_tests {
    use super::*;

    // Real kma-weather shapes (the module whose 22:00 cron died on the union blob).
    const ACTIONS: &[&str] = &[
        "short", "ultra-short", "ultra-now", "medium-land", "medium-ta", "medium-sea",
        "medium-fcst", "pwn-code", "wthr-info", "alerts-prelim", "uv-index-v5", "typhoon-info",
    ];

    #[test]
    fn tagged_param_scopes_to_its_actions() {
        let lat = "[short/ultra-*] 위도 (예: 37.5665 서울). lon 과 같이 입력.";
        assert!(param_applies(lat, "short", ACTIONS));
        assert!(param_applies(lat, "ultra-short", ACTIONS)); // wildcard
        assert!(!param_applies(lat, "medium-ta", ACTIONS));
        assert!(!param_applies(lat, "pwn-code", ACTIONS));
    }

    #[test]
    fn multiple_tag_groups_all_count() {
        // regId carries one group per action, spread through the description.
        let reg_id = "[medium-land] 육상 예보 구역 코드. [medium-ta] 기온 지점 코드. [medium-sea] 해상 구역";
        assert!(param_applies(reg_id, "medium-ta", ACTIONS));
        assert!(param_applies(reg_id, "medium-land", ACTIONS));
        assert!(!param_applies(reg_id, "short", ACTIONS));
    }

    #[test]
    fn nested_group_tokens_match() {
        let stn_id = "[기상특보·기상정보 계열(alerts·alerts-prelim·wthr-info 및 목록형)/medium-fcst] 지점 번호";
        assert!(param_applies(stn_id, "wthr-info", ACTIONS));
        assert!(param_applies(stn_id, "medium-fcst", ACTIONS));
        assert!(!param_applies(stn_id, "short", ACTIONS));
    }

    #[test]
    fn untagged_param_is_module_wide() {
        assert!(param_applies("최대 결과 수", "short", ACTIONS));
        assert!(param_applies("최대 결과 수", "pwn-code", ACTIONS));
    }

    #[test]
    fn incidental_bracket_never_filters() {
        // `[필수]` names no action → not an action tag → param stays visible everywhere.
        let d = "[필수] 종목코드";
        assert!(param_applies(d, "short", ACTIONS));
        assert!(param_applies(d, "medium-ta", ACTIONS));
    }

    #[test]
    fn filter_scopes_the_map_and_never_empties_it() {
        let params = serde_json::json!({
            "lat": "[short/ultra-*] 위도",
            "lon": "[short/ultra-*] 경도",
            "regId": "[medium-land] 구역 코드",
            "areaCode": "[pwn-code] 특보 구역코드",
            "limit": "최대 결과 수",
        });
        let short = filter_params_for_action(&params, "short", ACTIONS);
        let keys: Vec<&String> = short.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["lat", "limit", "lon"]); // serde_json Map = BTreeMap (sorted)
        assert!(short.get("regId").is_none());
        assert!(short.get("areaCode").is_none());

        // An action nothing is tagged for keeps the full map rather than showing nothing.
        let full = filter_params_for_action(
            &serde_json::json!({ "regId": "[medium-land] x" }),
            "short",
            ACTIONS,
        );
        assert!(full.get("regId").is_some());
    }
}

#[cfg(test)]
mod action_fragment_tests {
    use super::*;

    #[test]
    fn legacy_slash_separated_markers() {
        let blob = "Action. quote=current price / history=OHLCV time series / info=company profile";
        let acts = ["quote", "history", "info"];
        assert_eq!(derive_action_fragment(blob, "quote", &acts), "current price");
        assert_eq!(derive_action_fragment(blob, "history", &acts), "OHLCV time series");
        assert_eq!(derive_action_fragment(blob, "info", &acts), "company profile");
    }

    #[test]
    fn short_does_not_match_inside_ultra_short() {
        // 2026-07-11 실측: "short" 마커가 "ultra-short=" 안에서 매칭돼 엉뚱한 fragment 를 얻던 것.
        let blob = "ultra-short=초단기예보, short=단기예보 (오늘~모레), fcst-version=수정버전";
        let acts = ["short", "ultra-short", "fcst-version"];
        assert_eq!(derive_action_fragment(blob, "short", &acts), "단기예보 (오늘~모레)");
        assert_eq!(derive_action_fragment(blob, "ultra-short", &acts), "초단기예보");
    }

    #[test]
    fn compound_key_shares_description() {
        let blob = "short/ultra-now/ultra-short=단기예보 시리즈, fcst-version=예보 수정버전 조회";
        let acts = ["short", "ultra-now", "ultra-short", "fcst-version"];
        for a in ["short", "ultra-now", "ultra-short"] {
            assert_eq!(derive_action_fragment(blob, a, &acts), "단기예보 시리즈");
        }
        assert_eq!(derive_action_fragment(blob, "fcst-version", &acts), "예보 수정버전 조회");
    }

    #[test]
    fn fragment_clips_before_next_compound_key() {
        let blob = "alerts=특보 목록, medium-land/medium-ta/medium-sea=중기 육상·기온·해상 (regId)";
        let acts = ["alerts", "medium-land", "medium-ta", "medium-sea"];
        // clipping at a mid-key token must not leave a dangling "medium-land/" tail.
        assert_eq!(derive_action_fragment(blob, "alerts", &acts), "특보 목록");
    }

    #[test]
    fn unknown_action_returns_empty() {
        let blob = "quote=current price";
        assert_eq!(derive_action_fragment(blob, "history", &["quote", "history"]), "");
    }

    /// 와일드카드 marker — 한 줄이 가족 전체를 문서화한 blob(실측: naver-search)에서 각 멤버가
    /// 그 조각을 받아야 한다. 못 받으면 모듈 공통 설명이 문서가 되어 뉴스 질의에 쇼핑 액션이 이긴다.
    #[test]
    fn wildcard_action_marker() {
        const ACTS: &[&str] = &[
            "search", "search-trend", "shopping-categories", "shopping-keywords",
            "shopping-by-device", "shopping-by-gender", "shopping-by-age",
        ];
        let blob = "API 액션. search=네이버 검색, search-trend=검색어 트렌드, shopping-*=쇼핑인사이트";
        assert_eq!(derive_action_fragment(blob, "search", ACTS), "네이버 검색");
        assert_eq!(derive_action_fragment(blob, "search-trend", ACTS), "검색어 트렌드");
        for a in ["shopping-categories", "shopping-keywords", "shopping-by-age"] {
            assert_eq!(derive_action_fragment(blob, a, ACTS), "쇼핑인사이트", "action={a}");
        }
        // 더 긴 접두사가 이긴다.
        let blob2 = "a-*=넓은 것, a-b-*=좁은 것";
        assert_eq!(derive_action_fragment(blob2, "a-b-c", &["a-b-c", "a-x"]), "좁은 것");
        assert_eq!(derive_action_fragment(blob2, "a-x", &["a-b-c", "a-x"]), "넓은 것");
    }

    /// 모듈 공통 설명은 **첫 절만** — 뒤의 타입 열거가 모든 액션 문서를 동질화한다.
    #[test]
    fn module_blurb_first_clause_only() {
        let blurb = "네이버 검색 + 데이터랩 API — 텍스트·뉴스·해석 용도 (주가 뉴스·블로그·쇼핑 키워드). 검색: webkr/blog/news";
        let c = first_clause(blurb);
        assert_eq!(c, "네이버 검색 + 데이터랩 API");
        assert!(!c.contains("뉴스"), "열거가 새면 안 된다: {c}");
    }

    /// 액션 고유 열거값이 검색 문서에 들어가야 — `search` 의 type=[news, …] 가 뉴스 질의를 잡는다.
    #[test]
    fn action_enum_values_enter_document() {
        let extra = serde_json::json!({
            "params": {
                "type": "검색 종류 (enum: webkr, blog, news, image, shop)",
                "query": "검색어",
            }
        });
        let vals = param_enum_values(&extra);
        assert!(vals.contains(&"news".to_string()), "{vals:?}");
        assert!(vals.contains(&"shop".to_string()));
        assert_eq!(param_enum_values(&serde_json::json!({})), Vec::<String>::new());
    }

    #[test]
    fn clip_row_desc_char_boundary() {
        let long = "가".repeat(200);
        let clipped = clip_row_desc(&long);
        assert!(clipped.chars().count() <= 141);
        assert!(clipped.ends_with('…'));
        assert_eq!(clip_row_desc("  짧은 설명  "), "짧은 설명");
    }
}

#[cfg(test)]
mod display_vs_document_tests {
    use super::*;

    /// The upbit shape of 2026-08-06: a module blurb, several candle actions with no per-action
    /// fragment, and params whose enums have nothing to do with telling them apart.
    fn upbit_like() -> serde_json::Value {
        serde_json::json!({
            "description": "업비트 Open API 중 **공개 시세** — 캔들·체결·호가·티커.",
            "input": {
                "properties": {
                    "action": { "type": "string", "enum": ["candle-days", "candle-weeks"] },
                    "market": { "type": "string", "description": "마켓 코드 (예: KRW-BTC)" },
                    "count":  { "type": "integer", "description": "조회 개수" },
                    "method": { "type": "string", "enum": ["GET", "POST", "DELETE"] },
                    "ord_type": { "type": "string", "enum": ["limit", "best", "cancel_maker"] }
                },
                "required": ["action"]
            }
        })
    }

    #[test]
    fn the_row_prose_drops_the_enum_soup_the_index_keeps() {
        let cfg = upbit_like();
        let entries = derive_entries_from_input("upbit", &cfg, &serde_json::Value::Null);
        let e = entries.iter().find(|e| e.name == "candle-days").expect("candle-days entry");
        // The embedded document keeps every retrieval signal, enum values included.
        assert!(e.description.contains("GET"), "index doc keeps enums: {}", e.description);
        // What a reader sees does not.
        let display = e.extra.get("display").and_then(|v| v.as_str()).unwrap_or("");
        assert!(!display.is_empty(), "an entry must have display prose");
        for noise in ["GET", "POST", "DELETE", "cancel_maker"] {
            assert!(!display.contains(noise), "display leaked {noise}: {display}");
        }
    }

    #[test]
    fn params_travel_with_the_entry_so_a_row_can_show_them() {
        let cfg = upbit_like();
        let entries = derive_entries_from_input("upbit", &cfg, &serde_json::Value::Null);
        let e = entries.first().expect("at least one entry");
        let params = e.extra.get("params").and_then(|p| p.as_object()).expect("params map");
        assert!(params.contains_key("market"), "param names must reach the row");
        assert!(!params.contains_key("action"), "the selector is not a param");
    }

    #[test]
    fn derived_required_names_the_action_selector() {
        // The structured `required` used to omit the selector while the envelope prose demanded
        // it — and a model trusts the structured field over prose: ta was called with
        // bars-and-no-action six times across two measured turns (33/34, 2026-08-11).
        let cfg = upbit_like();
        let entries = derive_entries_from_input("upbit", &cfg, &serde_json::Value::Null);
        let e = entries.first().expect("at least one entry");
        let req = e
            .extra
            .get("required")
            .and_then(|r| r.as_array())
            .expect("required list");
        assert_eq!(
            req.first().and_then(|v| v.as_str()),
            Some("action"),
            "a selector module's first required param is the selector itself"
        );
    }
}
