//! Page↔module binding — pure-fn tests (gate + shortcode compiler).
//!
//! `bake_spec` needs a live ModuleManager+sandbox so its behavior is covered by the
//! deployment checklist; the security-critical decisions (opt-in gate, requiresApproval
//! refusal, alias-registered-only shortcodes) are pure and locked here.

use firebat_core::utils::page_binding::{
    binding_gate, compile_shortcodes, parse_page_binding, AliasMap,
};
use serde_json::json;

fn cfg(v: serde_json::Value) -> serde_json::Value {
    v
}

#[test]
fn parse_declared_binding_with_alias() {
    let c = cfg(json!({ "pageBinding": { "alias": "stock", "action": "page_blocks" } }));
    let b = parse_page_binding(&c).expect("declared");
    assert_eq!(b.alias.as_deref(), Some("stock"));
    assert_eq!(b.action, "page_blocks");
}

#[test]
fn parse_rejects_missing_or_empty() {
    assert!(parse_page_binding(&json!({})).is_none());
    assert!(parse_page_binding(&json!({ "pageBinding": {} })).is_none());
    assert!(parse_page_binding(&json!({ "pageBinding": { "action": "  " } })).is_none());
}

#[test]
fn parse_filters_invalid_alias_chars() {
    // alias with spaces/braces is dropped (block form still works via action).
    let c = cfg(json!({ "pageBinding": { "alias": "bad alias!", "action": "a" } }));
    let b = parse_page_binding(&c).expect("action valid");
    assert!(b.alias.is_none());
}

#[test]
fn gate_undeclared_module_is_refused() {
    let c = cfg(json!({ "input": {} }));
    assert!(binding_gate(&c, "").is_err());
}

#[test]
fn gate_empty_request_uses_declared_action() {
    let c = cfg(json!({ "pageBinding": { "action": "page_blocks" } }));
    assert_eq!(binding_gate(&c, "").unwrap(), "page_blocks");
    assert_eq!(binding_gate(&c, "page_blocks").unwrap(), "page_blocks");
}

#[test]
fn gate_other_action_is_refused() {
    let c = cfg(json!({ "pageBinding": { "action": "page_blocks" } }));
    assert!(binding_gate(&c, "history").is_err());
}

#[test]
fn gate_requires_approval_is_refused() {
    // bool form — the whole module is approval-gated.
    let c = cfg(json!({
        "pageBinding": { "action": "create-order" },
        "requiresApproval": true
    }));
    assert!(binding_gate(&c, "").is_err());
    // array form — only when the declared action is listed.
    let c = cfg(json!({
        "pageBinding": { "action": "create-order" },
        "requiresApproval": ["create-order"]
    }));
    assert!(binding_gate(&c, "").is_err());
    let c = cfg(json!({
        "pageBinding": { "action": "quotes" },
        "requiresApproval": ["create-order"]
    }));
    assert_eq!(binding_gate(&c, "").unwrap(), "quotes");
}

fn aliases() -> AliasMap {
    let mut m = AliasMap::new();
    m.insert("stock".to_string(), ("yfinance".to_string(), "page_blocks".to_string()));
    m
}

fn text_block(content: &str) -> serde_json::Value {
    json!({ "type": "text", "props": { "content": content } })
}

#[test]
fn shortcode_registered_alias_compiles_to_module_block() {
    let mut body = vec![text_block("before {stock symbol=\"005930.KS\" n=3} after")];
    compile_shortcodes(&mut body, &aliases());
    assert_eq!(body.len(), 3);
    assert_eq!(body[0]["props"]["content"], "before ");
    assert_eq!(body[1]["type"], "module");
    assert_eq!(body[1]["props"]["module"], "yfinance");
    assert_eq!(body[1]["props"]["action"], "page_blocks");
    assert_eq!(body[1]["props"]["args"]["symbol"], "005930.KS");
    assert_eq!(body[1]["props"]["args"]["n"], 3);
    assert_eq!(body[2]["props"]["content"], " after");
}

