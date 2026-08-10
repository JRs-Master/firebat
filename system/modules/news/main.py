"""news — measure what a news day did to the price, instead of guessing from words.

"Was it bullish news, and by how much?" is answered here by measurement: forward returns from
the pre-news close over declared horizons, next to two controls — the average same-horizon
return over ALL days in range (placebo baseline), and, when index bars are given, the
benchmark-relative excess. No sentiment lexicon: a Korean word list scoring headlines would be
fabricated precision, and the reading of WHY belongs to the model in the chat, on top of these
numbers. The module stays deterministic: dedupe, align, divide.

Honesty rails (the measurement memories): several stories sharing a day are inseparable and are
reported as one clustered event; reaction is not causation and the output says so; nothing is
extrapolated past the last bar — a horizon that runs off the data comes back null.
"""

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

KST = timezone(timedelta(hours=9))
MARKET_CLOSE = (15, 30)  # after this KST wall time, the news belongs to the next trading day

DATE_KEYS = ["date", "time", "timestamp", "day", "dt", "stck_bsop_date", "baseDate",
             "candle_date_time_kst", "dt_ymd", "trd_dd"]
CLOSE_KEYS = ["close", "clpr", "stck_clpr", "tradePrice", "trade_price", "closePrice",
              "cur_prc", "clos_prc", "c"]


# ── parsing ────────────────────────────────────────────────────────────────────────────────────


def parse_bar_date(v):
    s = str(v or "").strip()
    if not s:
        return None
    if s.isdigit():
        if len(s) == 8:  # YYYYMMDD
            return s[:4] + "-" + s[4:6] + "-" + s[6:8]
        if len(s) >= 12:  # epoch ms
            try:
                return datetime.fromtimestamp(int(s) / 1000, tz=KST).strftime("%Y-%m-%d")
            except (ValueError, OSError):
                return None
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    return m.group(0) if m else None


def parse_bars(rows):
    """Any broker dialect -> sorted [(date, close)]. Errors name the missing field."""
    if not isinstance(rows, list) or not rows:
        return None, "bars required — daily OHLCV rows (or barsCacheKey)"
    sample = next((r for r in rows if isinstance(r, dict)), None)
    if sample is None:
        return None, "bars rows are not objects"
    date_key = next((k for k in DATE_KEYS if k in sample), None)
    close_key = next((k for k in CLOSE_KEYS if k in sample), None)
    if not date_key or not close_key:
        return None, (f"could not find a date/close field in bars — looked for "
                      f"{DATE_KEYS} / {CLOSE_KEYS}, got {sorted(sample.keys())[:12]}")
    out = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        d = parse_bar_date(r.get(date_key))
        try:
            c = float(str(r.get(close_key)).replace(",", ""))
        except (TypeError, ValueError):
            continue
        if d and c > 0:
            out.append((d, c))
    if len(out) < 3:
        return None, f"only {len(out)} usable daily bars — need at least 3"
    out.sort(key=lambda t: t[0])
    dedup = {}
    for d, c in out:
        dedup[d] = c  # last write wins: revised rows override
    return sorted(dedup.items()), None


def parse_news_dt(item):
    """naver_search pubDate (RFC-2822) or any ISO-ish date field -> aware datetime in KST."""
    for key in ("pubDate", "pub_date", "date", "publishedAt", "datetime"):
        raw = str(item.get(key) or "").strip()
        if not raw:
            continue
        try:
            dt = parsedate_to_datetime(raw)
        except (TypeError, ValueError):
            dt = None
        if dt is None:
            m = re.match(r"(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2})?:?(\d{2})?", raw)
            if not m:
                continue
            dt = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                          int(m.group(4) or 0), int(m.group(5) or 0), tzinfo=KST)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=KST)
        return dt.astimezone(KST)
    return None


TAG_RE = re.compile(r"<[^>]+>")


def clean_title(t):
    return TAG_RE.sub("", str(t or "")).replace("&quot;", '"').replace("&amp;", "&").strip()


def title_tokens(t):
    return set(re.findall(r"[0-9A-Za-z가-힣]{2,}", clean_title(t).lower()))


def cluster_items(items):
    """Near-duplicate titles (token Jaccard >= 0.5) fold into one cluster, order-preserving."""
    clusters = []
    for it in items:
        toks = title_tokens(it.get("title"))
        placed = False
        for cl in clusters:
            inter = len(toks & cl["tokens"])
            union = len(toks | cl["tokens"]) or 1
            if inter / union >= 0.5:
                cl["items"].append(it)
                cl["tokens"] |= toks
                placed = True
                break
        if not placed:
            clusters.append({"tokens": toks or {clean_title(it.get("title"))}, "items": [it]})
    return clusters


