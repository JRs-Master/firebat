"""Choosing a strategy by measurement instead of by opinion.

Two actions, run either side of a pipeline loop:

    autotrade plan_sweep   → candidates[]        (what to test)
    ta signals × N         → backtest per run    (the measurement; FOREACH does the repeating)
    autotrade rank_sweep   → ranked[] + winner   (what it means)

The middle step is not here on purpose. `technical-analysis` owns every indicator in this
codebase, so a sweep that computed its own would be a second implementation drifting from the one
that actually trades. This module only decides *what to try* and *how to read the results*.

**A backtest is not evidence of future profit.** Try enough rule sets on one price series and the
best one is the luckiest one — that is arithmetic, not pessimism. So the ranking here does three
things that a plain "sort by return" does not:

  * every candidate is fitted on one window and scored on another (`barRange` in ta), and it is
    the *holdout* number that ranks;
  * a result with too few trades is labelled as noise rather than quietly winning;
  * the gap between the two windows is reported, because a strategy that shines in-sample and
    dies out-of-sample has told you exactly what it is.
"""
import itertools

# A sweep is a multiplier: three lists of four values is 64 runs, each a module spawn. The cap is
# a hard stop rather than a suggestion, and what it dropped gets reported. It is half the
# pipeline's FOREACH limit (100) on purpose — each candidate is two runs, so a higher number here
# would have the tail measured on one window only, which is the comparison this whole layer exists
# to avoid.
MAX_CANDIDATES = 50
# Below this a win rate is a coin flip with extra steps.
MIN_TRADES = 8


def _as_list(v, default=None):
    if v is None:
        return list(default or [])
    return list(v) if isinstance(v, (list, tuple)) else [v]


def _ma_rules(fast, slow, use_ema=False):
    kind = "ema" if use_ema else "ma"
    return [
        {"side": "buy", "label": f"{kind}{fast}>{kind}{slow}",
         "when": [{"a": f"{kind}{fast}", "op": "crossUp", "b": f"{kind}{slow}"}]},
        {"side": "sell", "label": f"{kind}{fast}<{kind}{slow}",
         "when": [{"a": f"{kind}{fast}", "op": "crossDown", "b": f"{kind}{slow}"}]},
    ]


def _rsi_rules(low, high):
    return [
        {"side": "buy", "label": f"rsi<{low}", "when": [{"a": "rsi", "op": "<", "b": low}]},
        {"side": "sell", "label": f"rsi>{high}", "when": [{"a": "rsi", "op": ">", "b": high}]},
    ]


def _bollinger_rules():
    return [
        {"side": "buy", "label": "lower band",
         "when": [{"a": "close", "op": "crossUp", "b": "bollinger.lower"}]},
        {"side": "sell", "label": "upper band",
         "when": [{"a": "close", "op": "crossDown", "b": "bollinger.upper"}]},
    ]


def _macd_rules():
    return [
        {"side": "buy", "label": "macd cross",
         "when": [{"a": "macd.macd", "op": "crossUp", "b": "macd.signal"}]},
        {"side": "sell", "label": "macd cross down",
         "when": [{"a": "macd.macd", "op": "crossDown", "b": "macd.signal"}]},
    ]


FAMILIES = {
    "ma-cross": lambda sp: [
        (f"ma{f}x{s}", _ma_rules(f, s), {})
        for f in _as_list(sp.get("fast"), [5, 10, 20])
        for s in _as_list(sp.get("slow"), [20, 60, 120])
        if f < s
    ],
    "ema-cross": lambda sp: [
        (f"ema{f}x{s}", _ma_rules(f, s, use_ema=True), {})
        for f in _as_list(sp.get("fast"), [12, 20])
        for s in _as_list(sp.get("slow"), [26, 60])
        if f < s
    ],
    "rsi": lambda sp: [
        (f"rsi{lo}/{hi}", _rsi_rules(lo, hi), {"rsiPeriod": p})
        for lo in _as_list(sp.get("low"), [25, 30, 35])
        for hi in _as_list(sp.get("high"), [65, 70, 75])
        for p in _as_list(sp.get("rsiPeriod"), [14])
    ],
    "bollinger": lambda sp: [
        (f"bb{p}x{m}", _bollinger_rules(), {"bbPeriod": p, "bbMult": m})
        for p in _as_list(sp.get("bbPeriod"), [20])
        for m in _as_list(sp.get("bbMult"), [2, 2.5])
    ],
    "macd": lambda sp: [("macd", _macd_rules(), {})],
}


