//! Fact-Provenance Firewall — L1 grounding for opaque-identifier tool args.
//!
//! Problem: an LLM pattern-completes an opaque identifier it does not know (a stock code
//! for a company name, a region code, a corp code) from memory instead of looking it up,
//! producing confident wrong data (e.g. 이노칩 → 088390 when the real code is 080420).
//! Plain type-checking can't catch this — any 6-digit string is type-valid — so the wrong
//! value passes the input schema. This is the **open-value** case; closed enums (action
//! names etc.) are already firewalled by the input-schema enum check.
//!
//! Principle: the LLM is a *judgment engine*, not a *fact store*. A declared opaque param
//! may only carry a value the model legitimately **observed this conversation** — from a
//! prior tool result (a real lookup) or the user. If the value appears in no observed text,
//! it was invented → the call is rejected with a resolve hint and the model retries
//! (resolve → use). Matching name→record stays with the LLM (its strength); Firebat only
//! enforces provenance. See plan `elegant-wibbling-donut.md` (#8-2).
//!
//! Declared per module in `config.json` (`grounding`); enforced at the tool-dispatch layer
//! (MCP first, FC next) — **both paths, args-based** (task-local alone is a no-op on the FC
//! path, per the hub-scope lesson).
//!
//! Pure / dependency-free (no I/O beyond a tracing line) — both core and the dispatch layers
//! import it.

/// One grounded-param requirement parsed from a module config's `grounding` object.
#[derive(Debug, Clone)]
pub struct GroundedParam {
    /// Param name in the action's input (e.g. "stk_cd"). Matched case-insensitively against args
    /// (some providers accept both `FID_INPUT_ISCD` and `fid_input_iscd`).
    pub param: String,
    /// Guidance returned to the model when the value isn't grounded — how to resolve it.
    pub hint: String,
    /// Actions exempt from the gate for this param — the resolve / confirm actions that
    /// *produce* provenance for it (e.g. ka10100 종목정보 조회 takes a code to confirm it).
    /// Gating these would block the very lookup that grounds the value (chicken-and-egg).
    pub exempt_actions: Vec<String>,
    /// Optional value shape — only tokens matching this regex are gated. Use when a param is
    /// **overloaded**: e.g. korea-invest `FID_INPUT_ISCD` holds a 6-digit stock code (needs
    /// grounding) but also fixed index/sector codes (`0001` 코스피) and member codes (must NOT be
    /// gated). `^Q?[0-9]{6}$` gates only stock codes; 4-digit index codes don't match → pass.
    /// `None` = gate every token (kiwoom `stk_cd` is never overloaded).
    pub pattern: Option<regex::Regex>,
    /// The issuing action, when the module also declares this param in `paramSource` — attached
    /// here at parse time so a rejection can point at the issuer as structure, not only via the
    /// `resolveHint` prose.
    pub source: Option<String>,
}

/// Parse `config.grounding` into requirements.
/// Shape: `{ "<param>": { "resolveHint": "<text>", "exemptActions": ["<action>", ...],
///          "pattern": "<regex>" }, ... }`.
/// Missing / malformed → empty (opt-in: a module without `grounding` is never gated).
/// An invalid `pattern` regex is dropped (treated as no pattern = gate all) rather than failing.
pub fn parse_grounding(config: &serde_json::Value) -> Vec<GroundedParam> {
    let sources = crate::utils::action_decl::param_source(config);
    let build = |param: &str, spec: &serde_json::Value| GroundedParam {
        param: param.to_string(),
        source: sources
            .iter()
            .find(|(p, _)| p == param)
            .map(|(_, s)| s.clone()),
        hint: spec
            .get("resolveHint")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        exempt_actions: spec
            .get("exemptActions")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        pattern: spec
            .get("pattern")
            .and_then(|v| v.as_str())
            .and_then(|p| regex::Regex::new(p).ok()),
    };
    let mut out: Vec<GroundedParam> = Vec::new();
    // v2 home: the parameter's OWN spec — `input.properties.<p>.grounding` — so the requirement
    // moves with the param it is about. (The schema keyword `pattern` is untouched: the grounding
    // shape lives inside its own object, like a component's `synonyms`.)
    if let Some(props) = config.pointer("/input/properties").and_then(|v| v.as_object()) {
        for (param, spec) in props {
            if let Some(g) = spec.get("grounding").filter(|g| g.is_object()) {
                out.push(build(param, g));
            }
        }
    }
    // Legacy top-level map — read until the migration sweep retires it; param-level wins.
    if let Some(obj) = config.get("grounding").and_then(|v| v.as_object()) {
        for (param, spec) in obj {
            if param.is_empty() || out.iter().any(|g| &g.param == param) {
                continue;
            }
            out.push(build(param, spec));
        }
    }
    out
}