# ── impact ─────────────────────────────────────────────────────────────────────────────────────


def effective_news_date(dt):
    """After-close (>= 15:30 KST) news belongs to the next calendar day's trading."""
    if (dt.hour, dt.minute) >= MARKET_CLOSE:
        return (dt + timedelta(days=1)).strftime("%Y-%m-%d")
    return dt.strftime("%Y-%m-%d")


def forward_return(bars, dates_index, news_date, horizon):
    """close(pre-news bar) -> close(h-th bar on/after the news date). None off the data."""
    idx = None
    for i, (d, _) in enumerate(bars):
        if d >= news_date:
            idx = i
            break
    if idx is None or idx == 0:
        return None, None
    base = bars[idx - 1][1]
    tgt = idx + horizon - 1
    if tgt >= len(bars):
        return None, bars[idx][0]
    return round((bars[tgt][1] / base - 1) * 100, 2), bars[idx][0]


def control_mean(bars, horizon):
    """Average h-day return across ALL days — the placebo the news numbers stand against."""
    rets = []
    for i in range(1, len(bars) - horizon + 1):
        rets.append(bars[i + horizon - 1][1] / bars[i - 1][1] - 1)
    if not rets:
        return None
    return round(sum(rets) / len(rets) * 100, 2)


def action_impact(inp):
    items = inp.get("items")
    if not isinstance(items, list) or not items:
        return {"success": False, "action": "impact",
                "error": "items required — naver_search news rows (or itemsCacheKey)"}
    bars, err = parse_bars(inp.get("bars"))
    if err:
        return {"success": False, "action": "impact", "error": err}
    bench = None
    if inp.get("benchmarkBars"):
        bench, berr = parse_bars(inp.get("benchmarkBars"))
        if berr:
            return {"success": False, "action": "impact", "error": f"benchmark: {berr}"}

    horizons = [int(h) for h in (inp.get("horizons") or [1, 5]) if int(h) >= 1][:4] or [1, 5]

    dated = []
    undated = 0
    for it in items:
        dt = parse_news_dt(it) if isinstance(it, dict) else None
        if dt is None:
            undated += 1
            continue
        dated.append((dt, it))
    if not dated:
        return {"success": False, "action": "impact",
                "error": "no item carried a readable date (pubDate expected)"}
    dated.sort(key=lambda t: t[0])

    # One event per (effective date, title-cluster): same-day stories are inseparable.
    by_date = {}
    for dt, it in dated:
        by_date.setdefault(effective_news_date(dt), []).append(it)

    events = []
    for news_date in sorted(by_date):
        clusters = cluster_items(by_date[news_date])
        returns = {}
        traded = None
        for h in horizons:
            r, traded_day = forward_return(bars, None, news_date, h)
            returns[f"d{h}Pct"] = r
            traded = traded or traded_day
            if bench:
                br, _ = forward_return(bench, None, news_date, h)
                returns[f"d{h}ExcessPct"] = (round(r - br, 2)
                                             if r is not None and br is not None else None)
        events.append({
            "newsDate": news_date,
            "tradedOn": traded,
            "stories": len(by_date[news_date]),
            "clusters": [{"title": clean_title(cl["items"][0].get("title")),
                          "count": len(cl["items"])} for cl in clusters[:8]],
            "returns": returns,
        })

    controls = {f"d{h}Pct": control_mean(bars, h) for h in horizons}
    news_means = {}
    for h in horizons:
        vals = [e["returns"][f"d{h}Pct"] for e in events if e["returns"][f"d{h}Pct"] is not None]
        news_means[f"d{h}Pct"] = round(sum(vals) / len(vals), 2) if vals else None

    notes = [
        "reaction, not causation — a same-day market move or a second story is inside the number",
        f"control = mean return over ALL {len(bars)} bars in range; compare newsDayMean against it",
    ]
    if not bench:
        notes.append("no benchmarkBars — returns are raw, index moves included")
    if undated:
        notes.append(f"{undated} item(s) skipped: no readable date")

    return {"success": True, "action": "impact", "data": {
        "events": events,
        "newsDayMean": news_means,
        "allDaysControl": controls,
        "barRange": {"from": bars[0][0], "to": bars[-1][0], "days": len(bars)},
        "horizons": horizons,
        "notes": notes,
    }}