def plan_sweep(inp):
    """Expand a declared search space into candidate runs for the pipeline to execute.

    Each candidate carries everything one ta call needs — rules, indicator params, costs, exits —
    plus the two windows it must be measured on. The pipeline only has to loop and pass them
    through; nothing here knows how a moving average is computed.
    """
    space = inp.get("space") or {}
    families = _as_list(space.get("families"), list(FAMILIES))
    unknown = [f for f in families if f not in FAMILIES]
    if unknown:
        raise ValueError(
            f"unknown strategy family {', '.join(unknown)} — available: {', '.join(sorted(FAMILIES))}"
        )
    costs = {k: v for k, v in {
        "feeRate": space.get("feeRate", 0.00015),
        "taxRate": space.get("taxRate", 0.0018),
        "slippageRate": space.get("slippageRate", 0.0005),
    }.items() if v is not None}
    stops = _as_list(space.get("stopLossPct"), [None])
    takes = _as_list(space.get("takeProfitPct"), [None])
    holdout = float(space.get("holdout") or 0.3)
    holdout = min(0.6, max(0.1, holdout))
    split = round(1.0 - holdout, 4)

    rows = []
    for fam in families:
        # Parameters are declared flat (`{fast, slow, low, high, ...}`) because that is what a
        # person writes; a family key holding the same names overrides them for that family only.
        # The two used to disagree — the schema documented flat and the code read nested, so a
        # declared sweep silently ran the defaults.
        fam_space = {**{k: v for k, v in space.items() if not isinstance(v, dict)},
                     **(space.get(fam) if isinstance(space.get(fam), dict) else {})}
        for cid, rules, params in FAMILIES[fam](fam_space):
            for stop, take in itertools.product(stops, takes):
                exits = {}
                if stop:
                    exits["stopLossPct"] = stop
                if take:
                    exits["takeProfitPct"] = take
                suffix = "".join(
                    [f"-sl{stop}" if stop else "", f"-tp{take}" if take else ""]
                )
                rows.append({
                    "id": f"{fam}:{cid}{suffix}",
                    "family": fam,
                    "rules": rules,
                    # One object the pipeline can splat straight into the ta call.
                    "taArgs": {**params, **costs, **exits},
                    "exits": exits,
                })
    dropped = max(0, len(rows) - MAX_CANDIDATES)
    rows = rows[:MAX_CANDIDATES]

    runs = []
    for r in rows:
        for window, rng in (("train", {"from": 0, "to": split}), ("holdout", {"from": split})):
            runs.append({
                "candidateId": r["id"],
                "window": window,
                "args": {
                    "action": "signals",
                    "rules": r["rules"],
                    "barRange": rng,
                    **r["taArgs"],
                },
            })
    return {
        "candidates": rows,
        "runs": runs,
        "runCount": len(runs),
        "dropped": dropped,
        "split": split,
        "note": (
            f"{len(rows)} candidates × 2 windows = {len(runs)} ta calls. "
            + (f"{dropped} candidates were dropped at the {MAX_CANDIDATES} cap. " if dropped else "")
            + "Pass each run's `args` to technical-analysis with the same barsCacheKey, then send "
              "the results to rank_sweep."
        ),
    }


def merge_sweeps(inp):
    """Combine one symbol's ranking into a running total across symbols.

    One symbol over one year is not a sample. A rule that survives 삼성전자 2025-26 has told you
    about 삼성전자 2025-26 — the sweep can only say "this did not fail here", and the way to turn
    that into something worth trading is to ask the same question of several series and keep what
    holds up in most of them.

    Called once per symbol with the previous total, so a pipeline can loop symbols the same way it
    loops candidates. Keeping the median rather than the mean is deliberate: one runaway symbol
    should not carry a rule that lost everywhere else.
    """
    running = inp.get("running") or {}
    symbol = inp.get("symbol") or "?"
    ranked = inp.get("ranked") or []
    acc = dict(running.get("byCandidate") or {})
    symbols = list(running.get("symbols") or [])
    if symbol not in symbols:
        symbols.append(symbol)

    for row in ranked:
        cid = row.get("candidateId")
        if not cid:
            continue
        entry = acc.setdefault(cid, {"vsBuyHold": [], "holdout": [], "trades": 0,
                                     "cleanIn": 0, "flaggedIn": 0, "symbols": []})
        if row.get("vsBuyHoldPct") is not None:
            entry["vsBuyHold"].append(float(row["vsBuyHoldPct"]))
        if row.get("holdoutReturnPct") is not None:
            entry["holdout"].append(float(row["holdoutReturnPct"]))
        entry["trades"] += int(row.get("trades") or 0)
        if row.get("flags"):
            entry["flaggedIn"] += 1
        else:
            entry["cleanIn"] += 1
        entry["symbols"].append(symbol)

    return {"byCandidate": acc, "symbols": symbols, "symbolCount": len(symbols)}


