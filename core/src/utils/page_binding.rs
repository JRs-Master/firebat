//! Page ↔ module binding — the PageSpec-only `module` block + publish-time bake.
//!
//! One convention unifies "a page consumes module data" across every timing:
//!   { "type": "module", "props": { "module", "action"?, "args"?, "when": "publish"|"request",
//!                                  "cacheTtl"?, "_baked": [blocks], "_bakedAt": ms } }
//! - when=publish (default): the SAVE path runs the module server-side and writes the returned
//!   render blocks into `_baked` NEXT TO the binding (never replacing it) — a live binding makes
//!   "rebake this page" a standard cron job (LLM-free periodic pages).
//! - when=request: the published-page SSR resolves it per visit (S3, TS side) with a TTL cache;
//!   `_baked` stays as the fallback snapshot.
//!
//! Security model (threat table in plan):
//! - The page-binding surface is a CLOSED OPT-IN SET: only a module whose config declares
//!   `"pageBinding": {"alias"?, "action"}` can be bound, and ONLY that declared action runs.
//!   A free-form page spec therefore cannot execute arbitrary sysmods/actions.
//! - requiresApproval actions are refused even when declared (mirror of the public page-form
//!   gate — order/destructive actions never run from a page surface).
//! - hub-scoped saves (project `hub:`) skip baking entirely (v1): widget visitors are not a
//!   periodic-page authoring surface; the binding is stored inert.
//! - Output caps bound the spec size (block count + serialized bytes).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::managers::module::ModuleManager;

/// Per-spec bake budget — a decoy-nested spec cannot spawn unbounded module runs.
const MAX_BINDINGS_PER_SPEC: usize = 20;
/// `_baked` caps — spec-bomb 방지 (dataCacheKey bake 와 같은 클래스).
const MAX_BAKED_BLOCKS: usize = 50;
const MAX_BAKED_BYTES: usize = 256 * 1024;

/// config `pageBinding` declaration.
#[derive(Debug, Clone, PartialEq)]
pub struct PageBinding {
    /// Template text-sugar alias (`{stock symbol="..."}`). Optional — block form works without it.
    pub alias: Option<String>,
    /// The ONE action allowed to run from a page binding. Its contract:
    /// `{success, data:{blocks:[{type,props},...]}}`(모듈이 렌더 소유).
    pub action: String,
}

pub fn parse_page_binding(config: &serde_json::Value) -> Option<PageBinding> {
    let pb = config.get("pageBinding")?;
    let action = pb.get("action")?.as_str()?.trim().to_string();
    if action.is_empty() {
        return None;
    }
    let alias = pb
        .get("alias")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    Some(PageBinding { alias, action })
}

/// Pure gate decision — shared by publish-bake (Rust) and mirrored by the TS request-resolve
/// gate (lib/page-binding-gate.ts). Returns the resolved action or a refusal reason.
/// `requested_action` empty = use the declared action (authoring convenience).
pub fn binding_gate(config: &serde_json::Value, requested_action: &str) -> Result<String, String> {
    let Some(binding) = parse_page_binding(config) else {
        return Err("module does not declare pageBinding — page binding is opt-in".to_string());
    };
    let action = if requested_action.trim().is_empty() {
        binding.action.clone()
    } else {
        requested_action.trim().to_string()
    };
    if action != binding.action {
        return Err(format!(
            "action '{}' is not the declared pageBinding action '{}'",
            action, binding.action
        ));
    }
    // requiresApproval(주문류) 는 페이지 표면에서 실행 금지 — page-form 게이트 미러.
    if let Some(decl) = config.get("requiresApproval") {
        if crate::utils::pending_tools::requires_approval_value(decl, &action) {
            return Err("requiresApproval actions cannot run from a page binding".to_string());
        }
    }
    Ok(action)
}

#[derive(Debug, Default)]
pub struct BakeReport {
    pub baked: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

/// Bake every `module` block (when != "request") in a page spec, in place.
/// Failures never kill the save — the block keeps its previous `_baked` (stale-but-alive) and
/// the reason lands in the report + WARN log.
pub async fn bake_spec(
    spec: &mut serde_json::Value,
    modules: &Arc<ModuleManager>,
    project: Option<&str>,
) -> BakeReport {
    let mut report = BakeReport::default();
    // hub visitor save = inert binding (v1 — admin 컨텍스트만 bake).
    if project.is_some_and(|p| p.starts_with("hub:")) {
        return report;
    }
    let Some(body) = spec.get_mut("body") else {
        return report;
    };
    let mut budget = MAX_BINDINGS_PER_SPEC;
    walk(body, modules, &mut report, &mut budget).await;
    if report.baked > 0 || !report.errors.is_empty() {
        tracing::info!(
            target: "page_binding",
            baked = report.baked,
            skipped = report.skipped,
            errors = report.errors.len(),
            "[page_binding] bake_spec done"
        );
        for e in &report.errors {
            tracing::warn!(target: "page_binding", "[page_binding] {e}");
        }
    }
    report
}

/// Recursive walk (boxed — async recursion). Containers(grid/tabs/card children)까지 하강하되
/// module 블록 안쪽(_baked 산출물)으로는 안 내려간다(재-bake·중첩 실행 방지).
fn walk<'a>(
    v: &'a mut serde_json::Value,
    modules: &'a Arc<ModuleManager>,
    report: &'a mut BakeReport,
    budget: &'a mut usize,
) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
    Box::pin(async move {
        match v {
            serde_json::Value::Array(arr) => {
                for item in arr.iter_mut() {
                    walk(item, modules, report, budget).await;
                }
            }
            serde_json::Value::Object(obj) => {
                if obj.get("type").and_then(|t| t.as_str()) == Some("module") {
                    bake_one(obj, modules, report, budget).await;
                    return; // do not descend into _baked
                }
                for (_k, val) in obj.iter_mut() {
                    walk(val, modules, report, budget).await;
                }
            }
            _ => {}
        }
    })
}