def action_timeline(inp):
    items = inp.get("items")
    if not isinstance(items, list) or not items:
        return {"success": False, "action": "timeline",
                "error": "items required — naver_search news rows (or itemsCacheKey)"}
    daily = {}
    undated = 0
    dated_items = []
    for it in items:
        if not isinstance(it, dict):
            continue
        dt = parse_news_dt(it)
        if dt is None:
            undated += 1
            continue
        day = dt.strftime("%Y-%m-%d")
        daily[day] = daily.get(day, 0) + 1
        dated_items.append(it)
    clusters = cluster_items(dated_items)
    data = {
        "days": [{"date": d, "count": daily[d]} for d in sorted(daily)],
        "clusters": [{"title": clean_title(cl["items"][0].get("title")),
                      "count": len(cl["items"])}
                     for cl in sorted(clusters, key=lambda c: -len(c["items"]))[:20]],
        "total": len(dated_items),
    }
    if undated:
        data["skippedNoDate"] = undated
    return {"success": True, "action": "timeline", "data": data}


# ── selftest ───────────────────────────────────────────────────────────────────────────────────


def action_selftest():
    checks = []

    def ck(name, want, got):
        checks.append({"name": name, "want": want, "got": got, "ok": want == got})

    # Flat at 100 through 7/09; the news day (7/10) closes 110; flat 110 after.
    bars = []
    base = datetime(2026, 7, 1, tzinfo=KST)
    for i in range(20):
        d = (base + timedelta(days=i)).strftime("%Y-%m-%d")
        bars.append({"date": d, "close": 100 if i < 9 else 110})
    news = [
        {"title": "회사 대박 계약 <b>체결</b>", "pubDate": "Fri, 10 Jul 2026 09:00:00 +0900"},
        {"title": "대박 계약 체결한 회사", "pubDate": "Fri, 10 Jul 2026 11:00:00 +0900"},
        {"title": "전혀 다른 소식 하나", "pubDate": "Fri, 03 Jul 2026 16:00:00 +0900"},
    ]
    out = action_impact({"items": news, "bars": bars, "horizons": [1]})
    d = out["data"]
    ck("two dated event days", 2, len(d["events"]))
    ev = {e["newsDate"]: e for e in d["events"]}
    ck("the jump day measures +10%", 10.0, ev["2026-07-10"]["returns"]["d1Pct"])
    ck("similar titles fold into one cluster", 1, len(ev["2026-07-10"]["clusters"]))
    ck("after-close news slides to the next day", True, "2026-07-04" in ev)
    ck("flat day measures 0%", 0.0, ev["2026-07-04"]["returns"]["d1Pct"])
    ctrl = d["allDaysControl"]["d1Pct"]
    ck("control mean is small but not zero (one jump in 19)", True,
       ctrl is not None and 0 < ctrl < 1)

    tl = action_timeline({"items": news})["data"]
    ck("timeline counts two days", 2, len(tl["days"]))
    ck("html tags come off titles", "회사 대박 계약 체결", tl["clusters"][0]["title"])

    ymd = parse_bar_date("20260810")
    ck("YYYYMMDD bars parse", "2026-08-10", ymd)

    failed = [c for c in checks if not c["ok"]]
    return {"success": not failed, "action": "selftest",
            "data": {"checks": checks, "total": len(checks), "failed": len(failed)}}


def main():
    # Bytes, decoded as UTF-8 explicitly — the locale default turns Korean into lone
    # surrogates on some hosts (measured on Windows), and the envelope is UTF-8 by contract.
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    try:
        envelope = json.loads(raw or "{}")
    except json.JSONDecodeError as e:
        sys.stdout.buffer.write((json.dumps(
            {"success": False, "action": "", "error": f"input JSON: {e}"})).encode("utf-8"))
        return
    inp = envelope.get("data") or envelope
    action = str(inp.get("action") or "").strip()
    handlers = {"impact": action_impact, "timeline": action_timeline}
    if action == "selftest":
        out = action_selftest()
    elif action in handlers:
        out = handlers[action](inp)
    else:
        out = {"success": False, "action": action,
               "error": f"unknown action {action!r} — one of: impact, timeline, selftest"}
    # UTF-8 bytes out, explicitly — print() writes the console codepage on some hosts.
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
