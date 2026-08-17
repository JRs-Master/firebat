//! Cache keys as module INPUT — the mirror of `dataCacheKey` on the render side.
//!
//! A large result is cached and the caller gets a key, so it never carries the rows in context. But
//! a module that consumes those rows had no way to accept the key: `technical-analysis` declares
//! `bars` as an array, so calling it meant serialising six hundred candles back into the tool call.
//! The model already held the data from `cache_read`, and computing a moving average itself is far
//! cheaper than echoing the series — so it computed, by hand, without the fee, tax, slippage and
//! stop handling the module would have applied (measured 2026-07-31, a golden-cross backtest).
//!
//! That is an economics problem, not a discovery one. Steering a model toward a tool that is
//! expensive to call does not work; making the call cheap does. A module declares which of its array
//! parameters may arrive as a key:
//!
//! ```json
//! "cacheInputs": ["bars"]
//! ```
//!
//! and the caller may then send `barsCacheKey` instead of `bars`. Expansion happens before schema
//! validation, so the module itself is unchanged and its `required` list still means what it says.
//!
//! # Nested declarations
//!
//! The rows a model wants to hand over are not always a top-level parameter. `docs.make_xlsx` takes
//! `sheets: [{name, headers, rows}]`, so the big array lives one level down and there was no key
//! path at all — measured 2026-08-12, a "일봉 (최근 120일)" sheet shipped whose `rows` were the
//! five-row inline preview the auto-cache truncation had shown the model. The chart was five stale
//! points under a 120-day label: the worst failure shape, because it looks like data.
//!
//! An entry may therefore be a path of exactly the shape `"<listParam>.*.<field>"`:
//!
//! ```json
//! "cacheInputs": ["blocks", "sheets.*.rows"]
//! ```
//!
//! Every element of `sheets` may then carry `rowsCacheKey` in place of `rows`. Plain entries keep
//! today's behaviour exactly; the two forms live in the same array.

use std::sync::Arc;

use crate::utils::sysmod_cache::SysmodCacheAdapter;

/// `bars` → `barsCacheKey`. Convention rather than a second declaration: one name to get wrong
/// instead of two.
pub fn key_field(param: &str) -> String {
    format!("{param}CacheKey")
}

/// `bars` → `barsLimit` / `barsRange`: the window vocabulary, borrowed verbatim from the render
/// layer's `dataLimit` / `dataRange` so a model learns it once and uses it in both places.
///
/// Without it the contract was all-or-nothing — "the server expands the FULL cached rows" — and a
/// turn that wanted the last fifteen candles of five hundred had exactly one way to say so:
/// hand-typing them. It did, the string broke mid-serialization, and the sheet shipped wrong
/// (measured 2026-08-12). The occasion is the bug; this removes it.
pub fn limit_field(param: &str) -> String {
    format!("{param}Limit")
}

pub fn range_field(param: &str) -> String {
    format!("{param}Range")
}

/// `rows` → `rowsColumns`: which record fields to take, in column order.
///
/// Only nested declarations (`<list>.*.<field>`) get this. A nested row set lands in a TABLE whose
/// columns are positional and paired with the caller's `headers`; a flat row set goes to a module
/// that reads its fields BY NAME, where choosing columns means nothing and reordering them cannot
/// be expressed (a JSON object has no order here). Measured 2026-08-13: a candle sheet asked for
/// six Korean headers, the expansion delivered the cache's THIRTEEN raw API fields, the headers
/// matched none of them, and after two repair attempts the model dropped its headers entirely —
/// shipping `acml_tr_pbmn` and `flng_cls_code` as column titles and a chart that plotted volume
/// against price on one axis.
pub fn columns_field(param: &str) -> String {
    format!("{param}Columns")
}

/// Projects records onto the named fields, in order. A field a record does not carry becomes
/// `null` — a hole, never a zero: a missing number drawn as 0 invents a trend (measured the same
/// day, an ROE line that "collapsed" was two empty forecast cells).
fn project_records(records: Vec<serde_json::Value>, columns: &[String]) -> Vec<serde_json::Value> {
    records
        .into_iter()
        .map(|rec| {
            serde_json::Value::Array(
                columns
                    .iter()
                    .map(|c| rec.get(c).cloned().unwrap_or(serde_json::Value::Null))
                    .collect(),
            )
        })
        .collect()
}

