//! TickAggregator — 1-second bars from realtime frames, straight into the timeseries store.
//!
//! A candle is a collapsed result: by the time OHLCV exists, the order flow that made it is
//! gone, and every microstructure signal measured on bars died for exactly that reason
//! (2026-08-05, six physics analogies, all rejected — the observable was already the collapse).
//! This is the pre-collapse record at the coarsest useful grain: one row per second per symbol
//! — price OHLC, signed volume split into buy/sell, and whatever else the stream's declaration
//! maps. Raw frames would be ~20× the rows for nothing we can act on (our executable horizon is
//! 30s–5m; milliseconds are structurally not ours).
//!
//! Declarative like the rest of the WS stack: a stream's config carries `tick1s` naming where
//! the items sit in a frame, which field is the symbol, and a semantic map of fields. The
//! aggregator knows no broker. Rows land in the shared timeseries store (`data/timeseries.db`)
//! under `tick1s:<module>:<real|mock>:<symbol>` with 14-digit UTC date keys — the same keyspace
//! discipline as candles, and NOT a module-private sqlite (that would be the fourth one).
//!
//! Restart guard: the store treats a differing row under a covered key as a retroactive
//! adjustment and wipes the series. A reboot mid-second would re-collect a poorer copy of a
//! second already stored, so the first flush per key reads the stored high-water mark and drops
//! anything at or below it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use firebat_core::ports::ITimeseriesStorePort;

/// How a stream states buy/sell volume. Kiwoom signs the number itself (`"15": "-3"`); upbit
/// sends an unsigned `trade_volume` next to a side flag (`ask_bid: "ASK"|"BID"`), so the sign
/// lives in a different field. Declared as either a plain field name (already signed) or
/// `{field, negateWhen: {field, equals}}` — when the side flag matches, the volume is a sell.
struct SignedVolumeDecl {
    field: String,
    negate_when: Option<(String, String)>,
}

/// Resolved per-watch declaration (`ws.streams.<key>.tick1s`).
struct TickDecl {
    items_path: Option<String>,
    type_field: Option<(String, String)>,
    symbol_field: String,
    values_field: Option<String>,
    price_field: Option<String>,
    signed_volume: Option<SignedVolumeDecl>,
    /// Everything else in `map` — stored last-value under its semantic name.
    extra_fields: Vec<(String, String)>,
}

/// A declared `equals` value, and the frame field it is compared against, need not be a string.
/// Upbit names its side `"ASK"`; Binance flags the maker side with the boolean `true`. Reading
/// only `as_str()` silently dropped the whole `negateWhen` clause on a boolean venue, which does
/// not fail — it counts every sell as a buy, so the tick series looks healthy and the order flow
/// it reports is fiction. Compare on the scalar's text instead, whatever JSON type carried it.
fn scalar_text(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(_) | serde_json::Value::Number(_) => Some(v.to_string()),
        _ => None,
    }
}

fn scalar_eq(v: Option<&serde_json::Value>, want: &str) -> bool {
    v.and_then(scalar_text).is_some_and(|got| got == want)
}

fn parse_decl(cfg: &serde_json::Value) -> Option<TickDecl> {
    let map = cfg.get("map")?.as_object()?;
    let mut price = None;
    let mut signed = None;
    let mut extra = Vec::new();
    for (k, v) in map {
        match k.as_str() {
            "price" => price = Some(v.as_str()?.to_string()),
            "signedVolume" => {
                signed = if let Some(f) = v.as_str() {
                    Some(SignedVolumeDecl { field: f.to_string(), negate_when: None })
                } else {
                    Some(SignedVolumeDecl {
                        field: v.get("field")?.as_str()?.to_string(),
                        negate_when: v.get("negateWhen").and_then(|n| {
                            Some((
                                n.get("field")?.as_str()?.to_string(),
                                scalar_text(n.get("equals")?)?,
                            ))
                        }),
                    })
                };
            }
            _ => extra.push((k.clone(), v.as_str()?.to_string())),
        }
    }
    Some(TickDecl {
        items_path: cfg.get("items").and_then(|v| v.as_str()).map(String::from),
        type_field: cfg.get("type").and_then(|t| {
            Some((
                t.get("field")?.as_str()?.to_string(),
                scalar_text(t.get("equals")?)?,
            ))
        }),
        symbol_field: cfg.get("symbol").and_then(|v| v.as_str()).unwrap_or("item").to_string(),
        values_field: cfg.get("values").and_then(|v| v.as_str()).map(String::from),
        price_field: price,
        signed_volume: signed,
        extra_fields: extra,
    })
}

