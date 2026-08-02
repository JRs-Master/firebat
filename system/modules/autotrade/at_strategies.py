"""Strategies the model wrote, and the bar they have to clear before they reach money.

The model is allowed to invent rules. It is not allowed to grade them. Everything in this file
exists to keep those two apart: `adopt` takes the ranking and the planned runs as they came out of
the sweep — machine output from earlier pipeline steps — and finds the winner itself. Nothing here
reads a number the model typed, so a strategy cannot talk its way in.

Three things follow from that:

  * **Adoption is a decision about evidence, not about the rule.** A candidate is refused for what
    the measurement failed to show — too few symbols, no confirmation set, too few trades — and
    the refusal is written down with its reason, because the refusals are what the next night's
    run should read before searching the same ground again.
  * **Nothing starts at real.** An adopted strategy enters at `paper` and moves up only after its
    own live record agrees with the backtest that got it in. Out-of-sample measurement catches
    overfitting to a window; it does not catch slippage, partial fills, or a rule that only worked
    because the spread was tight in the sample. Live-forward does.
  * **The stage is the strategy's own mode cap.** `effective_mode` already reads `strategy.mode`
    as a ceiling and only ever demotes, so a paper-stage strategy is one whose mode is `dryrun`.
    No new mechanism decides what a stage is allowed to do.

The store is its own database rather than paper.db or live.db: a strategy definition is not a
ledger entry, and it has to survive the mode switching underneath it.
"""
import json
import os
import sqlite3
import time

import at_store as store
import at_sweep as sweep