/// Case-insensitive field lookup in a JSON object (exact match first, then ascii-ci fallback).
fn get_ci<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    let obj = v.as_object()?;
    if let Some(found) = obj.get(key) {
        return Some(found);
    }
    obj.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, val)| val)
}

/// Tokens to validate for one grounded param in `args`.
/// A value may carry several ids (a multi-symbol field) — split on common delimiters so each
/// is checked. Empty / whitespace tokens are dropped. Param matched case-insensitively, also
/// under a nested `params` object.
fn arg_tokens(args: &serde_json::Value, param: &str) -> Vec<String> {
    let val = get_ci(args, param)
        .or_else(|| args.get("params").and_then(|p| get_ci(p, param)));
    let raw = match val {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        // Multi-value param (e.g. dart `corp_codes` — a list of ids). Flatten each string/number
        // element into the comma-joined form the delimiter split below already handles.
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| match v {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => return Vec::new(),
    };
    raw.split(|c: char| c == ',' || c == ';' || c == '|' || c == '/' || c.is_whitespace())
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .collect()
}

/// Whether a token is grounded — it appears as a substring of some observed text (a value the
/// model legitimately saw this conversation: a prior tool-result blob or user input).
///
/// Substring (not exact set membership) on purpose: a resolved id lives *inside* a larger
/// result/message blob, under whatever field name the action uses — substring is robust to
/// field-name variation across dozens of actions. 6-digit-class ids are specific enough that
/// coincidental substrings are negligible.
fn is_grounded(token: &str, observed: &[String]) -> bool {
    observed.iter().any(|o| o.contains(token))
}

/// Strip a vendor exchange/venue decoration off a token, returning the bare core id.
///
/// The decorated forms are the vendor's OWN documented format, not model invention: kiwoom's
/// `actions.json` (ka10081) declares `stk_cd` as "거래소별 종목코드 (KRX:039490, NXT:039490_NX,
/// SOR:039490_AL)" and live responses come back decorated (`000660_AL`). A model that follows the
/// docs sends `KRX:000660`, which is not a substring of the corpus even though the code it carries
/// was resolved this conversation — the gate rejected the vendor's own dialect (2026-08-12 실측).
///
/// Only the core carries provenance, so membership is checked against the core while the argument
/// itself is passed through **verbatim** — the vendor API expects the decorated form, and rewriting
/// the arg would change what the module executes.
///
/// Shapes stripped: a leading `<alnum, ≤6>:` exchange prefix and/or a trailing `_<alnum, ≤3>` venue
/// suffix. Deliberately narrow — a wide strip would turn arbitrary text into a "core" and let a
/// fabricated id borrow provenance from an unrelated substring.
/// `None` when the token carries no such decoration (nothing was stripped).
fn strip_vendor_decoration(token: &str) -> Option<String> {
    const MAX_PREFIX: usize = 6;
    const MAX_SUFFIX: usize = 3;
    let is_alnum = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric());
    let mut core = token;
    let mut stripped = false;
    if let Some((prefix, rest)) = core.split_once(':') {
        if !prefix.is_empty() && prefix.len() <= MAX_PREFIX && is_alnum(prefix) {
            core = rest;
            stripped = true;
        }
    }
    if let Some((head, suffix)) = core.rsplit_once('_') {
        if !suffix.is_empty() && suffix.len() <= MAX_SUFFIX && is_alnum(suffix) {
            core = head;
            stripped = true;
        }
    }
    if stripped && !core.is_empty() {
        Some(core.to_string())
    } else {
        None
    }
}

/// Default resolve guidance when a grounded param declares no `resolveHint`.
fn default_hint(param: &str) -> String {
    format!(
        "do not guess identifiers from memory. Look '{param}' up with a resolve tool first and \
         use the returned value. If several records match, ask the user with a picker."
    )
}