def _median(xs):
    if not xs:
        return None
    ys = sorted(xs)
    mid = len(ys) // 2
    return ys[mid] if len(ys) % 2 else (ys[mid - 1] + ys[mid]) / 2


def rank_across(inp):
    """Final ranking over every symbol swept — consistency first, size second."""
    running = inp.get("running") or {}
    acc = running.get("byCandidate") or {}
    total_symbols = int(running.get("symbolCount") or 0) or 1
    min_symbols = int(inp.get("minSymbols") or max(2, (total_symbols + 1) // 2))

    rows = []
    for cid, e in acc.items():
        vs = e.get("vsBuyHold") or []
        beat = [v for v in vs if v > 0]
        row = {
            "candidateId": cid,
            "symbols": len(e.get("symbols") or []),
            "beatBuyHoldIn": len(beat),
            "medianVsBuyHoldPct": round(_median(vs), 2) if vs else None,
            "worstVsBuyHoldPct": round(min(vs), 2) if vs else None,
            "medianHoldoutPct": round(_median(e.get("holdout") or []), 2) if e.get("holdout") else None,
            "trades": e.get("trades", 0),
            "cleanIn": e.get("cleanIn", 0),
            "flags": [],
        }
        if row["symbols"] < min_symbols:
            row["flags"].append(f"only measured on {row['symbols']} symbol(s)")
        if row["beatBuyHoldIn"] <= len(vs) // 2:
            row["flags"].append(
                f"beat buy & hold on {row['beatBuyHoldIn']} of {len(vs)} symbols — not a majority"
            )
        if row["trades"] < MIN_TRADES:
            row["flags"].append(f"{row['trades']} trades in total — too thin to read")
        rows.append(row)

    # Consistency is the ranking: how often it beat holding, then the median edge. Sorting by the
    # best number instead would hand the top spot to whichever rule got lucky on one series.
    rows.sort(key=lambda r: (r["beatBuyHoldIn"], r["medianVsBuyHoldPct"] or -999), reverse=True)
    survivors = [r for r in rows if not r["flags"]]

    return {
        "ranked": rows,
        "survivors": survivors,
        "winner": survivors[0] if survivors else None,
        "symbols": running.get("symbols") or [],
        "blocks": [{
            "type": "table",
            "props": {
                "title": f"{total_symbols}개 종목 종합",
                "columns": ["전략", "이긴 종목", "보유 대비(중앙)", "최악", "검증(중앙)", "체결", "경고"],
                "rows": [[r["candidateId"], f"{r['beatBuyHoldIn']}/{r['symbols']}",
                          r["medianVsBuyHoldPct"], r["worstVsBuyHoldPct"],
                          r["medianHoldoutPct"], r["trades"],
                          "; ".join(r["flags"]) or "—"] for r in rows[:20]],
            },
        }],
        "note": (
            "종목 과반에서 보유를 이긴 규칙만 승자 후보입니다. 한 종목에서만 크게 이긴 규칙은 "
            "그 종목에 맞춘 것이지 규칙이 좋은 게 아닙니다."
            if survivors else
            "어느 규칙도 종목 과반에서 보유를 이기지 못했습니다 — 이 검색공간·이 종목군에서는 "
            "규칙 매매보다 보유가 낫다는 뜻이고, 그것도 결과입니다."
        ),
    }


def _backtest_of(result):
    """Find the backtest object in whatever the pipeline handed back.

    A step result may arrive unwrapped (`{backtest}`), enveloped (`{success, data:{backtest}}`) or
    as the whole FOREACH row — accept all three rather than making the caller reshape it.
    """
    if not isinstance(result, dict):
        return None
    for path in (("backtest",), ("data", "backtest"), ("result", "backtest")):
        node = result
        for key in path:
            node = node.get(key) if isinstance(node, dict) else None
            if node is None:
                break
        if isinstance(node, dict):
            return node
    return None


def _score(bt):
    """One number to sort by, penalising the two ways a backtest lies.

    Drawdown is subtracted rather than reported beside the return, because a strategy that made
    30% after being down 40% is not comparable to one that made 20% smoothly — and a thin sample
    is discounted, since ten trades tell you far less than a hundred.
    """
    ret = float(bt.get("totalReturnPct") or 0.0)
    mdd = abs(float(bt.get("maxDrawdownPct") or 0.0))
    trades = int(bt.get("tradeCount") or 0)
    confidence = min(1.0, trades / 30.0)
    return round((ret - mdd * 0.5) * confidence, 4)


def rank_sweep(inp):
    """Turn the sweep's results into a ranking, with the caveats attached to the rows themselves."""
    results = inp.get("results") or []
    runs = inp.get("runs") or []
    # Results are matched to runs by position, so a length mismatch silently mislabels every row
    # after the gap — a loop that stopped early or a truncated list must be said out loud.
    mismatch = (
        f"{len(results)} results for {len(runs)} planned runs — the loop did not finish, "
        "so rows below may be matched to the wrong candidate"
        if runs and len(results) != len(runs)
        else None
    )
    by_candidate = {}

    for i, res in enumerate(results):
        run = runs[i] if i < len(runs) else {}
        # A FOREACH row keeps the item that produced it, so fall back to that when the caller did
        # not pass `runs` separately.
        cid = run.get("candidateId") or (res or {}).get("candidateId")
        window = run.get("window") or (res or {}).get("window") or "train"
        bt = _backtest_of(res)
        if not cid:
            continue
        if bt is None:
            # A run that produced no backtest is not a silent gap — ta refuses a window shorter
            # than the indicator needs, and that reason belongs on the row rather than in a log.
            why = (res or {}).get("error") or ((res or {}).get("data") or {}).get("error")
            by_candidate.setdefault(cid, {}).setdefault("errors", []).append(
                f"{window}: {str(why)[:120]}" if why else f"{window}: no backtest returned"
            )
            continue
        by_candidate.setdefault(cid, {})[window] = bt

    ranked = []
    for cid, windows in by_candidate.items():
        train, hold = windows.get("train"), windows.get("holdout")
        run_errors = windows.get("errors") or []
        primary = hold or train
        if primary is None:
            continue
        trades = int(primary.get("tradeCount") or 0)
        bench = primary.get("buyHoldPct")
        row = {
            "candidateId": cid,
            "score": _score(primary),
            "holdoutReturnPct": round(float((hold or {}).get("totalReturnPct") or 0.0), 2) if hold else None,
            "trainReturnPct": round(float((train or {}).get("totalReturnPct") or 0.0), 2) if train else None,
            "maxDrawdownPct": round(float(primary.get("maxDrawdownPct") or 0.0), 2),
            "winRate": round(float(primary.get("winRate") or 0.0), 1),
            "trades": trades,
            "buyHoldPct": round(float(bench), 2) if bench is not None else None,
            "flags": [],
        }
        # A rule that trails the thing it trades has not earned a place, however large its number
        # looks — in a year the stock tripled, "+138%" was underperformance.
        if bench is not None:
            ret = float(primary.get("totalReturnPct") or 0.0)
            row["vsBuyHoldPct"] = round(ret - float(bench), 2)
            if ret < float(bench):
                row["flags"].append(
                    f"buy & hold made {float(bench):.1f}% over the same bars — this rule lost to doing nothing"
                )
        if trades < MIN_TRADES:
            noun = "trade" if trades == 1 else "trades"
            row["flags"].append(f"only {trades} {noun} — not enough to tell skill from luck")
        if train and hold:
            gap = float(train.get("totalReturnPct") or 0.0) - float(hold.get("totalReturnPct") or 0.0)
            row["trainMinusHoldout"] = round(gap, 2)
            if gap > 10:
                row["flags"].append("much worse out of sample — likely fitted to the test window")
        if not hold:
            row["flags"].append("no holdout window — ranked on the window it was chosen from")
        row["flags"].extend(run_errors)
        ranked.append(row)

    # A row measured out of sample outranks one that was not, whatever its number says: comparing
    # a holdout return against an in-sample return is comparing two different questions.
    ranked.sort(key=lambda r: (r["holdoutReturnPct"] is not None, not r["flags"], r["score"]),
                reverse=True)
    clean = [r for r in ranked if not r["flags"]]
    winner = clean[0] if clean else (ranked[0] if ranked else None)

    blocks = [{
        "type": "table",
        "props": {
            "title": "백테스트 성적",
            "columns": ["전략", "점수", "검증 수익률", "보유 대비", "학습 수익률",
                        "최대낙폭", "승률", "체결", "경고"],
            "rows": [[
                r["candidateId"], r["score"],
                r["holdoutReturnPct"], r.get("vsBuyHoldPct"), r["trainReturnPct"],
                r["maxDrawdownPct"], r["winRate"], r["trades"],
                "; ".join(r["flags"]) or "—",
            ] for r in ranked[:20]],
        },
    }]

    return {
        "ranked": ranked,
        "winner": winner,
        "blocks": blocks,
        "warning": mismatch,
        "note": (
            "Ranked on the holdout window, not the one the rules were picked from. A backtest "
            "measures what a rule would have done, which is not what it will do — treat a flagged "
            "row as untested and a clean row as a hypothesis worth paper trading."
            if ranked else
            "No candidate produced a readable backtest — check that each run passed `bars`/"
            "`barsCacheKey` and that the results are in the same order as `runs`."
        ),
    }
