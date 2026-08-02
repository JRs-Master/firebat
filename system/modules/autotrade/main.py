"""Autotrade — runs declared strategies and owns the per-strategy ledger.

This slice deliberately places no orders. It fetches nothing either: candles and the ta signal
arrive as arguments, so the whole decision path can be driven from a cron pipeline
(`broker(candles) → technical-analysis(signals) → autotrade(cycle)`) before any module-to-module
call path exists. Two things follow from that, both wanted:

  * the strategy engine, the ledger and the risk gates can be verified on real prices today, and
  * when the call path does land, this stays the fallback for environments without it — the same
    code either way, which is the only way the dry run is evidence about live behaviour.

`dryrun` writes to its own database and simulates each fill at the intent price. That is the
standard paper-trading approximation and matches what ta's backtest assumes (a fill at the signal
bar), so paper results and backtest results are comparable. It is also optimistic: a real limit
order may not fill at all, which is what the mock-account slice exists to find out.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import at_engine as eng          # noqa: E402
import at_store as store         # noqa: E402
import at_universe as uni        # noqa: E402
import at_orders as orders       # noqa: E402
import at_strategies as strat    # noqa: E402
import at_sweep as sweep         # noqa: E402
import at_context as ctxstore  # noqa: E402


def read_input():
    """stdin protocol = `{correlationId, data:{...}}` (the sandbox wraps it).

    Accepts a bare object too, so the module can be driven by hand for testing.
    """
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    payload = json.loads(raw)
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        return payload["data"]
    return payload


def out(obj):
    print(json.dumps(obj, ensure_ascii=False, default=str))


def fail(message):
    out({"success": False, "error": message})


_DECLARED = None


def declared_default(key, fallback):
    """The `default` this setting declares in config.json, or the fallback.

    Settings reach the sandbox as `MODULE_<KEY>` env vars, which exist only once someone has
    pressed save. Before that the module saw nothing at all, so a freshly installed module was an
    empty shell: the settings screen showed the declared example and the module reported "no
    enabled strategy", which is the same thing said two different ways.

    Read from config.json rather than repeated here, because a default written in both places is
    a default that will disagree with itself the first time one of them is edited.
    """
    global _DECLARED
    if _DECLARED is None:
        _DECLARED = {}
        try:
            path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
            with open(path, encoding="utf-8") as fh:
                for f in (json.load(fh).get("settings_fields") or []):
                    # `defaultValue` is the name the settings screen reads; matching it here is
                    # what keeps the shipped value and the rendered value the same thing.
                    if isinstance(f, dict) and f.get("key") and "defaultValue" in f:
                        _DECLARED[f["key"]] = f["defaultValue"]
        except (OSError, ValueError):
            pass
    return _DECLARED.get(key, fallback)


def env_json(name, default, key=None):
    """Settings arrive as `MODULE_<KEY>` env vars — JSON values come through as strings."""
    raw = os.environ.get(name)
    if raw is None or raw == "":
        raw = declared_default(key, None) if key else None
        if raw is None:
            return default
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return default


def env_num(name, default):
    raw = os.environ.get(name)
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def env_bool(name, default=False):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def load_settings():
    return {
        "mode": os.environ.get("MODULE_MODE") or "dryrun",
        "killSwitch": env_bool("MODULE_KILLSWITCH"),
        # The human switch. Separate from the module's own enabled flag: that one blocks every
        # path including reading the ledger, and would make the scheduled pipeline fail once a
        # minute rather than skip.
        "tradingEnabled": env_bool("MODULE_TRADINGENABLED"),
        "activeFrom": os.environ.get("MODULE_ACTIVEFROM") or "",
        "activeUntil": os.environ.get("MODULE_ACTIVEUNTIL") or "",
        "realArmed": env_bool("MODULE_REALARMED"),
        "realMaxNotionalKrw": env_num("MODULE_REALMAXNOTIONALKRW", 100000),
        "dailyLossLimitKrw": env_num("MODULE_DAILYLOSSLIMITKRW", 50000),
        "accountMaxNotionalKrw": env_num("MODULE_ACCOUNTMAXNOTIONALKRW", 1000000),
        "maxOrdersPerCycle": env_num("MODULE_MAXORDERSPERCYCLE", 4),
        "feeInCost": env_bool("MODULE_FEEINCOST", True),
        "confirmTimeoutSec": env_num("MODULE_CONFIRMTIMEOUTSEC", 20),
        "unknownTimeoutSec": env_num("MODULE_UNKNOWNTIMEOUTSEC", 120),
        # What the model is allowed to trade, and where. This is a wall, not a strategy: which
        # stocks and whose account is the owner's call, how to trade them is the model's. Keeping
        # it here rather than in the cron declaration means changing it is a settings edit, not a
        # schedule edit.
        # The wiring: one entry per trade — a symbol, an account, and the broker that owns it.
        # `매매1 = 증권사1·계좌1`, `매매3 = 증권사2·계좌1` are two entries, and the model fills each
        # with a rule of its own. Which rule that is, is not written here; where it runs is.
        "trades": env_json("MODULE_TRADES", [], "trades"),
        "universe": env_json("MODULE_UNIVERSE", [], "universe"),
        "confirmUniverse": env_json("MODULE_CONFIRMUNIVERSE", [], "confirmUniverse"),
        "strategies": env_json("MODULE_STRATEGIES", [], "strategies"),
    }


def unattended():
    """`1` when the framework ran us without a person waiting (cron, schedule).

    Set by the runtime once the module-call path lands. Absent means a person is on the other end,
    and an interactive call is never allowed to trade live — see `effective_mode`.
    """
    return os.environ.get("FIREBAT_UNATTENDED") == "1"


def day_epoch(text):
    """Local midnight of a YYYY-MM-DD date, or None when it cannot be read.

    None is not "no limit". A mistyped end date that fell through as no-limit would quietly delete
    the day the person meant to stop on and keep trading past it, so the caller holds instead and
    says which field it could not read.
    """
    try:
        parts = [int(p) for p in str(text).strip().replace("/", "-").split("-")[:3]]
        if len(parts) != 3:
            return None
        return time.mktime((parts[0], parts[1], parts[2], 0, 0, 0, 0, 1, -1))
    except (ValueError, TypeError, OverflowError):
        return None


def day_start_ms():
    lt = time.localtime()
    return int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1)) * 1000)


def pick_strategies(settings, symbol=None, strategy_id=None):
    """Everything eligible to run: what a person declared, plus what the model has adopted.

    A person's entry is taken as written — they typed it, they meant it. A stored one carries the
    stage it earned as its own mode cap, so it cannot outrun the ladder no matter what the module
    is set to. A person's entry wins a name collision: the settings are the surface they control.
    """
    declared = list(settings.get("strategies") or [])
    names = {s.get("id") for s in declared if isinstance(s, dict)}
    try:
        conn = strat.connect()
        adopted = [a for a in strat.rows_to_strategies(conn) if a["id"] not in names]
        conn.close()
    except Exception:
        # A strategy store that cannot be opened must not take the declared ones down with it.
        adopted = []
    # A trade driven by a screen runs its rule over whatever the screen currently holds. The codes
    # come from the broker's own frames and are assembled here — never written out by the model,
    # which is the difference between a symbol that exists and one that reads like it should.
    expanded = []
    for s in declared + adopted:
        if not isinstance(s, dict):
            continue
        trade = trade_of(settings, s.get("id"))
        if trade:
            # Where a trade runs lives on the trade, not on the rule — a rule reused elsewhere
            # would otherwise carry the first account with it and place orders in the wrong one.
            s = {**s, "broker": s.get("broker") or trade.get("broker"),
                 "account": s.get("account") or trade.get("account")}
        if s.get("symbol") or not (trade and trade.get("conditionName")):
            expanded.append(s)
            continue
        try:
            ucon = uni.connect()
            screened = uni.symbols_of(ucon, trade["id"])
            ucon.close()
        except Exception:
            screened = []
        trigger = (s.get("trigger") or {})
        if str(trigger.get("type") or "") == "screen-entry":
            # Act on arrival, not on the bar. The window is generous because the drain is a short
            # cron rather than the frame itself — the sink discards a module's return today, so
            # nothing can order straight from a frame yet.
            within = float(trigger.get("entryWindowSec") or 300) * 1000
            try:
                ucon = uni.connect()
                fresh = uni.recent_entries(ucon, trade["id"], within)
                ucon.close()
            except Exception:
                fresh = []
            for e in fresh:
                expanded.append({**s, "symbol": e["symbol"], "_enteredMs": e["enteredMs"]})
            continue
        for code in screened:
            expanded.append({**s, "symbol": code})
    picked = []
    for s in expanded:
        if not isinstance(s, dict) or not s.get("id"):
            continue
        if strategy_id and s["id"] != strategy_id:
            continue
        if symbol and s.get("symbol") and s["symbol"] != symbol:
            continue
        if s.get("enabled") is False:
            continue
        picked.append(s)
    return picked


def normalize_bars(bars):
    rows = []
    for b in bars or []:
        if not isinstance(b, dict):
            continue
        close = b.get("close", b.get("Close"))
        if close is None:
            continue
        rows.append(b)
    return rows


def last_close(bars):
    for b in reversed(bars or []):
        try:
            return float(b.get("close", b.get("Close")))
        except (TypeError, ValueError):
            continue
    return 0.0


# ── actions ──────────────────────────────────────────────────────────────────────────────────
def action_adopt(inp, settings):
    """Take the sweep's winner into the strategy store, if the measurement earned it.

    `ranked` and `runs` are handed straight through from the earlier pipeline steps. That is the
    guard: the model declared the search space, and the evidence it is judged on never passed
    through the model on its way here.
    """
    ranked, runs = inp.get("ranked"), inp.get("runs")
    if not isinstance(ranked, dict) or not isinstance(runs, list):
        return {"success": False,
                "error": "adopt 는 `ranked`(rank_multi/rank_across 결과)와 `runs`(그 랭킹을 만든 "
                         "계획된 실행 목록)를 그대로 받습니다 — 성적을 손으로 적어 넣을 수 없습니다."}
    target = {"symbol": inp.get("symbol"), "broker": inp.get("broker"),
              "account": inp.get("account"), "id": inp.get("strategyId"),
              "template": inp.get("template")}
    if not target["symbol"] or not target["broker"]:
        return {"success": False,
                "error": "adopt 에는 symbol 과 broker 가 필요합니다 — 무엇을 어디서 굴릴지가 "
                         "규칙의 일부입니다."}
    # An empty account is legitimate: an exchange whose key IS the account has nothing to name,
    # and demanding one there blocked the gate before it could judge anything.
    target["account"] = target.get("account") or ""
    conn = strat.connect()
    try:
        result = strat.adopt(conn, ranked, runs, target,
                             results=inp.get("results"),
                             min_trades=int(inp.get("minTrades") or strat.MIN_TRADES),
                             min_confirm=int(inp.get("minConfirmSymbols")
                                             or strat.MIN_CONFIRM_SYMBOLS),
                             proposal=inp.get("proposal"))
    finally:
        conn.close()
    return {"success": True, "data": result}


def action_adopt_fits(inp, settings):
    """Adopt the (symbol, rule) pairs `fit_symbols` cleared — one strategy per symbol.

    The counterpart to `adopt`, which crowns a single rule for every symbol. Which one to use is
    a question about the design rather than the data: a rule paired with the coins that suit it is
    judged per symbol, and a rule meant to cover the whole market is judged across symbols.
    """
    fits, runs = inp.get("fits"), inp.get("runs")
    if isinstance(fits, dict):
        # Accept the whole fit_symbols envelope as well as its `fits` list, so a pipeline can pass
        # `$stepN` or `$stepN.fits` and neither is wrong.
        fits = fits.get("fits")
    if not isinstance(fits, list) or not isinstance(runs, list):
        return {"success": False,
                "error": "adopt_fits 는 `fits`(fit_symbols 결과)와 `runs`(그 측정을 만든 계획된 "
                         "실행 목록)를 그대로 받습니다 — 성적을 손으로 적어 넣을 수 없습니다."}
    if not inp.get("broker"):
        return {"success": False,
                "error": "adopt_fits 에는 broker 가 필요합니다 — 종목은 각 fit 이 들고 옵니다."}
    target = {"broker": inp.get("broker"), "account": inp.get("account") or "",
              "template": inp.get("template")}
    conn = strat.connect()
    try:
        result = strat.adopt_fits(conn, fits, runs, target, results=inp.get("results"),
                                  min_trades=int(inp.get("minTrades")
                                                 or strat.MIN_SYMBOL_TRADES),
                                  proposal=inp.get("proposal"))
    finally:
        conn.close()
    return {"success": True, "data": result}


def action_next_revision(inp, settings):
    """The one strategy tonight's revision run should work on — or nothing to revise.

    Separate from discovery on purpose. Revising means searching around a rule that is already
    running; finding a new one is a different job with a different search space, and doing both
    every night produces a new stranger each morning while the running rules never improve.
    """
    conns = {}

    def ledger_for(mode):
        if mode not in conns:
            conns[mode] = store.connect(mode)
        return conns[mode]

    conn = strat.connect()
    try:
        target = strat.next_revision(conn, ledger_for, min_closed_trips=int(inp.get("minClosedTrips") or settings.get("minClosedTrips") or strat.MIN_CLOSED_TRIPS))
    finally:
        conn.close()
        for c in conns.values():
            c.close()
    return {"success": True, "data": target or {
        "strategyId": None,
        "note": "고칠 전략이 없습니다 — 신규 발굴은 별도 실행입니다(새 매매를 시작할 때).",
    }}


def action_review(inp, settings):
    """Move every adopted strategy up or down by its own live record. No LLM in the decision.

    Called after the close. Each stage reads its own ledger — paper fills and live fills are
    different files on purpose — and the comparison is win rate against the backtest's, which is
    the one number that means the same thing on both sides.
    """
    conns = {}

    def ledger_for(mode):
        if mode not in conns:
            conns[mode] = store.connect(mode)
        return conns[mode]

    conn = strat.connect()
    try:
        rows = strat.review(conn, ledger_for,
                            min_trades=int(inp.get("minLiveTrades") or strat.MIN_LIVE_TRADES),
                            slack=float(inp.get("winRateSlack") or strat.WIN_RATE_SLACK))
    finally:
        conn.close()
        for c in conns.values():
            c.close()
    moved = [r for r in rows if r.get("moved")]
    return {"success": True, "data": {
        "reviewed": rows, "moved": moved,
        "note": ("단계는 실적으로만 움직입니다 — 백테스트가 약속한 승률을 실전이 따라오면 올라가고, "
                 "벌어지면 내려옵니다. 비교할 백테스트가 없으면 모의까지만 올라갑니다."),
    }}


def action_strategies(inp, settings):
    conn = strat.connect()
    try:
        data = {"strategies": strat.read_all(conn, int(inp.get("limit") or 100)),
                "events": strat.read_events(conn, inp.get("strategyId"),
                                            int(inp.get("limit") or 50))}
    finally:
        conn.close()
    return {"success": True, "data": data}


def action_retire(inp, settings):
    """Stop an adopted strategy. One direction only — promotion is earned, never asked for."""
    sid = inp.get("strategyId")
    if not sid:
        return {"success": False, "error": "retire 에는 strategyId 가 필요합니다."}
    conn = strat.connect()
    try:
        ok = strat.set_stage(conn, sid, "retired", inp.get("reason") or "retired on request")
    finally:
        conn.close()
    return {"success": ok, "data": {"strategyId": sid, "stage": "retired"}} if ok else {
        "success": False, "error": f"'{sid}' 은 전략 store 에 없습니다."}


def declared_trades(settings):
    """The owner's wiring, normalised. One entry per trade: where a rule will run.

    A trade is identified by the account it runs in as much as by the rule in it — the same rule
    in two accounts is two trades, two positions and two sets of orders. That is why the id
    defaults to the placement rather than to the rule.
    """
    out = []
    for t in settings.get("trades") or []:
        if not isinstance(t, dict):
            continue
        symbol = str(t.get("symbol") or "").strip()
        condition = str(t.get("conditionName") or "").strip()
        broker = str(t.get("broker") or "").strip()
        account = str(t.get("account") or "").strip()
        if not broker or not (symbol or condition):
            continue
        out.append({"id": str(t.get("id") or f"{broker}-{account}-{symbol or condition}").strip(),
                    "symbol": symbol, "conditionName": condition,
                    # The timeframe is part of the trade, not of the schedule. A rule measured on
                    # daily bars and traded on one-minute bars was measured on something else, so
                    # the same value has to reach the candle fetch and the nightly re-measurement.
                    "interval": str(t.get("interval") or "1d").strip(),
                    "broker": broker, "account": account,
                    "template": t.get("template") if isinstance(t.get("template"), dict) else None})
    return out


def trade_of(settings, trade_id=None):
    """One declared trade — the named one, or the first if none was named."""
    trades = declared_trades(settings)
    if not trades:
        return None
    if trade_id:
        for t in trades:
            if t["id"] == trade_id:
                return t
        return None
    return trades[0]


def as_object(value, field):
    """Accept an object that arrived as a JSON string.

    A pipeline's LLM_TRANSFORM step returns text, so a search space composed by the model reaches
    the next step as a string however well-formed it is. Parsing it here is the difference between
    a nightly run that works and one that fails on a quoting detail nobody can see in the log.
    Anything that is neither an object nor a string parsing to one is refused rather than coerced.
    """
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        text = value.strip()
        # Models fence JSON out of habit; the fence is not part of the value.
        if text.startswith("```"):
            text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        try:
            parsed = json.loads(text)
        except ValueError as e:
            raise ValueError(f"{field} 가 JSON 으로 읽히지 않습니다: {e}") from None
        if isinstance(parsed, dict):
            return parsed
        raise ValueError(f"{field} 는 객체여야 합니다 — 받은 것: {type(parsed).__name__}")
    if value in (None, ""):
        return {}
    raise ValueError(f"{field} 는 객체여야 합니다 — 받은 것: {type(value).__name__}")


def action_request_condition(inp, settings):
    """Ask for a screening condition the model cannot create itself.

    Kiwoom lists conditions and runs them; it has no call that accepts one. So the formula is
    written out for a person to type into HTS once, and after that the stream closes the loop.
    """
    trade = trade_of(settings, inp.get("tradeId"))
    if not trade:
        return {"success": False,
                "error": "매매가 선언돼 있지 않습니다 — 설정의 `trades` 에 먼저 추가해 주세요."}
    name = str(inp.get("name") or "").strip()
    criteria = str(inp.get("criteria") or "").strip()
    if not name or not criteria:
        return {"success": False,
                "error": "name 과 criteria 가 필요합니다 — criteria 는 사람이 HTS 에 그대로 옮겨 "
                         "적을 수 있는 조건이어야 합니다."}
    conn = uni.connect()
    try:
        data = uni.request_condition(conn, trade["id"], name, criteria, inp.get("rationale"))
    finally:
        conn.close()
    return {"success": True, "data": {**data, "tradeId": trade["id"]}}


def action_bind_condition(inp, settings):
    """Record the sequence number the registered condition came back as."""
    rid, seq = inp.get("requestId"), inp.get("seq")
    if not rid or seq in (None, ""):
        return {"success": False, "error": "requestId 와 seq 가 필요합니다."}
    conn = uni.connect()
    try:
        ok = uni.bind_seq(conn, rid, seq)
    finally:
        conn.close()
    return {"success": ok, "data": {"requestId": rid, "seq": str(seq)}} if ok else {
        "success": False, "error": f"'{rid}' 요청이 없습니다."}


def action_match_conditions(inp, settings):
    """Bind the requests to what a person actually created, matching on the name they typed."""
    rows = inp.get("rows")
    if rows is None and isinstance(inp.get("conditions"), list):
        rows = inp["conditions"]
    if not isinstance(rows, list):
        return {"success": False,
                "error": "조건검색 목록(`rows`)이 필요합니다 — 브로커의 목록조회 결과를 그대로 "
                         "넘기세요."}
    conn = uni.connect()
    try:
        data = uni.match_conditions(conn, rows)
        if inp.get("watchId") and data["bound"]:
            uni.bind_watch(conn, data["bound"][0]["requestId"], str(inp["watchId"]))
    finally:
        conn.close()
    return {"success": True, "data": data}


def action_universe(inp, settings):
    """The screening requests and what each trade is currently watching."""
    conn = uni.connect()
    try:
        lists = {t["id"]: uni.symbols_of(conn, t["id"]) for t in declared_trades(settings)}
        data = {"requests": uni.read_requests(conn), "watchlists": lists}
    finally:
        conn.close()
    return {"success": True, "data": data}


def action_gate(inp, settings):
    """Does the cycle run at all? The first step of the trading pipeline, and the only human gate.

    The switch is a setting, not an action, so nothing the model can call turns trading on — and it
    is a setting of its own rather than the module's enabled flag, because turning the module off
    blocks every path including reading the ledger, and the scheduled pipeline would then fail once
    a minute instead of skipping. A CONDITION step on `active` ends the run cleanly here, before a
    single broker call is made.

    The window is judged here rather than written into the cron expression: "until the fifth" is a
    date a person types once, not a schedule anyone should have to translate.
    """
    now = time.time()
    reasons = []
    if not settings.get("tradingEnabled"):
        reasons.append("trading is switched off in the module settings")
    start, end = settings.get("activeFrom"), settings.get("activeUntil")
    start_ms, end_ms = day_epoch(start), day_epoch(end)
    if start and start_ms is None:
        reasons.append(f"activeFrom '{start}' 은 날짜로 읽히지 않습니다 — YYYY-MM-DD 로 고쳐 주세요")
    elif start_ms is not None and now < start_ms:
        reasons.append(f"the active period starts {start}")
    if end and end_ms is None:
        reasons.append(f"activeUntil '{end}' 은 날짜로 읽히지 않습니다 — YYYY-MM-DD 로 고쳐 주세요")
    # Inclusive of the end date: someone writing 2026-08-05 means through that day, not up to
    # its midnight — the opposite reading silently loses a trading session.
    elif end_ms is not None and now >= end_ms + 86400:
        reasons.append(f"the active period ended {end}")
    conn = store.connect("dryrun" if settings.get("mode") == "dryrun" else "live")
    if store.kv_get(conn, "tripped") == "1":
        reasons.append("the kill switch is tripped — clear it in the settings")
    if settings.get("killSwitch"):
        reasons.append("killSwitch is on")
    strategies = pick_strategies(settings)
    conn.close()
    screened = [t for t in declared_trades(settings) if t.get("conditionName")]
    if not strategies and not reasons:
        if screened:
            # Not a misconfiguration. The rule exists and the screen is simply empty right now,
            # which is what a quiet market looks like — saying "no strategy" would send someone
            # to the settings to fix something that is not broken.
            reasons.append("the screen is empty — nothing currently qualifies")
        else:
            reasons.append("no enabled strategy is declared")
    return {"success": True, "data": {
        "active": not reasons,
        "why": reasons or None,
        # The declared mode, not a per-strategy verdict — that needs the account and is decided
        # in `cycle`. `unattended` is reported alongside because an interactive call is demoted to
        # paper regardless of the setting, and a gate that hid that would read as live when it
        # is not.
        "mode": settings.get("mode", "dryrun"),
        "unattended": unattended(),
        "strategies": len(strategies),
        "activeFrom": start or None,
        "activeUntil": end or None,
        # What the pipeline needs so the declaration holds no symbol or timeframe of its own.
        "trade": (lambda t: {k: t[k] for k in ("id", "symbol", "interval", "broker", "account")}
                  if t else None)(trade_of(settings)) if trade_of(settings) else None,
        # And the rule, for the same reason. A rule written into the cron file means changing
        # strategy means editing the schedule, and the analyser being handed one rule while the
        # sizing uses another is a mismatch nothing would report. The strategy owns its rules;
        # the pipeline passes them to the analyser and reads the answer back.
        "strategy": _pipeline_strategy(strategies),
        # Every trade, each with the rule that runs on it. One cycle can carry several: a rule is
        # fitted per symbol, so two coins are two rules on two timeframes, and a pipeline that can
        # only express one of them makes the fitting pointless.
        "trades": _pipeline_trades(settings, strategies),
    }}


def _pipeline_trades(settings, strategies):
    """Every (trade, strategy) pair, so nothing declared is left out.

    One entry per pair rather than per trade. Two strategies on the same coin is the ordinary
    case, not an exotic one — a swing rule and a scalping rule hold different positions in the
    same symbol, the ledger has keyed positions per strategy since it was written, and internal
    transfer exists precisely for the moment one sells what the other is buying.

    Before this, the first match won and the second strategy was dropped without a word: it sat
    enabled in the settings, appeared in the strategy count, and never traded. A declared thing
    that silently does nothing is the failure mode this module keeps having to be rescued from.
    """
    trades = declared_trades(settings)
    out = []
    for t in trades:
        for st in strategies:
            # A strategy belongs to a trade when it names it, or names its symbol, or names
            # nothing at all — the last being a rule written for whatever the trade points at.
            named = st.get("id") == t["id"] or st.get("symbol") == t.get("symbol")
            unbound = not st.get("symbol") and st.get("id") not in {x["id"] for x in trades}
            if not (named or unbound):
                continue
            rules = st.get("rules") or ((st.get("spec") or {}).get("rules"))
            if not rules:
                continue
            out.append({
                # Unique per pair: the analyser results come back positionally and the cycle
                # matches them by this, so two rules on one coin must not share an id.
                "tradeId": t["id"] if st.get("id") == t["id"] else f"{t['id']}:{st.get('id')}",
                "strategyId": st.get("id"), "symbol": t.get("symbol"),
                "interval": t.get("interval"), "broker": t.get("broker"),
                "account": t.get("account"), "rules": rules,
                "exits": st.get("exits") or {}})
    return out


def _pipeline_strategy(strategies):
    """The rule the pipeline should ask the analyser about — id, rules and exits, or None."""
    for s in strategies:
        rules = s.get("rules") or ((s.get("spec") or {}).get("rules"))
        if rules:
            return {"id": s.get("id"), "symbol": s.get("symbol"), "rules": rules,
                    "exits": s.get("exits") or {}}
    return None



def _signals_by_strategy(plan, signals):
    """Match each analyser result to the strategy whose rule produced it.

    Positional: the analyser calls were built from `plan.runs` and run in that order, so result i
    belongs to run i. Keyed by both strategy id and symbol, because a trade may name either.
    """
    runs = (plan or {}).get("runs") if isinstance(plan, dict) else None
    if runs is None and isinstance(plan, dict):
        runs = ((plan.get("data") or {}).get("runs"))
    if not isinstance(runs, list) or not isinstance(signals, list):
        return {}
    out = {}
    for i, run in enumerate(runs):
        if i >= len(signals):
            break
        entry = {"signal": signals[i], "lastClose": run.get("lastClose")}
        for key in (run.get("strategyId"), run.get("tradeId"), run.get("symbol")):
            if key:
                out.setdefault(key, entry)
    return out




def _shape(v, depth=0):
    """A short fingerprint of a value — enough to tell which step it came from."""
    if isinstance(v, list):
        return f"list[{len(v)}]" + (f" of {_shape(v[0], depth + 1)}" if v and depth < 1 else "")
    if isinstance(v, dict):
        keys = sorted(v)[:6]
        return "{" + ", ".join(keys) + ("…" if len(v) > 6 else "") + "}"
    return type(v).__name__


def _loop_items(value, key=None):
    """A list, however the pipeline handed it over.

    A FOREACH step does not return its items — it returns `{count, dropped, failed, results}`,
    and a declaration that maps `$stepN` passes that envelope on. Unwrapping it here means the
    caller can write either and neither is wrong, which is the same tolerance every other
    step-to-step hand-off in this module already has.
    """
    if isinstance(value, dict):
        # The asked-for key first. A step's output can carry several lists — a cycle answers with
        # both `calls` and `results` — and preferring the loop's own name would quietly hand back
        # the wrong one, which is worse than not unwrapping at all.
        for k in ([key] if key else []) + ["results", "rows", "records"]:
            if k and isinstance(value.get(k), list):
                return value[k]
        inner = value.get("data")
        if isinstance(inner, dict):
            return _loop_items(inner, key)
        return []
    return value if isinstance(value, list) else []


# The slow timeframes a rule may reach for. Two hundred weekly bars is four years — enough for a
# trend and for a position in a range — and fetching them is a once-a-day job, not a once-a-cycle
# one. Declared as a setting so a person can widen or drop it without touching a rule.
DEFAULT_CONTEXT = [{"interval": "1d", "bars": 400},
                   {"interval": "1w", "bars": 200},
                   {"interval": "1M", "bars": 60}]


def context_spec(settings):
    spec = settings.get("contextIntervals")
    if isinstance(spec, str):
        try:
            spec = json.loads(spec)
        except (ValueError, TypeError):
            spec = None
    if not isinstance(spec, list) or not spec:
        return list(DEFAULT_CONTEXT)
    out = []
    for row in spec:
        if isinstance(row, str):
            out.append({"interval": row, "bars": 200})
        elif isinstance(row, dict) and row.get("interval"):
            out.append({"interval": str(row["interval"]),
                        "bars": int(row.get("bars") or 200)})
    return out or list(DEFAULT_CONTEXT)


def action_context_plan(inp, settings):
    """What the slow fetch should ask for — one call per declared symbol per context timeframe."""
    symbols, seen = [], set()
    for t in declared_trades(settings):
        sym = t.get("symbol")
        if sym and sym not in seen:
            seen.add(sym)
            symbols.append(sym)
    for extra in (inp.get("symbols") or []):
        if isinstance(extra, str) and extra not in seen:
            seen.add(extra)
            symbols.append(extra)
    spec = context_spec(settings)
    runs = [{"symbol": sym, "interval": c["interval"],
             "args": {"action": "get_candles", "symbol": sym,
                      "interval": c["interval"], "bars": c["bars"]}}
            for sym in symbols for c in spec]
    return {"success": True, "data": {
        "runs": runs, "runCount": len(runs), "symbols": symbols,
        "intervals": [c["interval"] for c in spec],
        "note": ("각 `args` 를 브로커에 FOREACH 로 넘기고, 이 응답을 `plan`, 루프 결과를 "
                 "`results` 로 store_context 에 주십시오."),
    }}


def action_store_context(inp, settings):
    """Keep what the slow fetch brought back, so the trading cycle reads disk instead of a broker."""
    plan = inp.get("plan")
    runs = (plan or {}).get("runs") if isinstance(plan, dict) else None
    if runs is None and isinstance(plan, dict):
        runs = ((plan.get("data") or {}).get("runs"))
    results = _loop_items(inp.get("results"))
    if not isinstance(runs, list):
        return {"success": False,
                "error": "store_context 는 context_plan 결과를 `plan` 으로 받습니다."}
    if len(results) != len(runs):
        return {"success": False,
                "error": f"{len(results)} 개 결과 / {len(runs)} 개 요청 — 루프가 끝나지 않았습니다. "
                         "받은 것을 저장하지 않고 다음 실행에 맡깁니다."}
    conn = ctxstore.connect()
    saved, empty = [], []
    try:
        for run, res in zip(runs, results):
            payload = (res or {}).get("data") if isinstance(res, dict) and "data" in res else res
            rows = normalize_bars((payload or {}).get("records")
                                  or (payload or {}).get("rows"))
            if not rows:
                empty.append(f"{run.get('symbol')} {run.get('interval')}")
                continue
            r = ctxstore.save(conn, run["symbol"], run["interval"], rows)
            saved.append({"symbol": run["symbol"], "interval": run["interval"], **r})
    finally:
        conn.close()
    return {"success": True, "data": {
        "saved": saved, "empty": empty or None,
        # A fetch that came back empty leaves what was already held. Replacing a series with
        # nothing would turn a rate limit into "this coin has no history".
        "note": ("빈 응답은 기존 이력을 그대로 둡니다 — 비우지 않습니다."
                 if empty else None),
    }}


def action_context(inp, settings):
    """What is held and how old — an empty rule condition versus a fetch that never ran."""
    conn = ctxstore.connect()
    try:
        rows = ctxstore.status(conn, inp.get("symbols"))
    finally:
        conn.close()
    return {"success": True, "data": {"held": rows, "count": len(rows)}}


def action_bind_bars(inp, settings):
    """Pair each trade with the candles just fetched for it, and emit the analyser calls.

    The loop that fetches cannot also analyse: a FOREACH body chains through `$prev`, so by the
    second inner step the item that started it is gone. Two loops with this between them is the
    shape the sweep already uses — fetch everything, bind, then run one call per bound pair — and
    it is why each analyser call can carry its own rule and its own bars without the pipeline
    holding either.
    """
    trades = _loop_items(inp.get("trades"), "trades")
    fetched = _loop_items(inp.get("fetched"))
    if len(fetched) != len(trades):
        return {"success": False,
                "error": f"{len(fetched)} 개 봉 결과 / {len(trades)} 개 매매 — 같은 순서로 같은 "
                         "개수를 넘겨야 합니다(FOREACH 결과와 gate 의 trades)."}
    costs = {k: v for k, v in {
        "feeRate": inp.get("feeRate"), "taxRate": inp.get("taxRate"),
        "slippageRate": inp.get("slippageRate")}.items() if v is not None}
    # The slow series, read off disk once for the whole batch. A rule that names `w.slope10` gets
    # weekly bars here rather than a broker call — that is the point of keeping them.
    want_tf = set()
    for t in trades:
        for rule in (t.get("rules") or []):
            for c in (rule.get("when") or []):
                for side in ("a", "b"):
                    v = c.get(side)
                    if isinstance(v, str) and "." in v:
                        head = v.split(".", 1)[0]
                        if head in ("M", "w", "d", "h") or (
                                head[:-1].isdigit() and head[-1] in "mhdwM"):
                            want_tf.add({"M": "1M", "w": "1w", "d": "1d",
                                         "h": "1h"}.get(head, head))
    context, stale = {}, []
    if want_tf:
        cconn = ctxstore.connect()
        try:
            for t in trades:
                per = {}
                for tf in sorted(want_tf):
                    rows = ctxstore.read(cconn, t.get("symbol"), tf)
                    if rows:
                        per[tf] = rows
                    else:
                        stale.append(f"{t.get('symbol')} {tf}")
                if per:
                    context[t.get("tradeId")] = per
        finally:
            cconn.close()

    runs, missing = [], []
    for t, f in zip(trades, fetched):
        payload = (f or {}).get("data") if isinstance(f, dict) and "data" in f else f
        payload = payload if isinstance(payload, dict) else {}
        key = payload.get("_cacheKey")
        rows = normalize_bars(payload.get("records") or payload.get("rows"))
        if not key and not rows:
            missing.append(t.get("symbol"))
            continue
        args = {"action": "signals", "rules": t.get("rules"), **costs}
        higher = context.get(t.get("tradeId"))
        if higher:
            args["higher"] = higher
        if key:
            args["barsCacheKey"] = key
        else:
            args["bars"] = rows
        runs.append({"tradeId": t.get("tradeId"), "strategyId": t.get("strategyId"),
                     "symbol": t.get("symbol"),
                     # The last close, so the cycle has a price for this symbol even when the
                     # analyser fires nothing — a stop is checked against the market, not against
                     # a signal that did not happen.
                     "lastClose": (rows[-1].get("close") if rows else None),
                     "args": args})
    return {"success": True, "data": {
        "runs": runs, "runCount": len(runs),
        "missing": missing or None,
        # A rule reaching for a timeframe nobody has fetched yet is worth saying out loud: the
        # analyser refuses it, and without this the refusal reads as a broken rule rather than a
        # context fetch that has not run.
        "contextMissing": sorted(set(stale)) or None,
        "note": ("각 항목의 `args` 를 technical-analysis 에 FOREACH 로 넘기고, 그 결과 전체를 "
                 "cycle 의 `signals` 로, 이 응답을 `plan` 으로 넘기십시오."),
    }}


def action_cycle(inp, settings):
    symbol = inp.get("symbol")
    strategies = pick_strategies(settings, symbol=symbol, strategy_id=inp.get("strategyId"))
    if not strategies:
        return {"success": True, "data": {"ran": 0,
                "note": "no enabled strategy matched — declare one in the module settings"}}

    bars = normalize_bars(inp.get("bars"))
    signal = inp.get("signal") or {}
    price = eng.signal_price(signal, fallback=last_close(bars))
    if price <= 0:
        # A screen-driven entry arrives with no bars and no signal — the quote is the only price
        # there is, and refusing it would make the whole scalping path unreachable.
        quote = inp.get("quote") or {}
        for k in ("price", "last", "close", "cur_prc", "currentPrice"):
            try:
                price = abs(float(str(quote.get(k)).replace(",", "").lstrip("+")))
            except (TypeError, ValueError):
                continue
            if price > 0:
                break
    if price <= 0 and not (inp.get("plan") or inp.get("signals")):
        return {"success": False,
                "error": "no price to work from — pass `bars` (or barsCacheKey), `signal`, "
                         "or a `quote` with the current price"}

    mode_hint = settings.get("mode", "dryrun")
    # The ledger a row belongs to is decided by the mode that row was traded in, not by the mode
    # the module is set to. A strategy demoted to paper — by the ladder, by an interactive call,
    # by a missing arming switch — books a fill nobody placed, and writing that into the live
    # ledger is exactly the contamination the two files exist to prevent. Measured 2026-08-02:
    # two paper fills sat in live.db while the exchange had no record of an order.
    conns = {}

    def store_for(m):
        key = "dryrun" if m == "dryrun" else "live"
        if key not in conns:
            conns[key] = store.connect(key)
        return conns[key]

    conn = store_for(mode_hint)
    tripped = store.kv_get(conn, "tripped") == "1"
    settings = {**settings, "_tripped": tripped}

    # Daily loss limit trips before anything is decided, so one bad day cannot keep trading.
    limit = settings.get("dailyLossLimitKrw") or 0
    if not tripped and limit > 0 and store.realized_today(conn, day_start_ms()) <= -limit:
        store.kv_set(conn, "tripped", "1")
        store.log_event(conn, "halt", {"reason": "daily loss limit reached", "limitKrw": limit})
        settings["_tripped"] = tripped = True

    now = store.now_ms()
    sides = eng.fired_sides(signal)
    # One cycle can carry several symbols, each analysed on its own bars against its own rule.
    # `plan` is bind_bars' output and `signals` the analyser results in the same order, so the
    # answer that belongs to a strategy is found rather than assumed — a single shared signal
    # would silently apply one coin's verdict to another's position.
    per_strategy = _signals_by_strategy(inp.get("plan"), _loop_items(inp.get("signals")))
    results, all_intents, ctxs = [], [], {}

    for s in strategies:
        broker = s.get("broker") or "unknown"
        account = s.get("account") or ""
        sym = s.get("symbol") or symbol or ""
        own = per_strategy.get(s.get("id")) or per_strategy.get(sym)
        sig = own["signal"] if own else signal
        s_price = eng.signal_price(sig, fallback=(own or {}).get("lastClose") or 0.0) or price
        if s_price <= 0:
            results.append({"strategyId": s["id"], "symbol": sym,
                            "error": "no price for this symbol — its candles did not arrive"})
            continue
        sides = eng.fired_sides(sig)
        cycle_id = eng.cycle_id_for(s, sig, now, inp.get("cycleId"))
        account_is_mock = bool(inp.get("mock")) or str(s.get("mode")) == "mock"
        mode = eng.effective_mode(settings, s, account_is_mock, unattended())
        # Resolved before anything is read or written, because it decides which ledger this
        # strategy's rows belong to.
        sconn = store_for(mode)
        pos = store.position_of(sconn, s["id"], broker, account, sym)
        # The window guard stops a second entry, not a second look. While a position is open its
        # stop and target have to be evaluated on every pass — keying the cycle on the entry that
        # opened it would otherwise make the exit unreachable for as long as the trade lasts.
        # A repeated exit is still impossible: the order key carries the side.
        if float(pos.get("qty") or 0) <= 0 and store.cycle_already_ran(
                sconn, s["id"], cycle_id, broker, account, sym):
            results.append({"strategyId": s["id"], "cycleId": cycle_id, "skipped": "already ran"})
            continue
        # A scalping rule reacts to the arrival itself: the screen said this symbol qualifies now,
        # and that is the entry. Waiting for a separate indicator to agree would mean the condition
        # was written for nothing. Exits still come from the rule's stop and target, which
        # strategy_rules checks before any signal.
        s_sides = sides
        if str((s.get("trigger") or {}).get("type") or "") == "screen-entry":
            s_sides = set(sides) | ({"buy"} if float(pos.get("qty") or 0) <= 0 else set())
        ctx = {
            "position": pos, "price": s_price, "sides": s_sides, "signal": sig,
            "quote": inp.get("quote") or {}, "settings": settings, "strategy": s,
            "mode": mode, "account_exposure": 0.0,
            "vi_halted": store.kv_get(conn, f"vi:{sym}") == "1",
        }
        try:
            intents = eng.decide(s, ctx)
        except ValueError as e:
            store.log_event(conn, "error", str(e), strategy_id=s["id"], symbol=sym)
            results.append({"strategyId": s["id"], "error": str(e)})
            continue
        for i in intents:
            i.update({"broker": broker, "account": account, "symbol": sym,
                      "cycleId": cycle_id, "mode": mode})
        ctxs[s["id"]] = ctx
        ctx["_conn"] = sconn
        all_intents.extend(intents)

    # Offsetting pairs are settled in the ledger before anything reaches an order.
    transfers, remaining = eng.match_internal_transfers(all_intents)
    for t in transfers:
        ref = ctxs[t["from_strategy"]]["strategy"]
        store.record_transfer(
            conn, cycle_id=eng.cycle_id_for(ref, signal, now, inp.get("cycleId")),
            from_strategy=t["from_strategy"], to_strategy=t["to_strategy"],
            broker=ref.get("broker") or "unknown", account=ref.get("account") or "",
            symbol=ref.get("symbol") or symbol or "", qty=t["qty"], price=t["price"],
            fee_in_cost=settings.get("feeInCost", True))

    placed, dropped_all, calls = [], [], []
    for s in strategies:
        ctx = ctxs.get(s["id"])
        if ctx is None:
            continue
        mine = [i for i in remaining if i["strategyId"] == s["id"]]
        if not mine:
            continue
        wconn = ctx.get("_conn") or conn
        allowed, dropped = eng.risk_gates(mine, ctx)
        dropped_all.extend(dropped)
        for d in dropped:
            store.log_event(conn, "dropped",
                            {"side": d["side"], "qty": d.get("qty"), "why": d.get("dropReason")},
                            strategy_id=s["id"], symbol=d.get("symbol"))
        for intent in allowed:
            key = store.order_key(s["id"], intent["symbol"], intent["side"],
                                  intent["cycleId"], intent.get("seq", 0),
                                  broker=intent.get("broker") or "",
                                  account=intent.get("account") or "")
            order = {
                "order_key": key, "cycle_id": intent["cycleId"], "strategy_id": s["id"],
                "broker": intent["broker"], "account": intent["account"],
                "symbol": intent["symbol"], "side": intent["side"],
                "req_qty": intent["qty"],
                "req_price": _limit_price(s, intent, float(intent.get("price") or 0)),
                "ord_type": _order_type(s, intent),
                "mode": ctx["mode"], "state": "intent", "reason": intent.get("reason"),
            }
            if not store.insert_order(wconn, order):
                continue
            if ctx["mode"] == "dryrun":
                # Paper fill at the intent price. Optimistic on purpose and labelled as such: a
                # real limit order may not fill at all, which is what the mock account is for.
                store.update_order(wconn, key, state="filled", filled_qty=intent["qty"],
                                   filled_avg=intent["price"], sent_ms=store.now_ms())
                store.apply_fill(wconn, strategy_id=s["id"], broker=intent["broker"],
                                 account=intent["account"], symbol=intent["symbol"],
                                 side=intent["side"], qty=intent["qty"], price=intent["price"],
                                 source="dryrun", ref_order_key=key,
                                 fee_in_cost=settings.get("feeInCost", True))
            else:
                # The row exists before the call does. A crash between here and the broker leaves
                # something the next cycle can resolve rather than an order nobody remembers.
                store.update_order(wconn, key, state="sent", sent_ms=store.now_ms())
                calls.append({**orders.broker_call({**order, "order_key": key}, s),
                              "orderKey": key})
            placed.append({"strategyId": s["id"], "side": intent["side"], "qty": intent["qty"],
                           "price": intent["price"], "mode": ctx["mode"],
                           "reason": intent.get("reason"), "orderKey": key})

    # A limit order that never fills is the ordinary case, not an error: the price is the signal
    # bar's close and the market has moved on. Left alone it holds the money and blocks the next
    # entry, so it is withdrawn once it has had long enough, and the next cycle is free to enter
    # again at a price that exists. Cancelling is all this does — re-entering is the rule's job,
    # and deciding here would place an order no signal asked for.
    abandoned = _abandon_stale_orders(conn, settings, strategies, inp.get("openOrders"), calls)

    positions = [r for c in conns.values() for r in store.read_positions(c)]
    for c in conns.values():
        c.close()
    return {"success": True, "data": {
        "mode": mode_hint, "unattended": unattended(), "tripped": tripped,
        "ran": len(strategies), "price": price, "firedSides": sorted(sides),
        "placed": placed, "dropped": dropped_all, "transfers": transfers,
        "abandoned": abandoned,
        "results": results, "positions": positions,
        # Empty in dry run. Otherwise the pipeline runs these with FOREACH and returns what came
        # back to record_orders — the module never calls a broker itself.
        "calls": calls,
        "next": ("FOREACH over `calls` (inputData: \"$prev.input\", tool: sysmod_<$prev.module>), "
                 "then autotrade record_orders with `calls` and the loop's `results`."
                 if calls else None),
    }}



# How long a resting limit order is given before it is withdrawn. Two cycles of a five-minute
# schedule: long enough that a fill still arriving is not thrown away, short enough that the money
# is not held all day for a price the market has left behind.
DEFAULT_UNFILLED_AFTER_SEC = 600


def _order_type(strategy, intent):
    """Limit or market, decided by why the order exists.

    Not filling and filling badly are different costs, and which one is worse depends entirely on
    the reason. Missing an entry costs nothing — the rule fires again tomorrow — so an entry is a
    limit and a price that has run away is a trade not worth having. A stop is the opposite: a
    stop that does not fill is not a stop, it is a position still losing money while an order sits
    on the book at a price the market has left. Paying the spread is the cheaper mistake there.

    `marketWhen` lists the reasons that go to market, defaulting to the stop. The reasons an
    intent can carry are `rule`, `stop`, `take` and `split`, so a strategy that wants its targets
    taken immediately writes `["stop", "take"]` and one that never wants to cross the spread
    writes `[]`.
    """
    explicit = intent.get("ordType")
    if explicit:
        return explicit
    orders_cfg = strategy.get("orders") or {}
    base = orders_cfg.get("type") or "limit"
    market_when = orders_cfg.get("marketWhen")
    if market_when is None:
        market_when = ["stop"]
    if not isinstance(market_when, list):
        market_when = [str(market_when)]
    return "market" if intent.get("reason") in market_when else base


def _limit_price(strategy, intent, price):
    """Where to put a limit so it can actually fill.

    A limit at the signal bar's close is a limit at a price that has already gone: the bar closed,
    the market moved, and the order rests until it is withdrawn. `limitOffsetPct` reaches across
    the spread by a declared amount — up for a buy, down for a sell — which is still a bounded
    price, unlike a market order that accepts whatever the book holds.
    """
    off = float((strategy.get("orders") or {}).get("limitOffsetPct") or 0)
    if not off or price <= 0:
        return price
    return price * (1 + off / 100.0) if intent["side"] == "buy" else price * (1 - off / 100.0)


def _abandon_stale_orders(conn, settings, strategies, open_rows, calls):
    """Withdraw our own resting orders that have had long enough. Returns what was given up on.

    Only orders the broker still lists are candidates: one it no longer lists is finished, and
    reconcile settles that. Nothing is re-placed here — the next cycle enters again if the rule
    still says so, and inventing a replacement would be trading on a signal nobody gave.
    """
    if not isinstance(open_rows, list):
        return []
    still_open = {orders._dig(r, *orders.ORDER_NO_KEYS) for r in open_rows
                  if isinstance(r, dict)}
    by_strategy = {s.get("id"): s for s in strategies}
    now = store.now_ms()
    gone = []
    for o in store.open_orders(conn):
        no = o.get("broker_order_no")
        if not no or no not in still_open:
            continue
        if float(o.get("filled_qty") or 0) > 0:
            # Partly filled — leaving it is the safer read; the rest may still come.
            continue
        strategy = by_strategy.get(o["strategy_id"]) or {}
        after = (strategy.get("orders") or {}).get("unfilledAfterSec")
        if after is None:
            after = settings.get("unfilledAfterSec")
        after = float(DEFAULT_UNFILLED_AFTER_SEC if after is None else after)
        if after <= 0:
            continue                      # 0 = leave them, a real choice
        if now - int(o.get("sent_ms") or now) < after * 1000:
            continue
        calls.append({**orders.cancel_call(o), "orderKey": o["order_key"]})
        store.update_order(conn, o["order_key"], state="canceling", last_checked_ms=now)
        store.log_event(conn, "order_abandoned",
                        {"orderKey": o["order_key"], "afterSec": after},
                        strategy_id=o["strategy_id"], symbol=o.get("symbol"))
        gone.append({"orderKey": o["order_key"], "symbol": o.get("symbol"),
                     "waitedSec": round((now - int(o.get("sent_ms") or now)) / 1000)})
    return gone


def action_record_orders(inp, settings):
    """Record what the broker said, without letting it decide what happened.

    An acknowledgement moves a row from `sent` to `acked` and may add the broker's order number.
    It never creates a fill: "accepted" and "filled" are different events, and treating one as the
    other books trades that did not happen. A rejection is terminal and says so; anything
    unreadable leaves the row `unknown` for reconciliation to settle rather than guessing.
    """
    calls = _loop_items(inp.get("calls"), "calls")
    results = _loop_items(inp.get("results"))
    if len(results) != len(calls):
        # Counts alone do not say where a wrong list came from, and a pipeline hands these over by
        # reference — `$step6.results` and `$step5.calls` are easy to point one step off. Show a
        # fingerprint of each so the declaration can be checked against what actually arrived.
        return {"success": False,
                "error": f"{len(results)} responses for {len(calls)} calls — the order loop did "
                         "not finish; leave the rows alone and run reconcile. "
                         f"받은 results = {_shape(inp.get('results'))}, "
                         f"calls = {_shape(inp.get('calls'))}"}
    conn = store.connect("dryrun" if settings.get("mode") == "dryrun" else "live")
    recorded = []
    for call, ack in zip(calls, results):
        key = call.get("orderKey")
        if not key:
            continue
        read = orders.read_ack(ack)
        # Kept verbatim, every time: this is the only place the acknowledgement schema can be
        # learned from, and it is not documented for any of these brokers.
        store.log_api(conn, call.get("module"), "place_order", read["accepted"], 0,
                      call.get("input"), ack)
        if read["accepted"]:
            state = "acked"
        elif read["error"]:
            state = "rejected"
        else:
            state = "unknown"
        store.update_order(conn, key, state=state,
                           broker_order_no=read["brokerOrderNo"],
                           ack_raw=json.dumps(ack, ensure_ascii=False)[:4000],
                           error=read["error"],
                           last_checked_ms=store.now_ms())
        if state == "rejected":
            store.log_event(conn, "order_rejected", {"orderKey": key, "why": read["error"]})
        recorded.append({"orderKey": key, "state": state,
                         "brokerOrderNo": read["brokerOrderNo"], "error": read["error"]})
    open_now = store.open_orders(conn)
    conn.close()
    return {"success": True, "data": {
        "recorded": recorded,
        "openOrders": len(open_now),
        "note": ("접수 응답은 체결이 아닙니다 — 수량·평단은 reconcile 이 미체결·잔고 조회로 "
                 "확정합니다."),
    }}


def action_reconcile(inp, settings):
    """Settle against the broker's own record: fills first, then open orders, then the balance.

    Order matters. Fills are what actually happened, so they land in the ledger before anything is
    compared; open orders say which of our rows are still live; the balance is the final arbiter of
    how many shares exist. Doing it the other way round would compare a position to a ledger that
    had not caught up yet and call the difference a discrepancy.
    """
    conn = store.connect("dryrun" if settings.get("mode") == "dryrun" else "live")
    symbol = inp.get("symbol")
    strategies = pick_strategies(settings, symbol=symbol, strategy_id=inp.get("strategyId"))
    broker = (strategies[0].get("broker") if strategies else None) or "unknown"
    account = (strategies[0].get("account") if strategies else None) or ""
    report = {"applied": [], "unattributed": [], "unreadable": [], "aged": []}

    # 1. Fills → ledger, attributed through the order row that produced them.
    fills, unreadable = orders.read_fills(inp.get("fills"))
    report["unreadable"] = unreadable
    if unreadable:
        store.log_api(conn, broker, "fills:unreadable", False, 0, {"symbol": symbol}, unreadable[:5])
    by_no = {o["broker_order_no"]: o for o in store.open_orders(conn) if o.get("broker_order_no")}
    for f in fills:
        order = by_no.get(f["brokerOrderNo"])
        if order is None:
            # Someone traded this account outside the system, or the order number never came back.
            # Either way it is not ours to attribute — the balance step will absorb it.
            report["unattributed"].append(f["raw"])
            continue
        if not store.record_fill(conn, order_key_=order["order_key"], qty=f["qty"],
                                 price=f["price"], broker_exec_id=f["execId"], raw=f["raw"]):
            continue  # already booked on an earlier pass
        store.apply_fill(conn, strategy_id=order["strategy_id"], broker=order["broker"],
                         account=order["account"], symbol=order["symbol"], side=order["side"],
                         qty=f["qty"], price=f["price"], source="order",
                         ref_order_key=order["order_key"],
                         fee_in_cost=settings.get("feeInCost", True))
        filled = float(order.get("filled_qty") or 0) + f["qty"]
        store.update_order(conn, order["order_key"],
                           filled_qty=filled,
                           filled_avg=f["price"],
                           state="filled" if filled >= float(order["req_qty"]) - 1e-9 else "partial",
                           last_checked_ms=store.now_ms())
        report["applied"].append({"orderKey": order["order_key"], "qty": f["qty"],
                                  "price": f["price"]})

    # 2. Open orders — a row the broker no longer lists, with nothing filled, is finished.
    open_list = inp.get("openOrders")
    if isinstance(open_list, list):
        still_open = {orders._dig(r, *orders.ORDER_NO_KEYS) for r in open_list
                      if isinstance(r, dict)}
        for o in store.open_orders(conn):
            no = o.get("broker_order_no")
            if no and no not in still_open and float(o.get("filled_qty") or 0) <= 0:
                store.update_order(conn, o["order_key"], state="canceled",
                                   last_checked_ms=store.now_ms())

    # 3. Anything still unconfirmed past the timeout stops the strategy rather than being assumed.
    # `or 120` would turn a configured 0 back into the default — "wait no time at all" is a real
    # setting, and the same falsy-zero slip has cost us twice today.
    timeout_sec = settings.get("unknownTimeoutSec")
    limit_ms = float(120 if timeout_sec is None else timeout_sec) * 1000
    now = store.now_ms()
    # Only orders the broker does not list. A limit order resting on the book is `acked` and
    # perfectly healthy; ageing it into `unknown` degraded the position and blocked new entries
    # for a rule that was working exactly as written.
    listed = set()
    if isinstance(open_list, list):
        listed = {orders._dig(r, *orders.ORDER_NO_KEYS) for r in open_list if isinstance(r, dict)}
    for o in store.open_orders(conn):
        if o.get("broker_order_no") and o["broker_order_no"] in listed:
            continue
        if o["state"] in ("sent", "acked") and now - int(o.get("sent_ms") or now) > limit_ms:
            store.update_order(conn, o["order_key"], state="unknown",
                               last_checked_ms=now,
                               error="not confirmed by the broker within the timeout")
            store.set_position_state(conn, o["strategy_id"], o["broker"], o["account"],
                                     o["symbol"], "degraded")
            store.log_event(conn, "order_unknown", {"orderKey": o["order_key"]},
                            strategy_id=o["strategy_id"], symbol=o["symbol"])
            report["aged"].append(o["order_key"])

    # 4. The balance is the arbiter of how many shares exist.
    verdict = None
    unread_pos = None
    pos = inp.get("position") or {}
    if symbol and "qty" not in pos:
        # Given the balance rows verbatim, read this symbol out of them here rather than making
        # the caller know which field holds the quantity — the same reason fills are read here.
        found, row = orders.read_position(inp.get("balanceRows"), symbol)
        if found:
            pos = found
        elif row is not None:
            unread_pos = row
        elif isinstance(inp.get("balanceRows"), list):
            # The broker listed the account and this symbol was not in it: a real, readable zero.
            pos = {"qty": 0.0, "avgPrice": 0.0}
    if symbol and "qty" in pos and unread_pos is None:
        verdict = store.reconcile_symbol(conn, broker, account, symbol,
                                         float(pos.get("qty") or 0),
                                         float(pos.get("avgPrice") or pos.get("avg_price") or 0))
    elif unread_pos is not None:
        store.log_api(conn, broker, "balance:unreadable", False, 0, {"symbol": symbol}, unread_pos)

    drift = store.replay_positions(conn)
    if drift:
        store.kv_set(conn, "tripped", "1")
        store.log_event(conn, "halt", {"reason": "ledger replay disagrees with positions",
                                       "diffs": drift})
    conn.close()
    return {"success": True, "data": {
        "reconcile": verdict, "ledgerDrift": drift,
        "fillsApplied": report["applied"], "unattributedFills": report["unattributed"],
        "unreadableFills": report["unreadable"], "agedToUnknown": report["aged"],
        "unreadablePosition": unread_pos,
        "note": ("접수 응답이 아니라 체결·잔고 조회가 원장을 확정합니다. 읽지 못한 체결 행은 "
                 "버리지 않고 그대로 돌려주므로, 실제 응답을 보고 필드명을 늘리면 됩니다."
                 if report["unreadable"] or unread_pos else None),
    }}


def action_read(inp, settings, which):
    conn = store.connect("dryrun" if settings.get("mode") == "dryrun" else "live")
    limit = int(inp.get("limit") or 50)
    data = {"mode": settings.get("mode")}
    if which in ("positions", "report"):
        data["positions"] = store.read_positions(conn)
    if which in ("orders", "report"):
        data["orders"] = store.read_orders(conn, limit)
    if which in ("ledger", "report"):
        data["ledger"] = store.read_ledger(conn, limit)
        data["transfers"] = store.read_transfers(conn, limit)
    if which == "report":
        data["events"] = store.read_events(conn, limit)
        data["tripped"] = store.kv_get(conn, "tripped") == "1"
        # A page renders the closed round trips with the existing paper_trades component.
        data["blocks"] = [{"type": "paper_trades", "props": {
            "title": "자동매매 원장", "records": _round_trips(store.read_ledger(conn, 500))}}]
    conn.close()
    return {"success": True, "data": data}


def _round_trips(ledger_rows):
    """Pair buys with sells per strategy so the ledger renders as completed trades.

    FIFO, and only closed pairs — an open position is a position, not a result, and showing it as
    one would let an unrealised loss read as performance.
    """
    opens, trades = {}, []
    for row in sorted(ledger_rows, key=lambda r: r["id"]):
        key = (row["strategy_id"], row["symbol"])
        if row["side"] in ("buy", "transfer_in"):
            opens.setdefault(key, []).append(dict(row))
            continue
        if row["side"] not in ("sell", "transfer_out"):
            continue
        need = float(row["qty"])
        while need > 1e-9 and opens.get(key):
            lot = opens[key][0]
            take = min(need, float(lot["qty"]))
            entry, exit_ = float(lot["price"]), float(row["price"])
            trades.append({
                "entryDate": lot["ts_ms"], "entryPrice": entry, "entryLabel": lot["side"],
                "exitDate": row["ts_ms"], "exitPrice": exit_, "exitLabel": row["side"],
                "exitReason": row["source"], "qty": take,
                "returnPct": round((exit_ - entry) / entry * 100.0, 4) if entry else 0.0,
                "grossPct": round((exit_ - entry) / entry * 100.0, 4) if entry else 0.0,
                "strategyId": row["strategy_id"], "symbol": row["symbol"],
            })
            lot["qty"] = float(lot["qty"]) - take
            need -= take
            if float(lot["qty"]) <= 1e-9:
                opens[key].pop(0)
    return trades


def action_halt(settings):
    conn = store.connect("dryrun" if settings.get("mode") == "dryrun" else "live")
    store.kv_set(conn, "tripped", "1")
    store.log_event(conn, "halt", {"reason": "halt requested"})
    conn.close()
    # Clearing it is a settings change on purpose — the switch only moves one way from here.
    return {"success": True, "data": {"tripped": True,
            "note": "설정 화면에서 해제하실 수 있습니다."}}


def action_selftest():
    """Golden fixtures over the parts that must never drift: cost basis, transfers, idempotency."""
    import tempfile
    checks = []
    tmp = tempfile.mkdtemp()
    store.DATA_DIR = tmp
    conn = store.connect("dryrun")
    args = dict(strategy_id="s1", broker="b", account="a", symbol="X")

    store.apply_fill(conn, **args, side="buy", qty=10, price=1000, source="test")
    store.apply_fill(conn, **args, side="buy", qty=10, price=2000, source="test")
    pos = store.position_of(conn, "s1", "b", "a", "X")
    checks.append({"name": "moving average after two buys", "want": 1500.0,
                   "got": pos["avg_price"], "ok": abs(pos["avg_price"] - 1500.0) < 1e-6})

    store.apply_fill(conn, **args, side="sell", qty=5, price=1800, source="test")
    pos = store.position_of(conn, "s1", "b", "a", "X")
    checks.append({"name": "a sell leaves the average alone", "want": 1500.0,
                   "got": pos["avg_price"], "ok": abs(pos["avg_price"] - 1500.0) < 1e-6})
    checks.append({"name": "realised gain booked", "want": 1500.0,
                   "got": pos["realized_pnl"], "ok": abs(pos["realized_pnl"] - 1500.0) < 1e-6})

    store.apply_fill(conn, **args, side="sell", qty=15, price=1400, source="test")
    pos = store.position_of(conn, "s1", "b", "a", "X")
    checks.append({"name": "flat position resets the average", "want": 0.0,
                   "got": pos["avg_price"], "ok": pos["avg_price"] == 0.0})

    oversell = False
    try:
        store.apply_fill(conn, **args, side="sell", qty=1, price=1000, source="test")
    except ValueError:
        oversell = True
    checks.append({"name": "cannot sell what the strategy does not hold", "want": True,
                   "got": oversell, "ok": oversell})

    store.apply_fill(conn, strategy_id="s1", broker="b", account="a", symbol="Y",
                     side="buy", qty=4, price=500, source="test")
    store.record_transfer(conn, cycle_id="c1", from_strategy="s1", to_strategy="s2",
                          broker="b", account="a", symbol="Y", qty=4, price=600)
    p1 = store.position_of(conn, "s1", "b", "a", "Y")
    p2 = store.position_of(conn, "s2", "b", "a", "Y")
    checks.append({"name": "transfer moves the shares", "want": [0.0, 4.0],
                   "got": [p1["qty"], p2["qty"]],
                   "ok": p1["qty"] == 0.0 and p2["qty"] == 4.0})
    checks.append({"name": "transfer gain is booked apart from market P&L", "want": 400.0,
                   "got": p1["realized_pnl_internal"],
                   "ok": abs(p1["realized_pnl_internal"] - 400.0) < 1e-6
                         and p1["realized_pnl"] == 0.0})
    checks.append({"name": "buyer's basis is the transfer price", "want": 600.0,
                   "got": p2["avg_price"], "ok": abs(p2["avg_price"] - 600.0) < 1e-6})

    order = {"order_key": store.order_key("s1", "X", "buy", "bar:2026-08-01"),
             "cycle_id": "bar:2026-08-01", "strategy_id": "s1", "broker": "b", "account": "a",
             "symbol": "X", "side": "buy", "req_qty": 1, "req_price": 100, "mode": "dryrun"}
    first = store.insert_order(conn, order)
    second = store.insert_order(conn, order)
    checks.append({"name": "the same window cannot order twice", "want": [True, False],
                   "got": [first, second], "ok": first and not second})

    v = store.reconcile_symbol(conn, "b", "a", "Y", broker_qty=6)
    checks.append({"name": "surplus goes to the unassigned bucket", "want": 2.0,
                   "got": v["unassignedQty"], "ok": abs(v["unassignedQty"] - 2.0) < 1e-6})
    v2 = store.reconcile_symbol(conn, "b", "a", "Y", broker_qty=1)
    checks.append({"name": "a shortfall degrades the position", "want": "degraded",
                   "got": v2["action"], "ok": v2["action"] == "degraded"})

    intents = [
        {"strategyId": "a", "side": "sell", "qty": 3, "price": 1000},
        {"strategyId": "b", "side": "buy", "qty": 2, "price": 1000},
        {"strategyId": "c", "side": "buy", "qty": 5, "price": 1001},
    ]
    transfers, rest = eng.match_internal_transfers([dict(i) for i in intents])
    checks.append({"name": "only an equal price offsets", "want": [1, 2],
                   "got": [len(transfers), len(rest)],
                   "ok": len(transfers) == 1 and transfers[0]["qty"] == 2 and len(rest) == 2})

    mode = eng.effective_mode({"mode": "real", "realArmed": True}, {"mode": "real"}, False, False)
    checks.append({"name": "an interactive call stays on paper", "want": "dryrun",
                   "got": mode, "ok": mode == "dryrun"})
    mode2 = eng.effective_mode({"mode": "real", "realArmed": False}, {"mode": "real"}, False, True)
    checks.append({"name": "live trading needs arming", "want": "mock",
                   "got": mode2, "ok": mode2 == "mock"})
    mode3 = eng.effective_mode({"mode": "real", "realArmed": True}, {"mode": "real"}, True, True)
    checks.append({"name": "a mock account stays mock", "want": "mock",
                   "got": mode3, "ok": mode3 == "mock"})

    drift = store.replay_positions(conn)
    checks.append({"name": "ledger replay matches the positions", "want": [],
                   "got": drift, "ok": drift == []})
    conn.close()

    plan = sweep.plan_sweep({"space": {"families": ["ma-cross"], "fast": [5], "slow": [20, 60]}})
    checks.append({"name": "a sweep plans two windows per candidate", "want": [2, 4],
                   "got": [len(plan["candidates"]), plan["runCount"]],
                   "ok": len(plan["candidates"]) == 2 and plan["runCount"] == 4})
    # A window that cannot hold the indicator's warm-up is refused, not measured: "zero trades"
    # would otherwise read as a verdict on the rule.
    short = sweep.plan_sweep({"space": {"families": ["ma-cross"], "fast": [5], "slow": [20, 60]},
                              "barCount": 243})
    refused = [u["id"] for u in short["unmeasurable"]]
    checks.append({"name": "a rule the window cannot measure is refused up front",
                   "want": ["ma-cross:ma5x60"], "got": refused,
                   "ok": refused == ["ma-cross:ma5x60"] and len(short["candidates"]) == 1})
    long = sweep.plan_sweep({"space": {"families": ["ma-cross"], "fast": [5], "slow": [20, 60]},
                             "barCount": 1200})
    checks.append({"name": "a long enough series measures both", "want": 2,
                   "got": len(long["candidates"]),
                   "ok": len(long["candidates"]) == 2 and not long["unmeasurable"]})

    windows = sorted({r["window"] for r in plan["runs"]})
    checks.append({"name": "fitted on one window, scored on another", "want": ["holdout", "train"],
                   "got": windows, "ok": windows == ["holdout", "train"]})

    def bt(ret, trades, mdd=0.0):
        return {"success": True, "data": {"backtest": {
            "totalReturnPct": ret, "tradeCount": trades, "maxDrawdownPct": mdd, "winRate": 50}}}

    runs = [
        {"candidateId": "thin", "window": "train"}, {"candidateId": "thin", "window": "holdout"},
        {"candidateId": "solid", "window": "train"}, {"candidateId": "solid", "window": "holdout"},
    ]
    ranked = sweep.rank_sweep({
        "runs": runs,
        "results": [bt(90, 2), bt(80, 2), bt(20, 40), bt(18, 40)],
    })
    # The thin candidate posts a far bigger number and must still lose: two trades is not a result.
    top = ranked["ranked"][0]["candidateId"]
    checks.append({"name": "a huge return on two trades does not win", "want": "solid",
                   "got": top, "ok": top == "solid"})
    # Reading executions: the numbers are found by name, and a row that does not give both a
    # quantity and a price is handed back rather than guessed at or skipped.
    got, bad = orders.read_fills([
        {"ord_no": "1", "cntr_qty": "3", "cntr_uv": "70,500", "cntr_no": "E9"},
        {"ODNO": "2", "CCLD_QTY": "1", "CCLD_PRVS": "500"},
        {"ord_no": "3", "mystery": "1"},
    ])
    checks.append({"name": "executions are read across broker vocabularies", "want": [2, 1],
                   "got": [len(got), len(bad)],
                   "ok": len(got) == 2 and len(bad) == 1
                        and got[0]["qty"] == 3 and got[0]["price"] == 70500})
    checks.append({"name": "an execution without an id still gets one", "want": True,
                   "got": got[1]["execId"], "ok": bool(got[1]["execId"])})

    # An acknowledgement is not a fill. Every broker names its order number differently and none
    # of them document the response, so the number is found by name and everything else ignored.
    for label, ack, want_no in (
        ("kiwoom", {"success": True, "data": {"return_code": 0, "ord_no": "0001234"}}, "0001234"),
        ("kis", {"success": True, "data": {"output": {"ODNO": "77"}}}, "77"),
        ("toss", {"success": True, "data": {"result": {"orderId": "tx-9"}}}, "tx-9"),
    ):
        read = orders.read_ack(ack)
        checks.append({"name": f"the order number is found in a {label} ack", "want": want_no,
                       "got": read["brokerOrderNo"],
                       "ok": read["brokerOrderNo"] == want_no and read["accepted"]})
    rejected = orders.read_ack({"success": False, "error": "주문가능금액 부족"})
    checks.append({"name": "a rejection is not accepted and keeps its reason", "want": False,
                   "got": rejected, "ok": not rejected["accepted"] and rejected["error"]})
    checks.append({"name": "an unreadable response is not treated as success", "want": False,
                   "got": orders.read_ack(None), "ok": not orders.read_ack(None)["accepted"]})
    # Nothing in an ack may carry a filled quantity through — that only comes from reconcile.
    checks.append({"name": "an ack cannot report a fill", "want": ["accepted", "brokerOrderNo", "clientOrderId", "error"],
                   "got": sorted(orders.read_ack({"success": True, "data": {"cntr_qty": 5}})),
                   "ok": "filled" not in " ".join(orders.read_ack({"success": True, "data": {"cntr_qty": 5}}))})

    # The two-call form plans every symbol at once and splits the flat results back out, so a
    # pipeline stays four steps whatever the symbol count.
    fetched = [{"_cacheMeta": {"totalCount": 1200}, "records": []},
               {"_cacheMeta": {"totalCount": 1200}, "records": []}]
    multi = sweep.plan_multi({
        "symbols": ["AAA", "BBB"], "confirmSymbols": ["BBB"],
        "space": {"families": ["ma-cross"], "fast": [5], "slow": [20]},
        "fetched": fetched})
    roles = {p["symbol"]: p["role"] for p in multi["perSymbol"]}
    checks.append({"name": "planning tags each symbol's role", "want": {"AAA": "select", "BBB": "confirm"},
                   "got": roles, "ok": roles == {"AAA": "select", "BBB": "confirm"}})
    checks.append({"name": "every planned run carries its own bars reference", "want": 4,
                   "got": len(multi["runs"]),
                   "ok": len(multi["runs"]) == 4 and all(r.get("symbol") for r in multi["runs"])})
    mismatch = sweep.plan_multi.__doc__ is not None
    try:
        sweep.plan_multi({"symbols": ["AAA", "BBB"], "fetched": fetched[:1]})
        mismatch = False
    except ValueError:
        pass
    checks.append({"name": "a fetch list that does not line up is refused", "want": True,
                   "got": mismatch, "ok": mismatch})
    bt_rows = [{"success": True, "data": {"backtest": {
        "totalReturnPct": 30 if r["symbol"] == "AAA" else -10, "tradeCount": 25,
        "maxDrawdownPct": -5, "winRate": 55, "buyHoldPct": 10}}} for r in multi["runs"]]
    rolled = sweep.rank_multi({"runs": multi["runs"], "results": bt_rows})
    checks.append({"name": "ranking splits the flat results back out by symbol", "want": 2,
                   "got": len(rolled.get("perSymbol") or []),
                   "ok": len(rolled.get("perSymbol") or []) == 2})

    # Cross-symbol: a rule that wins big on one series and loses on two is not a strategy.
    running = None
    for sym, rows in (
        ("A", [{"candidateId": "lucky", "vsBuyHoldPct": 90, "holdoutReturnPct": 95, "trades": 20, "flags": []},
               {"candidateId": "steady", "vsBuyHoldPct": 4, "holdoutReturnPct": 12, "trades": 20, "flags": []}]),
        ("B", [{"candidateId": "lucky", "vsBuyHoldPct": -30, "holdoutReturnPct": -20, "trades": 20, "flags": []},
               {"candidateId": "steady", "vsBuyHoldPct": 3, "holdoutReturnPct": 9, "trades": 20, "flags": []}]),
        ("C", [{"candidateId": "lucky", "vsBuyHoldPct": -25, "holdoutReturnPct": -15, "trades": 20, "flags": []},
               {"candidateId": "steady", "vsBuyHoldPct": 5, "holdoutReturnPct": 11, "trades": 20, "flags": []}]),
    ):
        running = sweep.merge_sweeps({"running": running, "symbol": sym, "ranked": rows})
    # The accumulator comes back under the same key it goes in as, so chaining is literal.
    assert "running" in running, "merge_sweeps must return its accumulator as `running`"
    across = sweep.rank_across({"running": running})
    # The real 2026-08-01 shape: 3/3 where it was chosen, 2/5 where it was not.
    confirmed = sweep.merge_sweeps({
        "running": running, "symbol": "D", "role": "confirm",
        "ranked": [{"candidateId": "steady", "vsBuyHoldPct": -45, "trades": 40, "flags": []},
                   {"candidateId": "lucky", "vsBuyHoldPct": -20, "trades": 40, "flags": []}]})
    confirmed = sweep.merge_sweeps({
        "running": confirmed, "symbol": "E", "role": "confirm",
        "ranked": [{"candidateId": "steady", "vsBuyHoldPct": -30, "trades": 40, "flags": []},
                   {"candidateId": "lucky", "vsBuyHoldPct": -25, "trades": 40, "flags": []}]})
    after = sweep.rank_across({"running": confirmed})
    checks.append({"name": "a rule that fails on unseen symbols is not crowned", "want": None,
                   "got": (after["winner"] or {}).get("candidateId"),
                   "ok": after["winner"] is None})
    steady_after = next(r for r in after["ranked"] if r["candidateId"] == "steady")
    checks.append({"name": "the confirmation set is reported, not just used", "want": "0/2",
                   "got": f"{steady_after.get('confirmBeatIn')}/{steady_after.get('confirmSymbols')}",
                   "ok": steady_after.get("confirmBeatIn") == 0
                         and steady_after.get("confirmSymbols") == 2
                         and any("not chosen from" in f for f in steady_after["flags"])})
    # Selection-set ranking is unchanged by the presence of a confirmation set.
    checks.append({"name": "selection ranking still puts the consistent rule first",
                   "want": "steady", "got": after["ranked"][0]["candidateId"],
                   "ok": after["ranked"][0]["candidateId"] == "steady"})
    top = across["ranked"][0]["candidateId"]
    checks.append({"name": "consistency beats one lucky symbol", "want": "steady",
                   "got": top, "ok": top == "steady"})
    lucky = next(r for r in across["ranked"] if r["candidateId"] == "lucky")
    checks.append({"name": "a rule that lost on most symbols is flagged", "want": True,
                   "got": lucky["flags"],
                   "ok": any("not a majority" in f for f in lucky["flags"])})
    checks.append({"name": "the survivor is the one that held up everywhere", "want": "steady",
                   "got": (across["winner"] or {}).get("candidateId"),
                   "ok": (across["winner"] or {}).get("candidateId") == "steady"})

    fitted = sweep.rank_sweep({
        "runs": [{"candidateId": "curve", "window": "train"},
                 {"candidateId": "curve", "window": "holdout"}],
        "results": [bt(60, 30), bt(1, 30)],
    })["ranked"][0]
    checks.append({"name": "in-sample only is called out", "want": True,
                   "got": fitted["flags"],
                   "ok": any("out of sample" in f for f in fitted["flags"])})

    # --- reading the balance -------------------------------------------------------------
    # The suffixed code is what the order endpoints actually echo back; a strict compare would
    # read this holding as absent and settle it as a sale.
    held, _ = orders.read_position([{"stk_cd": "005930_AL", "rmnd_qty": "7", "pur_pric": "70,500"}],
                                   "005930")
    checks.append({"name": "a suffixed symbol is still the same holding",
                   "want": {"qty": 7.0, "avgPrice": 70500.0}, "got": held,
                   "ok": held == {"qty": 7.0, "avgPrice": 70500.0}})

    us, _ = orders.read_position([{"symbol": "AAPL.US", "qty": "3", "avgPrice": "210.5"}], "AAPL")
    checks.append({"name": "a lettered ticker is matched too", "want": {"qty": 3.0,
                                                                       "avgPrice": 210.5},
                   "got": us, "ok": us == {"qty": 3.0, "avgPrice": 210.5}})

    missing, row = orders.read_position([{"stk_cd": "000660", "rmnd_qty": "3"}], "005930")
    checks.append({"name": "another symbol's row is not this symbol's position",
                   "want": [None, None], "got": [missing, row],
                   "ok": missing is None and row is None})

    unread, bad_row = orders.read_position([{"stk_cd": "005930", "holding": "9"}], "005930")
    checks.append({"name": "an unreadable holding is reported, not read as zero",
                   "want": [None, True], "got": [unread, bad_row is not None],
                   "ok": unread is None and bad_row is not None})

    # A listed account without this symbol is a readable zero, and reconcile must act on it.
    conn2 = store.connect("dryrun")
    store.apply_fill(conn2, strategy_id="bal", broker="b", account="a", symbol="Z",
                     side="buy", qty=5, price=100, source="test")
    settings_bal = {"mode": "dryrun", "strategies": [
        {"id": "bal", "symbol": "Z", "broker": "b", "account": "a"}]}
    conn2.close()
    sold_out = action_reconcile({"symbol": "Z", "balanceRows": [{"stk_cd": "999999",
                                                                "rmnd_qty": "1"}]},
                                settings_bal)["data"]["reconcile"]
    checks.append({"name": "a symbol absent from the balance is zero, not unknown",
                   "want": 0.0, "got": (sold_out or {}).get("brokerQty"),
                   "ok": (sold_out or {}).get("brokerQty") == 0.0})

    skipped = action_reconcile({"symbol": "Z", "balanceRows": [{"stk_cd": "Z", "holding": "5"}]},
                               settings_bal)["data"]
    checks.append({"name": "an unreadable balance row skips the comparison entirely",
                   "want": [None, True],
                   "got": [skipped["reconcile"], skipped["unreadablePosition"] is not None],
                   "ok": skipped["reconcile"] is None and skipped["unreadablePosition"] is not None})

    # --- the human switch ----------------------------------------------------------------
    gate_strats = [{"id": "g", "enabled": True, "symbol": "X", "broker": "b", "account": "a"}]

    def gate(**over):
        base = {"mode": "dryrun", "tradingEnabled": True, "strategies": gate_strats}
        return action_gate({}, {**base, **over})["data"]

    checks.append({"name": "switched off means no cycle", "want": False,
                   "got": gate(tradingEnabled=False)["active"],
                   "ok": gate(tradingEnabled=False)["active"] is False})
    checks.append({"name": "switched on with a strategy runs", "want": True,
                   "got": gate()["active"], "ok": gate()["active"] is True})
    checks.append({"name": "no strategy is not a run", "want": False,
                   "got": gate(strategies=[])["active"],
                   "ok": gate(strategies=[])["active"] is False})
    # The end date is inclusive — reading it as exclusive silently drops a whole session.
    today = time.strftime("%Y-%m-%d")
    checks.append({"name": "the last day of the window still trades", "want": True,
                   "got": gate(activeUntil=today)["active"],
                   "ok": gate(activeUntil=today)["active"] is True})
    checks.append({"name": "a window that has ended stops trading", "want": False,
                   "got": gate(activeUntil="2020-01-01")["active"],
                   "ok": gate(activeUntil="2020-01-01")["active"] is False})
    checks.append({"name": "a window not yet open stops trading", "want": False,
                   "got": gate(activeFrom="2099-01-01")["active"],
                   "ok": gate(activeFrom="2099-01-01")["active"] is False})
    # A typo must not read as "no deadline" — that would keep trading past the day meant.
    typo = gate(activeUntil="8월5일")
    checks.append({"name": "an unreadable end date holds instead of removing the deadline",
                   "want": False, "got": typo["why"],
                   "ok": typo["active"] is False and "activeUntil" in str(typo["why"])})
    checks.append({"name": "the kill switch is a reason of its own", "want": False,
                   "got": gate(killSwitch=True)["active"],
                   "ok": gate(killSwitch=True)["active"] is False})
    # An interactive call is paper whatever the setting says, and the gate must not hide it.
    checks.append({"name": "the gate reports whether anyone is watching", "want": False,
                   "got": gate(mode="real")["unattended"],
                   "ok": gate(mode="real")["unattended"] is False})

    # --- what the model may adopt --------------------------------------------------------
    # The gate is only worth anything if it refuses, so every refusal is measured, not just the
    # pass. A candidate that clears one bar and fails another must still be refused.
    good = {"candidateId": "c1", "symbols": 5, "beatBuyHoldIn": 4, "confirmSymbols": 2,
            "confirmBeatIn": 2, "trades": 40, "medianVsBuyHoldPct": 8.0, "flags": []}
    checks.append({"name": "a measured winner is allowed", "want": [],
                   "got": strat.judge(good), "ok": strat.judge(good) == []})

    for name, patch, expect in [
        ("one symbol is an anecdote", {"symbols": 1, "beatBuyHoldIn": 1}, "anecdote"),
        ("winning on a minority is not winning", {"beatBuyHoldIn": 2}, "not a majority"),
        ("never confirmed is not proven", {"confirmSymbols": 0, "confirmBeatIn": 0}, "untested"),
        ("losing the confirmation set", {"confirmBeatIn": 0}, "confirmation set"),
        ("too few trades is luck", {"trades": 3}, "luck"),
        ("a negative median is not an edge", {"medianVsBuyHoldPct": -2.0}, "median"),
        ("the sweep's own overfit flag is a refusal",
         {"flags": ["only worked in sample — out of sample it lost"]}, "out of sample"),
    ]:
        why = strat.judge({**good, **patch})
        checks.append({"name": name, "want": expect, "got": why,
                       "ok": any(expect in w for w in why)})

    # A missing field must read as "never measured", never as "nothing to check".
    bare = strat.judge({"candidateId": "c2"})
    checks.append({"name": "an empty measurement is refused, not waved through",
                   "want": True, "got": bare, "ok": len(bare) >= 3})

    at_dir = tempfile.mkdtemp()
    store.DATA_DIR = at_dir
    sconn = strat.connect()
    costs = {"feeRate": 0.00015, "taxRate": 0.0018, "slippageRate": 0.0005}
    runs = [{"candidateId": "c1", "args": {"action": "signals", "stopLossPct": 3, **costs,
                                           "rules": [{"side": "buy", "when": [
                                               {"a": "ma5", "op": "crossUp", "b": "ma20"}]}]}}]
    target = {"symbol": "005930", "broker": "kiwoom", "account": "모의국내"}
    ok_res = strat.adopt(sconn, {"winner": good, "ranked": [good]}, runs, target)
    checks.append({"name": "an adopted strategy starts on paper, never at real",
                   "want": "paper", "got": ok_res.get("stage"),
                   "ok": ok_res.get("stage") == "paper"})
    live = strat.rows_to_strategies(sconn)
    checks.append({"name": "the stage becomes the strategy's own mode ceiling",
                   "want": "dryrun", "got": (live[0]["mode"] if live else None),
                   "ok": bool(live) and live[0]["mode"] == "dryrun"})
    checks.append({"name": "the measured rules travel with it", "want": 1,
                   "got": len(live[0]["rules"]) if live else 0,
                   "ok": bool(live) and len(live[0]["rules"]) == 1})
    checks.append({"name": "the exit that was measured travels with it", "want": 3,
                   "got": (live[0].get("exits") or {}).get("stopLossPct") if live else None,
                   "ok": bool(live) and (live[0]["exits"] or {}).get("stopLossPct") == 3})

    bad_res = strat.adopt(sconn, {"winner": {**good, "candidateId": "c1", "trades": 2}},
                          runs, target)
    checks.append({"name": "a refused candidate is not stored", "want": None,
                   "got": bad_res.get("adopted"), "ok": bad_res.get("adopted") is None})
    events = strat.read_events(sconn)
    checks.append({"name": "the refusal is written down for the next search",
                   "want": "refused", "got": [e["event"] for e in events][:2],
                   "ok": any(e["event"] == "refused" for e in events)})

    # Rules the ranking never saw cannot be smuggled in by naming a candidate that is not there.
    ghost = strat.adopt(sconn, {"winner": {**good, "candidateId": "nope"}}, runs, target)
    checks.append({"name": "a winner whose rules are not in the runs is refused",
                   "want": None, "got": ghost.get("adopted"),
                   "ok": ghost.get("adopted") is None})

    # A revision is a different strategy wearing the same name — it starts over.
    strat.set_stage(sconn, ok_res["adopted"], "real", "test")
    again = strat.adopt(sconn, {"winner": good}, runs, target)
    checks.append({"name": "a revised rule restarts the ladder", "want": "paper",
                   "got": again.get("stage"), "ok": again.get("stage") == "paper"})
    sconn.close()

    # --- the ladder ----------------------------------------------------------------------
    # A stage is earned by trading, so the test trades: real fills into the paper ledger, then the
    # review that reads them back. Nothing here asserts on a number the review was handed.
    with_results = [{"backtest": {"winRate": 60.0, "avgReturnPct": 1.2}}]
    ladder_runs = [{"candidateId": "c1", "window": "holdout",
                    "args": {**costs, "rules": [{"side": "buy", "when": [
                        {"a": "ma5", "op": "crossUp", "b": "ma20"}]}]}}]
    lconn = strat.connect()
    lres = strat.adopt(lconn, {"winner": good}, ladder_runs,
                       {"id": "ladder", "symbol": "L", "broker": "b", "account": "a"},
                       results=with_results)
    stored = json.loads(lconn.execute(
        "SELECT measured_json FROM ai_strategy WHERE id='ladder'").fetchone()[0])
    checks.append({"name": "what the backtest promised is kept for later", "want": 60.0,
                   "got": (stored.get("expected") or {}).get("winRatePct"),
                   "ok": (stored.get("expected") or {}).get("winRatePct") == 60.0})

    paper = store.connect("dryrun")
    ledger_for = lambda mode: paper

    def round_trip(sid, buy_price, sell_price, n=1):
        for _ in range(n):
            store.apply_fill(paper, strategy_id=sid, broker="b", account="a", symbol="L",
                             side="buy", qty=1, price=buy_price, source="test")
            store.apply_fill(paper, strategy_id=sid, broker="b", account="a", symbol="L",
                             side="sell", qty=1, price=sell_price, source="test")

    # review walks every strategy, so pick this one out by name — the store already holds others.
    def reviewed(sid):
        return [r for r in strat.review(lconn, ledger_for) if r["id"] == sid][0]

    held = reviewed("ladder")
    checks.append({"name": "a strategy with no record does not move", "want": "hold",
                   "got": held["verdict"], "ok": held["verdict"] == "hold"})

    round_trip("ladder", 1000, 1100, n=7)   # seven wins
    round_trip("ladder", 1000, 950, n=3)    # three losses -> 70% win rate, profitable
    up = reviewed("ladder")
    checks.append({"name": "a record that keeps the promise climbs", "want": "paper → mock",
                   "got": up.get("moved"), "ok": up.get("moved") == "paper → mock"})
    checks.append({"name": "the live win rate is read from our own fills", "want": 70.0,
                   "got": up["live"]["winRatePct"], "ok": up["live"]["winRatePct"] == 70.0})

    # Losing money at the new stage sends it back down, whatever the win rate looks like.
    round_trip("ladder", 1000, 400, n=10)
    down = reviewed("ladder")
    checks.append({"name": "a losing record at a stage sends it back down", "want": "mock → paper",
                   "got": down.get("moved"), "ok": down.get("moved") == "mock → paper"})

    # A rule whose live win rate falls far under what was measured is demoted even while profitable.
    strat.set_stage(lconn, "ladder", "mock", "test")
    round_trip("drifter", 1000, 1001, n=3)
    lconn.execute("INSERT INTO ai_strategy(id,symbol,broker,account,spec_json,stage,"
                  "stage_since_ms,measured_json,created_ms,updated_ms) VALUES"
                  "('drifter','L','b','a','{}','mock',0,?,0,0)",
                  (json.dumps({"expected": {"winRatePct": 90.0}}),))
    lconn.commit()
    round_trip("drifter", 1000, 1002, n=4)
    round_trip("drifter", 1000, 999, n=6)   # 40% win rate against 90% promised, still in profit
    drift = reviewed("drifter")
    checks.append({"name": "profitable but nothing like the backtest is still a demotion",
                   "want": "demote", "got": [drift["verdict"], drift["live"]["winRatePct"]],
                   "ok": drift["verdict"] == "demote"})

    # Without a promise to check, the climb stops at mock — real money is not reached blind.
    lconn.execute("INSERT INTO ai_strategy(id,symbol,broker,account,spec_json,stage,"
                  "stage_since_ms,measured_json,created_ms,updated_ms) VALUES"
                  "('blind','L','b','a','{}','mock',0,'{}',0,0)")
    lconn.commit()
    round_trip("blind", 1000, 1200, n=12)
    blind = reviewed("blind")
    checks.append({"name": "an unmeasured strategy cannot climb into real money",
                   "want": "hold", "got": [blind["verdict"], blind["stage"]],
                   "ok": blind["verdict"] == "hold" and blind["stage"] == "mock"})
    paper.close()
    lconn.close()

    # --- a search space that arrived as text ----------------------------------------------
    # The nightly pipeline composes it in an LLM_TRANSFORM step, which returns a string however
    # well-formed the JSON is. Failing on that would be a quoting detail nobody can see in a log.
    want_space = {"families": ["ma-cross"], "fast": [5]}
    checks.append({"name": "an object passes through", "want": want_space,
                   "got": as_object(want_space, "space"), "ok": as_object(want_space, "space") == want_space})
    as_text = json.dumps(want_space)
    checks.append({"name": "a JSON string is read as the object it is", "want": want_space,
                   "got": as_object(as_text, "space"), "ok": as_object(as_text, "space") == want_space})
    fenced = "```json" + chr(10) + as_text + chr(10) + "```"
    checks.append({"name": "a fenced block is unwrapped", "want": want_space,
                   "got": as_object(fenced, "space"), "ok": as_object(fenced, "space") == want_space})
    for name, bad_value in (("prose is refused, not coerced", "let us try moving averages"),
                            ("a list is refused", "[1,2]")):
        try:
            as_object(bad_value, "space")
            checks.append({"name": name, "want": "refused", "got": "accepted", "ok": False})
        except ValueError as e:
            checks.append({"name": name, "want": "refused", "got": str(e)[:60], "ok": True})

    # --- revision picks one, worst first ---------------------------------------------------
    # The ladder block closed its ledger; this one needs its own open handle.
    rpaper = store.connect("dryrun")
    rledger = lambda mode: rpaper
    rconn = strat.connect()
    rconn.execute("DELETE FROM ai_strategy")
    rconn.commit()
    checks.append({"name": "nothing adopted means nothing to revise", "want": None,
                   "got": strat.next_revision(rconn, rledger),
                   "ok": strat.next_revision(rconn, rledger) is None})


    for sid, updated in (("healthy", 200), ("stale", 100)):
        rconn.execute("INSERT INTO ai_strategy(id,symbol,broker,account,spec_json,stage,"
                      "stage_since_ms,measured_json,created_ms,updated_ms) VALUES"
                      "(?,'L','b','a',?,'paper',0,'{}',0,?)",
                      (sid, json.dumps({"rules": [{"side": "buy", "when": []}],
                                        "exits": {"stopLossPct": 3}}), updated))
    rconn.commit()

    # The clock is the round trip, not the calendar. A healthy strategy that has not completed a
    # cycle since its rule was last written has produced nothing new to revise on, and offering it
    # anyway would mean rewriting a rule on the evidence that already wrote it.
    idle = strat.next_revision(rconn, rledger)
    checks.append({"name": "a rule with no completed cycle since it was written is not offered",
                   "want": None, "got": idle.get("strategyId"),
                   "ok": idle.get("strategyId") is None and len(idle.get("waiting") or []) == 2})

    def _round_trips(sid, n, first_ts):
        """n completed cycles: each a buy, then a sell that takes the position flat."""
        for k in range(n):
            for side, after in (("buy", 1.0), ("sell", 0.0)):
                rpaper.execute(
                    "INSERT INTO ledger(ts_ms,strategy_id,broker,account,symbol,side,qty,price,"
                    "fee,tax,source,qty_after,avg_after,realized) "
                    "VALUES(?,?,'b','a','L',?,1,100,0,0,'test',?,100,?)",
                    (first_ts + k, sid, side, after, 1.0 if side == "sell" else 0.0))
        rpaper.commit()

    # A partial exit is not a cycle — only the sell that flattens counts.
    rpaper.execute("INSERT INTO ledger(ts_ms,strategy_id,broker,account,symbol,side,qty,price,"
                   "fee,tax,source,qty_after,avg_after,realized) "
                   "VALUES(9999,'stale','b','a','L','sell',1,100,0,0,'test',0.5,100,1)")
    rpaper.commit()
    part = strat.next_revision(rconn, rledger)
    checks.append({"name": "scaling out of one entry is still one position, not one cycle",
                   "want": None, "got": part.get("strategyId"),
                   "ok": part.get("strategyId") is None})

    _round_trips("stale", 8, 1000)
    _round_trips("healthy", 8, 1000)
    picked = strat.next_revision(rconn, rledger)
    checks.append({"name": "the least recently revised is picked when all are healthy",
                   "want": "stale", "got": picked["strategyId"],
                   "ok": picked["strategyId"] == "stale"})
    checks.append({"name": "how many cycles earned the revision travels with it", "want": 8,
                   "got": picked.get("closedRoundTrips"),
                   "ok": picked.get("closedRoundTrips") == 8})
    checks.append({"name": "the current rule travels to the revision step", "want": 1,
                   "got": len(picked["currentRules"]),
                   "ok": len(picked["currentRules"]) == 1 and
                         picked["currentExits"].get("stopLossPct") == 3})

    # A strategy that just lost a stage is the one whose rule stopped describing the market.
    strat.set_stage(rconn, "healthy", "paper", "demoted in a test")
    rconn.execute("UPDATE ai_strategy SET updated_ms=999 WHERE id='healthy'")
    rconn.commit()
    demoted_first = strat.next_revision(rconn, rledger)
    checks.append({"name": "a demoted rule jumps the queue even if just revised",
                   "want": "healthy", "got": demoted_first["strategyId"],
                   "ok": demoted_first["strategyId"] == "healthy"})
    rconn.close()
    rpaper.close()

    # --- the same rule in two accounts is two trades ---------------------------------------
    # 매매1 = 증권사1·계좌1, 매매3 = 증권사2·계좌1 with the same rule. The position table always
    # keyed on where a trade runs; the cycle check and the order key did not, so the second one
    # was read as a repeat of the first and skipped — an order that never left, wearing the log
    # line of correct idempotency.
    tconn = store.connect("dryrun")
    bar = "bar:2026-08-02T09:00"
    keys = {store.order_key("rule1", "005930", "buy", bar, 0, broker=b, account=a)
            for b, a in (("kiwoom", "실전"), ("kiwoom", "모의국내"), ("korea-invest", "실전"))}
    checks.append({"name": "one rule in three places is three order keys", "want": 3,
                   "got": len(keys), "ok": len(keys) == 3})

    store.insert_order(tconn, {"order_key": store.order_key("rule1", "005930", "buy", bar, 0,
                                                            broker="kiwoom", account="실전"),
                               "cycle_id": bar, "strategy_id": "rule1", "broker": "kiwoom",
                               "account": "실전", "symbol": "005930", "side": "buy",
                               "req_qty": 1, "req_price": 70000, "ord_type": "limit",
                               "mode": "dryrun", "state": "sent", "reason": "test"})
    checks.append({"name": "the account that already traded this window is held",
                   "want": True,
                   "got": store.cycle_already_ran(tconn, "rule1", bar, "kiwoom", "실전"),
                   "ok": store.cycle_already_ran(tconn, "rule1", bar, "kiwoom", "실전") is True})
    checks.append({"name": "the other account is not held by it", "want": False,
                   "got": store.cycle_already_ran(tconn, "rule1", bar, "korea-invest", "실전"),
                   "ok": store.cycle_already_ran(tconn, "rule1", bar, "korea-invest", "실전") is False})
    tconn.close()

    # --- the wiring the owner declares -----------------------------------------------------
    wired = declared_trades({"trades": [
        {"symbol": "005930", "broker": "kiwoom", "account": "실전"},
        {"id": "t2", "symbol": "005930", "broker": "kiwoom", "account": "모의국내"},
        {"symbol": "", "broker": "kiwoom"},          # no symbol — not a trade
        {"symbol": "000660", "account": "실전"},      # no broker — nowhere to send it
    ]})
    checks.append({"name": "a trade needs a symbol and a broker", "want": 2,
                   "got": len(wired), "ok": len(wired) == 2})
    checks.append({"name": "an unnamed trade is identified by where it runs",
                   "want": "kiwoom-실전-005930", "got": wired[0]["id"],
                   "ok": wired[0]["id"] == "kiwoom-실전-005930"})
    checks.append({"name": "a named trade keeps its name", "want": "t2",
                   "got": wired[1]["id"], "ok": wired[1]["id"] == "t2"})

    # --- where symbols come from -----------------------------------------------------------
    ucon = uni.connect()
    frames_in = [{"9001": "005930", "843": "I"}, {"9001": "000660", "843": "I"}]
    r1 = uni.apply_frames(ucon, "t1", frames_in)
    checks.append({"name": "entering the screen adds to the list", "want": ["005930", "000660"],
                   "got": sorted(uni.symbols_of(ucon, "t1")),
                   "ok": sorted(uni.symbols_of(ucon, "t1")) == ["000660", "005930"]})

    # The accident this whole file is shaped around: a stream that says nothing must not be read
    # as a screen that emptied, because an empty list is indistinguishable from "sell everything".
    uni.apply_frames(ucon, "t1", [])
    checks.append({"name": "silence does not empty the list", "want": 2,
                   "got": len(uni.symbols_of(ucon, "t1")),
                   "ok": len(uni.symbols_of(ucon, "t1")) == 2})

    uni.apply_frames(ucon, "t1", [{"9001": "005930", "843": "D"}])
    checks.append({"name": "only a departure frame removes", "want": ["000660"],
                   "got": uni.symbols_of(ucon, "t1"),
                   "ok": uni.symbols_of(ucon, "t1") == ["000660"]})

    # A first subscription reports the set as it stands, with no direction on the frames.
    fresh = uni.apply_frames(ucon, "t2", [{"jmcode": "035420"}])
    checks.append({"name": "a frame with no direction is an entry", "want": ["035420"],
                   "got": uni.symbols_of(ucon, "t2"),
                   "ok": uni.symbols_of(ucon, "t2") == ["035420"]})

    unreadable = uni.apply_frames(ucon, "t2", [{"mystery": 1}, {"9001": "051910", "843": "?"}])
    checks.append({"name": "a frame that cannot be read is reported, not dropped", "want": 2,
                   "got": len(unreadable["unreadableFrames"]),
                   "ok": len(unreadable["unreadableFrames"]) == 2})
    checks.append({"name": "an unreadable frame does not change the list", "want": ["035420"],
                   "got": uni.symbols_of(ucon, "t2"),
                   "ok": uni.symbols_of(ucon, "t2") == ["035420"]})

    # A declared field name wins over the guesses, once a real frame has shown what it is.
    mapped = uni.apply_frames(ucon, "t3", [{"weird_code": "068270", "flag": "I"}],
                              {"symbol": "weird_code", "action": "flag"})
    checks.append({"name": "a declared frame map is used over the candidates", "want": ["068270"],
                   "got": uni.symbols_of(ucon, "t3"),
                   "ok": uni.symbols_of(ucon, "t3") == ["068270"]})

    # --- matching a request to what a person actually created ------------------------------
    uni.request_condition(ucon, "t1", "급등 초입", "거래량 3배 이상 and 5일선 상향돌파")
    uni.request_condition(ucon, "t2", "없는 조건", "아직 안 만든 것")
    matched = uni.match_conditions(ucon, [{"seq": "7", "name": "급등 초입"},
                                          {"seq": "8", "name": "남의 조건"},
                                          {"broken": True}])
    checks.append({"name": "a request binds to the condition of the same name", "want": "7",
                   "got": [b["seq"] for b in matched["bound"]],
                   "ok": [b["seq"] for b in matched["bound"]] == ["7"]})
    checks.append({"name": "a request nobody has created yet is still waiting", "want": 1,
                   "got": matched["awaitingRegistration"],
                   "ok": len(matched["awaitingRegistration"]) == 1})
    checks.append({"name": "an unreadable list row is reported", "want": 1,
                   "got": len(matched["unreadableRows"]),
                   "ok": len(matched["unreadableRows"]) == 1})
    positional = uni.match_conditions(ucon, [["8", "없는 조건"]])
    checks.append({"name": "a positional list row is read too", "want": "8",
                   "got": [b["seq"] for b in positional["bound"]],
                   "ok": [b["seq"] for b in positional["bound"]] == ["8"]})

    # Frames route by the watch they arrived on, so two screens cannot pour into one list.
    uni.bind_watch(ucon, "t1:급등 초입", "ws-kiwoom-condition-aaa")
    checks.append({"name": "a frame is routed by the watch it came in on", "want": "t1",
                   "got": uni.trade_for_watch(ucon, "ws-kiwoom-condition-aaa"),
                   "ok": uni.trade_for_watch(ucon, "ws-kiwoom-condition-aaa") == "t1"})
    checks.append({"name": "an unknown watch routes nowhere rather than to the first trade",
                   "want": None, "got": uni.trade_for_watch(ucon, "ws-someone-else"),
                   "ok": uni.trade_for_watch(ucon, "ws-someone-else") is None})
    ucon.close()

    # --- a screened trade assembles its own symbols ----------------------------------------
    # The codes come out of the broker's frames and into the order path without anyone writing
    # them down. A model that types a symbol is a model that can invent one.
    econ = uni.connect()
    uni.apply_frames(econ, "screened", [{"9001": "005930", "843": "I"},
                                        {"9001": "000660", "843": "I"}])
    econ.close()
    screened_settings = {
        "trades": [{"id": "screened", "conditionName": "급등 초입",
                    "broker": "kiwoom", "account": "모의국내"}],
        "strategies": [{"id": "screened", "enabled": True, "money": {"qty": 1}}],
    }
    # The store still holds strategies from the blocks above; this asserts on this trade only.
    runnable = [x for x in pick_strategies(screened_settings) if x["id"] == "screened"]
    checks.append({"name": "one rule over a screen becomes one run per screened symbol",
                   "want": ["000660", "005930"],
                   "got": sorted(x["symbol"] for x in runnable),
                   "ok": sorted(x["symbol"] for x in runnable) == ["000660", "005930"]})
    checks.append({"name": "a screened trade needs no symbol declared", "want": 1,
                   "got": len(declared_trades(screened_settings)),
                   "ok": len(declared_trades(screened_settings)) == 1})

    # Same rule, same window, two symbols — the guard must not read the first as the whole cycle.
    gconn = store.connect("dryrun")
    win = "bar:2026-08-02T10:00"
    gconn.execute("INSERT INTO orders(order_key,ts_ms,cycle_id,strategy_id,broker,account,symbol,"
                  "side,req_qty,req_price,ord_type,mode,state) VALUES"
                  "('k1',0,?,'screened','kiwoom','모의국내','005930','buy',1,70000,'limit',"
                  "'dryrun','sent')", (win,))
    gconn.commit()
    first = store.cycle_already_ran(gconn, "screened", win, "kiwoom", "모의국내", "005930")
    second = store.cycle_already_ran(gconn, "screened", win, "kiwoom", "모의국내", "000660")
    checks.append({"name": "the symbol already ordered this window is held", "want": True,
                   "got": first, "ok": first is True})
    checks.append({"name": "the next screened symbol is not silenced by it", "want": False,
                   "got": second, "ok": second is False})
    gconn.close()

    # --- a scalping entry must not lock its own exit out -----------------------------------
    # Keying the window on the arrival is what makes draining the screen twice harmless, but the
    # same key would then cover the exit: the position opened in this window could never be closed
    # while the window lasted. The guard applies to opening, never to looking.
    scalp_conn = store.connect("dryrun")
    win = "entry:005930:1700000000000"
    scalp_conn.execute(
        "INSERT INTO orders(order_key,ts_ms,cycle_id,strategy_id,broker,account,symbol,side,"
        "req_qty,req_price,ord_type,mode,state) VALUES"
        "('e1',0,?,'scalp','kiwoom','a','005930','buy',1,70000,'limit','dryrun','filled')", (win,))
    scalp_conn.commit()
    checks.append({"name": "the entry window blocks a second entry", "want": True,
                   "got": store.cycle_already_ran(scalp_conn, "scalp", win, "kiwoom", "a", "005930"),
                   "ok": store.cycle_already_ran(scalp_conn, "scalp", win, "kiwoom", "a",
                                                 "005930") is True})
    # Two exits in one window collapse on the key rather than on the guard — the side is in it.
    buy_key = store.order_key("scalp", "005930", "buy", win, 0, broker="kiwoom", account="a")
    sell_key = store.order_key("scalp", "005930", "sell", win, 0, broker="kiwoom", account="a")
    checks.append({"name": "an exit in the entry's window is a different order", "want": True,
                   "got": buy_key != sell_key, "ok": buy_key != sell_key})
    scalp_conn.close()

    # The arrival is the signal: a screen-driven rule needs no indicator to agree before entering.
    entry_ctx = {"position": {"qty": 0, "avg_price": 0}, "price": 70000, "sides": {"buy"},
                 "signal": {}, "quote": {}, "settings": {}, "mode": "mock",
                 "strategy": {}, "account_exposure": 0.0, "vi_halted": False}
    entered = eng.decide({"id": "scalp", "kind": "rules", "money": {"qty": 1},
                          "trigger": {"type": "screen-entry"}}, entry_ctx)
    checks.append({"name": "arriving on the screen is enough to enter", "want": 1,
                   "got": len(entered), "ok": len(entered) == 1 and entered[0]["side"] == "buy"})
    held_ctx = {**entry_ctx, "position": {"qty": 1, "avg_price": 70000}, "price": 71100,
                "sides": set()}
    exited = eng.decide({"id": "scalp", "kind": "rules", "money": {"qty": 1},
                         "exits": {"takeProfitPct": 1.5},
                         "trigger": {"type": "screen-entry"}}, held_ctx)
    checks.append({"name": "the target closes it without any signal at all", "want": "take",
                   "got": [(x["side"], x.get("reason")) for x in exited],
                   "ok": len(exited) == 1 and exited[0]["reason"] == "take"})

    # --- a costless backtest is not a measurement ------------------------------------------
    # Live on 5-minute BTC bars: the same five trades were 60% winners and +0.11% with no costs,
    # and 0% winners and -0.59% once the exchange's own 0.05% each way was charged. The analyser
    # treats an absent cost as zero, so the gate has to ask.
    ccon = strat.connect()
    free_runs = [{"candidateId": "c1", "args": {"rules": [{"side": "buy", "when": []}]}}]
    free = strat.adopt(ccon, {"winner": good}, free_runs,
                       {"id": "costfree", "symbol": "KRW-BTC", "broker": "upbit", "account": "a"})
    checks.append({"name": "a rule measured without costs is not adopted", "want": None,
                   "got": free.get("adopted"), "ok": free.get("adopted") is None})
    checks.append({"name": "and it is told which costs are missing", "want": True,
                   "got": free.get("why"),
                   "ok": any("slippage" in w for w in (free.get("why") or []))})

    paid_runs = [{"candidateId": "c1", "args": {"rules": [{"side": "buy", "when": []}],
                                                "feeRate": 0.0005, "taxRate": 0.0,
                                                "slippageRate": 0.0002}}]
    paid = strat.adopt(ccon, {"winner": good}, paid_runs,
                       {"id": "costed", "symbol": "KRW-BTC", "broker": "upbit", "account": "a"})
    checks.append({"name": "a venue with no transaction tax still counts as measured",
                   "want": "costed", "got": paid.get("adopted"),
                   "ok": paid.get("adopted") == "costed"})
    checks.append({"name": "the round trip charged is recorded with the rule", "want": 0.14,
                   "got": (paid.get("measured") or {}).get("costs", {}).get("roundTripPct"),
                   "ok": abs(((paid.get("measured") or {}).get("costs", {})
                              .get("roundTripPct") or 0) - 0.14) < 1e-9})
    ccon.close()

    # --- fitting a rule to a symbol rather than to the market ----------------------------
    # The cross-symbol gate above asks "does this work everywhere". This one asks "does this work
    # here", which is the question when a rule is deliberately paired with the coins that suit it.
    # Both refusals it adds over the cross-symbol bar are measured, since a gate is only worth
    # what it turns away.
    fit_ok = {"candidateId": "c1", "holdoutReturnPct": 9.0, "holdoutVsBuyHoldPct": 4.0,
              "holdoutTrades": 20, "neighbours": 4, "neighbourSupport": 0.75}
    checks.append({"name": "a rule that earned out of sample on this symbol is allowed",
                   "want": [], "got": strat.judge_symbol(fit_ok),
                   "ok": strat.judge_symbol(fit_ok) == []})
    for name, patch, expect in [
        # A rising market makes buy & hold the thing to beat; a falling one makes it trivial.
        # Requiring absolute profit is what keeps the bar from moving with the regime.
        ("beating a falling benchmark is not making money",
         {"holdoutReturnPct": -6.0, "holdoutVsBuyHoldPct": 9.0}, "make money"),
        ("making less than simply holding is not a reason to trade",
         {"holdoutVsBuyHoldPct": -3.0}, "against simply holding"),
        ("a handful of round trips is a coin count", {"holdoutTrades": 5}, "coin count"),
        ("a cell with nothing to compare against", {"neighbours": 1}, "cannot be told from noise"),
        ("a winning cell among losing ones is the grid's luckiest cell",
         {"neighbourSupport": 0.25}, "luckiest cell"),
    ]:
        why = strat.judge_symbol({**fit_ok, **patch})
        checks.append({"name": name, "want": expect, "got": why,
                       "ok": any(expect in w for w in why)})

    # Neighbourhood is read off the knobs, not off the candidate's name.
    cands = [{"id": f"f:s{sl}-t{tp}", "family": "f", "knobs": {"sl": sl, "tp": tp}}
             for sl in (1, 2, 3) for tp in (4, 5)]
    fruns, fres = [], []
    # A plateau: every cell with sl>=2 earns. Plus one isolated winner at the far corner.
    for c in cands:
        for window in ("train", "holdout"):
            fruns.append({"candidateId": c["id"], "symbol": "KRW-AAA", "window": window})
            good_cell = c["knobs"]["sl"] >= 2
            ret = 10.0 if good_cell else -5.0
            fres.append({"backtest": {"totalReturnPct": ret, "buyHoldPct": 1.0,
                                      "tradeCount": 30, "maxDrawdownPct": 3.0}})
    fitted = sweep.fit_symbols({"runs": fruns, "results": fres, "candidates": cands})
    chosen = fitted["fits"][0] if fitted["fits"] else {}
    checks.append({"name": "one rule per symbol, taken from the plateau and not from outside it",
                   "want": 1, "got": (len(fitted["fits"]), chosen.get("candidateId")),
                   "ok": len(fitted["fits"]) == 1 and "s1-" not in str(chosen.get("candidateId"))})
    checks.append({"name": "how wide the agreement was travels with the choice", "want": 4,
                   "got": chosen.get("clearedCells"), "ok": chosen.get("clearedCells") == 4})
    # The peak of a plateau is its most fitted point; the choice is the cell its neighbours back.
    checks.append({"name": "the cell its neighbours back is preferred to the highest return",
                   "want": 1.0, "got": chosen.get("neighbourSupport"),
                   "ok": chosen.get("neighbourSupport") == 1.0})
    checks.append({"name": "each fit says which symbol it is for", "want": ["KRW-AAA"],
                   "got": sorted({f["symbol"] for f in fitted["fits"]}),
                   "ok": sorted({f["symbol"] for f in fitted["fits"]}) == ["KRW-AAA"]})
    worst = next(r for r in [fitted["perSymbol"][0]["best"]] if r)
    checks.append({"name": "a symbol's best attempt is reported even when it cleared",
                   "want": True, "got": worst.get("candidateId") is not None,
                   "ok": worst.get("candidateId") is not None})

    # adopt_fits re-judges rather than believing the verdict handed to it.
    fcon = strat.connect()
    fit_runs = [{"candidateId": "c1", "window": "train",
                 "args": {"action": "signals", "rules": [{"side": "buy", "when": []}],
                          "feeRate": 0.0005, "taxRate": 0.0, "slippageRate": 0.0002}}]
    lying = {"symbol": "KRW-AAA", "candidateId": "c1", "holdoutReturnPct": -9.0,
             "holdoutVsBuyHoldPct": -9.0, "holdoutTrades": 2, "neighbours": 4,
             "neighbourSupport": 0.0, "why": []}
    out_fits = strat.adopt_fits(fcon, [lying], fit_runs, {"broker": "upbit", "account": ""})
    checks.append({"name": "a fit that arrives pre-approved is judged anyway", "want": 0,
                   "got": out_fits["adoptedCount"],
                   "ok": out_fits["adoptedCount"] == 0 and bool(out_fits["refused"])})
    honest = {**lying, "holdoutReturnPct": 9.0, "holdoutVsBuyHoldPct": 4.0,
              "holdoutTrades": 20, "neighbourSupport": 0.75}
    out2 = strat.adopt_fits(fcon, [honest], fit_runs, {"broker": "upbit", "account": ""})
    checks.append({"name": "a per-symbol adoption starts on paper like any other",
                   "want": "paper", "got": (out2["adopted"] or [{}])[0].get("stage"),
                   "ok": (out2["adopted"] or [{}])[0].get("stage") == "paper"})
    checks.append({"name": "the strategy is named for the symbol it was fitted to",
                   "want": True,
                   "got": (out2["adopted"] or [{}])[0].get("adopted"),
                   "ok": "KRW-AAA" in str((out2["adopted"] or [{}])[0].get("adopted"))})
    fcon.close()

    # --- the signal arrives inside its envelope -------------------------------------------
    # Every declared pipeline maps `signal: $stepN`, which is what the tool returned rather than
    # what is inside it. Reading only the inner shape meant no rule declared this way ever fired.
    env_sig = {"success": True, "data": {
        "firedOnLastClosedBar": [{"side": "buy", "price": 100.0}],
        "lastClosedBarDate": "2026-08-02 03:00:00"}}
    bare_sig = env_sig["data"]
    for name, sig in (("as the pipeline passes it", env_sig), ("already unwrapped", bare_sig)):
        checks.append({"name": f"the fired side is read {name}", "want": ["buy"],
                       "got": sorted(eng.fired_sides(sig)),
                       "ok": sorted(eng.fired_sides(sig)) == ["buy"]})
        checks.append({"name": f"the price is read {name}", "want": 100.0,
                       "got": eng.signal_price(sig), "ok": eng.signal_price(sig) == 100.0})
        # Falling through to a per-minute key would re-order the same closed bar on every run of
        # a five-minute cron instead of once.
        cid = eng.cycle_id_for({}, sig, 1754100000000)
        checks.append({"name": f"the window is the bar, {name}", "want": "bar:...",
                       "got": cid, "ok": cid == "bar:2026-08-02 03:00:00"})

    # --- a quantity is whatever the venue's increment is -----------------------------------
    # Whole units are a stock assumption. A coin priced above the per-order budget came out at
    # zero, so BTC and ETH could not be bought at all, and the zero was silent.
    coin = {"id": "c", "kind": "rules", "symbol": "KRW-ETH", "broker": "upbit", "account": "",
            "money": {"perOrderKrw": 6000, "lotSize": 0.00000001},
            "limits": {"maxPositionKrw": 10000}, "exits": {}}
    def coin_ctx(**over):
        base = {"position": {"qty": 0, "avg_price": 0, "state": "active"}, "price": 4200000.0,
                "sides": {"buy"}, "signal": {}, "quote": {}, "settings": {}, "strategy": coin,
                "mode": "dryrun", "account_exposure": 0.0, "vi_halted": False}
        base.update(over)
        return base
    got = eng.decide(coin, coin_ctx())
    checks.append({"name": "a coin is bought in fractions of one", "want": 0.00142857,
                   "got": got[0]["qty"] if got else None,
                   "ok": bool(got) and abs(got[0]["qty"] - 0.00142857) < 1e-9})
    allowed, _ = eng.risk_gates(got, coin_ctx())
    checks.append({"name": "the position cap trims to a fraction too, not to zero",
                   "want": 0.00142857, "got": allowed[0]["qty"] if allowed else None,
                   "ok": bool(allowed) and abs(allowed[0]["qty"] - 0.00142857) < 1e-9})
    # Unchanged for shares: no lotSize declared means whole units, as before.
    share = {**coin, "money": {"perOrderKrw": 300000}, "symbol": "005930",
             "limits": {"maxPositionKrw": 1000000}}
    sh = eng.decide(share, coin_ctx(price=70000.0, strategy=share))
    checks.append({"name": "a share is still whole units", "want": 4,
                   "got": sh[0]["qty"] if sh else None,
                   "ok": bool(sh) and sh[0]["qty"] == 4 and isinstance(sh[0]["qty"], int)})
    # And a budget too small to buy one unit says so instead of disappearing.
    poor = {**share, "money": {"perOrderKrw": 6000}}
    pd = eng.decide(poor, coin_ctx(strategy=poor))
    _, why = eng.risk_gates(pd, coin_ctx(strategy=poor))
    checks.append({"name": "a budget below one unit is refused out loud, not silently",
                   "want": "최소 거래단위", "got": (why[0].get("dropReason") if why else None),
                   "ok": bool(why) and "최소 거래단위" in str(why[0].get("dropReason"))})

    # --- a freshly installed module is not an empty shell ----------------------------------
    # Settings only reach the sandbox once someone has pressed save, so before that the module
    # saw nothing and reported "no enabled strategy" while the settings screen displayed an
    # example. The declared defaults are read at runtime from the same config.json the screen
    # renders, so the two cannot drift apart.
    fresh = {"trades": env_json("MODULE_TRADES", [], "trades"),
             "strategies": env_json("MODULE_STRATEGIES", [], "strategies")}
    checks.append({"name": "a module nobody has configured still has a trade and a rule",
                   "want": (1, 1),
                   "got": (len(declared_trades(fresh)), len(pick_strategies(fresh))),
                   "ok": len(declared_trades(fresh)) >= 1 and len(pick_strategies(fresh)) >= 1})
    # And it is inert: the only thing standing between it and a live order is the human switch.
    checks.append({"name": "and it is switched off until a person says otherwise",
                   "want": "trading is switched off",
                   "got": (action_gate({}, load_settings())["data"].get("why") or [None])[0],
                   "ok": "switched off" in str(
                       (action_gate({}, load_settings())["data"].get("why") or [""])[0])})
    checks.append({"name": "the shipped trade and the shipped rule name the same coin",
                   "want": True,
                   "got": (declared_trades(fresh)[0]["symbol"],
                           pick_strategies(fresh)[0].get("symbol")),
                   "ok": declared_trades(fresh)[0]["symbol"]
                         == pick_strategies(fresh)[0].get("symbol")})

    # --- the rule travels with the strategy, not with the schedule --------------------------
    # A rule written into the cron file means the analyser and the sizing can be handed two
    # different rules with nothing to report the mismatch, and changing strategy means editing a
    # schedule. The gate reports the matched strategy's rule; the pipeline passes it through.
    shake_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "shakedown.upbit.json")
    shaken = None
    if os.path.exists(shake_path):
        with open(shake_path, encoding="utf-8") as fh:
            shaken = json.load(fh)
    gate_out = action_gate({}, load_settings())["data"]
    st = gate_out.get("strategy") or {}
    # How many conditions the shipped rule happens to have is a property of that rule, not of the
    # mechanism — asserting the count made a measurement result into a test fixture.
    checks.append({"name": "the gate hands the pipeline the rule to analyse", "want": ">0",
                   "got": len(st.get("rules") or []),
                   "ok": len(st.get("rules") or []) > 0
                         and all(r.get("when") for r in st["rules"])})
    checks.append({"name": "and it is the rule of the strategy that matched",
                   "want": gate_out.get("trade", {}).get("symbol"), "got": st.get("symbol"),
                   "ok": st.get("symbol") == (gate_out.get("trade") or {}).get("symbol")})
    if shaken:
        # The shakedown is a settings edit, not a schedule edit — same pipeline, other rule.
        sset = {"trades": shaken["trades"], "strategies": shaken["strategies"]}
        sg = action_gate({}, {**load_settings(), **sset})["data"]
        checks.append({"name": "another strategy needs no change to the schedule",
                       "want": "KRW-XRP", "got": (sg.get("strategy") or {}).get("symbol"),
                       "ok": (sg.get("strategy") or {}).get("symbol") == "KRW-XRP"})

    # --- several coins in one cycle, each on its own bars and its own rule ------------------
    # A rule is fitted per symbol, so a pipeline that can only carry one makes the fitting
    # pointless. The danger in carrying several is subtler than not carrying them: one shared
    # signal applied to every position would act on one coin's verdict in another coin's market.
    def mrule(tag):
        return [{"side": "buy", "label": tag, "when": [{"a": "ma5", "op": ">", "b": "ma20"}]}]
    mset = {
        "trades": [{"id": "a", "symbol": "AAA", "broker": "b", "account": "", "interval": "1h"},
                   {"id": "z", "symbol": "ZZZ", "broker": "b", "account": "", "interval": "5m"}],
        "strategies": [
            {"id": "a", "enabled": True, "kind": "rules", "symbol": "AAA", "broker": "b",
             "account": "", "money": {"perOrderKrw": 6000}, "limits": {}, "rules": mrule("a")},
            {"id": "z", "enabled": True, "kind": "rules", "symbol": "ZZZ", "broker": "b",
             "account": "", "money": {"perOrderKrw": 6000}, "limits": {}, "rules": mrule("z")}],
        "tradingEnabled": True, "mode": "dryrun"}
    mg = action_gate({}, mset)["data"]
    checks.append({"name": "the gate carries every trade, each with its own timeframe",
                   "want": [("AAA", "1h"), ("ZZZ", "5m")],
                   "got": [(t["symbol"], t["interval"]) for t in mg["trades"]],
                   "ok": [(t["symbol"], t["interval"]) for t in mg["trades"]]
                         == [("AAA", "1h"), ("ZZZ", "5m")]})

    def mcandles(px):
        return {"success": True, "data": {"records": [
            {"date": f"d{i}", "open": px, "high": px, "low": px, "close": px, "volume": 1}
            for i in range(4)]}}
    bound = action_bind_bars({"trades": mg["trades"],
                              "fetched": [mcandles(1000), mcandles(50)]}, mset)["data"]
    checks.append({"name": "each analyser call carries its own bars and its own rule",
                   "want": [1000, 50], "got": [r["lastClose"] for r in bound["runs"]],
                   "ok": [r["lastClose"] for r in bound["runs"]] == [1000, 50]
                         and all(r["args"].get("rules") for r in bound["runs"])})
    checks.append({"name": "a fetch list that does not line up is refused, not zipped short",
                   "want": True,
                   "got": action_bind_bars({"trades": mg["trades"],
                                            "fetched": [mcandles(1)]}, mset).get("success"),
                   "ok": action_bind_bars({"trades": mg["trades"],
                                           "fetched": [mcandles(1)]}, mset).get("success") is False})

    def msig(side, px):
        return {"success": True, "data": {
            "firedOnLastClosedBar": ([{"side": side, "price": px, "date": "d3"}] if side else []),
            "firedOnLastBar": [], "lastClosedBarDate": "d3"}}
    mc = action_cycle({"plan": bound, "signals": [msig("buy", 1000), msig(None, 0)]},
                      mset)["data"]
    checks.append({"name": "only the coin whose rule fired is traded", "want": ["a"],
                   "got": [p["strategyId"] for p in mc["placed"]],
                   "ok": [p["strategyId"] for p in mc["placed"]] == ["a"]})
    checks.append({"name": "and it is priced from its own bars, not the other coin's",
                   "want": 1000.0, "got": (mc["placed"] or [{}])[0].get("price"),
                   "ok": (mc["placed"] or [{}])[0].get("price") == 1000.0})
    mc2 = action_cycle({"plan": bound, "signals": [msig(None, 0), msig("buy", 50)]},
                       mset)["data"]
    checks.append({"name": "the other coin trades on its own signal at its own price",
                   "want": ("z", 50.0),
                   "got": ((mc2["placed"] or [{}])[0].get("strategyId"),
                           (mc2["placed"] or [{}])[0].get("price")),
                   "ok": (mc2["placed"] or [{}])[0].get("strategyId") == "z"
                         and (mc2["placed"] or [{}])[0].get("price") == 50.0})

    # --- what the dispatcher answers and what the schema allows must be the same list -------
    # Validation happens before the sandbox runs, against the declared enum. An action added to
    # the dispatcher but not to the declaration is refused at the door with "not one of […]",
    # which reads as a caller mistake rather than a missing declaration — measured 2026-08-02,
    # a live pipeline died at step 4 on exactly that.
    import re as _re
    _src = open(os.path.abspath(__file__), encoding="utf-8").read()
    _tail = _src[_src.index('if action == "gate"'):] if 'if action == "gate"' in _src else ""
    _dispatched = set(_re.findall(r'action == "([a-z_]+)"', _tail))
    _cfgp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    with open(_cfgp, encoding="utf-8") as _fh:
        _enum = set(json.load(_fh)["input"]["properties"]["action"]["enum"])
    _undeclared = sorted(_dispatched - _enum)
    checks.append({"name": "every action the module answers is declared in its schema",
                   "want": [], "got": _undeclared, "ok": not _undeclared})
    # Same class, other half. `additionalProperties` is false, so an input the module reads but
    # the schema does not list is refused before the sandbox runs — and the message shows the
    # offending value rather than the missing declaration, so it reads as bad data. Measured
    # 2026-08-02: `trades`, `plan` and `signals` were all undeclared and the live pipeline died
    # on them one after another.
    with open(_cfgp, encoding="utf-8") as _fh:
        _declared = set(json.load(_fh)["input"]["properties"])
    _read = set(_re.findall(r'inp\.get\("([a-zA-Z][a-zA-Z0-9_]*)"', _src))
    _missing_in = sorted(_read - _declared)
    checks.append({"name": "every input the module reads is declared in its schema",
                   "want": [], "got": _missing_in, "ok": not _missing_in})

    # --- a limit order that will not fill -------------------------------------------------
    # The ordinary case, not an error: the price is the signal bar's close and the market moved.
    # Left alone it holds the money and blocks the next entry; aged wrongly it degrades a position
    # that is perfectly healthy. Both halves are measured here.
    ucon = store.connect("dryrun")
    ucon.execute("DELETE FROM orders")
    ucon.commit()
    now_ms = store.now_ms()

    def put_order(key, sent_ago_sec, no, filled=0.0):
        store.insert_order(ucon, {
            "order_key": key, "cycle_id": "c", "strategy_id": "u", "broker": "b",
            "account": "", "symbol": "AAA", "side": "buy", "req_qty": 1.0, "req_price": 10.0,
            "ord_type": "limit", "mode": "real", "state": "acked"})
        store.update_order(ucon, key, broker_order_no=no, state="acked",
                           sent_ms=now_ms - int(sent_ago_sec * 1000), filled_qty=filled)

    ustrat = [{"id": "u", "broker": "b", "account": "", "symbol": "AAA", "orders": {}}]
    listed = [{"ord_no": "N1"}, {"ord_no": "N2"}, {"ord_no": "N3"}]
    put_order("old", 900, "N1")           # resting past the window
    put_order("fresh", 60, "N2")          # resting, but not long enough
    put_order("partial", 900, "N3", 0.4)  # part of it filled — leave the rest a chance
    ucalls = []
    gone = _abandon_stale_orders(ucon, {}, ustrat, listed, ucalls)
    checks.append({"name": "a resting order is withdrawn once it has had long enough",
                   "want": ["old"], "got": [g["orderKey"] for g in gone],
                   "ok": [g["orderKey"] for g in gone] == ["old"]})
    checks.append({"name": "and the withdrawal is a broker call, not a local edit",
                   "want": "cancel_order",
                   "got": (ucalls[0]["input"]["action"] if ucalls else None),
                   "ok": bool(ucalls) and ucalls[0]["input"]["action"] == "cancel_order"})
    checks.append({"name": "a partly filled order keeps its chance", "want": True,
                   "got": "partial" not in [g["orderKey"] for g in gone],
                   "ok": "partial" not in [g["orderKey"] for g in gone]})
    # Nothing is re-placed: entering again is the rule's decision, and inventing a replacement
    # would trade on a signal nobody gave.
    checks.append({"name": "withdrawing does not place anything in its stead", "want": 1,
                   "got": len(ucalls), "ok": len(ucalls) == 1})
    zero = _abandon_stale_orders(ucon, {"unfilledAfterSec": 0}, ustrat, listed, [])
    checks.append({"name": "zero means leave them, and is not read as no setting",
                   "want": [], "got": zero, "ok": zero == []})
    # An order the broker still lists is working. Ageing it into `unknown` degraded the position
    # and blocked new entries for a rule doing exactly what it was written to do.
    aged = action_reconcile({"openOrders": listed, "symbol": "AAA"},
                            {"mode": "dryrun", "unknownTimeoutSec": 1})["data"]
    checks.append({"name": "an order the broker still lists is not called unconfirmed",
                   "want": [], "got": aged.get("aged"), "ok": not aged.get("aged")})
    ucon.close()

    # --- a paper fill never lands in the live ledger ---------------------------------------
    # The ledger a row belongs to is decided by the mode it was traded in, not the mode the
    # module is set to. Measured 2026-08-02: the module read `real`, every strategy was demoted
    # to paper because nothing set the unattended flag, and two invented fills sat in live.db
    # while the exchange had no record of an order.
    checks.append({"name": "an interactive call is paper however the module is set", "want":
                   "dryrun",
                   "got": eng.effective_mode({"mode": "real", "realArmed": True}, {}, False, False),
                   "ok": eng.effective_mode({"mode": "real", "realArmed": True}, {}, False,
                                            False) == "dryrun"})
    checks.append({"name": "and unattended with arming is the only way to real", "want": "real",
                   "got": eng.effective_mode({"mode": "real", "realArmed": True}, {}, False, True),
                   "ok": eng.effective_mode({"mode": "real", "realArmed": True}, {}, False,
                                            True) == "real"})
    # The routing itself: a strategy demoted to paper writes to the paper file even when the
    # module is set to real.
    routed = []
    real_settings = {"mode": "real", "realArmed": True, "tradingEnabled": True,
                     "strategies": [{"id": "r", "enabled": True, "kind": "rules", "symbol": "AAA",
                                     "broker": "b", "account": "",
                                     "money": {"perOrderKrw": 6000}, "limits": {}, "rules": []}]}
    rc = action_cycle({"signal": {"firedOnLastClosedBar": [{"side": "buy", "price": 10.0}],
                                  "lastClosedBarDate": "d1"},
                       "symbol": "AAA",
                       "bars": [{"date": "d1", "open": 10, "high": 10, "low": 10, "close": 10,
                                 "volume": 1}]}, real_settings)["data"]
    routed.append(rc.get("mode"))
    paper = store.connect("dryrun")
    live = store.connect("live")
    in_paper = paper.execute("SELECT COUNT(*) c FROM ledger WHERE symbol='AAA'").fetchone()["c"]
    in_live = live.execute("SELECT COUNT(*) c FROM ledger WHERE symbol='AAA'").fetchone()["c"]
    paper.close()
    live.close()
    checks.append({"name": "a demoted strategy's fill goes to the paper ledger, not the live one",
                   "want": (True, 0), "got": (in_paper > 0, in_live),
                   "ok": in_paper > 0 and in_live == 0})

    # --- the slow timeframes ---------------------------------------------------------------
    cplan = action_context_plan({"symbols": ["ZZZ"]}, {"trades": [], "contextIntervals":
                                [{"interval": "1w", "bars": 50}]})["data"]
    checks.append({"name": "the slow fetch asks once per symbol per timeframe", "want": 1,
                   "got": cplan["runCount"], "ok": cplan["runCount"] == 1})
    weeks = [{"date": "2026-0%d-01" % m, "open": 50, "high": 60, "low": 40,
              "close": 50 + m, "volume": 1} for m in range(1, 8)]
    res = [{"success": True, "data": {"records": weeks}}]
    action_store_context({"plan": cplan, "results": res}, {})
    cc = ctxstore.connect()
    held = ctxstore.read(cc, "ZZZ", "1w", drop_last=False)
    shown = ctxstore.read(cc, "ZZZ", "1w")
    checks.append({"name": "the newest higher bar is never handed to a rule",
                   "want": (7, 6), "got": (len(held), len(shown)),
                   "ok": len(held) == 7 and len(shown) == 6})
    # A fetch that comes back empty must not erase what is held — otherwise a rate limit reads as
    # "this symbol has no history" and every rule that uses it silently stops firing.
    action_store_context({"plan": cplan, "results": [{"success": True, "data": {"records": []}}]},
                         {})
    after = ctxstore.read(cc, "ZZZ", "1w", drop_last=False)
    cc.close()
    checks.append({"name": "an empty fetch leaves the history alone", "want": 7,
                   "got": len(after), "ok": len(after) == 7})
    # Only the timeframes a rule actually names travel with the call.
    ctrades = [{"tradeId": "z", "strategyId": "z", "symbol": "ZZZ", "interval": "1h",
                "rules": [{"side": "buy", "when": [{"a": "w.slope3", "op": ">", "b": 0}]}]}]
    cbars = {"success": True, "data": {"records": [
        {"date": "2026-07-%02d" % (i + 1), "open": 100, "high": 101, "low": 99,
         "close": 100 + i, "volume": 1} for i in range(20)]}}
    cb = action_bind_bars({"trades": ctrades, "fetched": [cbars]}, {})["data"]
    carried = sorted((cb["runs"][0]["args"].get("higher") or {}))
    checks.append({"name": "only the timeframes the rule names are carried", "want": ["1w"],
                   "got": carried, "ok": carried == ["1w"]})

    # --- limit or market, decided by why the order exists -----------------------------------
    # Not filling and filling badly are different costs and the reason decides which is worse.
    ot = lambda cfg, reason: _order_type({"orders": cfg}, {"reason": reason, "side": "sell"})
    checks.append({"name": "a stop crosses the spread — one that does not fill is not a stop",
                   "want": "market", "got": ot({"type": "limit"}, "stop"),
                   "ok": ot({"type": "limit"}, "stop") == "market"})
    checks.append({"name": "an entry does not — missing it costs nothing", "want": "limit",
                   "got": ot({"type": "limit"}, "rule"),
                   "ok": ot({"type": "limit"}, "rule") == "limit"})
    checks.append({"name": "and the list is the strategy's to write", "want": ("market", "limit"),
                   "got": (ot({"type": "limit", "marketWhen": ["take"]}, "take"),
                           ot({"type": "limit", "marketWhen": []}, "stop")),
                   "ok": ot({"type": "limit", "marketWhen": ["take"]}, "take") == "market"
                         and ot({"type": "limit", "marketWhen": []}, "stop") == "limit"})
    # A limit priced at the signal bar's close is a limit at a price that has already gone.
    buy = _limit_price({"orders": {"limitOffsetPct": 0.2}}, {"side": "buy"}, 1000.0)
    sell = _limit_price({"orders": {"limitOffsetPct": 0.2}}, {"side": "sell"}, 1000.0)
    checks.append({"name": "the offset reaches across the spread, and the right way per side",
                   "want": (1002.0, 998.0), "got": (buy, sell),
                   "ok": abs(buy - 1002.0) < 1e-9 and abs(sell - 998.0) < 1e-9})
    checks.append({"name": "no offset declared leaves the price alone", "want": 1000.0,
                   "got": _limit_price({"orders": {}}, {"side": "buy"}, 1000.0),
                   "ok": _limit_price({"orders": {}}, {"side": "buy"}, 1000.0) == 1000.0})
    # The broker call carried `int()` — invisible on a share, fatal on a coin.
    bc = orders.broker_call({"side": "buy", "symbol": "KRW-ETH", "req_qty": 0.00142857,
                             "req_price": 4200000, "ord_type": "limit", "order_key": "k",
                             "broker": "upbit", "account": ""}, {})["input"]
    checks.append({"name": "a fractional quantity survives the broker call", "want": 0.00142857,
                   "got": bc["qty"], "ok": abs(bc["qty"] - 0.00142857) < 1e-12})
    bc2 = orders.broker_call({"side": "buy", "symbol": "X", "req_qty": 3, "req_price": 0.5,
                              "ord_type": "limit", "order_key": "k2", "broker": "b",
                              "account": ""}, {})["input"]
    checks.append({"name": "and so does a price below one won", "want": (3, 0.5),
                   "got": (bc2["qty"], bc2["price"]),
                   "ok": bc2["qty"] == 3 and abs(bc2["price"] - 0.5) < 1e-12})

    # --- two strategies on one coin ---------------------------------------------------------
    # A swing rule and a scalping rule hold different positions in the same symbol; the ledger has
    # keyed positions per strategy since it was written. Pairing by trade meant the first match
    # won and the second sat enabled, counted, and never traded.
    two = {"trades": [{"id": "p", "symbol": "PPP", "broker": "b", "account": "",
                       "interval": "1h"}],
           "strategies": [
               {"id": "p-slow", "enabled": True, "kind": "rules", "symbol": "PPP", "broker": "b",
                "account": "", "money": {"perOrderKrw": 6000}, "limits": {},
                "rules": [{"side": "buy", "when": [{"a": "ma5", "op": ">", "b": "ma20"}]}]},
               {"id": "p-fast", "enabled": True, "kind": "rules", "symbol": "PPP", "broker": "b",
                "account": "", "money": {"perOrderKrw": 6000}, "limits": {},
                "rules": [{"side": "buy", "when": [{"a": "rsi", "op": "<", "b": 30}]}]}],
           "tradingEnabled": True, "mode": "dryrun"}
    tg = action_gate({}, two)["data"]
    checks.append({"name": "both rules on one coin reach the pipeline", "want":
                   ["p-fast", "p-slow"],
                   "got": sorted(t["strategyId"] for t in tg["trades"]),
                   "ok": sorted(t["strategyId"] for t in tg["trades"]) == ["p-fast", "p-slow"]})
    checks.append({"name": "and each is addressable on its own", "want": 2,
                   "got": len({t["tradeId"] for t in tg["trades"]}),
                   "ok": len({t["tradeId"] for t in tg["trades"]}) == 2})
    tbars = {"success": True, "data": {"records": [
        {"date": "d%02d" % i, "open": 10, "high": 10, "low": 10, "close": 10, "volume": 1}
        for i in range(5)]}}
    tb = action_bind_bars({"trades": tg["trades"], "fetched": [tbars, tbars]}, two)["data"]
    checks.append({"name": "each gets its own analyser call with its own rule", "want": 2,
                   "got": tb["runCount"],
                   "ok": tb["runCount"] == 2
                         and tb["runs"][0]["args"]["rules"] != tb["runs"][1]["args"]["rules"]})
    def tsig(fire):
        return {"success": True, "data": {
            "firedOnLastClosedBar": ([{"side": "buy", "price": 10.0, "date": "d4"}]
                                     if fire else []),
            "firedOnLastBar": [], "lastClosedBarDate": "d4"}}
    order = [r["strategyId"] for r in tb["runs"]]
    fired = [tsig(sid == "p-fast") for sid in order]
    tc = action_cycle({"plan": tb, "signals": fired}, two)["data"]
    checks.append({"name": "only the rule that fired trades, on the shared coin",
                   "want": ["p-fast"], "got": [x["strategyId"] for x in tc["placed"]],
                   "ok": [x["strategyId"] for x in tc["placed"]] == ["p-fast"]})

    failed = [c for c in checks if not c["ok"]]
    return {"success": not failed,
            "data": {"checks": checks, "passed": len(checks) - len(failed), "failed": len(failed)},
            **({"error": f"{len(failed)} self-test check(s) failed"} if failed else {})}


def main():
    try:
        inp = read_input()
    except ValueError as e:
        return fail(f"입력 JSON 파싱 실패: {e}")
    action = (inp.get("action") or "").strip()
    if not action:
        return fail("action 이 필요합니다.")
    settings = load_settings()

    # One place, so the two sweep planners cannot disagree about what a space is. A pipeline's
    # LLM_TRANSFORM step returns text, so a model-composed search space arrives as a string.
    # A pipeline step cannot read settings, so the declared universe is filled in here — that is
    # what keeps "which stocks, whose account" out of the cron declaration and in the one place
    # the owner controls.
    if action in ("plan_multi", "plan_sweep") and not inp.get("symbols"):
        if settings.get("universe"):
            inp["symbols"] = list(settings["universe"])
        if not inp.get("confirmSymbols") and settings.get("confirmUniverse"):
            inp["confirmSymbols"] = list(settings["confirmUniverse"])
    if action == "adopt":
        # A trade names where it runs; the model supplies the rule that goes in it. Falling back
        # to the first declared trade keeps the pipeline free of placement details.
        target = trade_of(settings, inp.get("strategyId"))
        if target:
            inp.setdefault("strategyId", target.get("id"))
            inp.setdefault("symbol", target.get("symbol"))
            inp.setdefault("broker", target.get("broker"))
            inp.setdefault("account", target.get("account"))
    if "space" in inp:
        try:
            inp["space"] = as_object(inp.get("space"), "space")
        except ValueError as e:
            return fail(str(e))

    try:
        if action == "selftest":
            return out(action_selftest())
        if action == "plan_sweep":
            return out({"success": True, "data": sweep.plan_sweep(inp)})
        if action == "rank_sweep":
            return out({"success": True, "data": sweep.rank_sweep(inp)})
        if action == "merge_sweeps":
            return out({"success": True, "data": sweep.merge_sweeps(inp)})
        if action == "rank_across":
            return out({"success": True, "data": sweep.rank_across(inp)})
        if action == "plan_multi":
            return out({"success": True, "data": sweep.plan_multi(inp)})
        if action == "rank_multi":
            return out({"success": True, "data": sweep.rank_multi(inp)})
        if action == "fit_symbols":
            return out({"success": True, "data": sweep.fit_symbols(inp)})
        if action == "adopt_fits":
            return out(action_adopt_fits(inp, settings))
        if action == "context_plan":
            return out(action_context_plan(inp, settings))
        if action == "store_context":
            return out(action_store_context(inp, settings))
        if action == "context":
            return out(action_context(inp, settings))
        if action == "bind_bars":
            return out(action_bind_bars(inp, settings))
        if action == "cycle":
            return out(action_cycle(inp, settings))
        if action == "adopt":
            return out(action_adopt(inp, settings))
        if action == "next_revision":
            return out(action_next_revision(inp, settings))
        if action == "review":
            return out(action_review(inp, settings))
        if action == "strategies":
            return out(action_strategies(inp, settings))
        if action == "retire":
            return out(action_retire(inp, settings))
        if action == "request_condition":
            return out(action_request_condition(inp, settings))
        if action == "bind_condition":
            return out(action_bind_condition(inp, settings))
        if action == "match_conditions":
            return out(action_match_conditions(inp, settings))
        if action == "universe":
            return out(action_universe(inp, settings))
        if action == "gate":
            return out(action_gate(inp, settings))
        if action == "reconcile":
            return out(action_reconcile(inp, settings))
        if action == "record_orders":
            return out(action_record_orders(inp, settings))
        if action in ("report", "positions", "orders", "ledger"):
            return out(action_read(inp, settings, action))
        if action == "halt":
            return out(action_halt(settings))
        if action == "on_stream_event":
            # Frames are recorded verbatim until the field mapping is measured rather than guessed;
            # the tick trigger itself lands with the stream-sink slice.
            conn = store.connect("dryrun" if settings.get("mode") == "dryrun" else "live")
            frames = inp.get("frames") or []
            store.log_api(conn, "stream", inp.get("watchId") or "", True, 0,
                          {"watchId": inp.get("watchId")}, frames[:20])
            conn.close()
            folded = None
            ucon0 = uni.connect()
            try:
                routed = uni.trade_for_watch(ucon0, str(inp.get("watchId") or ""))
            finally:
                ucon0.close()
            # Only a watch bound to a screening condition folds into a list. The sink tells us the
            # watch and nothing else — not which stream it is — so an unbound watch must mean "not
            # a screen", never "the first trade". Quote frames would otherwise be read as
            # condition frames and pile up as unreadable, once a minute, forever.
            trade = trade_of(settings, routed) if routed else None
            if trade is None and inp.get("tradeId"):
                trade = trade_of(settings, inp.get("tradeId"))
            if trade:
                # Condition frames say which symbols entered and left the screen. Absence never
                # removes: a dropped socket or a broker in maintenance must not empty the list,
                # because an empty list reads as "sell everything".
                ucon = uni.connect()
                try:
                    folded = uni.apply_frames(ucon, trade["id"], frames,
                                              (settings.get("conditionFrameMap") or None))
                finally:
                    ucon.close()
            return out({"success": True, "data": {"recorded": len(frames), "watchlist": folded}})
        if action in ("liquidate_all", "cancel_all", "resolve_unassigned", "import_position"):
            return fail(f"{action} 은 주문 경로가 들어온 뒤 동작합니다(현재 슬라이스는 판단·원장까지).")
        return fail(f"알 수 없는 action: {action}")
    except Exception as e:  # noqa: BLE001 — the sandbox needs one JSON line, never a traceback
        return fail(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
