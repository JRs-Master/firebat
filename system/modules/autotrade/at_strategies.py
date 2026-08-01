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


def adopt(conn, ranked, runs, target, results=None, min_trades=MIN_TRADES,
          min_confirm=MIN_CONFIRM_SYMBOLS):
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
    sid = target.get("id") or f"ai-{target.get('symbol')}-{cid}"
    if why:
        # Recorded, not discarded: tomorrow's search should know this ground was covered.
        log_event(conn, sid, "refused", {"candidateId": cid, "why": why, "measured": row})
        return {"adopted": None, "candidateId": cid, "why": why}

    spec = spec_from_args(args, target.get("template"))
    # What the backtest promised, kept alongside the ranking so the ladder has something to check
    # the live record against later. Absent when the pipeline did not pass the run results — the
    # ladder then refuses to let this strategy reach real money at all.
    row = {**row, "expected": expected_from(runs, results, cid)}
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