/// The three siblings as PUBLISHABLE properties — the form for this vocabulary.
///
/// The names above are framework convention, which means no author declares them and no schema
/// carried them: `<param>CacheKey` existed only in prose (an action catalog's description) and in
/// validation hints. A model that had the right key and the right intent therefore had to guess
/// the shape. Measured 2026-08-13 (SK하이닉스, turn 49): fa `ratios` was called five different
/// ways in seven rounds — the key as the value of `statements`, `{"_cacheKey": …}`,
/// `[{"_cacheKey": …}]`, `[{"statementsCacheKey": …}]`, and three keys comma-joined into one
/// string — and the model's own reasoning names the reason twice: "the schema I got only shows 4
/// params". fa's `config.input` had declared `statementsCacheKey` all along; the catalog that
/// feeds `get_action_schema` had not, and the published form intersects on catalog names, so the
/// one surface the model reads never showed it. Seven rounds and the tool budget went to a
/// parameter that existed.
///
/// So the convention publishes itself. Every surface that lists a cacheInputs param lists these
/// beside it, derived from the same declaration the expander reads — one derivation, no drift.
/// `nested` = this param is a `<list>.*.<field>` entry, whose rows land in a positional table —
/// only those get the column projection (see `columns_field`).
pub fn sibling_schemas(param: &str, nested: bool) -> Vec<(String, serde_json::Value)> {
    let mut out = vec![
        (
            key_field(param),
            serde_json::json!({
                "type": ["string", "array"],
                "items": {"type": "string"},
                "description": format!(
                    "The producing call's `_cacheKey`, sent INSTEAD of `{param}` — a top-level \
                     parameter of its own, never a value inside `{param}`. The server reads the \
                     rows and fills `{param}` before validation. Several keys may be sent as a \
                     list and their rows are concatenated in the order given (three yearly \
                     reports into one table)."
                ),
            }),
        ),
        (
            limit_field(param),
            serde_json::json!({
                "type": "integer",
                "minimum": 1,
                "description": format!(
                    "Keep only the most-recent N rows of what `{}` expands to.",
                    key_field(param)
                ),
            }),
        ),
        (
            range_field(param),
            serde_json::json!({
                "type": "object",
                "properties": {
                    "from": {"type": "string", "description": "Inclusive start, as the rows' own date format."},
                    "to": {"type": "string", "description": "Inclusive end, as the rows' own date format."},
                },
                "description": format!(
                    "Keep only the rows of `{}` inside this date range. A range that matches \
                     nothing is refused, not silently widened.",
                    key_field(param)
                ),
            }),
        ),
    ];
    if nested {
        out.push((
            columns_field(param),
            serde_json::json!({
                "type": "array",
                "items": {"type": "string"},
                "description": format!(
                    "Which record fields to take, in column order — e.g.                      [\"date\",\"open\",\"close\"]. Without it the sheet gets EVERY field the                      cached rows carry, raw vendor names included, and `headers` that name                      something else match nothing. `headers` stays the display text; this names                      the data. A field a record lacks becomes an empty cell, never a zero."
                ),
            }),
        ));
    }
    out
}

/// Every key in an argument that is meant to name cached rows.
///
/// One key stays one key. A LIST of keys is the answer to a question the vocabulary could not
/// answer before: three `dart financialAll` calls, one per year, feeding one `fa ratios` call.
/// With no way to say it, the model joined them with commas into a single string (measured
/// 2026-08-13) — so the joined string is read the same way, but only when EVERY comma-part has
/// the key shape. A value with one key-shaped part and one of anything else is not a list of
/// keys, and guessing there would corrupt an argument rather than repair it.
fn keys_in(value: &serde_json::Value) -> Vec<String> {
    match value {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return Vec::new();
            }
            // A hand-serialized LIST of keys. The form says several keys may be sent as a list,
            // and the model sent one — as a JSON string (measured 2026-08-13, turn 51: its own
            // reasoning reads "the entire list was passed as a single string"). Parsing it is
            // lossless; refusing it cost a round.
            if t.starts_with('[') {
                if let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(t) {
                    let keys: Vec<String> = items
                        .iter()
                        .filter_map(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect();
                    if keys.len() == items.len() && !keys.is_empty() {
                        return keys;
                    }
                }
            }
            if !t.contains(',') {
                return vec![t.to_string()];
            }
            let parts: Vec<&str> = t.split(',').map(str::trim).collect();
            if parts.iter().all(|p| looks_like_cache_key(p)) {
                parts.into_iter().map(str::to_string).collect()
            } else {
                vec![t.to_string()]
            }
        }
        serde_json::Value::Array(items) if !items.is_empty() => {
            let keys: Vec<String> = items
                .iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|s| looks_like_cache_key(s))
                .map(str::to_string)
                .collect();
            if keys.len() == items.len() {
                keys
            } else {
                Vec::new()
            }
        }
        _ => Vec::new(),
    }
}

/// Applies the `<param>Limit` / `<param>Range` siblings sitting next to a cache key.
///
/// `holder` is whichever object carries them (the call for a flat param, the list element for a
/// nested one) and `at` names the slot in errors. A range that matches nothing is an ERROR here,
/// unlike the render layer which keeps the full set: a chart that blanks is a visible failure,
/// while a sheet quietly holding all five hundred rows under a "최근 15일" heading is a lie the
/// reader cannot see. The message names the span that does exist, so the next call is a fix
/// rather than a guess.
fn sliced_records(
    param: &str,
    holder: &serde_json::Map<String, serde_json::Value>,
    records: Vec<serde_json::Value>,
    at: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let limit = holder
        .get(&limit_field(param))
        .and_then(|v| v.as_u64())
        .map(|n| n as usize);
    let range = holder.get(&range_field(param)).and_then(|v| v.as_object());
    let from = range.and_then(|r| r.get("from")).and_then(|v| v.as_str());
    let to = range.and_then(|r| r.get("to")).and_then(|v| v.as_str());
    if limit.is_none() && from.is_none() && to.is_none() {
        return Ok(records);
    }
    let total = records.len();
    let out = crate::utils::row_slice::slice_rows(records, limit, from, to);
    if out.range_emptied {
        let span = crate::utils::row_slice::date_span(&out.rows)
            .map(|(a, b)| format!(" the cached rows span {a}..{b};"))
            .unwrap_or_default();
        let (rf, lf) = (range_field(param), limit_field(param));
        return Err(format!(
            "{at}: {rf} matched 0 of {total} cached rows —{span} widen it, or drop it and use \
             {lf}:N for the most-recent N rows."
        ));
    }
    if out.rows.len() != total {
        tracing::info!(
            target: "module",
            slot = %at,
            kept = out.rows.len(),
            of = total,
            "cache key sliced on expansion"
        );
    }
    Ok(out.rows)
}

/// A `"<list>.*.<field>"` declaration, split. The wildcard is the only supported path element:
/// "every element of this array may swap `<field>` for `<field>CacheKey`".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NestedSpec {
    pub list: String,
    pub field: String,
}