/// Check `args` against grounded-param requirements using the observed-text corpus.
///
/// For each grounded param present in `args`, every token of its value must be grounded.
/// Returns the first violation's resolve guidance (the model gets it as a tool error and
/// retries: resolve → use). `Ok(())` when nothing is ungrounded.
/// Whether a tool's result may be recorded into the provenance corpus. Discovery / schema / catalog
/// tools describe the *system* (param docs, action lists, config) rather than fetch real-world data,
/// and their output embeds literal example identifiers — `get_action_schema` param docs carry
/// examples like `KRX:005930` / `1100000000=서울`. Recording those would let a model "ground" a
/// fabricated code against a documentation example that merely happened to match (2026-07-09 실측:
/// a stock code passed the gate because the schema desc it read had put an example into the corpus).
/// Only genuine data-fetch results (sysmod calls, lookups) belong in the corpus.
pub fn records_provenance(tool_name: &str) -> bool {
    // Strip a leading `sysmod_` so `sysmod_dart` etc. are always data tools.
    let n = tool_name.trim_start_matches("sysmod_");
    !matches!(
        n,
        "search_module_actions"
            | "get_action_schema"
            | "get_module_config"
            | "get_module_schema"
            | "search_components"
            | "get_component_schema"
            | "list_system_modules"
            | "list_user_modules"
            | "list_mcp_servers"
            | "list_mcp_tools"
    )
}