/// Broker numerics arrive as "+71200", "-3", "1,234" — the sign is data (buy/sell), the rest
/// is formatting.
fn num_of(v: &serde_json::Value) -> Option<f64> {
    if let Some(n) = v.as_f64() {
        return Some(n);
    }
    let s = v.as_str()?.trim().replace(',', "");
    let s = s.strip_prefix('+').unwrap_or(&s);
    s.parse::<f64>().ok()
}

#[derive(Clone)]
struct SecondAgg {
    sec_key: i64, // 14-digit UTC
    o: f64,
    h: f64,
    l: f64,
    c: f64,
    vol: f64,
    buy: f64,
    sell: f64,
    n: u64,
    extras: serde_json::Map<String, serde_json::Value>,
}

impl SecondAgg {
    fn row(&self) -> serde_json::Value {
        let mut m = serde_json::Map::new();
        m.insert("t".into(), serde_json::json!(self.sec_key));
        m.insert("o".into(), serde_json::json!(self.o));
        m.insert("h".into(), serde_json::json!(self.h));
        m.insert("l".into(), serde_json::json!(self.l));
        m.insert("c".into(), serde_json::json!(self.c));
        m.insert("vol".into(), serde_json::json!(self.vol));
        m.insert("buyVol".into(), serde_json::json!(self.buy));
        m.insert("sellVol".into(), serde_json::json!(self.sell));
        m.insert("n".into(), serde_json::json!(self.n));
        for (k, v) in &self.extras {
            m.insert(k.clone(), v.clone());
        }
        serde_json::Value::Object(m)
    }
}

#[derive(Default)]
struct KeyState {
    cur: Option<SecondAgg>,
    done: Vec<SecondAgg>,
    /// Highest date_key already in the store — set on first flush, everything ≤ it is dropped.
    floor: Option<i64>,
}

pub struct TickAggregator {
    store: Arc<dyn ITimeseriesStorePort>,
    state: Mutex<HashMap<String, KeyState>>,
}

fn utc_sec_key() -> i64 {
    chrono::Utc::now()
        .format("%Y%m%d%H%M%S")
        .to_string()
        .parse()
        .unwrap_or(0)
}