/// Parses the nested form. Returns `None` for a plain param name — so callers can branch on it
/// without a second membership test — and also for anything dotted that is not exactly
/// `<list>.*.<field>`: an unrecognised path is not silently reinterpreted as a flat param.
pub fn parse_nested(entry: &str) -> Option<NestedSpec> {
    let (list, field) = entry.split_once(".*.")?;
    if list.is_empty() || field.is_empty() || list.contains('.') || field.contains('.') {
        return None;
    }
    Some(NestedSpec {
        list: list.to_string(),
        field: field.to_string(),
    })
}

/// Whether the module's input schema declares this param as an object (plain `"object"` or
/// the nullable union `["object","null"]`). Such a param takes the cached record itself.
fn param_wants_object(config: &serde_json::Value, param: &str) -> bool {
    let ty = config
        .get("input")
        .and_then(|i| i.get("properties"))
        .and_then(|p| p.get(param))
        .and_then(|s| s.get("type"));
    match ty {
        Some(serde_json::Value::String(s)) => s == "object",
        Some(serde_json::Value::Array(arr)) => {
            let mut non_null = arr
                .iter()
                .filter_map(|v| v.as_str())
                .filter(|s| *s != "null");
            matches!((non_null.next(), non_null.next()), (Some("object"), None))
        }
        _ => false,
    }
}

/// Array parameters this module accepts as a cache key, as declared — plain names and nested
/// `"<list>.*.<field>"` paths alike, unparsed. Empty unless declared.
///
/// Returning the raw entries keeps this the single source for both readers: `expand` parses them,
/// while the validation-error hint in `module.rs` substring-matches them against a failing JSON
/// pointer. A nested entry simply never matches there, which costs a hint, not correctness.
pub fn declared(config: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // v2 home: `"cacheInput": true` on the parameter's OWN spec, at any depth — a nested
    // array-of-objects field declares it on itself and the `"<list>.*.<field>"` path is derived
    // here rather than hand-written in a parallel list at the top of the file.
    if let Some(props) = config.pointer("/input/properties").and_then(|v| v.as_object()) {
        collect_declared(props, "", &mut out);
    }
    // Legacy top-level `cacheInputs` list — read until the migration sweep retires it.
    if let Some(list) = config.get("cacheInputs").and_then(|v| v.as_array()) {
        for v in list {
            if let Some(s) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                if !out.iter().any(|e| e == s) {
                    out.push(s.to_string());
                }
            }
        }
    }
    out
}

/// Walk property specs collecting `cacheInput: true`, deriving nested paths as it descends.
fn collect_declared(
    props: &serde_json::Map<String, serde_json::Value>,
    prefix: &str,
    out: &mut Vec<String>,
) {
    for (name, spec) in props {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        if spec.get("cacheInput").and_then(|v| v.as_bool()).unwrap_or(false) {
            out.push(path.clone());
        }
        if let Some(item_props) = spec.pointer("/items/properties").and_then(|v| v.as_object()) {
            collect_declared(item_props, &format!("{path}.*"), out);
        }
    }
}