#[test]
fn shortcode_unknown_alias_stays_literal() {
    // `{date}` principle — unregistered tokens (placeholders, prose braces) never fire.
    let original = "today is {date} and {weather k=\"seoul\"} stays";
    let mut body = vec![text_block(original)];
    compile_shortcodes(&mut body, &aliases());
    assert_eq!(body.len(), 1);
    assert_eq!(body[0]["props"]["content"], original);
}

#[test]
fn shortcode_skips_non_text_blocks() {
    let code = json!({ "type": "code", "props": { "code": "{stock symbol=\"x\"}" } });
    let mut body = vec![code.clone()];
    compile_shortcodes(&mut body, &aliases());
    assert_eq!(body[0], code);
}

#[test]
fn shortcode_newline_spanning_brace_is_literal() {
    let original = "open {stock\nsymbol=\"x\"} close";
    let mut body = vec![text_block(original)];
    compile_shortcodes(&mut body, &aliases());
    assert_eq!(body.len(), 1);
    assert_eq!(body[0]["props"]["content"], original);
}

// ── 선언형 blocks 템플릿 (config 만으로 페이지 블록 구성 — 모듈 코드 0) ─────────
use firebat_core::utils::page_binding::render_declared_blocks;

fn args_of(v: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    v.as_object().cloned().unwrap()
}

#[test]
fn declared_binding_parses_args_and_blocks() {
    let c = cfg(json!({
        "pageBinding": {
            "alias": "kstock",
            "action": "ka10081",
            "args": { "upd_stkpc_tp": "1" },
            "blocks": [{ "type": "stock_chart", "props": { "data": "$.rows" } }]
        }
    }));
    let b = parse_page_binding(&c).expect("declared");
    assert_eq!(b.action, "ka10081");
    assert_eq!(b.args.unwrap()["upd_stkpc_tp"], "1");
    assert_eq!(b.blocks.unwrap().len(), 1);
}

#[test]
fn declared_template_fills_data_path_and_args() {
    let tpl = vec![json!({
        "type": "stock_chart",
        "props": { "symbol": "{stk_cd}", "title": "{title}", "data": "$.stk_dt_pole_chart_qry", "indicators": ["MA5"] }
    })];
    let data = json!({ "apiId": "ka10081", "stk_dt_pole_chart_qry": [{ "date": "2026-07-20", "close": 244000 }] });
    let args = args_of(json!({ "stk_cd": "005930", "title": "삼성전자" }));
    let out = render_declared_blocks(&tpl, &data, &args);
    assert_eq!(out.len(), 1);
    let p = &out[0]["props"];
    assert_eq!(p["symbol"], "005930");
    assert_eq!(p["title"], "삼성전자");
    assert_eq!(p["data"][0]["close"], 244000);
    assert_eq!(p["indicators"][0], "MA5"); // 리터럴 보존
}

#[test]
fn declared_template_skips_block_when_data_path_missing() {
    // 응답에 해당 필드가 없으면 그 블록은 빠진다(빈 차트를 그리느니 생략).
    let tpl = vec![json!({ "type": "stock_chart", "props": { "data": "$.nope" } })];
    let out = render_declared_blocks(&tpl, &json!({ "other": [1] }), &args_of(json!({})));
    assert!(out.is_empty());
}

#[test]
fn declared_template_drops_unresolved_arg_prop_only() {
    // 인자가 없으면 그 prop 만 빠지고 블록은 살아남는다(빈 문자열이 흘러들지 않게).
    let tpl = vec![json!({ "type": "table", "props": { "title": "{missing}", "rows": "$.rows" } })];
    let out = render_declared_blocks(&tpl, &json!({ "rows": [["a"]] }), &args_of(json!({})));
    assert_eq!(out.len(), 1);
    assert!(out[0]["props"].get("title").is_none());
    assert_eq!(out[0]["props"]["rows"][0][0], "a");
}
