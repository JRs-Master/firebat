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
        let actions: Vec<serde_json::Value> = if let Some(arr) =
            decl.get("actions").and_then(|v| v.as_array())
        {
            arr.clone()
        } else if let Some(file) = decl.get("file").and_then(|v| v.as_str()) {
            match self.module.read_module_file(scope, name, file).await {
                Some(raw) => serde_json::from_str::<Vec<serde_json::Value>>(&raw).unwrap_or_default(),
                None => Vec::new(),
            }
        } else {
            Vec::new()
        };
        actions
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
                    "{} {} {}",
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
                Some(CatalogEntry {
                    id: format!("{}:{}", name, id),
                    name: a_name,
                    description: sem.trim().to_string(),
                    extra,
                })
            })
            .collect()
    }
}

/// F4 — one catalog entry per declared realtime WS subscription (`config.ws.streams.<key>`), so a
/// "실시간 / live" query surfaces `stream_watch_start` alongside REST actions. Entries are tagged
/// `kind: "stream"`; `get_action_schema(module, <key>)` returns the subscribe contract. Pure data —
/// the loader knows nothing about any provider.
fn derive_stream_entries(name: &str, config: &serde_json::Value) -> Vec<CatalogEntry> {
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
            // Realtime vocabulary is baked into the semantic text so "실시간 체결 차트" / "live
            // quotes" rank these above the snapshot REST actions they would otherwise lose to.
            // English trade/tick vocab included — an English query ("trade") was ranking US-stock
            // REST actions above the streams (07-11 실측: usa* 도배 위로 quotes 가 안 올라옴).
            let sem = format!(
                "{key} {desc} {key_desc} 실시간 라이브 스트림 구독 체결 틱 호가 시세 realtime live stream subscribe push tick trade execution quote orderbook"
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
            for field in ["trId", "realtimeMatch"] {
                if let Some(v) = decl.get(field) {
                    extra[field] = v.clone();
                }
            }
            CatalogEntry {
                // `stream:` keeps the id namespace disjoint from action ids.
                id: format!("{}:stream:{}", name, key),
                name: key.clone(),
                description: sem.trim().to_string(),
                extra,
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
        let required: Vec<&String> = module_required
            .iter()
            .filter(|r| scoped.get(r.as_str()).is_some())
            .collect();
        let mut extra = serde_json::json!({
            "module": name,
            "action": action_id,
            "params": scoped,
            "envelope": envelope,
            "requiresApproval": requires_approval_value(approval_decl, action_id),
            "derived": true,
        });
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
                // Semantic text = the action name (distinguishes quote↔history) + its fragment,
                // or the module blurb when no fragment is parseable.
                let sem = if frag.is_empty() {
                    format!("{} {}", act, module_blurb)
                } else {
                    frag
                };
                CatalogEntry {
                    id: format!("{}:{}", name, act),
                    name: act.to_string(),
                    description: sem.trim().to_string(),
                    extra: make_extra(act),
                }
            })
            .collect(),
        None => vec![CatalogEntry {
            id: format!("{}:{}", name, name),
            name: name.to_string(),
            description: module_blurb,
            extra: make_extra(name),
        }],
    }
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

pub struct ModuleActionCatalog {
    catalog: RefreshingCatalog,
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
                Arc::new(ModuleActionSource { module }),
                REBUILD_TTL,
            ),
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

    /// `search` + the OOV analysis (rows, all_oov, dropped_tokens) — the search tool handler
    /// uses `all_oov` to answer a zero-signal query (bare subject name) with a teaching hint
    /// instead of confident junk rows.
    pub async fn search_analyzed(
        &self,
        query: &str,
        module: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<serde_json::Value>, bool, Vec<String>), String> {
        let scopes: Option<Vec<String>> = module.map(|m| vec![format!("{}:", m)]);
        let outcome = self
            .catalog
            .query_analyzed(query, limit, scopes.as_deref())
            .await
            .map_err(|e| e.to_string())?;
        let all_oov = outcome.all_oov;
        let dropped = outcome.dropped_tokens;
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
                let mut row = serde_json::json!({
                    "module": m.extra.get("module").cloned().unwrap_or_default(),
                    "action": m.extra.get("action").cloned().unwrap_or_default(),
                    "kind": "action",
                    "name": m.name,
                    "domain": m.extra.get("domain").cloned().unwrap_or_default(),
                    "requiresApproval": m.extra.get("requiresApproval").cloned().unwrap_or(serde_json::Value::Bool(false)),
                    "score": score,
                });
                let desc = clip_row_desc(&m.description);
                if !desc.is_empty() && desc != m.name {
                    row["desc"] = serde_json::Value::String(desc);
                }
                row
            })
            .collect();
        Ok((rows, all_oov, dropped))
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

    #[test]
    fn clip_row_desc_char_boundary() {
        let long = "가".repeat(200);
        let clipped = clip_row_desc(&long);
        assert!(clipped.chars().count() <= 141);
        assert!(clipped.ends_with('…'));
        assert_eq!(clip_row_desc("  짧은 설명  "), "짧은 설명");
    }
}