impl TickAggregator {
    pub fn new(store: Arc<dyn ITimeseriesStorePort>) -> Arc<Self> {
        let agg = Arc::new(Self { store, state: Mutex::new(HashMap::new()) });
        // The last second of a quiet stream never completes on its own — a frame has to arrive
        // to roll it. The ticker closes anything older than the current second and flushes.
        let weak = Arc::downgrade(&agg);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let Some(agg) = weak.upgrade() else { break };
                agg.flush();
            }
        });
        agg
    }

    /// Series key — mock and real never share a series, same rule as the ledgers.
    fn series_key(module: &str, mock: bool, symbol: &str) -> String {
        format!("tick1s:{}:{}:{}", module, if mock { "mock" } else { "real" }, symbol)
    }

    /// Feed one realtime frame through a watch's `tick1s` declaration. Cheap no-op on frames
    /// that do not match (control frames, other stream types).
    pub fn ingest(&self, module: &str, mock: bool, cfg: &serde_json::Value, frame: &serde_json::Value) {
        let Some(decl) = parse_decl(cfg) else { return };
        let items: Vec<&serde_json::Value> = match &decl.items_path {
            Some(p) => match frame.get(p).and_then(|v| v.as_array()) {
                Some(arr) => arr.iter().collect(),
                None => return,
            },
            None => vec![frame],
        };
        let now_key = utc_sec_key();
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        for item in items {
            if let Some((f, want)) = &decl.type_field {
                if !scalar_eq(item.get(f), want) {
                    continue;
                }
            }
            let Some(symbol) = item.get(&decl.symbol_field).and_then(|v| v.as_str()) else {
                continue;
            };
            let values = match &decl.values_field {
                Some(f) => match item.get(f) {
                    Some(v) => v,
                    None => continue,
                },
                None => item,
            };
            let price = decl
                .price_field
                .as_ref()
                .and_then(|f| values.get(f))
                .and_then(num_of)
                .map(f64::abs); // brokers sign the price by tick direction; magnitude is the price
            let signed = decl.signed_volume.as_ref().and_then(|sv| {
                let n = values.get(&sv.field).and_then(num_of)?;
                Some(match &sv.negate_when {
                    // Side-flag venues (upbit): the number is a magnitude; the flag is the sign.
                    Some((f, want)) => {
                        if scalar_eq(values.get(f), want) {
                            -n.abs()
                        } else {
                            n.abs()
                        }
                    }
                    None => n,
                })
            });
            let ks = state.entry(Self::series_key(module, mock, symbol)).or_default();
            // Roll the second.
            if ks.cur.as_ref().map(|c| c.sec_key) != Some(now_key) {
                if let Some(done) = ks.cur.take() {
                    ks.done.push(done);
                }
            }
            let p = match price {
                Some(p) if p > 0.0 => p,
                _ => ks.cur.as_ref().map(|c| c.c).unwrap_or(0.0),
            };
            if p <= 0.0 {
                continue; // no price yet for this key — nothing worth a row
            }
            let cur = ks.cur.get_or_insert_with(|| SecondAgg {
                sec_key: now_key,
                o: p, h: p, l: p, c: p,
                vol: 0.0, buy: 0.0, sell: 0.0, n: 0,
                extras: serde_json::Map::new(),
            });
            cur.h = cur.h.max(p);
            cur.l = cur.l.min(p);
            cur.c = p;
            cur.n += 1;
            if let Some(sv) = signed {
                cur.vol += sv.abs();
                if sv > 0.0 {
                    cur.buy += sv;
                } else {
                    cur.sell += sv.abs();
                }
            }
            for (name, field) in &decl.extra_fields {
                if let Some(n) = values.get(field).and_then(num_of) {
                    cur.extras.insert(name.clone(), serde_json::json!(n));
                }
            }
        }
    }

    /// Close finished seconds and write them. Called by the 1s ticker; safe to call anytime.
    pub fn flush(&self) {
        let now_key = utc_sec_key();
        let mut batches: Vec<(String, Vec<(i64, serde_json::Value)>)> = Vec::new();
        {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            for (key, ks) in state.iter_mut() {
                if ks.cur.as_ref().is_some_and(|c| c.sec_key < now_key) {
                    if let Some(done) = ks.cur.take() {
                        ks.done.push(done);
                    }
                }
                if ks.done.is_empty() {
                    continue;
                }
                if ks.floor.is_none() {
                    // First flush since boot: never rewrite a second the store already holds —
                    // a poorer duplicate reads as a retroactive adjustment and wipes the series.
                    let last = self
                        .store
                        .read_before(key, 99_999_999_999_999, 1)
                        .first()
                        .and_then(|r| r.get("t").and_then(|v| v.as_i64()))
                        .unwrap_or(0);
                    ks.floor = Some(last);
                }
                let floor = ks.floor.unwrap_or(0);
                let rows: Vec<(i64, serde_json::Value)> = ks
                    .done
                    .drain(..)
                    .filter(|a| a.sec_key > floor)
                    .map(|a| (a.sec_key, a.row()))
                    .collect();
                if let Some(max) = rows.iter().map(|(k, _)| *k).max() {
                    ks.floor = Some(max);
                    batches.push((key.clone(), rows));
                }
            }
        }
        for (key, mut rows) in batches {
            rows.sort_by_key(|(k, _)| *k);
            let min = rows.first().map(|r| r.0).unwrap_or(0);
            let max = rows.last().map(|r| r.0).unwrap_or(0);
            let (upserted, invalidated) = self.store.merge_rows(&key, &rows, min, max + 1);
            if invalidated {
                tracing::warn!(target: "tick_agg", key = %key,
                    "tick series invalidated on write — a covered second differed (should not happen: floor guard)");
            } else {
                tracing::debug!(target: "tick_agg", key = %key, rows = upserted, "tick rows written");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_numerics_parse_with_signs_and_commas() {
        assert_eq!(num_of(&serde_json::json!("+71,200")), Some(71200.0));
        assert_eq!(num_of(&serde_json::json!("-3")), Some(-3.0));
        assert_eq!(num_of(&serde_json::json!(42.5)), Some(42.5));
        assert_eq!(num_of(&serde_json::json!("abc")), None);
    }

    #[test]
    fn decl_splits_semantic_map() {
        let cfg = serde_json::json!({
            "items": "data", "type": {"field": "type", "equals": "0B"},
            "symbol": "item", "values": "values",
            "map": {"price": "10", "signedVolume": "15", "strength": "228"}
        });
        let d = parse_decl(&cfg).unwrap();
        assert_eq!(d.price_field.as_deref(), Some("10"));
        let sv = d.signed_volume.expect("signed volume declared");
        assert_eq!(sv.field, "15");
        assert!(sv.negate_when.is_none(), "kiwoom signs the number itself");
        assert_eq!(d.extra_fields, vec![("strength".to_string(), "228".to_string())]);
    }

    /// The upbit shape: unsigned volume + a side flag in a sibling field. `negateWhen` makes the
    /// flag the sign; the frame itself is the item (no `items`, no `values`).
    #[test]
    fn a_side_flag_signs_an_unsigned_volume() {
        let cfg = serde_json::json!({
            "type": {"field": "type", "equals": "trade"},
            "symbol": "code",
            "map": {
                "price": "trade_price",
                "signedVolume": {
                    "field": "trade_volume",
                    "negateWhen": {"field": "ask_bid", "equals": "ASK"}
                }
            }
        });
        let d = parse_decl(&cfg).unwrap();
        assert!(d.items_path.is_none());
        assert!(d.values_field.is_none());
        assert_eq!(d.symbol_field, "code");
        let sv = d.signed_volume.expect("signed volume declared");
        assert_eq!(sv.field, "trade_volume");
        assert_eq!(
            sv.negate_when,
            Some(("ask_bid".to_string(), "ASK".to_string()))
        );
    }

    /// The binance shape: the side is a BOOLEAN (`m` — was the buyer the maker), not a word.
    /// Reading `equals` as a string dropped the clause and left every sell counted as a buy —
    /// a tick series that looks fine and reports invented order flow. Both the parse and the
    /// comparison have to travel on the scalar's text.
    #[test]
    fn a_boolean_side_flag_still_signs_the_volume() {
        let cfg = serde_json::json!({
            "type": {"field": "e", "equals": "trade"},
            "symbol": "s",
            "map": {
                "price": "p",
                "signedVolume": {
                    "field": "q",
                    "negateWhen": {"field": "m", "equals": true}
                }
            }
        });
        let d = parse_decl(&cfg).expect("boolean equals must parse");
        assert_eq!(d.type_field, Some(("e".to_string(), "trade".to_string())));
        let sv = d.signed_volume.expect("signed volume declared");
        assert_eq!(sv.negate_when, Some(("m".to_string(), "true".to_string())));
        // And the comparison agrees with the parse, which is the half that actually signs a row.
        assert!(scalar_eq(Some(&serde_json::json!(true)), "true"));
        assert!(!scalar_eq(Some(&serde_json::json!(false)), "true"));
        assert!(scalar_eq(Some(&serde_json::json!("trade")), "trade"));
    }
}