pub fn check_grounding(
    args: &serde_json::Value,
    grounded: &[GroundedParam],
    observed: &[String],
) -> Result<(), String> {
    let action = args.get("action").and_then(|v| v.as_str());
    for gp in grounded {
        // Skip the resolve / confirm actions that produce this param's provenance.
        if let Some(a) = action {
            if gp.exempt_actions.iter().any(|e| e == a) {
                continue;
            }
        }
        for token in arg_tokens(args, &gp.param) {
            // The bare id under any vendor decoration — computed once, used by both the shape
            // test and the membership test so the two cannot disagree about what the token is.
            let core = strip_vendor_decoration(&token);
            // Overloaded param: only gate tokens matching the declared id shape (e.g. 6-digit
            // stock code). Fixed reference codes (index/sector) that don't match are left alone.
            //
            // The core counts for the shape test too, or the decoration becomes an escape hatch:
            // an anchored `^Q?[0-9]{6}$` never matches `KRX:123456`, so a fabricated code in
            // vendor dress used to skip the very gate that exists to catch it (absence is not
            // consent). Dressed-up id → this param's business → gated. A genuinely overloaded
            // value whose core still fails the shape (a `09:30:00` timestamp, a composite key)
            // strips to nothing that matches and keeps the old skip.
            if let Some(re) = &gp.pattern {
                let shape_hit = re.is_match(&token)
                    || core.as_deref().map(|c| re.is_match(c)).unwrap_or(false);
                if !shape_hit {
                    continue;
                }
            }
            if !is_grounded(&token, observed) {
                // Vendor dialect before verdict: the exchange-qualified / venue-suffixed forms are
                // the vendor's documented format, so check membership against the bare core before
                // calling the token invented. The core must ALSO satisfy the declared shape (when
                // one is declared) and be grounded — a fabricated `KRX:123456` still fails here.
                if let Some(core) = core.as_deref() {
                    let shape_ok = gp
                        .pattern
                        .as_ref()
                        .map(|re| re.is_match(core))
                        .unwrap_or(true);
                    if shape_ok && is_grounded(core, observed) {
                        tracing::info!(
                            target: "grounding",
                            param = %gp.param,
                            token = %token,
                            core = %core,
                            "vendor-format token accepted: prefix/suffix stripped for membership check"
                        );
                        continue;
                    }
                }
                let hint = if gp.hint.is_empty() {
                    default_hint(&gp.param)
                } else {
                    gp.hint.clone()
                };
                let issuer = gp
                    .source
                    .as_deref()
                    .map(|s| format!(" `{}` is issued by {s}.", gp.param))
                    .unwrap_or_default();
                return Err(format!(
                    "Ungrounded value: '{}' = '{}' was never resolved in this conversation. {}{}",
                    gp.param, token, hint, issuer
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn kiwoom_grounding() -> serde_json::Value {
        json!({ "grounding": { "stk_cd": {
            "resolveHint": "resolve via ka10099 first.",
            "exemptActions": ["ka10100"]
        } } })
    }

    #[test]
    fn a_param_declares_its_own_grounding_and_wins_over_the_legacy_map() {
        let config = json!({
            "input": { "properties": {
                "stk_cd": { "type": "string",
                            "grounding": { "resolveHint": "param-level wording." } }
            } },
            "grounding": { "stk_cd": { "resolveHint": "legacy wording." },
                           "acct": { "resolveHint": "list accounts first." } }
        });
        let g = parse_grounding(&config);
        assert_eq!(g.len(), 2);
        let stk = g.iter().find(|p| p.param == "stk_cd").unwrap();
        assert_eq!(stk.hint, "param-level wording.");
        assert!(g.iter().any(|p| p.param == "acct"));
    }

    #[test]
    fn discovery_tools_excluded_from_provenance() {
        // Schema/discovery tools describe the system (with doc examples) — never provenance.
        assert!(!records_provenance("get_action_schema"));
        assert!(!records_provenance("search_module_actions"));
        assert!(!records_provenance("get_module_config"));
        assert!(!records_provenance("search_components"));
        assert!(!records_provenance("get_component_schema"));
        // Real data fetchers — recorded.
        assert!(records_provenance("sysmod_dart"));
        assert!(records_provenance("sysmod_kiwoom"));
        assert!(records_provenance("network_request"));
        assert!(records_provenance("execute"));
    }

    #[test]
    fn parse_reads_param_hint_and_exempt() {
        let g = parse_grounding(&kiwoom_grounding());
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].param, "stk_cd");
        assert!(g[0].hint.contains("ka10099"));
        assert_eq!(g[0].exempt_actions, vec!["ka10100".to_string()]);
    }

    #[test]
    fn exempt_action_skips_gate() {
        let g = parse_grounding(&kiwoom_grounding());
        // ka10100 (confirm a given code) must run even with an unobserved code — it *produces*
        // provenance. Gating it would block the user-typed-code confirm path.
        let args = json!({ "action": "ka10100", "stk_cd": "088390" });
        assert!(check_grounding(&args, &g, &[]).is_ok());
        // a non-exempt action with the same unobserved code is still rejected.
        let gated = json!({ "action": "ka10081", "stk_cd": "088390" });
        assert!(check_grounding(&gated, &g, &[]).is_err());
    }

    #[test]
    fn parse_missing_grounding_is_empty() {
        assert!(parse_grounding(&json!({ "name": "kiwoom" })).is_empty());
    }

    #[test]
    fn ungrounded_code_rejected() {
        let g = parse_grounding(&kiwoom_grounding());
        // model invented 088390; only 080420 was actually observed
        let observed = vec![r#"{"종목명":"이노칩","종목코드":"080420"}"#.to_string()];
        let args = json!({ "action": "ka10081", "stk_cd": "088390" });
        let err = check_grounding(&args, &g, &observed).unwrap_err();
        assert!(err.contains("088390"));
        assert!(err.contains("ka10099")); // hint surfaced
    }

    #[test]
    fn grounded_code_passes() {
        let g = parse_grounding(&kiwoom_grounding());
        let observed = vec![r#"{"종목명":"이노칩","종목코드":"080420"}"#.to_string()];
        let args = json!({ "action": "ka10081", "stk_cd": "080420" });
        assert!(check_grounding(&args, &g, &observed).is_ok());
    }

    #[test]
    fn code_nested_under_params_checked() {
        let g = parse_grounding(&kiwoom_grounding());
        let observed = vec!["005930 삼성전자".to_string()];
        let args = json!({ "action": "ka10001", "params": { "stk_cd": "999999" } });
        assert!(check_grounding(&args, &g, &observed).is_err());
        let ok = json!({ "action": "ka10001", "params": { "stk_cd": "005930" } });
        assert!(check_grounding(&ok, &g, &observed).is_ok());
    }

    #[test]
    fn multi_code_value_each_checked() {
        let g = parse_grounding(&kiwoom_grounding());
        let observed = vec!["005930 000660".to_string()];
        // one grounded, one invented → reject
        let args = json!({ "stk_cd": "005930;088390" });
        assert!(check_grounding(&args, &g, &observed).is_err());
        // both grounded → pass
        let ok = json!({ "stk_cd": "005930;000660" });
        assert!(check_grounding(&ok, &g, &observed).is_ok());
    }

    #[test]
    fn param_absent_from_args_is_ok() {
        let g = parse_grounding(&kiwoom_grounding());
        let args = json!({ "action": "ka10099", "mrkt_tp": "10" }); // the resolve call itself
        assert!(check_grounding(&args, &g, &[]).is_ok());
    }

    #[test]
    fn no_grounded_params_never_gates() {
        let args = json!({ "stk_cd": "088390" });
        assert!(check_grounding(&args, &[], &[]).is_ok());
    }

    /// kiwoom's own docs declare `KRX:039490` / `NXT:039490_NX` / `SOR:039490_AL` as the format,
    /// and the gate rejected the code it had itself grounded (2026-08-12 실측).
    #[test]
    fn vendor_decorated_token_passes_when_core_is_grounded() {
        let g = parse_grounding(&kiwoom_grounding());
        let observed = vec![r#"{"종목명":"SK하이닉스","stock_code":"000660"}"#.to_string()];
        // exchange prefix
        let prefixed = json!({ "action": "ka10081", "stk_cd": "KRX:000660" });
        assert!(check_grounding(&prefixed, &g, &observed).is_ok());
        // venue suffix (the shape live responses come back in)
        let suffixed = json!({ "action": "ka10081", "stk_cd": "000660_AL" });
        assert!(check_grounding(&suffixed, &g, &observed).is_ok());
        // both at once
        let both = json!({ "action": "ka10081", "params": { "stk_cd": "SOR:000660_AL" } });
        assert!(check_grounding(&both, &g, &observed).is_ok());
    }

    #[test]
    fn vendor_decoration_does_not_launder_a_fabricated_code() {
        let g = parse_grounding(&kiwoom_grounding());
        let observed = vec![r#"{"종목명":"SK하이닉스","stock_code":"000660"}"#.to_string()];
        // the core was never resolved — decoration must not buy provenance.
        let fake = json!({ "action": "ka10081", "stk_cd": "KRX:123456" });
        assert!(check_grounding(&fake, &g, &observed).is_err());
        let fake_suffix = json!({ "action": "ka10081", "stk_cd": "123456_NX" });
        assert!(check_grounding(&fake_suffix, &g, &observed).is_err());
    }

    #[test]
    fn plain_token_behavior_unchanged_by_decoration_rule() {
        let g = parse_grounding(&kiwoom_grounding());
        let observed = vec!["000660 SK하이닉스".to_string()];
        // undecorated grounded → pass, undecorated invented → reject (as before).
        assert!(check_grounding(&json!({ "stk_cd": "000660" }), &g, &observed).is_ok());
        assert!(check_grounding(&json!({ "stk_cd": "123456" }), &g, &observed).is_err());
    }

    #[test]
    fn decorated_token_under_a_declared_shape() {
        // An unanchored shape still gates the decorated token (an anchored `^[0-9]{6}$` never
        // matches a decorated one, so the shape gate skips it long before this path).
        let g = parse_grounding(&json!({ "grounding": { "stk_cd": {
            "resolveHint": "resolve via stock-lookup first.",
            "pattern": "[0-9]{6}"
        } } }));
        let observed = vec!["005930 삼성전자".to_string()];
        // core grounded and shaped → pass
        let ok = json!({ "action": "ka10081", "stk_cd": "KRX:005930" });
        assert!(check_grounding(&ok, &g, &observed).is_ok());
        // core ungrounded → still rejected
        let bad = json!({ "action": "ka10081", "stk_cd": "KRX:005931" });
        assert!(check_grounding(&bad, &g, &observed).is_err());
    }

    /// The inverse hole: with an ANCHORED shape (`^Q?[0-9]{6}$`) a decorated token matches
    /// nothing, so a fabricated code in vendor dress used to skip the gate entirely. The core
    /// decides membership in the param, so the dressed-up code is gated like a bare one.
    #[test]
    fn decorated_token_under_an_anchored_shape_is_gated_not_skipped() {
        let g = parse_grounding(&kis_grounding());
        let observed = vec!["005930 삼성전자".to_string()];
        // grounded core in vendor dress → passes
        let ok = json!({ "action": "v1_국내주식-008", "FID_INPUT_ISCD": "KRX:005930" });
        assert!(check_grounding(&ok, &g, &observed).is_ok());
        let ok_suffix = json!({ "action": "v1_국내주식-008", "FID_INPUT_ISCD": "005930_AL" });
        assert!(check_grounding(&ok_suffix, &g, &observed).is_ok());
        // fabricated core in the same dress → rejected (this is the hole)
        let fake = json!({ "action": "v1_국내주식-008", "FID_INPUT_ISCD": "KRX:123456" });
        let err = check_grounding(&fake, &g, &observed).unwrap_err();
        assert!(err.contains("KRX:123456"), "the error names the token as sent");
        assert!(err.contains("dart lookup")); // hint surfaced
    }

    /// Overloaded values that merely contain a delimiter must keep the old skip — the shape test
    /// is what protects index codes, timestamps and composite keys from the gate.
    #[test]
    fn overloaded_value_with_a_delimiter_is_still_skipped() {
        let g = parse_grounding(&kis_grounding());
        // a clock value: strips to "30:00", which is not a 6-digit code → not this param's id
        let ts = json!({ "action": "v1_국내주식-063", "FID_INPUT_ISCD": "09:30:00" });
        assert!(check_grounding(&ts, &g, &[]).is_ok());
        // an index code in exchange dress: core "0001" is not a 6-digit stock code → skipped
        let index = json!({ "action": "v1_국내주식-063", "FID_INPUT_ISCD": "KRX:0001" });
        assert!(check_grounding(&index, &g, &[]).is_ok());
        // a composite key: nothing strippable → skipped
        let composite = json!({ "action": "v1_국내주식-063", "FID_INPUT_ISCD": "SECTOR-KOSPI-LARGE" });
        assert!(check_grounding(&composite, &g, &[]).is_ok());
    }

    #[test]
    fn oversized_prefix_is_not_treated_as_a_venue() {
        // A 7-char prefix is not an exchange mnemonic — no strip, so no borrowed provenance.
        assert!(strip_vendor_decoration("SEVENCH:000660").is_none());
        assert!(strip_vendor_decoration("000660_LONG").is_none());
        assert!(strip_vendor_decoration("000660").is_none());
        assert_eq!(
            strip_vendor_decoration("SOR:039490_AL").as_deref(),
            Some("039490")
        );
    }

    fn kis_grounding() -> serde_json::Value {
        // korea-invest: FID_INPUT_ISCD is overloaded (stock code vs index/member code) → pattern
        // gates only 6-digit stock codes.
        json!({ "grounding": { "FID_INPUT_ISCD": {
            "resolveHint": "resolve company name → code via dart lookup.",
            "pattern": "^Q?[0-9]{6}$"
        } } })
    }

    #[test]
    fn pattern_gates_only_matching_shape() {
        let g = parse_grounding(&kis_grounding());
        // 6-digit invented stock code → gated (rejected).
        let stock = json!({ "action": "v1_국내주식-008", "FID_INPUT_ISCD": "088390" });
        assert!(check_grounding(&stock, &g, &[]).is_err());
        // 4-digit index code (코스피 0001) → doesn't match pattern → NOT gated (passes).
        let index = json!({ "action": "v1_국내주식-063", "FID_INPUT_ISCD": "0001" });
        assert!(check_grounding(&index, &g, &[]).is_ok());
        // grounded 6-digit code passes.
        let observed = vec!["모다이노칩 080420".to_string()];
        let ok = json!({ "action": "v1_국내주식-008", "FID_INPUT_ISCD": "080420" });
        assert!(check_grounding(&ok, &g, &observed).is_ok());
    }

    #[test]
    fn param_matched_case_insensitively() {
        let g = parse_grounding(&kis_grounding());
        // lowercase fid_input_iscd (some actions use it) still gated.
        let lower = json!({ "action": "v1_국내주식-080", "fid_input_iscd": "088390" });
        assert!(check_grounding(&lower, &g, &[]).is_err());
    }

    #[test]
    fn array_param_each_element_checked() {
        // dart corp_codes = a list of ids (multi-company). Each element must be grounded.
        let g = parse_grounding(&json!({ "grounding": { "corp_codes": {
            "resolveHint": "resolve each via lookup.",
            "exemptActions": ["lookup"]
        } } }));
        let observed = vec![r#"{"corp_code":"00126380"}"#.to_string(), "00164779".to_string()];
        // one grounded, one invented → reject
        let bad = json!({ "action": "financialMulti", "corp_codes": ["00126380", "99999999"] });
        assert!(check_grounding(&bad, &g, &observed).is_err());
        // all grounded → pass
        let ok = json!({ "action": "financialMulti", "corp_codes": ["00126380", "00164779"] });
        assert!(check_grounding(&ok, &g, &observed).is_ok());
        // the resolve action itself is exempt
        let lookup = json!({ "action": "lookup", "corp_codes": ["99999999"] });
        assert!(check_grounding(&lookup, &g, &observed).is_ok());
    }
}
