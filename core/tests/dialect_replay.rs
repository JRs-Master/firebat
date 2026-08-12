//! Dialect replay — yesterday's calls, against today's rules.
//!
//! Every absorber in `repair_input` was bought with a measured failure, and each one was found the
//! same expensive way: a live turn broke, the user reported it, and the shape was reconstructed
//! from the archive. That made dialect-hunting the test loop, which is exactly backwards — a new
//! rule could quietly change what an old shape means and nothing would notice until the next
//! failure.
//!
//! So the shapes live in a corpus (`fixtures/dialect_corpus.jsonl`) and CI replays them through
//! the SAME function the live path calls. Adding a rule now means proving the whole history still
//! reads the way it did. When a new dialect is measured, it lands here as one line — that line is
//! the regression test, forever.
//!
//! Corpus entry:
//!   case          — what this shape is, in one sentence
//!   config        — the module config fragment (`input` schema, optional `cacheInputs`)
//!   input         — the arguments exactly as a model sent them
//!   cacheRows     — seed N dated rows and substitute the resulting key for `"<KEY>"`
//!   expect        — "accept" (repairs and validates) or "reject" (must fail)
//!   errorContains — the rejection must NAME this, because an error is a next-step pointer
//!   expectInput   — the repaired arguments, exactly
//!   expectRows    — {path, len}: the row count that landed in a slot

use std::sync::Arc;

use firebat_core::managers::module::{repair_input, validate_value};
use firebat_core::utils::sysmod_cache::SysmodCacheAdapter;
use serde_json::Value;

/// Seeds `n` dated rows and hands back the cache plus its key, so a corpus entry can name one
/// with `"<KEY>"` without knowing how keys are built.
fn seeded_cache(n: usize) -> (Arc<SysmodCacheAdapter>, String, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let cache = SysmodCacheAdapter::new(dir.path().to_path_buf()).unwrap();
    let rows: Vec<Value> = (1..=n)
        .map(|i| serde_json::json!({ "date": format!("2026-08-{i:02}"), "close": i }))
        .collect();
    let key = cache
        .data("m", "a:rows", serde_json::json!({}), rows, None)
        .unwrap();
    (Arc::new(cache), key, dir)
}

fn substitute_key(v: &Value, key: &str) -> Value {
    match v {
        Value::String(s) if s == "<KEY>" => Value::String(key.to_string()),
        Value::String(_) | Value::Null | Value::Bool(_) | Value::Number(_) => v.clone(),
        Value::Array(a) => Value::Array(a.iter().map(|x| substitute_key(x, key)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), substitute_key(x, key)))
                .collect(),
        ),
    }
}

#[test]
fn every_measured_dialect_still_reads_the_way_it_did() {
    let corpus = include_str!("fixtures/dialect_corpus.jsonl");
    let mut ran = 0usize;
    for (line_no, line) in corpus.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        let entry: Value = serde_json::from_str(line)
            .unwrap_or_else(|e| panic!("corpus line {} is not JSON: {e}", line_no + 1));
        let case = entry["case"].as_str().unwrap_or("<unnamed>");
        let config = entry["config"].clone();

        // Only entries that ask for a cache get one — the rest prove the no-cache path too.
        let seeded = entry["cacheRows"].as_u64().map(|n| seeded_cache(n as usize));
        let (cache, input) = match &seeded {
            Some((cache, key, _dir)) => (Some(cache), substitute_key(&entry["input"], key)),
            None => (None, entry["input"].clone()),
        };

        let outcome: Result<Value, String> =
            repair_input("m", Some(&config), &input, cache).and_then(|repaired| {
                let out = repaired.unwrap_or_else(|| input.clone());
                match config.get("input") {
                    Some(schema) => validate_value(&out, schema).map(|_| out),
                    None => Ok(out),
                }
            });

        match entry["expect"].as_str() {
            Some("accept") => {
                let out = outcome
                    .unwrap_or_else(|e| panic!("[{case}] should have been accepted, got: {e}"));
                if let Some(want) = entry.get("expectInput").filter(|v| !v.is_null()) {
                    assert_eq!(&out, want, "[{case}] repaired arguments differ");
                }
                if let Some(rows) = entry.get("expectRows").filter(|v| !v.is_null()) {
                    let path = rows["path"].as_str().unwrap();
                    let got = out[path].as_array().map(|a| a.len()).unwrap_or_default();
                    assert_eq!(got, rows["len"].as_u64().unwrap() as usize, "[{case}] rows in `{path}`");
                }
            }
            Some("reject") => {
                let err = match outcome {
                    Err(e) => e,
                    Ok(v) => panic!("[{case}] should have been refused, but it passed as {v}"),
                };
                if let Some(needle) = entry["errorContains"].as_str() {
                    assert!(
                        err.contains(needle),
                        "[{case}] the refusal must name {needle:?} — an error is a next-step \
                         pointer, not a verdict. Got: {err}"
                    );
                }
            }
            other => panic!("[{case}] unknown expect: {other:?}"),
        }
        ran += 1;
    }
    assert!(ran >= 12, "the corpus lost entries — {ran} ran");
}