async fn bake_one(
    block: &mut serde_json::Map<String, serde_json::Value>,
    modules: &Arc<ModuleManager>,
    report: &mut BakeReport,
    budget: &mut usize,
) {
    let Some(props) = block.get_mut("props").and_then(|p| p.as_object_mut()) else {
        report.skipped += 1;
        return;
    };
    let when = props.get("when").and_then(|v| v.as_str()).unwrap_or("publish");
    if when == "request" {
        // 방문 시 SSR 이 resolve — publish bake 대상 아님.
        report.skipped += 1;
        return;
    }
    let module = props
        .get("module")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if module.is_empty() {
        report.errors.push("module block without a module name".to_string());
        return;
    }
    if *budget == 0 {
        report
            .errors
            .push(format!("binding budget exceeded ({MAX_BINDINGS_PER_SPEC}) — '{module}' skipped"));
        return;
    }
    *budget -= 1;

    // 게이트 — opt-in 선언 + 선언 액션 + requiresApproval 거부.
    let Some(config) = modules.get_config_any_scope(&module).await else {
        report.errors.push(format!("module '{module}' not found"));
        return;
    };
    let requested = props.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let action = match binding_gate(&config, requested) {
        Ok(a) => a,
        Err(reason) => {
            report.errors.push(format!("'{module}': {reason}"));
            return;
        }
    };

    // 실행 — run_raw = 풀 데이터(auto-cache truncation 없음). 게이트(enabled·스키마 검증·
    // sandbox·net_guard)는 run_impl 이 그대로 적용.
    let mut input = serde_json::Map::new();
    input.insert("action".to_string(), serde_json::Value::String(action.clone()));
    if let Some(args) = props.get("args").and_then(|a| a.as_object()) {
        for (k, val) in args {
            if k != "action" {
                input.insert(k.clone(), val.clone());
            }
        }
    }
    match modules.run_raw(&module, &serde_json::Value::Object(input)).await {
        Ok(out) if out.success => {
            let blocks = out
                .data
                .get("blocks")
                .and_then(|b| b.as_array())
                .cloned()
                .unwrap_or_default();
            if blocks.is_empty() {
                report
                    .errors
                    .push(format!("'{module}:{action}' returned no data.blocks — pageBinding contract"));
                return;
            }
            if blocks.len() > MAX_BAKED_BLOCKS {
                report.errors.push(format!(
                    "'{module}:{action}' returned {} blocks (cap {MAX_BAKED_BLOCKS})",
                    blocks.len()
                ));
                return;
            }
            let serialized = serde_json::to_string(&blocks).unwrap_or_default();
            if serialized.len() > MAX_BAKED_BYTES {
                report.errors.push(format!(
                    "'{module}:{action}' baked output {}B exceeds cap {MAX_BAKED_BYTES}B",
                    serialized.len()
                ));
                return;
            }
            // 유효 블록 shape 만(각 항목 = object with string type) — 모듈 실수 방어.
            if !blocks
                .iter()
                .all(|b| b.get("type").and_then(|t| t.as_str()).is_some())
            {
                report
                    .errors
                    .push(format!("'{module}:{action}' blocks must be objects with a string type"));
                return;
            }
            props.insert("_baked".to_string(), serde_json::Value::Array(blocks));
            props.insert(
                "_bakedAt".to_string(),
                serde_json::Value::from(chrono::Utc::now().timestamp_millis()),
            );
            report.baked += 1;
        }
        Ok(out) => {
            report.errors.push(format!(
                "'{module}:{action}' failed: {}",
                out.error.unwrap_or_else(|| "module returned success:false".to_string())
            ));
        }
        Err(e) => {
            report.errors.push(format!("'{module}:{action}' error: {e}"));
        }
    }
}

// ── 템플릿 텍스트 sugar (S4) ────────────────────────────────────────────────
//
// `{alias key="value" n=3}` in TEXT block content compiles into a `module` block.
// Registered aliases only — an unknown `{word ...}` stays literal (the `{date}` principle:
// the token table is the trigger, prose can't misfire). code/html/math/diagram 블록은 제외.