# What a measurement has to show before a rule is allowed to trade at all. These are the same
# things the sweep already flags — restated here as refusals rather than warnings, because a flag
# nobody acts on is not a gate.
MIN_CONFIRM_SYMBOLS = 2   # symbols held out of the selection entirely
MIN_TRADES = 20           # below this, win rate and drawdown are not distinguishable from luck
STAGES = ("paper", "mock", "real", "retired")
STAGE_MODE = {"paper": "dryrun", "mock": "mock", "real": "real", "retired": "dryrun"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS ai_strategy(
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  broker TEXT NOT NULL,
  account TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  stage TEXT NOT NULL,
  stage_since_ms INTEGER NOT NULL,
  measured_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
-- Append-only, same reason the ledger is: a stage change nobody can audit is a stage change that
-- will be blamed on the market. Refusals live here too — they are the record of what was tried.
CREATE TABLE IF NOT EXISTS ai_strategy_event(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  event TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_ai_strategy_event_id ON ai_strategy_event(id, seq);
"""


def connect():
    os.makedirs(store.DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(os.path.join(store.DATA_DIR, "strategies.db"), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.executescript(SCHEMA)
    return conn


def log_event(conn, sid, event, detail=None):
    conn.execute("INSERT INTO ai_strategy_event(id, ts_ms, event, detail_json) VALUES(?,?,?,?)",
                 (sid, store.now_ms(), event, json.dumps(detail or {}, ensure_ascii=False)))
    conn.commit()


def _num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# A rule is adopted for one symbol, so the evidence has to be about that symbol. Twelve closed
# round trips in the held-out window is the floor: below that a win rate is a coin count.
MIN_SYMBOL_TRADES = 12
# A winning cell whose neighbours in the grid all lose is the luckiest cell of a few hundred, not
# an edge. Half the neighbours must also be profitable, and there must be at least two to ask.
MIN_NEIGHBOURS = 2
MIN_NEIGHBOUR_SUPPORT = 0.5


def judge_symbol(row, min_trades=MIN_SYMBOL_TRADES,
                 min_neighbours=MIN_NEIGHBOURS, min_support=MIN_NEIGHBOUR_SUPPORT):
    """Why this rule may not trade *this symbol* — empty list means it may.

    The cross-symbol gate (`judge`) asks whether a rule wins on symbols it was never chosen from.
    That is the right question when one rule is meant to cover everything, and the wrong one when
    the design is to pair a rule with the symbols that suit it: a trend rule *should* lose on a
    range-bound pair, and calling that overfitting throws away the whole approach.

    What still has to be defended is the multiple-comparisons problem, which per-symbol adoption
    makes worse rather than better — fourteen symbols times a few hundred cells is a few thousand
    chances to find a fluke. Two things replace the cross-symbol check:

      * **A held-out window on this symbol.** The rule must earn in bars the selection never saw.
        Both in absolute terms and against buy & hold — absolute because "beat buy & hold" carries
        the regime with it (in a rising market anything holding cash loses to it; in a falling one
        anything wins), and relative because a profit smaller than holding is not a reason to trade.
      * **Neighbouring cells in the grid.** If ma5/20/30 wins and ma5/20/60, a steeper slope and a
        wider stop all lose, the win is grid noise. A real effect is a plateau, not a spike.
    """
    why = []
    hold = row.get("holdoutReturnPct")
    vs = row.get("holdoutVsBuyHoldPct")
    trades = int(_num(row.get("holdoutTrades")))
    neighbours = int(_num(row.get("neighbours")))
    support = row.get("neighbourSupport")

    if hold is None or _num(hold) <= 0:
        why.append(f"out of sample it returned {hold} — before any benchmark, it has to make money")
    if vs is None or _num(vs) <= 0:
        why.append(f"out of sample it was {vs} against simply holding the coin")
    if trades < min_trades:
        why.append(f"{trades} round trips out of sample — below {min_trades} the win rate is "
                   "a coin count, not a rate")
    if neighbours < min_neighbours:
        why.append(f"only {neighbours} neighbouring parameter cell(s) to compare against, "
                   f"needs {min_neighbours} — a cell measured alone cannot be told from noise")
    elif support is None or _num(support) < min_support:
        why.append(f"neighbouring cells agree {support} of the time — a winning cell surrounded "
                   "by losing ones is the grid's luckiest cell, not an edge")
    return why


def judge(row, min_trades=MIN_TRADES, min_confirm=MIN_CONFIRM_SYMBOLS):
    """Why this ranked candidate may not trade — empty list means it may.

    Written as refusals so the caller cannot accidentally treat a missing field as a pass: an
    absent `confirmSymbols` is not "no confirmation needed", it is "never confirmed".
    """
    why = []
    symbols = int(_num(row.get("symbols")))
    beat = int(_num(row.get("beatBuyHoldIn")))
    confirm_n = int(_num(row.get("confirmSymbols")))
    confirm_beat = int(_num(row.get("confirmBeatIn")))
    trades = int(_num(row.get("trades")))
    median = row.get("medianVsBuyHoldPct")

    if symbols < 2:
        why.append(f"measured on {symbols} symbol(s) — one symbol is an anecdote")
    elif beat * 2 <= symbols:
        why.append(f"beat buy & hold on {beat} of {symbols} — not a majority")
    if confirm_n < min_confirm:
        why.append(f"confirmed on {confirm_n} unseen symbol(s), needs {min_confirm} — "
                   "a rule measured only where it was chosen is untested, not proven")
    elif confirm_beat * 2 <= confirm_n:
        why.append(f"lost on the confirmation set ({confirm_beat} of {confirm_n})")
    if trades < min_trades:
        why.append(f"{trades} trades — below {min_trades} the result is not "
                   "distinguishable from luck")
    if median is None or _num(median) <= 0:
        why.append(f"median result vs buy & hold is {median}")
    # The sweep already names these; refusing on them keeps one definition of "overfitted".
    for flag in row.get("flags") or []:
        low = str(flag).lower()
        if "out of sample" in low or "not a majority" in low or "only measured on" in low:
            why.append(str(flag))
    return why


def _winner_of(ranked):
    if not isinstance(ranked, dict):
        return None
    if isinstance(ranked.get("winner"), dict):
        return ranked["winner"]
    rows = ranked.get("ranked") or []
    return rows[0] if rows and isinstance(rows[0], dict) else None


def _args_for(runs, candidate_id):
    """The ta call that defined this candidate — the rules come from here, not from the caller."""
    for r in runs or []:
        if not isinstance(r, dict):
            continue
        if (r.get("candidateId") or (r.get("args") or {}).get("candidateId")) == candidate_id:
            return r.get("args") or {}
    return None


def spec_from_args(args, template=None):
    """A ta call plus the money rules → a strategy the cycle can run.

    Only the parts that decide trading are carried over. Window and cache references are dropped:
    they described the measurement, and keeping them would let a stale bar range follow a strategy
    into live trading.
    """
    base = dict(template or {})
    spec = {
        "kind": "rules",
        "rules": args.get("rules") or [],
        "money": base.get("money") or {"qty": 1},
        "limits": base.get("limits") or {},
        "exits": {k: v for k, v in {
            "stopLossPct": args.get("stopLossPct"),
            "takeProfitPct": args.get("takeProfitPct"),
            "trailingStopPct": args.get("trailingStopPct"),
        }.items() if v is not None} or (base.get("exits") or {}),
        "orders": base.get("orders") or {"type": "limit"},
    }
    # Indicator periods the rules refer to travel with them; a rule naming rsi14 and a module
    # defaulting to rsi9 would trade a different rule than the one that was measured.
    for k in ("rsiPeriod", "macdFast", "macdSlow", "macdSignal", "bbPeriod", "bbMult",
              "stochK", "stochD", "stochSmooth", "feeRate", "taxRate", "slippageRate"):
        if args.get(k) is not None:
            spec.setdefault("analysis", {})[k] = args[k]
    return spec


def costs_of(args):
    """What the measurement charged per trade — fee both ways, tax on the sell, slippage.

    The analyser treats an absent cost as zero, which is not a neutral default: it is the most
    flattering one. Measured live on 5-minute BTC bars, the same five trades were 60% winners and
    +0.11% at zero cost, and 0% winners and -0.59% once Upbit's own 0.05% each way was applied.
    A rule can only look good enough to trade because nobody charged it.
    """
    fee = _num((args or {}).get("feeRate"))
    tax = _num((args or {}).get("taxRate"))
    slip = _num((args or {}).get("slippageRate"))
    return {"feeRate": fee, "taxRate": tax, "slippageRate": slip,
            "roundTripPct": round((fee * 2 + tax + slip * 2) * 100, 4)}



def _coverage(runs):
    """Which values were actually tried, read off the planned runs.

    "This was refused" names one cell; "fast was 3, 5 or 8 and slow was 20, 30 or 60, and the best
    of the ninety was this" names the ground. Only the second stops the same grid being run again
    next week, which is the whole reason a refusal is written down.
    """
    if not isinstance(runs, list):
        return None
    knobs, cids = {}, set()
    for r in runs:
        if not isinstance(r, dict):
            continue
        if r.get("candidateId"):
            cids.add(r["candidateId"])
        args = r.get("args") if isinstance(r.get("args"), dict) else {}
        for k, v in args.items():
            if k in ("action", "rules", "bars", "barsCacheKey", "barRange"):
                continue
            if isinstance(v, (int, float, str)) and not isinstance(v, bool):
                knobs.setdefault(k, set()).add(v)
    return {"candidates": len(cids),
            "values": {k: sorted(v, key=str)[:12] for k, v in sorted(knobs.items())}}


def _outcome(ranked):
    """How the field did, not just its winner — a whole grid of near-misses reads differently
    from one outlier, and the next search should be able to tell them apart."""
    rows = (ranked or {}).get("ranked") if isinstance(ranked, dict) else None
    if not isinstance(rows, list) or not rows:
        return None
    def num(r, k):
        v = r.get(k)
        return float(v) if isinstance(v, (int, float)) else None
    rets = [x for x in (num(r, "medianVsBuyHoldPct") for r in rows) if x is not None]
    flags = {}
    for r in rows:
        for f in (r.get("flags") or []):
            key = str(f).split(" — ")[0][:60]
            flags[key] = flags.get(key, 0) + 1
    return {"measured": len(rows),
            "bestVsBuyHoldPct": max(rets) if rets else None,
            "medianVsBuyHoldPct": (sorted(rets)[len(rets) // 2] if rets else None),
            "positive": sum(1 for x in rets if x > 0),
            # The reasons the field failed, counted. One rule refused for too few trades is a
            # parameter; ninety refused for it is a timeframe that does not trade.
            "flagCounts": dict(sorted(flags.items(), key=lambda kv: -kv[1])[:5])}


def _log_proposal(conn, sid, proposal):
    """The model's own words, verbatim, before anything is judged.

    A refusal that records only the numbers loses the reasoning behind the attempt, and the
    reasoning is what tells the next revision whether this ground was covered thoughtfully or by
    accident. Written before the verdict so it survives an early refusal.
    """
    if proposal in (None, "", {}, []):
        return
    log_event(conn, sid, "proposal", {"proposal": proposal})


def adopt(conn, ranked, runs, target, results=None, min_trades=MIN_TRADES,
          min_confirm=MIN_CONFIRM_SYMBOLS, proposal=None):
    """Take the sweep's winner into the store — at `paper`, or not at all.

    `ranked` and `runs` are the earlier steps' output passed through the pipeline, which is the
    whole point: the model chose what to search, not what won.
    """
    row = _winner_of(ranked)
    if not row:
        return {"adopted": None, "why": ["the ranking named no candidate"]}
    cid = row.get("candidateId")
    args = _args_for(runs, cid)
    if args is None:
        return {"adopted": None,
                "why": [f"candidate '{cid}' won but its rules are not in `runs` — "
                        "pass the same planned runs the ranking was built from"]}
    why = judge(row, min_trades=min_trades, min_confirm=min_confirm)
    # A costless backtest is not a cheaper backtest, it is a different one. At scalping frequency
    # the round trip is most of the result, so a rule measured without it has not been measured.
    costs = costs_of(args)
    if costs["roundTripPct"] <= 0:
        why = why + ["measured with no commission, tax or slippage — at this frequency the round "
                     "trip is most of the result, so declare feeRate/taxRate/slippageRate for the "
                     "venue and measure again"]
    sid = target.get("id") or f"ai-{target.get('symbol')}-{cid}"
    _log_proposal(conn, sid, proposal)
    if why:
        # Recorded, not discarded: tomorrow's search should know this ground was covered. The
        # winner's refusal alone does not say that — it names one cell. What stops the same grid
        # being run again is knowing which values were tried and how the whole field did, so the
        # coverage and a summary of the results go in beside the verdict.
        log_event(conn, sid, "refused", {
            "candidateId": cid, "why": why, "measured": row,
            "searched": _coverage(runs), "outcome": _outcome(ranked)})
        return {"adopted": None, "candidateId": cid, "why": why}

    return _store_adopted(conn, sid, cid, args, row, target, runs, results, costs)


def _store_adopted(conn, sid, cid, args, row, target, runs, results, costs):
    """Write one judged candidate into the store at `paper`. The only path that adopts anything."""
    spec = spec_from_args(args, target.get("template"))
    # What the backtest promised, kept alongside the ranking so the ladder has something to check
    # the live record against later. Absent when the pipeline did not pass the run results — the
    # ladder then refuses to let this strategy reach real money at all.
    row = {**row, "expected": expected_from(runs, results, cid), "costs": costs}
    now = store.now_ms()
    existing = conn.execute("SELECT stage, created_ms FROM ai_strategy WHERE id=?", (sid,)).fetchone()
    # A revision restarts the ladder. The rules changed, so the live record that earned the old
    # stage was earned by a different strategy wearing the same name.
    stage = "paper"
    conn.execute(
        "INSERT INTO ai_strategy(id, symbol, broker, account, spec_json, stage, stage_since_ms,"
        " measured_json, created_ms, updated_ms) VALUES(?,?,?,?,?,?,?,?,?,?)"
        " ON CONFLICT(id) DO UPDATE SET spec_json=excluded.spec_json, stage=excluded.stage,"
        " stage_since_ms=excluded.stage_since_ms, measured_json=excluded.measured_json,"
        " symbol=excluded.symbol, broker=excluded.broker, account=excluded.account,"
        " updated_ms=excluded.updated_ms",
        (sid, target.get("symbol") or "", target.get("broker") or "", target.get("account") or "",
         json.dumps(spec, ensure_ascii=False), stage, now,
         json.dumps(row, ensure_ascii=False),
         int(existing["created_ms"]) if existing else now, now))
    conn.commit()
    log_event(conn, sid, "revised" if existing else "adopted",
              {"candidateId": cid, "stage": stage, "measured": row,
               "previousStage": existing["stage"] if existing else None})
    return {"adopted": sid, "candidateId": cid, "stage": stage, "measured": row,
            "note": ("채택은 종이거래부터입니다 — 실전 성적이 백테스트를 따라올 때만 올라갑니다."
                     if not existing else
                     "규칙이 바뀌었으므로 사다리를 다시 시작합니다 — 옛 단계를 벌어들인 건 다른 규칙입니다.")}


def rows_to_strategies(conn, include_retired=False):
    """Store rows → the strategy dicts `cycle` already understands.

    The stage becomes the strategy's `mode`, which `effective_mode` reads as a ceiling. That is why
    a paper strategy cannot place a live order even while the module is set to real: the mode
    resolver only ever demotes.
    """
    q = "SELECT * FROM ai_strategy" + ("" if include_retired else " WHERE stage != 'retired'")
    out = []
    for r in conn.execute(q):
        try:
            spec = json.loads(r["spec_json"])
        except (ValueError, TypeError):
            continue
        out.append({**spec, "id": r["id"], "enabled": True, "symbol": r["symbol"],
                    "broker": r["broker"], "account": r["account"],
                    "mode": STAGE_MODE.get(r["stage"], "dryrun"),
                    "stage": r["stage"], "source": "ai"})
    return out


def set_stage(conn, sid, stage, why=None):
    if stage not in STAGES:
        raise ValueError(f"unknown stage '{stage}' — one of {', '.join(STAGES)}")
    cur = conn.execute("SELECT stage FROM ai_strategy WHERE id=?", (sid,)).fetchone()
    if cur is None:
        return False
    conn.execute("UPDATE ai_strategy SET stage=?, stage_since_ms=?, updated_ms=? WHERE id=?",
                 (stage, store.now_ms(), store.now_ms(), sid))
    conn.commit()
    log_event(conn, sid, "stage", {"from": cur["stage"], "to": stage, "why": why})
    return True


def read_all(conn, limit=100):
    rows = []
    for r in conn.execute("SELECT * FROM ai_strategy ORDER BY updated_ms DESC LIMIT ?", (limit,)):
        rows.append({"id": r["id"], "symbol": r["symbol"], "broker": r["broker"],
                     "account": r["account"], "stage": r["stage"],
                     "stageSinceMs": r["stage_since_ms"],
                     "spec": json.loads(r["spec_json"]),
                     "measured": json.loads(r["measured_json"]),
                     "updatedMs": r["updated_ms"]})
    return rows


def read_events(conn, sid=None, limit=50):
    if sid:
        q = ("SELECT * FROM ai_strategy_event WHERE id=? ORDER BY seq DESC LIMIT ?", (sid, limit))
    else:
        q = ("SELECT * FROM ai_strategy_event ORDER BY seq DESC LIMIT ?", (limit,))
    return [{"id": r["id"], "tsMs": r["ts_ms"], "event": r["event"],
             "detail": json.loads(r["detail_json"] or "{}")}
            for r in conn.execute(*q)]


# ── the ladder ───────────────────────────────────────────────────────────────────────────────
# Out-of-sample measurement catches a rule fitted to one window. It does not catch slippage, a
# fill that never came, or an edge that existed only because the sample happened to be liquid.
# Only trading it forward catches those, so a strategy climbs by its own record and nothing else.
LADDER = ("paper", "mock", "real")
MIN_LIVE_TRADES = 10        # closed round-trips at a stage before it may move either way
WIN_RATE_SLACK = 20.0       # points below the measured win rate that still counts as tracking
RETIRE_AFTER_DEMOTIONS = 2  # a rule demoted off the bottom rung is not worth more sessions


def live_record(conn, strategy_id, since_ms=0):
    """The strategy's own realised round-trips — the same two numbers a backtest reports.

    Win rate and average return per trade are comparable to the backtest directly, which a won
    figure is not: comparing realised P&L against a percentage would need the benchmark over the
    same live window, and inventing one is how a comparison starts lying.
    """
    rows = conn.execute(
        "SELECT qty, price, realized FROM ledger WHERE strategy_id=? AND ts_ms>=?"
        " AND side IN ('sell','transfer_out')", (strategy_id, int(since_ms or 0))).fetchall()
    returns, realized_total = [], 0.0
    for r in rows:
        realized = float(r["realized"] or 0.0)
        realized_total += realized
        # Cost is what the row itself implies: proceeds minus what was made on them.
        cost = float(r["price"]) * float(r["qty"]) - realized
        if cost > 1e-6:
            returns.append(realized / cost * 100.0)
    wins = [x for x in returns if x > 0]
    return {
        "trades": len(returns),
        "winRatePct": round(len(wins) / len(returns) * 100, 2) if returns else None,
        "avgReturnPct": round(sum(returns) / len(returns), 4) if returns else None,
        "realized": round(realized_total, 2),
    }


def _median(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    mid = len(xs) // 2
    return xs[mid] if len(xs) % 2 else (xs[mid - 1] + xs[mid]) / 2


def expected_from(runs, results, candidate_id):
    """What the winning candidate's backtest promised — median across the runs that measured it.

    Holdout runs are preferred when the sweep marked them: the in-sample half is the half the rule
    was fitted on, so promising numbers there are not a promise about anything.
    """
    picked = []
    for i, run in enumerate(runs or []):
        if not isinstance(run, dict) or i >= len(results or []):
            continue
        cid = run.get("candidateId") or (run.get("args") or {}).get("candidateId")
        if cid != candidate_id:
            continue
        res = results[i]
        bt = (res or {}).get("backtest") if isinstance(res, dict) else None
        if isinstance(bt, dict):
            picked.append((run.get("window"), bt))
    holdout = [bt for w, bt in picked if str(w or "").lower() == "holdout"]
    use = holdout or [bt for _, bt in picked]
    if not use:
        return None
    return {
        "winRatePct": _median([b.get("winRate") for b in use]),
        "avgReturnPct": _median([b.get("avgReturnPct") for b in use]),
        "window": "holdout" if holdout else "all",
        "runs": len(use),
    }


def verdict(expected, live, stage="paper", min_trades=MIN_LIVE_TRADES, slack=WIN_RATE_SLACK):
    """`promote` / `hold` / `demote`, and why — decided only from numbers we produced ourselves."""
    trades = int(live.get("trades") or 0)
    if trades < min_trades:
        return "hold", f"{trades} closed trades at this stage, needs {min_trades}"
    realized = float(live.get("realized") or 0.0)
    if realized < 0:
        return "demote", f"realised {realized:,.0f} at this stage"
    want = (expected or {}).get("winRatePct")
    got = live.get("winRatePct")
    if want is None or got is None:
        # No backtest to track against. A positive record still earns the paper-to-mock step, but
        # not the one into real money: that step is the reward for keeping a promise, and there is
        # no promise here to have kept. Profit alone can be a short lucky run.
        if stage != "paper":
            return "hold", ("no measured win rate to compare against — real money needs a "
                            "backtest this record can be checked against")
        return "promote", f"realised {realized:,.0f} over {trades} trades (nothing to compare to)"
    if got + slack < want:
        return "demote", f"win rate {got}% against {want}% measured — the backtest did not survive"
    return "promote", f"win rate {got}% against {want}% measured, realised {realized:,.0f}"


def next_stage(stage, direction, demotions=0):
    i = LADDER.index(stage) if stage in LADDER else 0
    if direction == "promote":
        return LADDER[min(i + 1, len(LADDER) - 1)]
    if i == 0:
        return "retired" if demotions + 1 >= RETIRE_AFTER_DEMOTIONS else "paper"
    return LADDER[i - 1]


def demotion_count(conn, sid):
    rows = conn.execute(
        "SELECT detail_json FROM ai_strategy_event WHERE id=? AND event='stage'", (sid,)).fetchall()
    n = 0
    for r in rows:
        try:
            d = json.loads(r["detail_json"] or "{}")
        except (ValueError, TypeError):
            continue
        a, b = d.get("from"), d.get("to")
        if a in LADDER and b in LADDER and LADDER.index(b) < LADDER.index(a):
            n += 1
        elif b == "paper" and a == "paper":
            n += 1
    return n


def review(conn, ledger_for, min_trades=MIN_LIVE_TRADES, slack=WIN_RATE_SLACK):
    """Walk every adopted strategy up or down by what its own ledger says.

    `ledger_for(stage)` hands back the open ledger a strategy at that stage trades in — paper and
    live are separate files, and reading the wrong one would grade a strategy on someone else's
    fills. Only the record since the current stage began counts: the point is whether this rule
    works here, now, and a stage it already left is a different question.
    """
    out = []
    for r in conn.execute("SELECT * FROM ai_strategy WHERE stage != 'retired'").fetchall():
        sid, stage = r["id"], r["stage"]
        try:
            measured = json.loads(r["measured_json"] or "{}")
        except (ValueError, TypeError):
            measured = {}
        expected = measured.get("expected") if isinstance(measured, dict) else None
        led = ledger_for(STAGE_MODE.get(stage, "dryrun"))
        live = live_record(led, sid, r["stage_since_ms"])
        move, why = verdict(expected, live, stage=stage, min_trades=min_trades, slack=slack)
        row = {"id": sid, "stage": stage, "live": live, "expected": expected,
               "verdict": move, "why": why}
        if move != "hold":
            to = next_stage(stage, move, demotion_count(conn, sid))
            if to != stage:
                set_stage(conn, sid, to, why)
                row["stage"] = to
                row["moved"] = f"{stage} → {to}"
        out.append(row)
    return out


MAX_MEASURE_SYMBOLS = 8


def traded_symbols(conn, strategy_id, since_ms=0, cap=MAX_MEASURE_SYMBOLS):
    """The names this strategy actually traded, busiest first.

    A screened rule does not trade a fixed list — it trades whatever came up that day, which can
    be dozens of names. Measuring it against a universe declared months ago would score it on a
    population it never touched. Capped because the nightly run has to finish: the busiest names
    are the ones its record is mostly made of.
    """
    rows = conn.execute(
        "SELECT symbol, COUNT(*) n FROM ledger WHERE strategy_id=? AND ts_ms>=?"
        " GROUP BY symbol ORDER BY n DESC LIMIT ?", (strategy_id, int(since_ms or 0), cap)
    ).fetchall()
    return [r["symbol"] for r in rows]


# How many completed round trips a strategy owes before its rule is revised again.
#
# "After the close" is not a trigger in a market that never closes, and the unit that actually
# carries information is the round trip, not the day. But one closed trade is a sample of one:
# revising on it would chase noise, and — because a changed rule restarts the promotion ladder —
# a strategy revised every trade would never leave paper. So the clock ticks on trades, and this
# is how many have to have ticked.
MIN_CLOSED_TRIPS = 8


def closed_round_trips(led, strategy_id, since_ms=0):
    """Completed entry→exit cycles since a moment — a sell that took the position flat.

    Partial exits are not cycles. A rule that scales out of one entry three times has run one
    round trip, and counting the sells would revise it three times as often as it earned.
    """
    row = led.execute(
        "SELECT COUNT(*) AS n FROM ledger WHERE strategy_id=? AND ts_ms>=?"
        " AND side IN ('sell','transfer_out') AND qty_after IS NOT NULL"
        " AND ABS(qty_after) < 1e-9", (strategy_id, int(since_ms or 0))).fetchone()
    return int(row["n"] if row else 0)


def next_revision(conn, ledger_for, limit_events=8, min_closed_trips=MIN_CLOSED_TRIPS):
    """Which strategy tonight's revision run should work on, and everything it needs to do it.

    One per night, on purpose. A revision searches the neighbourhood of a rule that is already
    running, so it needs that rule, its live record and what has already been refused for it — and
    a pipeline cannot carry six chained steps per item inside a loop. Picking one and rotating is
    honest about that instead of pretending a loop would work.

    Worst first: a strategy that just lost a stage is the one whose rule stopped describing the
    market. After that, whichever has gone longest without a revision.
    """
    rows = conn.execute("SELECT * FROM ai_strategy WHERE stage != 'retired'").fetchall()
    if not rows:
        return None
    scored, waiting = [], []
    for r in rows:
        led_r = ledger_for(STAGE_MODE.get(r["stage"], "dryrun"))
        live = live_record(led_r, r["id"], r["stage_since_ms"])
        demotions = demotion_count(conn, r["id"])
        # Since the rule was last written, not since the stage began: a revision is what resets
        # the question, so the evidence for the next one starts there.
        trips = closed_round_trips(led_r, r["id"], r["updated_ms"])
        # A demotion is already a verdict reached on completed trades, so it does not wait.
        if not demotions and trips < min_closed_trips:
            waiting.append({"strategyId": r["id"], "closedRoundTrips": trips,
                            "needs": min_closed_trips})
            continue
        # Lower sorts first: demoted before healthy, then least recently revised.
        scored.append(((0 if demotions else 1), r["updated_ms"], r, live, trips))
    if not scored:
        return {"strategyId": None, "waiting": waiting,
                "note": ("아직 수정할 전략이 없습니다 — 규칙을 고친 뒤로 완결된 매매가 "
                         f"{min_closed_trips} 회는 쌓여야 합니다. 24시간 시장에서는 장 마감이 "
                         "아니라 이 횟수가 시계입니다.")}
    scored.sort(key=lambda x: (x[0], x[1]))
    _, _, r, live, trips = scored[0]
    # The scoring loop's handle belonged to whichever row came last, not to the one picked.
    led = ledger_for(STAGE_MODE.get(r["stage"], "dryrun"))
    try:
        spec = json.loads(r["spec_json"])
        measured = json.loads(r["measured_json"] or "{}")
    except (ValueError, TypeError):
        spec, measured = {}, {}
    events = [e for e in read_events(conn, r["id"], limit_events)]
    # What the model was shown, kept with the strategy. Without it a later reader sees a revision
    # and its verdict but not the evidence it was made on, and cannot tell a good call from a
    # lucky one — the ledger records what happened, this records what was known at the time.
    log_event(conn, r["id"], "revision_brief", {
        "stage": r["stage"], "live": live, "measured": measured,
        "closedRoundTrips": trips, "currentRules": spec.get("rules") or [],
        "currentExits": spec.get("exits") or {},
        "refusedBefore": [e for e in events if e.get("kind") == "refused"][:3],
    })
    return {
        "strategyId": r["id"], "symbol": r["symbol"], "broker": r["broker"],
        "account": r["account"], "stage": r["stage"],
        "currentRules": spec.get("rules") or [],
        "currentExits": spec.get("exits") or {},
        "measured": measured,
        "live": live,
        "closedRoundTrips": trips,
        "waiting": waiting,
        # What to re-measure on. A rule that trades a screen is scored on the names it actually
        # traded, not on a list someone declared once — and the ledger is the only place that
        # knows which those were.
        "tradedSymbols": traded_symbols(led, r["id"], r["stage_since_ms"]),
        "history": events,
        # The vocabulary, from the code that consumes it. A model can only propose what it is
        # told exists, and a list typed into the schedule file goes stale the moment a family or
        # an exit shape is added — which is how the alignment families and the exit ladders came
        # to be unreachable from the one loop that is supposed to find them.
        "searchSpace": sweep.space_vocabulary(),
        "note": ("이 전략의 규칙 주변을 탐색하세요 — 새 전략을 만드는 자리가 아닙니다. "
                 "채택되면 같은 전략이 갱신되고 사다리는 처음부터 다시 시작합니다."),
    }


def verdict_fact(symbol, candidate_id, why, row, adopted):
    """One night's verdict, in a sentence the next night can read.

    The strategy store already holds all of this, in more detail — but only this module can read
    that store, and only by opening the file. A fact goes into recall, which the framework hands
    back on the next revision without anyone asking. The point is not to store it twice; it is
    that the search which decides what to try next can see what was already tried.

    Numbers, not adjectives. "Refused" tells the next round nothing; "refused, beat holding on 2
    of 8 symbols, median -61.8%p" tells it which direction is already known to be wrong.
    """
    detail = []
    if isinstance(row, dict):
        for key, label in (("beatBuyHoldIn", "이긴 종목"), ("symbols", "/"),
                           ("medianVsBuyHoldPct", "보유 대비 중앙"), ("trades", "왕복")):
            v = row.get(key)
            if v is not None:
                detail.append(f"{label} {v}" if label != "/" else f"/{v}")
    head = "채택" if adopted else "거부"
    reason = "" if adopted else " — " + "; ".join(str(w) for w in (why or [])[:2])
    body = " · ".join(x for x in [" ".join(detail).replace(" /", "/")] if x)
    return {
        "entity": str(symbol or "?"),
        "entityType": "symbol",
        "factType": "strategy-verdict",
        "content": f"{candidate_id}: {head}{reason}" + (f" ({body})" if body else ""),
    }


def adopt_fits(conn, fits, runs, target, results=None, min_trades=MIN_SYMBOL_TRADES,
               proposal=None):
    """Adopt one rule per symbol, from `fit_symbols` output passed straight through.

    The rows are re-judged here rather than trusted. `fit_symbols` already attached a verdict, but
    a verdict that arrives as data is a verdict that can be edited on the way — and the whole
    reason the evidence never passes through the model is that nothing between the measurement and
    the store should be able to rewrite it.

    A symbol whose rule is refused is recorded, not dropped: tomorrow's search should know this
    coin was tried and why it did not take.
    """
    if not isinstance(fits, list):
        return {"adopted": [], "why": ["adopt_fits 는 fit_symbols 의 `fits` 목록을 그대로 받습니다"]}
    adopted, refused = [], []
    for fit in fits:
        if not isinstance(fit, dict):
            continue
        cid, symbol = fit.get("candidateId"), fit.get("symbol")
        if not cid or not symbol:
            refused.append({"symbol": symbol, "candidateId": cid,
                            "why": ["a fit needs both a symbol and a candidate"]})
            continue
        args = _args_for(runs, cid)
        if args is None:
            refused.append({"symbol": symbol, "candidateId": cid,
                            "why": [f"candidate '{cid}' is not in `runs` — pass the same planned "
                                    "runs the measurement was built from"]})
            continue
        why = judge_symbol(fit, min_trades=min_trades)
        costs = costs_of(args)
        if costs["roundTripPct"] <= 0:
            why = why + ["measured with no commission, tax or slippage — at this frequency the "
                         "round trip is most of the result, so declare feeRate/taxRate/"
                         "slippageRate for the venue and measure again"]
        sid = f"ai-{symbol}-{cid}"
        _log_proposal(conn, sid, proposal)
        if why:
            log_event(conn, sid, "refused", {"candidateId": cid, "symbol": symbol,
                                             "why": why, "measured": fit})
            refused.append({"symbol": symbol, "candidateId": cid, "why": why})
            continue
        one = dict(target)
        one["symbol"] = symbol
        adopted.append(_store_adopted(conn, sid, cid, args, dict(fit), one, runs, results, costs))
    return {
        "adopted": adopted,
        "refused": refused,
        "adoptedCount": len(adopted),
        "note": (f"{len(adopted)} 개 종목에 규칙이 붙었습니다 — 전부 종이거래부터 시작합니다. "
                 f"{len(refused)} 개는 거부됐고 사유는 `refused` 에 있습니다."),
    }