/// Whether a string has the cache-key SHAPE (`…-<16 hex>-<13 digit ms>`). Models hand keys to
/// the value slot instead of the key slot ("statements": "<key>" — measured 2026-08-12, turn
/// 39, two rounds burned); the shape is distinctive enough to read the intent losslessly.
pub fn looks_like_cache_key(s: &str) -> bool {
    let s = s.trim();
    let Some((head, ts)) = s.rsplit_once('-') else { return false };
    let Some((_, hash)) = head.rsplit_once('-') else { return false };
    ts.len() == 13
        && ts.bytes().all(|b| b.is_ascii_digit())
        && hash.len() == 16
        && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The `{"_cacheKey": "<key>"}` dialect: the model hands back the CARRIER object the cached
/// response advertised instead of the bare key — measured 2026-08-12, fa received
/// `"statements": [{"_cacheKey": "dart-financialAll:list-…"}]`. Both the bare object and the
/// one-element list around it arrive (scalar coercion wraps a lone object into a list).
///
/// Deliberately strict: each object must carry `_cacheKey` and NOTHING else. An object that also
/// holds real fields is a record, not an instruction.
///
/// A LIST of such carriers is read as a list of keys — every element must be a pure carrier, so a
/// records list can never be mistaken for one (real rows carry real fields). The one-element case
/// used to be the only one accepted; the model that had three yearly reports to hand over wrote
/// the three-element form and got a type error naming a structure it had reasoned its way to
/// (measured 2026-08-13).
fn carrier_cache_keys(v: &serde_json::Value) -> Vec<String> {
    fn one(v: &serde_json::Value) -> Option<String> {
        let obj = v.as_object()?;
        if obj.len() != 1 {
            return None;
        }
        obj.get("_cacheKey")
            .and_then(|k| k.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }
    match v {
        serde_json::Value::Object(_) => one(v).into_iter().collect(),
        serde_json::Value::Array(items) if !items.is_empty() => {
            let keys: Vec<String> = items.iter().filter_map(one).collect();
            if keys.len() == items.len() {
                keys
            } else {
                Vec::new()
            }
        }
        _ => Vec::new(),
    }
}

/// Whether a cache key points at a WHOLE-response entry (scalar/autoCacheWhole path — the
/// action label's field segment is `_`). Such an entry is one object, never a rows list.
fn is_whole_entry_key(key: &str) -> bool {
    let Some((head, _ts)) = key.trim().rsplit_once('-') else { return false };
    let Some((label, _hash)) = head.rsplit_once('-') else { return false };
    label.ends_with(":_")
}

/// Reads the records behind one key. `where_` names the argument slot (`barsCacheKey` or
/// `sheets[2].rowsCacheKey`) so every failure below says which one died.
fn read_records(
    cache: &Arc<SysmodCacheAdapter>,
    key: &str,
    where_: &str,
) -> Result<Vec<serde_json::Value>, String> {
    cache
        .read(key, 0, usize::MAX)
        .map_err(|e| format!("{where_}: {e}"))?
        .get("records")
        .and_then(|r| r.as_array())
        .cloned()
        .ok_or_else(|| format!("{where_}: cache entry {key} holds no records"))
}

/// Expands `<field>CacheKey` inside every element of a `<list>.*.<field>` declaration.
///
/// Returns `Ok(None)` when no element carried a key, so the caller can leave the input untouched.
/// Unlike the flat case there is no object-slot unwrap here: a nested field is always an array of
/// records (a sheet's `rows`), and `param_wants_object` reads the TOP-LEVEL schema, which describes
/// the list, not its items. Keeping nested fields array-only means one shape to reason about.
fn expand_nested(
    module: &str,
    spec: &NestedSpec,
    list: &[serde_json::Value],
    cache: Option<&Arc<SysmodCacheAdapter>>,
) -> Result<Option<Vec<serde_json::Value>>, String> {
    let field = key_field(&spec.field);
    let mut out: Option<Vec<serde_json::Value>> = None;
    for (i, item) in list.iter().enumerate() {
        let Some(item_obj) = item.as_object() else {
            continue;
        };
        let keys: Vec<String> = item_obj.get(&field).map(keys_in).unwrap_or_default();
        if keys.is_empty() {
            continue;
        }
        let at = format!("{}[{i}].{field}", spec.list);
        // A whole-response key can never be rows. Turn 39 (2026-08-12) shipped a "일봉
        // (120일)" sheet that was EMPTY: the model grabbed an earlier dud call's `…:_`
        // key while the real 500-row array key sat one call later in the history.
        // Expanding it faithfully injects one response object where rows belong — data
        // loss that looks like data. Refuse with the shape named instead.
        if let Some(whole) = keys.iter().find(|k| is_whole_entry_key(k)) {
            return Err(format!(
                "{at}: {whole} is a WHOLE-response cache entry (label ':_'), not a rows list — \
                 pass the _cacheKey whose label names the rows field (e.g. \
                 module-action:rowsField-…), from the call that actually returned the rows."
            ));
        }
        let slice_keys = (
            limit_field(&spec.field),
            range_field(&spec.field),
            columns_field(&spec.field),
        );
        let items = out.get_or_insert_with(|| list.to_vec());
        let target = items[i].as_object_mut().expect("checked above");
        // Inline wins: the element already carries the real rows, so the stray key — and any
        // window siblings meant for it — are dropped (leaving them would fail schemas that
        // forbid extra properties). Rows the caller typed are already the slice it wanted.
        if target.get(&spec.field).is_some_and(|v| !v.is_null()) {
            target.remove(&field);
            target.remove(&slice_keys.0);
            target.remove(&slice_keys.1);
            target.remove(&slice_keys.2);
            continue;
        }
        let Some(cache) = cache else {
            return Err(format!(
                "{at} was given but this server has no result cache — send `{}` inline.",
                spec.field
            ));
        };
        let mut records: Vec<serde_json::Value> = Vec::new();
        for (k, key) in keys.iter().enumerate() {
            let at = if keys.len() == 1 { at.clone() } else { format!("{at}[{k}]") };
            records.extend(read_records(cache, key, &at)?);
        }
        let records = sliced_records(&spec.field, item_obj, records, &at)?;
        // Column projection — the caller names the fields, so nothing is guessed and the sheet
        // holds what its headers say it holds.
        let columns: Vec<String> = item_obj
            .get(&columns_field(&spec.field))
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let records =
            if columns.is_empty() { records } else { project_records(records, &columns) };
        let count = records.len();
        let key = keys.join(", ");
        target.insert(spec.field.clone(), serde_json::Value::Array(records));
        target.remove(&field);
        target.remove(&slice_keys.0);
        target.remove(&slice_keys.1);
        // `<field>Columns` STAYS. The key and the window are spent here, but the column list is
        // also the only record of which source field became which column — and the module needs
        // that to answer "which column is 종가?" when the caller labelled the sheet in Korean and
        // named the chart's series in English. Measured 2026-08-13 (turn 59): that mismatch cost
        // a round and an extra file, twice in one day. Consumed keys are removed because leaving
        // them would fail strict schemas; this one is data the module reads.
        tracing::info!(
            target: "module",
            module,
            param = %format!("{}.*.{}", spec.list, spec.field),
            index = i,
            rows = count,
            cache_key = %key,
            "nested cache key expanded into input"
        );
    }
    Ok(out)
}

/// Replaces declared `<param>CacheKey` arguments with the cached rows — top-level params and
/// nested `<list>.*.<field>` slots alike.
///
/// Returns `Ok(None)` when there is nothing to do — the overwhelmingly common case, and it clones
/// nothing. An unreadable key is an error rather than a silent skip: the alternative is the module
/// failing validation on a missing parameter, which says nothing about the expired key that caused
/// it.
pub fn expand(
    module: &str,
    config: &serde_json::Value,
    input: &serde_json::Value,
    cache: Option<&Arc<SysmodCacheAdapter>>,
) -> Result<Option<serde_json::Value>, String> {
    let params = declared(config);
    if params.is_empty() {
        return Ok(None);
    }
    let Some(obj) = input.as_object() else {
        return Ok(None);
    };

    let mut out: Option<serde_json::Map<String, serde_json::Value>> = None;
    for param in params {
        if let Some(spec) = parse_nested(&param) {
            // Read the list from the working copy when an earlier entry already touched it.
            let source: &serde_json::Map<String, serde_json::Value> = out.as_ref().unwrap_or(obj);
            let Some(list) = source.get(&spec.list).and_then(|v| v.as_array()).cloned() else {
                continue;
            };
            if let Some(expanded) = expand_nested(module, &spec, &list, cache)? {
                let target = out.get_or_insert_with(|| obj.clone());
                target.insert(spec.list.clone(), serde_json::Value::Array(expanded));
            }
            continue;
        }
        let field = key_field(&param);
        let mut keys: Vec<String> = obj.get(&field).map(keys_in).unwrap_or_default();
        if keys.is_empty() {
            // Dialect: the key handed to the VALUE slot — "statements": "<key>" (string
            // coercion then wraps it into a one-item list, so both shapes arrive).
            // The key shape is unmistakable; reading the intent is lossless and saves
            // the relearning round (measured 2026-08-12 turn 39: two rounds burned).
            keys = obj
                .get(&param)
                .map(keys_in)
                .unwrap_or_default()
                .into_iter()
                .filter(|k| looks_like_cache_key(k))
                .collect();
        }
        if keys.is_empty() {
            // Dialect: the carrier object the cached response advertised, handed back whole —
            // `"statements": [{"_cacheKey": "…"}]` (measured 2026-08-12). Same intent, same
            // expansion, same errors: a miss reports `<param>CacheKey` exactly as the normal
            // path does.
            keys = obj.get(&param).map(carrier_cache_keys).unwrap_or_default();
        }
        if keys.is_empty() {
            continue;
        }
        let cache = cache.ok_or_else(|| {
            format!("{field} was given but this server has no result cache — send `{param}` directly.")
        })?;
        // An object-shaped param holds ONE response, so several keys have no meaning there —
        // concatenating them would silently drop all but one. Say which slot and how many.
        if keys.len() > 1 && param_wants_object(config, &param) {
            return Err(format!(
                "{field}: {} keys given, but `{param}` takes a single object — call once per key, \
                 or pass the key of the one call that returned them together.",
                keys.len()
            ));
        }
        let mut records: Vec<serde_json::Value> = Vec::new();
        for (i, key) in keys.iter().enumerate() {
            let at =
                if keys.len() == 1 { field.clone() } else { format!("{field}[{i}]") };
            records.extend(read_records(cache, key, &at)?);
        }
        let key = keys.join(", ");
        let key = key.as_str();
        let records = sliced_records(&param, obj, records, &field)?;
        // A param declared as an OBJECT receives the record itself, not a one-element list.
        // Whole-object caching (`autoCacheWhole`) stores a multi-section response as a single
        // record; wrapping it in an array here would fail the very schema the expansion exists
        // to satisfy (fa `estimates` is `object|null` — measured 2026-08-11 turn 33).
        let value = if param_wants_object(config, &param)
            && records.len() == 1
            && records[0].is_object()
        {
            records.into_iter().next().unwrap()
        } else {
            serde_json::Value::Array(records)
        };
        let target = out.get_or_insert_with(|| obj.clone());
        target.insert(param.clone(), value);
        // The key and its window siblings are dropped: none of them is a declared parameter, so
        // leaving them would fail validation on modules whose schema forbids extra properties.
        target.remove(&field);
        target.remove(&limit_field(&param));
        target.remove(&range_field(&param));
        tracing::info!(
            target: "module",
            module,
            param = %param,
            cache_key = %key,
            "cache key expanded into input"
        );
    }
    Ok(out.map(serde_json::Value::Object))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn cache_with(records: Vec<serde_json::Value>) -> (Arc<SysmodCacheAdapter>, String, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let c = SysmodCacheAdapter::new(dir.path().to_path_buf()).unwrap();
        let key = c.data("m", "a", serde_json::json!({}), records, None).unwrap();
        (Arc::new(c), key, dir)
    }

    #[test]
    fn undeclared_module_is_left_alone() {
        let (cache, key, _d) = cache_with(vec![serde_json::json!({"close": 1})]);
        let input = serde_json::json!({"barsCacheKey": key});
        let out = expand("m", &serde_json::json!({}), &input, Some(&cache)).unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn declared_key_becomes_the_array_and_the_key_is_dropped() {
        let (cache, key, _d) = cache_with(vec![
            serde_json::json!({"close": 1}),
            serde_json::json!({"close": 2}),
        ]);
        let cfg = serde_json::json!({"cacheInputs": ["bars"]});
        let input = serde_json::json!({"action": "signals", "barsCacheKey": key});
        let out = expand("m", &cfg, &input, Some(&cache)).unwrap().unwrap();
        assert_eq!(out["bars"].as_array().unwrap().len(), 2);
        assert_eq!(out["action"], "signals");
        assert!(out.get("barsCacheKey").is_none());
    }

    #[test]
    fn a_param_declares_cache_input_on_itself_and_nested_paths_are_derived() {
        let cfg = serde_json::json!({
            "input": { "properties": {
                "bars": { "type": "array", "cacheInput": true },
                "sheets": { "type": "array", "items": { "properties": {
                    "rows": { "type": "array", "cacheInput": true },
                    "title": { "type": "string" }
                } } },
                "plain": { "type": "string" }
            } },
            "cacheInputs": ["bars", "legacy_only"]
        });
        let got = declared(&cfg);
        assert!(got.contains(&"bars".to_string()));
        assert!(got.contains(&"sheets.*.rows".to_string()), "nested path derived: {got:?}");
        assert!(got.contains(&"legacy_only".to_string()), "legacy list still read");
        assert_eq!(got.iter().filter(|s| *s == "bars").count(), 1, "no duplicate: {got:?}");
        assert!(!got.iter().any(|s| s == "plain"));
    }

    #[test]
    fn an_inline_array_is_untouched() {
        let (cache, _key, _d) = cache_with(vec![]);
        let cfg = serde_json::json!({"cacheInputs": ["bars"]});
        let input = serde_json::json!({"bars": [{"close": 1}]});
        assert!(expand("m", &cfg, &input, Some(&cache)).unwrap().is_none());
    }

    #[test]
    fn an_object_param_receives_the_record_itself() {
        // autoCacheWhole stores a multi-section response as ONE record; a param declared
        // `["object","null"]` (fa estimates) must get the object back, not a 1-element list.
        let (cache, key, _d) = cache_with(vec![serde_json::json!({
            "output1": {"name": "x"}, "output2": [1, 2], "output4": [{"dt": "2026E"}],
        })]);
        let cfg = serde_json::json!({
            "cacheInputs": ["estimates"],
            "input": {"properties": {"estimates": {"type": ["object", "null"]}}},
        });
        let input = serde_json::json!({"action": "ratios", "estimatesCacheKey": key});
        let out = expand("m", &cfg, &input, Some(&cache)).unwrap().unwrap();
        assert!(out["estimates"].is_object(), "{out}");
        assert_eq!(out["estimates"]["output2"].as_array().unwrap().len(), 2);
        assert!(out.get("estimatesCacheKey").is_none());
    }

    #[test]
    fn a_nested_key_expands_into_the_element_and_the_key_is_dropped() {
        // "sheets.*.rows": the 120-day candle sheet gets its real rows, and the sibling sheet
        // that never carried a key is passed through byte-for-byte.
        let (cache, key, _d) = cache_with(vec![
            serde_json::json!({"d": "2026-08-10", "close": 1}),
            serde_json::json!({"d": "2026-08-11", "close": 2}),
            serde_json::json!({"d": "2026-08-12", "close": 3}),
        ]);
        let cfg = serde_json::json!({"cacheInputs": ["blocks", "sheets.*.rows"]});
        let input = serde_json::json!({
            "action": "make_xlsx",
            "sheets": [
                {"name": "요약", "headers": ["k", "v"], "rows": [["a", 1]]},
                {"name": "일봉 (최근 120일)", "headers": ["d", "close"], "rowsCacheKey": key},
            ],
        });
        let out = expand("m", &cfg, &input, Some(&cache)).unwrap().unwrap();
        let sheets = out["sheets"].as_array().unwrap();
        assert_eq!(sheets[0], input["sheets"][0], "sibling sheet was touched");
        assert_eq!(sheets[1]["rows"].as_array().unwrap().len(), 3);
        assert_eq!(sheets[1]["rows"][2]["close"], 3);
        assert!(sheets[1].get("rowsCacheKey").is_none());
        assert_eq!(sheets[1]["name"], "일봉 (최근 120일)");
        assert_eq!(out["action"], "make_xlsx");
    }

    #[test]
    fn nested_inline_rows_win_over_a_stray_key() {
        let (cache, key, _d) = cache_with(vec![serde_json::json!({"close": 9})]);
        let cfg = serde_json::json!({"cacheInputs": ["sheets.*.rows"]});
        let input = serde_json::json!({
            "sheets": [{"name": "s", "rows": [["a", 1]], "rowsCacheKey": key}],
        });
        let out = expand("m", &cfg, &input, Some(&cache)).unwrap().unwrap();
        let sheet = &out["sheets"][0];
        assert_eq!(sheet["rows"], serde_json::json!([["a", 1]]));
        // The key is still dropped — it is not a declared property of the item.
        assert!(sheet.get("rowsCacheKey").is_none());
    }

    #[test]
    fn a_nested_expired_key_is_an_error_naming_the_element() {
        let (cache, key, _d) = cache_with(vec![serde_json::json!({"close": 1})]);
        cache.drop_key(&key).unwrap();
        let cfg = serde_json::json!({"cacheInputs": ["sheets.*.rows"]});
        let input = serde_json::json!({"sheets": [{"name": "s", "rowsCacheKey": key}]});
        let err = expand("m", &cfg, &input, Some(&cache)).unwrap_err();
        assert!(err.starts_with("sheets[0].rowsCacheKey:"), "{err}");
    }

    #[test]
    fn a_nested_declaration_without_keys_changes_nothing() {
        let (cache, _key, _d) = cache_with(vec![]);
        let cfg = serde_json::json!({"cacheInputs": ["sheets.*.rows"]});
        let input = serde_json::json!({"sheets": [{"name": "s", "rows": [["a", 1]]}]});
        assert!(expand("m", &cfg, &input, Some(&cache)).unwrap().is_none());
    }

    #[test]
    fn nested_paths_parse_only_in_the_exact_shape() {
        assert_eq!(
            parse_nested("sheets.*.rows"),
            Some(NestedSpec { list: "sheets".into(), field: "rows".into() })
        );
        assert_eq!(parse_nested("bars"), None);
        assert_eq!(parse_nested("a.*.b.*.c"), None);
        assert_eq!(parse_nested(".*.rows"), None);
        assert_eq!(parse_nested("sheets.*."), None);
        // declared() hands the raw entries on, nested ones included.
        let cfg = serde_json::json!({"cacheInputs": ["blocks", "sheets.*.rows"]});
        assert_eq!(declared(&cfg), vec!["blocks", "sheets.*.rows"]);
    }

    #[test]
    fn a_key_in_the_value_slot_is_read_as_the_key() {
        // "statements": "<key>" and "statements": ["<key>"] — the model hands the key to
        // the value slot; the shape is unmistakable, so the intent is read losslessly.
        let (cache, key, _d) = cache_with(vec![serde_json::json!({"a": 1})]);
        let cfg = serde_json::json!({"cacheInputs": ["statements"]});
        for input in [
            serde_json::json!({"action": "ratios", "statements": key}),
            serde_json::json!({"action": "ratios", "statements": [key]}),
        ] {
            let out = expand("m", &cfg, &input, Some(&cache)).unwrap().unwrap();
            assert_eq!(out["statements"].as_array().unwrap().len(), 1, "{out}");
            assert_eq!(out["statements"][0]["a"], 1);
        }
        // An ordinary string value is NOT mistaken for a key.
        let plain = serde_json::json!({"statements": "hello world"});
        assert!(expand("m", &cfg, &plain, Some(&cache)).unwrap().is_none());
    }

    #[test]
    fn a_whole_entry_key_is_refused_for_nested_rows() {
        // Turn 39: a `…:_` whole-response key in rowsCacheKey shipped an EMPTY 120-day
        // sheet. The label is decisive — refuse with the shape named.
        let dir = tempfile::tempdir().unwrap();
        let c = SysmodCacheAdapter::new(dir.path().to_path_buf()).unwrap();
        let key = c
            .data("kiwoom", "ka10081:_", serde_json::json!({}), vec![serde_json::json!({"whole": true})], None)
            .unwrap();
        let cache = Arc::new(c);
        let cfg = serde_json::json!({"cacheInputs": ["sheets.*.rows"]});
        let input = serde_json::json!({"sheets": [{"name": "일봉", "rowsCacheKey": key}]});
        let err = expand("docs", &cfg, &input, Some(&cache)).unwrap_err();
        assert!(err.contains("WHOLE-response"), "{err}");
        assert!(err.starts_with("sheets[0].rowsCacheKey:"), "{err}");
    }

    /// The window the model always wanted. Before this it could only say "all of it", so it
    /// hand-typed the rows instead — and the string it typed broke (2026-08-12).
    #[test]
    fn a_window_beside_the_key_slices_on_expansion() {
        let (cache, key, _d) = cache_with(vec![
            serde_json::json!({"date": "2026-08-01", "close": 1}),
            serde_json::json!({"date": "2026-08-02", "close": 2}),
            serde_json::json!({"date": "2026-08-03", "close": 3}),
        ]);
        let cfg = serde_json::json!({"cacheInputs": ["bars"]});
        let input = serde_json::json!({"barsCacheKey": key, "barsLimit": 2});
        let out = expand("m", &cfg, &input, Some(&cache)).unwrap().unwrap();
        let bars = out["bars"].as_array().unwrap();
        assert_eq!(bars.len(), 2, "the most-recent two");
        assert_eq!(bars[0]["date"], "2026-08-02");
        assert!(out.get("barsCacheKey").is_none());
        assert!(out.get("barsLimit").is_none(), "window siblings are not declared params");
    }

    /// Nested slots take the window on the element that owns them — one sheet may be windowed
    /// while its neighbour takes the full table.
    #[test]
    fn a_nested_window_slices_only_that_element() {
        let (cache, key, _d) = cache_with(vec![
            serde_json::json!({"date": "2026-08-01", "close": 1}),
            serde_json::json!({"date": "2026-08-02", "close": 2}),
            serde_json::json!({"date": "2026-08-03", "close": 3}),
        ]);
        let cfg = serde_json::json!({"cacheInputs": ["sheets.*.rows"]});
        let input = serde_json::json!({"sheets": [
            {"name": "일봉", "rowsCacheKey": key, "rowsLimit": 1},
            {"name": "전체", "rowsCacheKey": key}
        ]});
        let out = expand("m", &cfg, &input, Some(&cache)).unwrap().unwrap();
        let sheets = out["sheets"].as_array().unwrap();
        assert_eq!(sheets[0]["rows"].as_array().unwrap().len(), 1);
        assert_eq!(sheets[0]["rows"][0]["date"], "2026-08-03");
        assert_eq!(sheets[1]["rows"].as_array().unwrap().len(), 3);
        assert!(sheets[0].get("rowsLimit").is_none());
    }

    /// An empty window is refused, not silently widened — a sheet holding every row under a
    /// windowed heading is a lie the reader cannot see. The error names the span that exists.
    #[test]
    fn a_range_that_matches_nothing_names_the_span_that_does() {
        let (cache, key, _d) = cache_with(vec![
            serde_json::json!({"date": "2026-08-01", "close": 1}),
            serde_json::json!({"date": "2026-08-03", "close": 3}),
        ]);
        let cfg = serde_json::json!({"cacheInputs": ["bars"]});
        let input = serde_json::json!({
            "barsCacheKey": key, "barsRange": {"from": "2027-01-01"}
        });
        let err = expand("m", &cfg, &input, Some(&cache)).unwrap_err();
        assert!(err.contains("barsRange matched 0 of 2"), "{err}");
        assert!(err.contains("20260801..20260803"), "{err}");
        assert!(err.contains("barsLimit:N"), "the message names the cheaper next step: {err}");
    }

    #[test]
    fn a_carrier_object_in_the_value_slot_is_read_as_the_key() {
        // `"statements": {"_cacheKey": "…"}` and the one-element list around it — the model
        // hands back the carrier the cached response advertised (measured 2026-08-12, fa).
        let (cache, key, _d) = cache_with(vec![
            serde_json::json!({"a": 1}),
            serde_json::json!({"a": 2}),
        ]);
        let cfg = serde_json::json!({"cacheInputs": ["statements"]});
        for input in [
            serde_json::json!({"action": "ratios", "statements": {"_cacheKey": key}}),
            serde_json::json!({"action": "ratios", "statements": [{"_cacheKey": key}]}),
        ] {
            let out = expand("m", &cfg, &input, Some(&cache)).unwrap().unwrap();
            assert_eq!(out["statements"].as_array().unwrap().len(), 2, "{out}");
            assert_eq!(out["statements"][1]["a"], 2);
        }
    }

    #[test]
    fn a_carrier_object_with_other_keys_is_data_not_an_instruction() {
        // A record that merely CARRIES a `_cacheKey` alongside real fields is data. Absorbing it
        // would throw the real fields away — the one shape this dialect must not touch.
        let (cache, key, _d) = cache_with(vec![serde_json::json!({"a": 1})]);
        let cfg = serde_json::json!({"cacheInputs": ["statements"]});
        for input in [
            serde_json::json!({"statements": {"_cacheKey": key, "account": "x"}}),
            serde_json::json!({"statements": [{"_cacheKey": key, "account": "x"}]}),
            serde_json::json!({"statements": {"_cacheKey": ""}}),
        ] {
            assert!(
                expand("m", &cfg, &input, Some(&cache)).unwrap().is_none(),
                "absorbed a shape it should have left alone: {input}"
            );
        }
    }

    /// Three yearly DART reports, one ratios call. The vocabulary had no way to say it, so the
    /// model said it four ways in one turn (2026-08-13): a list of keys, a list of carriers, and
    /// the three keys comma-joined into one string. All three now mean the same thing — rows
    /// concatenated in the order given.
    #[test]
    fn several_keys_become_one_table_however_they_are_written() {
        let (cache, k1, _d1) = cache_with(vec![serde_json::json!({"y": 2023})]);
        // Both keys must live in the SAME store, as three dart calls in one turn do.
        let k2 = cache
            .data("dart", "financialAll", serde_json::json!({}), vec![serde_json::json!({"y": 2024})], None)
            .unwrap();
        let cfg = serde_json::json!({"cacheInputs": ["statements"]});
        for input in [
            serde_json::json!({"statementsCacheKey": [k1.clone(), k2.clone()]}),
            serde_json::json!({"statementsCacheKey": format!("{k1}, {k2}")}),
            serde_json::json!({"statements": [{"_cacheKey": k1}, {"_cacheKey": k2}]}),
        ] {
            let out = expand("m", &cfg, &input, Some(&cache)).unwrap().unwrap();
            let rows = out["statements"].as_array().unwrap();
            assert_eq!(rows.len(), 2, "{input} → {out}");
            assert_eq!(rows[0]["y"], 2023);
            assert_eq!(rows[1]["y"], 2024, "order follows the order given");
            assert!(out.get("statementsCacheKey").is_none());
        }
    }

    /// An object slot holds one response, so several keys there cannot be honoured — and dropping
    /// all but one silently is the failure this refuses to become.
    #[test]
    fn several_keys_for_an_object_param_are_refused_by_name() {
        let (cache, k1, _d) = cache_with(vec![serde_json::json!({"a": 1})]);
        let cfg = serde_json::json!({
            "cacheInputs": ["estimates"],
            "input": {"properties": {"estimates": {"type": ["object", "null"]}}}
        });
        let input = serde_json::json!({"estimatesCacheKey": [k1.clone(), k1]});
        let err = expand("m", &cfg, &input, Some(&cache)).unwrap_err();
        assert!(err.contains("estimatesCacheKey: 2 keys given"), "{err}");
        assert!(err.contains("call once per key"), "{err}");
    }

    #[test]
    fn a_missing_carrier_key_fails_exactly_like_the_normal_path() {
        let (cache, key, _d) = cache_with(vec![serde_json::json!({"a": 1})]);
        cache.drop_key(&key).unwrap();
        let cfg = serde_json::json!({"cacheInputs": ["statements"]});
        let input = serde_json::json!({"statements": [{"_cacheKey": key}]});
        let err = expand("m", &cfg, &input, Some(&cache)).unwrap_err();
        assert!(err.starts_with("statementsCacheKey:"), "{err}");
    }

    #[test]
    fn a_container_that_is_still_a_json_string_cannot_be_traversed() {
        // The contract behind the pipeline order in `module.rs`: expansion runs AFTER scalar
        // coercion has parsed stringified containers. A raw JSON *string* carries the keys past
        // every traversal — measured 2026-08-12, a `sheets` string shipped an EMPTY xlsx because
        // expansion skipped it and coercion later parsed it into a valid, row-less array.
        let (cache, key, _d) = cache_with(vec![serde_json::json!({"d": "2026-08-12", "c": 3})]);
        let cfg = serde_json::json!({"cacheInputs": ["sheets.*.rows"]});
        let as_string = serde_json::json!({
            "action": "make_xlsx",
            "sheets": format!(
                r#"[{{"name":"일봉","headers":["d","c"],"rowsCacheKey":"{key}"}}]"#
            ),
        });
        assert!(
            expand("m", &cfg, &as_string, Some(&cache)).unwrap().is_none(),
            "a string is not traversable — the caller must parse first"
        );
        // Parsed first (what coercion does), the very same input expands.
        let parsed: serde_json::Value = serde_json::json!({
            "action": "make_xlsx",
            "sheets": serde_json::from_str::<serde_json::Value>(
                as_string["sheets"].as_str().unwrap()
            ).unwrap(),
        });
        let out = expand("m", &cfg, &parsed, Some(&cache)).unwrap().unwrap();
        assert_eq!(out["sheets"][0]["rows"].as_array().unwrap().len(), 1);
        assert_eq!(out["sheets"][0]["rows"][0]["c"], 3);
        assert!(out["sheets"][0].get("rowsCacheKey").is_none());
    }

    #[test]
    fn an_expired_key_is_an_error_naming_the_field() {
        let (cache, key, _d) = cache_with(vec![serde_json::json!({"close": 1})]);
        cache.drop_key(&key).unwrap();
        let cfg = serde_json::json!({"cacheInputs": ["bars"]});
        let input = serde_json::json!({"barsCacheKey": key});
        let err = expand("m", &cfg, &input, Some(&cache)).unwrap_err();
        assert!(err.starts_with("barsCacheKey:"), "{err}");
    }
}
