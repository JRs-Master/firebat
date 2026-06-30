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
//! Pure / dependency-free — both core and the dispatch layers import it.

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
}

/// Parse `config.grounding` into requirements.
/// Shape: `{ "<param>": { "resolveHint": "<text>", "exemptActions": ["<action>", ...],
///          "pattern": "<regex>" }, ... }`.
/// Missing / malformed → empty (opt-in: a module without `grounding` is never gated).
/// An invalid `pattern` regex is dropped (treated as no pattern = gate all) rather than failing.
pub fn parse_grounding(config: &serde_json::Value) -> Vec<GroundedParam> {
    let Some(obj) = config.get("grounding").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    obj.iter()
        .filter(|(param, _)| !param.is_empty())
        .map(|(param, spec)| GroundedParam {
            param: param.clone(),
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
        })
        .collect()
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
            // Overloaded param: only gate tokens matching the declared id shape (e.g. 6-digit
            // stock code). Fixed reference codes (index/sector) that don't match are left alone.
            if let Some(re) = &gp.pattern {
                if !re.is_match(&token) {
                    continue;
                }
            }
            if !is_grounded(&token, observed) {
                let hint = if gp.hint.is_empty() {
                    default_hint(&gp.param)
                } else {
                    gp.hint.clone()
                };
                return Err(format!(
                    "Ungrounded value: '{}' = '{}' was never resolved in this conversation. {}",
                    gp.param, token, hint
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
}
