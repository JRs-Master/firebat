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
import at_orders as orders       # noqa: E402
import at_strategies as strat    # noqa: E402
import at_sweep as sweep         # noqa: E402


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


def env_json(name, default):
    """Settings arrive as `MODULE_<KEY>` env vars — JSON values come through as strings."""
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
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
        "trades": env_json("MODULE_TRADES", []),
        "universe": env_json("MODULE_UNIVERSE", []),
        "confirmUniverse": env_json("MODULE_CONFIRMUNIVERSE", []),
        "strategies": env_json("MODULE_STRATEGIES", []),
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
    picked = []
    for s in declared + adopted:
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
    if not target["symbol"] or not target["broker"] or not target["account"]:
        return {"success": False,
                "error": "adopt 에는 symbol·broker·account 가 필요합니다 — 어느 계좌에서 돌지가 "
                         "규칙의 일부입니다."}
    conn = strat.connect()
    try:
        result = strat.adopt(conn, ranked, runs, target,
                             results=inp.get("results"),
                             min_trades=int(inp.get("minTrades") or strat.MIN_TRADES),
                             min_confirm=int(inp.get("minConfirmSymbols")
                                             or strat.MIN_CONFIRM_SYMBOLS))
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
        target = strat.next_revision(conn, ledger_for)
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
        broker = str(t.get("broker") or "").strip()
        account = str(t.get("account") or "").strip()
        if not symbol or not broker:
            continue
        out.append({"id": str(t.get("id") or f"{broker}-{account}-{symbol}").strip(),
                    "symbol": symbol, "broker": broker, "account": account,
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
    if not strategies and not reasons:
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
        return {"success": False,
                "error": "no price to work from — pass `bars` (or barsCacheKey) and/or `signal`"}

    mode_hint = settings.get("mode", "dryrun")
    conn = store.connect("dryrun" if mode_hint == "dryrun" else "live")
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
    results, all_intents, ctxs = [], [], {}

    for s in strategies:
        broker = s.get("broker") or "unknown"
        account = s.get("account") or ""
        sym = s.get("symbol") or symbol or ""
        cycle_id = eng.cycle_id_for(s, signal, now, inp.get("cycleId"))
        if store.cycle_already_ran(conn, s["id"], cycle_id, broker, account):
            results.append({"strategyId": s["id"], "cycleId": cycle_id, "skipped": "already ran"})
            continue
        pos = store.position_of(conn, s["id"], broker, account, sym)
        account_is_mock = bool(inp.get("mock")) or str(s.get("mode")) == "mock"
        mode = eng.effective_mode(settings, s, account_is_mock, unattended())
        ctx = {
            "position": pos, "price": price, "sides": sides, "signal": signal,
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
                "req_qty": intent["qty"], "req_price": intent.get("price"),
                "ord_type": intent.get("ordType") or (s.get("orders") or {}).get("type") or "limit",
                "mode": ctx["mode"], "state": "intent", "reason": intent.get("reason"),
            }
            if not store.insert_order(conn, order):
                continue
            if ctx["mode"] == "dryrun":
                # Paper fill at the intent price. Optimistic on purpose and labelled as such: a
                # real limit order may not fill at all, which is what the mock account is for.
                store.update_order(conn, key, state="filled", filled_qty=intent["qty"],
                                   filled_avg=intent["price"], sent_ms=store.now_ms())
                store.apply_fill(conn, strategy_id=s["id"], broker=intent["broker"],
                                 account=intent["account"], symbol=intent["symbol"],
                                 side=intent["side"], qty=intent["qty"], price=intent["price"],
                                 source="dryrun", ref_order_key=key,
                                 fee_in_cost=settings.get("feeInCost", True))
            else:
                # The row exists before the call does. A crash between here and the broker leaves
                # something the next cycle can resolve rather than an order nobody remembers.
                store.update_order(conn, key, state="sent", sent_ms=store.now_ms())
                calls.append({**orders.broker_call({**order, "order_key": key}, s),
                              "orderKey": key})
            placed.append({"strategyId": s["id"], "side": intent["side"], "qty": intent["qty"],
                           "price": intent["price"], "mode": ctx["mode"],
                           "reason": intent.get("reason"), "orderKey": key})

    positions = store.read_positions(conn)
    conn.close()
    return {"success": True, "data": {
        "mode": mode_hint, "unattended": unattended(), "tripped": tripped,
        "ran": len(strategies), "price": price, "firedSides": sorted(sides),
        "placed": placed, "dropped": dropped_all, "transfers": transfers,
        "results": results, "positions": positions,
        # Empty in dry run. Otherwise the pipeline runs these with FOREACH and returns what came
        # back to record_orders — the module never calls a broker itself.
        "calls": calls,
        "next": ("FOREACH over `calls` (inputData: \"$prev.input\", tool: sysmod_<$prev.module>), "
                 "then autotrade record_orders with `calls` and the loop's `results`."
                 if calls else None),
    }}


def action_record_orders(inp, settings):
    """Record what the broker said, without letting it decide what happened.

    An acknowledgement moves a row from `sent` to `acked` and may add the broker's order number.
    It never creates a fill: "accepted" and "filled" are different events, and treating one as the
    other books trades that did not happen. A rejection is terminal and says so; anything
    unreadable leaves the row `unknown` for reconciliation to settle rather than guessing.
    """
    calls = inp.get("calls") or []
    results = inp.get("results") or []
    if len(results) != len(calls):
        return {"success": False,
                "error": f"{len(results)} responses for {len(calls)} calls — the order loop did "
                         "not finish; leave the rows alone and run reconcile"}
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
    for o in store.open_orders(conn):
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
    runs = [{"candidateId": "c1", "args": {"action": "signals", "stopLossPct": 3,
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
                    "args": {"rules": [{"side": "buy", "when": [
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
    picked = strat.next_revision(rconn, rledger)
    checks.append({"name": "the least recently revised is picked when all are healthy",
                   "want": "stale", "got": picked["strategyId"],
                   "ok": picked["strategyId"] == "stale"})
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
            return out({"success": True, "data": {"recorded": len(frames)}})
        if action in ("liquidate_all", "cancel_all", "resolve_unassigned", "import_position"):
            return fail(f"{action} 은 주문 경로가 들어온 뒤 동작합니다(현재 슬라이스는 판단·원장까지).")
        return fail(f"알 수 없는 action: {action}")
    except Exception as e:  # noqa: BLE001 — the sandbox needs one JSON line, never a traceback
        return fail(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