/// 등록 alias 맵: alias → (module, action).
pub type AliasMap = std::collections::HashMap<String, (String, String)>;

/// ModuleManager 의 모든 config 를 스캔해 pageBinding alias 맵 구성.
pub async fn collect_aliases(modules: &Arc<ModuleManager>) -> AliasMap {
    let mut map = AliasMap::new();
    let mut entries = modules.list_system().await;
    entries.extend(modules.list_user_modules().await);
    for e in entries {
        if let Some(config) = modules.get_config_any_scope(&e.name).await {
            if let Some(b) = parse_page_binding(&config) {
                if let Some(alias) = b.alias {
                    map.entry(alias).or_insert((e.name.clone(), b.action));
                }
            }
        }
    }
    map
}

/// body 블록 배열 안 text 블록의 shortcode 를 module 블록으로 컴파일 (in place).
/// text 가 shortcode 로 쪼개지면 [text?, module, text?] 순서로 배열 확장.
pub fn compile_shortcodes(body: &mut Vec<serde_json::Value>, aliases: &AliasMap) {
    if aliases.is_empty() {
        return;
    }
    let mut out: Vec<serde_json::Value> = Vec::with_capacity(body.len());
    for block in body.drain(..) {
        let ty = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        // 텍스트류만 — code/html 안 리터럴 예시 보호.
        if ty != "text" {
            out.push(block);
            continue;
        }
        let content = block
            .pointer("/props/content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        let segments = split_shortcodes(&content, aliases);
        if segments.len() == 1 {
            if let ShortcodeSegment::Text(_) = &segments[0] {
                out.push(block);
                continue;
            }
        }
        for seg in segments {
            match seg {
                ShortcodeSegment::Text(t) => {
                    if !t.trim().is_empty() {
                        let mut b = block.clone();
                        if let Some(p) = b.pointer_mut("/props/content") {
                            *p = serde_json::Value::String(t);
                        }
                        out.push(b);
                    }
                }
                ShortcodeSegment::Module { module, action, args } => {
                    out.push(serde_json::json!({
                        "type": "module",
                        "props": { "module": module, "action": action, "args": args, "when": "publish" }
                    }));
                }
            }
        }
    }
    *body = out;
}

enum ShortcodeSegment {
    Text(String),
    Module {
        module: String,
        action: String,
        args: serde_json::Value,
    },
}

/// `{alias k="v" n=3}` 스캐너 — 등록 alias 만 토큰으로 인정, 나머지는 리터럴 유지.
fn split_shortcodes(text: &str, aliases: &AliasMap) -> Vec<ShortcodeSegment> {
    let mut segments = Vec::new();
    let mut plain = String::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' {
            if let Some((consumed, alias, args)) = try_parse_shortcode(&chars[i..], aliases) {
                if !plain.is_empty() {
                    segments.push(ShortcodeSegment::Text(std::mem::take(&mut plain)));
                }
                let (module, action) = aliases.get(&alias).cloned().expect("alias verified");
                segments.push(ShortcodeSegment::Module { module, action, args });
                i += consumed;
                continue;
            }
        }
        plain.push(chars[i]);
        i += 1;
    }
    if !plain.is_empty() || segments.is_empty() {
        segments.push(ShortcodeSegment::Text(plain));
    }
    segments
}

/// `{alias k="v" n=3}` 하나 파싱 시도 — 성공 시 (소비 char 수, alias, args). 실패 = None(리터럴).
fn try_parse_shortcode(
    chars: &[char],
    aliases: &AliasMap,
) -> Option<(usize, String, serde_json::Value)> {
    // chars[0] == '{'. 닫는 '}' 를 같은 줄 안에서 찾는다(개행 넘는 중괄호 = 리터럴 취급).
    let mut end = None;
    for (k, c) in chars.iter().enumerate().skip(1) {
        if *c == '\n' {
            return None;
        }
        if *c == '}' {
            end = Some(k);
            break;
        }
    }
    let end = end?;
    let inner: String = chars[1..end].iter().collect();
    let mut parts = inner.trim().split_whitespace();
    let alias = parts.next()?.to_string();
    if !aliases.contains_key(&alias) {
        return None;
    }
    let mut args = serde_json::Map::new();
    for kv in parts {
        let (k, v) = kv.split_once('=')?; // key=value 형식 아니면 전체를 리터럴로
        let key = k.trim();
        if key.is_empty() {
            return None;
        }
        let raw = v.trim();
        let value = if let Some(stripped) = raw.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
            serde_json::Value::String(stripped.to_string())
        } else if let Ok(n) = raw.parse::<i64>() {
            serde_json::Value::from(n)
        } else if let Ok(f) = raw.parse::<f64>() {
            serde_json::Value::from(f)
        } else if raw == "true" || raw == "false" {
            serde_json::Value::Bool(raw == "true")
        } else {
            serde_json::Value::String(raw.to_string())
        };
        args.insert(key.to_string(), value);
    }
    Some((end + 1, alias, serde_json::Value::Object(args)))
}
