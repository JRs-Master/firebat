"""Decision layer — from a signal to a set of orders, and the gates every order passes through.

The split against `technical-analysis` is deliberate and one-directional: ta says *what the market
did* (indicators, crossings, fired signals), this file says *what we do about it* (how many shares,
at what price, whether we are allowed to). Nothing here recomputes an indicator, and nothing in ta
knows about money, accounts or limits.

Two invariants hold the whole thing together:

  * **Only a confirmed bar can trigger an order.** ta hands back both `firedOnLastBar` (which can
    still repaint while the bar is open) and `firedOnLastClosedBar`. Trading the open bar means
    acting on a signal that may not exist a minute later, so only the closed one is read here.
  * **Every intent leaves through `risk_gates`.** One choke point, in a fixed order. Gates that
    live next to the code that happens to need them are gates that some later path forgets.
"""
import math

# Modes are ordered, so combining constraints is a minimum rather than a pile of if-statements.
MODE_RANK = {"dryrun": 0, "mock": 1, "real": 2}
MODE_NAME = ["dryrun", "mock", "real"]


def effective_mode(settings, strategy, account_is_mock, unattended):
    """The one place real money becomes reachable.

    Read it as a series of demotions, never promotions: the global setting and the strategy each
    cap the other, an interactive call is always paper (a chat message must not be able to place a
    live order — the scheduled run is the thing that was approved), the kill switch overrides
    everything, live trading needs its own arming toggle, and a mock account stays mock no matter
    what the settings say because its credentials only work on the mock host anyway.
    """
    m = min(MODE_RANK.get(settings.get("mode", "dryrun"), 0),
            MODE_RANK.get(strategy.get("mode", "real"), 2))
    if not unattended:
        m = 0
    if settings.get("killSwitch") or settings.get("_tripped"):
        m = 0
    if m == 2 and not settings.get("realArmed"):
        m = 1
    if m == 2 and account_is_mock:
        m = 1
    return MODE_NAME[m]


def signal_payload(signal):
    """The analyser's result, whether it arrived bare or inside its envelope.

    A pipeline step hands on what the tool returned — `{success, data:{...}}` — and every declared
    pipeline maps `signal: $stepN`, the whole thing. Reading only the bare shape meant the fired
    points were never found, `firedSides` came back empty on every cycle, and no rule declared
    this way could ever have placed an order. The same tolerance `_backtest_of` has in the sweep:
    accept both rather than making the caller reshape it.
    """
    if not isinstance(signal, dict):
        return {}
    if any(k in signal for k in ("firedOnLastClosedBar", "firedOnLastBar", "counts")):
        return signal
    inner = signal.get("data")
    return inner if isinstance(inner, dict) else signal


def cycle_id_for(strategy, signal, now_ms, explicit=None):
    """The idempotency window: one order per strategy per window.

    A bar-close strategy keys on the bar itself, so re-running the cron, restarting mid-cycle or
    firing twice at 09:01 all collapse onto the same key. A tick strategy has no bar to key on, so
    it keys on the debounce window instead.
    """
    if explicit:
        return str(explicit)
    trigger = strategy.get("trigger") or {}
    if trigger.get("type") == "screen-entry" and strategy.get("_enteredMs"):
        # The entry is the event, so it is also the window. Draining the screen twice, restarting
        # mid-drain, or two crons overlapping all collapse onto the same key — the symbol is
        # bought once for the arrival that caused it, not once per drain.
        return f"entry:{strategy.get('symbol')}:{strategy['_enteredMs']}"
    if trigger.get("type") == "tick":
        window = max(1000, int(trigger.get("debounceMs") or 3000))
        return f"tick:{now_ms // window}"
    # Through the envelope, like every other read of the signal. Missing it here did not fail
    # loudly: the key fell through to a per-minute window, so a five-minute cron would re-order
    # the same closed bar on every run instead of once.
    bar = signal_payload(signal).get("lastClosedBarDate")
    if bar:
        return f"bar:{bar}"
    return f"time:{now_ms // 60000}"


def _num(v, default=0.0):
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def fired_sides(signal, use="firedOnLastClosedBar"):
    """Which sides fired on the bar we are allowed to act on."""
    fired = signal_payload(signal).get(use) or []
    sides = set()
    for f in fired:
        declared = (f or {}).get("side")
        if isinstance(declared, str) and declared.lower() in ("buy", "sell"):
            sides.add(declared.lower())
            continue
        # Fallback for responses from before the side travelled with the point. Reading the
        # direction out of prose is not something to rely on — the default labels are 매수/매도,
        # which contain neither word, so a strategy whose analyser predates this simply never
        # traded. Kept only so an old cached response degrades instead of misfiring.
        label = (f or {}).get("label")
        if isinstance(label, str):
            low = label.lower()
            if "buy" in low or "매수" in label:
                sides.add("buy")
            elif "sell" in low or "매도" in label:
                sides.add("sell")
    return sides


def signal_price(signal, use="firedOnLastClosedBar", fallback=0.0):
    fired = signal_payload(signal).get(use) or []
    for f in fired:
        p = _num((f or {}).get("price"), 0.0)
        if p > 0:
            return p
    return fallback


# ── strategies (built-in code; analysis stays in ta) ─────────────────────────────────────────
def floor_to_lot(qty, lot):
    """Round a quantity down to something the venue will accept.

    `lot` is the smallest tradeable increment: 1 for a share, 0.00000001 for a coin. Whole lots
    come back as ints so a broker that puts the quantity in a string sends "3" and not "3.0".
    """
    lot = _num(lot, 1.0)
    if lot <= 0:
        lot = 1.0
    steps = math.floor(_num(qty) / lot + 1e-9)
    if lot >= 1:
        return int(steps * lot)
    # Binary floats cannot hold 0.1 exactly, and a quantity one ulp over what the budget buys is
    # rejected for insufficient funds. Round at the lot's own precision.
    return round(steps * lot, max(0, -int(math.floor(math.log10(lot)))))


# Money is stated in whatever currency the price is quoted in, and the original field names claim
# otherwise. A US share priced at 230 dollars sized against "perOrderKrw: 1000000" comes out at
# four thousand shares — the name is not cosmetic, it is a thirteen-hundred-fold order. The
# currency-neutral names are the ones to use; the old ones keep working so nothing declared
# before this stops sizing.
def money_of(money, *names):
    for n in names:
        if money.get(n) is not None:
            return _num(money.get(n))
    return 0.0


def _size_from_money(money, price):
    """How much to trade for one leg. `qty` wins when declared; otherwise a won budget per order.

    Quantities used to be truncated to whole units, which is right for a share and wrong for
    everything else: at 6,000 won per order a coin priced above that came out at zero, so BTC and
    ETH could never be bought at all. `lotSize` says what the venue's increment is and defaults
    to 1, so stocks behave exactly as before and a coin declares 0.00000001.
    """
    if price <= 0:
        return 0
    lot = money.get("lotSize", 1)
    if money.get("qty"):
        return floor_to_lot(_num(money["qty"]), lot)
    per_order = money_of(money, "perOrder", "perOrderKrw")
    if per_order <= 0:
        budget = money_of(money, "budget", "budgetKrw")
        splits = max(1, int(_num(money.get("splitCount"), 1)))
        per_order = budget / splits
    return floor_to_lot(per_order / price, lot)


DAY_MS = 86400 * 1000


def _rung_due(rung, move_pct, age_days):
    """Is this rung's condition met?

    A rung can name a price move, an elapsed time, or both — and when it names both, both have to
    hold. That is what makes "add on a three percent dip, but not twice in the same week" one
    declaration instead of two mechanisms, and it makes a pure time split (`afterDays` alone) fall
    out of the same shape rather than needing its own.
    """
    want_move = rung.get("move")
    want_days = rung.get("afterDays")
    if want_move is not None and move_pct < want_move - 1e-9:
        return False
    if want_days is not None and (age_days is None or age_days < want_days - 1e-9):
        return False
    return want_move is not None or want_days is not None


def _parse_rungs(spec, move_key, size_key):
    """A ladder of `{<move_key>, afterDays, <size_key>}` rungs → `{move, afterDays, filled}`.

    `filled` is cumulative against the position's full size, so the last rung is 100. Rungs run in
    declared order and each must ask for more than the one before it; anything else is refused
    rather than guessed at, because a ladder that is read differently from how it was written
    trades an amount nobody asked for.
    """
    if not isinstance(spec, list) or not spec:
        return []
    # ATR 단위는 백테스트(ta)엔 있고 여기엔 아직 없다. 조용히 무시하면 **측정과 거래가 갈린다** —
    # 같은 선언이 한쪽에선 변동성 폭으로, 다른 쪽에선 사다리 없음으로 읽힌다. 진입 시점 ATR 을
    # 원장에 기억시키기 전까지는 거부한다.
    atr_key = (move_key[:-3] if move_key.endswith("Pct") else move_key) + "Atr"
    for r in spec:
        if isinstance(r, dict) and r.get(atr_key) is not None:
            raise ValueError(
                f"{atr_key} 는 아직 실거래 엔진이 읽지 못합니다 — 백테스트에만 있습니다. "
                f"{move_key} 로 적어 주세요. (엔진이 진입 시점 ATR 을 원장에 기억하게 된 뒤 열립니다.)")
    rungs, last_filled = [], 0.0
    for r in spec:
        if not isinstance(r, dict):
            return []
        filled = _num(r.get(size_key))
        if not 0 < filled <= 100 or filled <= last_filled:
            return []
        move = r.get(move_key)
        days = r.get("afterDays")
        rung = {"filled": filled / 100.0}
        if move is not None:
            m = _num(move)
            if m <= 0:
                return []
            rung["move"] = m
        if days is not None:
            d = _num(days)
            if d < 0:
                return []
            rung["afterDays"] = d
        if "move" not in rung and "afterDays" not in rung:
            return []          # a rung with no condition would fire immediately, every time
        rungs.append(rung)
        last_filled = filled
    # Ascending moves keep the "highest rung reached" reading honest; a ladder that goes 8% then
    # 3% cannot be climbed in order.
    moves = [r["move"] for r in rungs if "move" in r]
    if any(b <= a for a, b in zip(moves, moves[1:])):
        return []
    return rungs


def refuse_atr_exits(exits):
    """폭을 ATR 로 적은 손절·익절도 같은 이유로 거부. 백테스트만 읽을 수 있는 선언이다."""
    for key in ("stopLossAtr", "takeProfitAtr", "trailingStopAtr"):
        if (exits or {}).get(key) is not None:
            raise ValueError(
                f"{key} 는 아직 실거래 엔진이 읽지 못합니다 — {key.replace('Atr', 'Pct')} 로 적어 주세요.")


def entry_ladder(money):
    """The accumulation ladder — `scaleIn: [{dropPct, afterDays, buyPct}]`.

    `dropPct` is measured from the price the position opened at, not from the moving average: the
    average falls every time you add, so anchoring there makes each rung chase the last one down
    and the ladder never finishes.
    """
    return _parse_rungs((money or {}).get("scaleIn"), "dropPct", "buyPct")


def ladder_step(rungs, move_pct, age_days, done, full):
    """How much of `full` to trade now — one step to the highest rung whose condition is met.

    Rung by rung at the same price would be several orders for one decision, and they would
    collide on the order key besides. The highest reached is the answer.
    """
    target, idx = 0.0, None
    for i, rung in enumerate(rungs):
        if _rung_due(rung, move_pct, age_days) and rung["filled"] > target:
            target, idx = rung["filled"], i
    if idx is None or target <= done + 1e-9:
        return 0.0, None
    return (target - done) * full, idx


def _full_size(money, limits, price):
    """The position this ladder is a fraction of, in shares at `price`.

    A rung says "be two thirds in", and two thirds of *what* has to be declared — `budget` if
    there is one, otherwise the position cap. Neither declared means the ladder cannot size
    itself, and it says nothing rather than inventing a whole.
    """
    full_money = money_of(money, "budget", "budgetKrw") or money_of(
        limits or {}, "maxPosition", "maxPositionKrw")
    if full_money <= 0 or price <= 0:
        return 0.0
    return full_money / price


def _first_rung_size(money, price):
    """The opening purchase when an entry ladder is declared — its first rung, not `perOrder`."""
    rungs = entry_ladder(money)
    full = _full_size(money, None, price)
    if not rungs or full <= 0:
        return 0.0
    return floor_to_lot(rungs[0]["filled"] * full, money.get("lotSize", 1))


def _scale_in_step(strategy, pos, price, anchor, age_days):
    """The next entry rung, if one is due."""
    money = strategy.get("money") or {}
    rungs = entry_ladder(money)
    if not rungs or anchor <= 0 or price <= 0:
        return None
    if _ladder_started(strategy, pos):
        return None
    full = _full_size(money, strategy.get("limits"), anchor)
    if full <= 0:
        return None
    held = _num(pos.get("qty"))
    done = min(1.0, held / full) if full > 0 else 1.0
    # The move is how far below the opening price we are — a rung asking for a three percent dip
    # is asking for this to reach three.
    drop_pct = (anchor - price) / anchor * 100.0
    want, idx = ladder_step(rungs, drop_pct, age_days, done, full)
    qty = floor_to_lot(want, money.get("lotSize", 1))
    if qty <= 0:
        return None
    return {"side": "buy", "qty": qty, "price": price, "reason": "add",
            "seq": 100 + idx, "rung": idx + 1, "rungs": len(rungs), "partial": True}


def _ladder_started(strategy, pos):
    """Has the exit ladder already sold part of this position?

    Derived, like the ladder itself, from how large the position got — there is no flag to keep
    in step with the ledger.
    """
    if not exit_ladder(strategy.get("exits") or {}):
        return False
    held, peak = _num(pos.get("qty")), _num(pos.get("peak_qty"))
    return peak > 0 and held > 0 and held < peak - 1e-9


def exit_ladder(exits):
    """The profit ladder, normalised — a single take-profit target is its one-rung case.

    `sellPct` is cumulative against the size the position reached, so "12% -> 100" reads as "be
    fully out by twelve percent". Same vocabulary the analyser measures with: a ladder that is
    backtested one way and traded another is not the same strategy.

    A declaration that cannot be read yields no ladder rather than a guess — the caller sees the
    position simply not taking profit, which is visible, instead of selling an amount nobody asked
    for.
    """
    spec = (exits or {}).get("scaleOut")
    if not isinstance(spec, list) or not spec:
        take = _num((exits or {}).get("takeProfitPct"))
        return [{"move": take, "filled": 1.0}] if take > 0 else []
    return _parse_rungs(spec, "gainPct", "sellPct")


def ladder_sell_qty(ladder, change_pct, qty_held, peak_qty, lot, age_days=None):
    """How much to sell right now, given how far the ladder has already been climbed."""
    if not ladder or qty_held <= 0 or peak_qty <= 0:
        return 0.0, None
    already = max(0.0, 1.0 - qty_held / peak_qty)
    want, idx = ladder_step(ladder, change_pct, age_days, already, peak_qty)
    if idx is None:
        return 0.0, None
    want = min(want, qty_held)
    # The last rung means "all of it", and a lot-rounded fraction can leave a sliver behind.
    if ladder[idx]["filled"] >= 1.0 - 1e-9:
        return qty_held, idx
    return floor_to_lot(want, lot), idx


def strategy_rules(strategy, ctx):
    """Straight rule following: ta says buy, we buy; ta says sell, we sell what this strategy holds.

    Stops and targets are checked before the rules because a stop that only fires when a rule also
    fires is not a stop.
    """
    pos, price = ctx["position"], ctx["price"]
    money = strategy.get("money") or {}
    exits = strategy.get("exits") or {}
    qty_held = _num(pos.get("qty"))
    avg = _num(pos.get("avg_price"))
    intents = []

    age_days = _num(pos.get("age_days")) or None
    anchor = _num(pos.get("anchor_price")) or avg

    if qty_held > 0 and avg > 0 and price > 0:
        change_pct = (price - avg) / avg * 100.0
        stop = _num(exits.get("stopLossPct"))
        if stop > 0 and change_pct <= -stop:
            # A stop takes all of it. The ladder is for collecting a gain in pieces, not for
            # holding on to part of a loss.
            return [{"side": "sell", "qty": qty_held, "price": price, "reason": "stop"}]
        ladder = exit_ladder(exits)
        part, rung = ladder_sell_qty(ladder, change_pct, qty_held,
                                     _num(pos.get("peak_qty")) or qty_held,
                                     money.get("lotSize", 1), age_days)
        if part > 0:
            whole = part >= qty_held - 1e-12
            # The rung is the order's sequence within the window. Without it the second rung to
            # fire in the same bar collides with the first on the order key and is dropped —
            # safe, but it would look like the ladder simply stopped.
            return [{"side": "sell", "qty": part, "price": price, "reason": "take",
                     "seq": (rung or 0) + 1, "rung": (rung or 0) + 1, "rungs": len(ladder),
                     "partial": not whole}]
        # Adding on the way down, if the strategy declared a ladder for it. This does not wait
        # for the rule to fire again: the rung *is* the trigger, which is the whole point of
        # writing "another third if it drops three percent" instead of hoping the signal repeats.
        # A position already being distributed is excluded above, where the guard lives.
        step = _scale_in_step(strategy, pos, price, anchor, age_days)
        if step:
            return [step]

    sides = ctx["sides"]
    if "sell" in sides and qty_held > 0:
        intents.append({"side": "sell", "qty": qty_held, "price": price, "reason": "rule"})
    elif "buy" in sides and _ladder_started(strategy, pos):
        # Distributing and accumulating at the same time is not a strategy, it is two of them
        # arguing. And it does not merely look odd: the ladder measures its rungs against the
        # size the position reached, so a later buy re-bases it, the first rung reads as unfired,
        # and the same shares are sold again — buy, sell half, buy, sell half, paying costs each
        # way forever. Once the ladder has taken anything, the position only shrinks.
        intents.append({"side": "buy", "qty": 0, "price": price, "reason": "rule",
                        "skip": "분할청산이 이미 시작된 포지션에는 추가 매수하지 않습니다 — "
                                "전량 청산 후 새로 진입합니다."})
    elif "buy" in sides:
        want = _first_rung_size(money, price) if entry_ladder(money) \
            else _size_from_money(money, price)
        lot = money.get("lotSize", 1)
        cap = money_of(strategy.get("limits") or {}, "maxPosition", "maxPositionKrw")
        if cap > 0:
            room = max(0.0, cap - qty_held * price)
            want = min(want, floor_to_lot(room / price, lot) if price > 0 else 0)
        if want > 0:
            intents.append({"side": "buy", "qty": want, "price": price, "reason": "rule"})
        else:
            # A zero that vanishes reads as "the rule did not fire". It did fire; the money did
            # not reach one tradeable unit, which is a settings problem and has to say so.
            intents.append({"side": "buy", "qty": 0, "price": price, "reason": "rule",
                            "skip": ("1회 주문금액이 최소 거래단위 1개 값에 못 미칩니다 — "
                                     f"단가 {price:,.0f} · lotSize "
                                     f"{money.get('lotSize', 1)} · 1회 주문금액 "
                                     f"{money_of(money, 'perOrder', 'perOrderKrw') or money_of(money, 'budget', 'budgetKrw')}"
                                     + (" · 한도(maxPosition)에 이미 닿았을 수도 있습니다"
                                        if cap > 0 else ""))})
    return intents


def strategy_infinite_buy(strategy, ctx):
    """Split buying: add one tranche at a time, exit the whole position at a target.

    The money rule is the strategy here, not the signal — ta only decides whether this cycle is
    allowed to add. That is why it is code rather than a rule string: "how much is left of my
    budget" is not something an indicator expression can express.
    """
    pos, price = ctx["position"], ctx["price"]
    money = strategy.get("money") or {}
    qty_held = _num(pos.get("qty"))
    avg = _num(pos.get("avg_price"))
    budget = money_of(money, "budget", "budgetKrw")
    splits = max(1, int(_num(money.get("splitCount"), 1)))
    per_order = money_of(money, "perOrder", "perOrderKrw") or (budget / splits if budget > 0 else 0.0)
    target_pct = _num((strategy.get("exits") or {}).get("takeProfitPct"), 10.0)

    if qty_held > 0 and avg > 0 and price > 0:
        if (price - avg) / avg * 100.0 >= target_pct:
            return [{"side": "sell", "qty": qty_held, "price": price, "reason": "target"}]

    invested = qty_held * avg
    if budget > 0 and invested >= budget - 1:
        return []
    # `buyWhen: "signal"` waits for ta; anything else adds a tranche every cycle (the classic form).
    if (strategy.get("money") or {}).get("buyWhen") == "signal" and "buy" not in ctx["sides"]:
        return []
    if price <= 0 or per_order <= 0:
        return []
    room = budget - invested if budget > 0 else per_order
    qty = floor_to_lot(min(per_order, room) / price, money.get("lotSize", 1))
    if qty <= 0:
        return []
    return [{"side": "buy", "qty": qty, "price": price, "reason": "split"}]


STRATEGY_KINDS = {
    "rules": strategy_rules,
    "infinite-buy": strategy_infinite_buy,
}


def decide(strategy, ctx):
    kind = strategy.get("kind") or "rules"
    fn = STRATEGY_KINDS.get(kind)
    if fn is None:
        raise ValueError(
            f"unknown strategy kind '{kind}' — declared kinds: {', '.join(sorted(STRATEGY_KINDS))}"
        )
    out = []
    for i, intent in enumerate(fn(strategy, ctx) or []):
        # A zero-quantity intent carrying a reason travels on to the gates, which put it in
        # `dropped` where every other refusal is. Dropping it here made "the money could not buy
        # one unit" indistinguishable from "the rule did not fire" — the exact ambiguity the
        # gates were written to remove.
        if _num(intent.get("qty")) <= 0 and not intent.get("skip"):
            continue
        # The position in the list is a sequence number only when the strategy did not give one.
        # A ladder names its rung, and that is the number the order key has to carry: two rungs
        # reaching their targets in the same bar are two orders, not one placed twice.
        out.append({**intent, "strategyId": strategy["id"], "seq": intent.get("seq", i)})
    return out


# ── internal transfer ───────────────────────────────────────────────────────────────────────
def match_internal_transfers(intents):
    """Offset a sell and a buy that would trade the same shares at the same price.

    Two strategies on one account, one exiting and one entering at the same price on the same bar,
    would send two orders to the market that net to nothing — and pay commission and tax for the
    privilege. Moving the shares in the ledger instead is the same economic position minus the
    friction, which is why the price has to match exactly: at different prices this is a real trade
    with a real gain or loss, and pretending otherwise would fabricate profit.

    Returns `(transfers, remaining_intents)`.
    """
    transfers = []
    sells = [i for i in intents if i["side"] == "sell"]
    buys = [i for i in intents if i["side"] == "buy"]
    for sell in sells:
        for buy in buys:
            if sell["strategyId"] == buy["strategyId"]:
                continue
            if abs(_num(sell.get("price")) - _num(buy.get("price"))) > 1e-9:
                continue
            qty = min(_num(sell["qty"]), _num(buy["qty"]))
            if qty <= 0:
                continue
            transfers.append({
                "from_strategy": sell["strategyId"], "to_strategy": buy["strategyId"],
                "qty": qty, "price": _num(sell["price"]),
            })
            sell["qty"] = _num(sell["qty"]) - qty
            buy["qty"] = _num(buy["qty"]) - qty
    remaining = [i for i in intents if _num(i.get("qty")) > 0]
    return transfers, remaining


# ── risk gates ──────────────────────────────────────────────────────────────────────────────
def market_guard(intent, strategy, ctx):
    """Decide whether a price is safe to trade at, and at what price.

    A market order is a promise to accept whatever the book offers, which on a thin or halted
    symbol is not the price the signal was computed at. So the reference is the confirmed bar, and
    the default response to a gap is to convert to a limit rather than to refuse — refusing on
    every wobble means never trading, while chasing without a limit means buying the spike.
    """
    guard = (strategy.get("orders") or {}).get("marketGuard") or {}
    quote = ctx.get("quote") or {}
    ref = _num(intent.get("price"))
    last = _num(quote.get("last"), ref)
    if ref <= 0:
        return None, "no reference price"
    if ctx.get("vi_halted"):
        return None, "volatility interruption in effect"

    max_dev = _num(guard.get("maxDeviationPct"))
    if max_dev > 0 and last > 0:
        dev = abs(last - ref) / ref * 100.0
        if dev > max_dev:
            if (guard.get("mode") or "convertToLimit") == "reject":
                return None, f"price moved {dev:.2f}% from the signal bar"
            # Convert to a limit at the reference, plus the declared slippage allowance.
            orders = strategy.get("orders") or {}
            ticks = int(_num(orders.get("slippageTicks")))
            tick = _num(orders.get("tickSize"))
            adj = ticks * tick * (1 if intent["side"] == "buy" else -1)
            return {**intent, "price": ref + adj, "ordType": "limit",
                    "reason": (intent.get("reason") or "") + "+guard"}, None

    bid, ask = _num(quote.get("bid")), _num(quote.get("ask"))
    max_spread = _num(guard.get("maxSpreadPct"))
    if max_spread > 0 and bid > 0 and ask > 0:
        mid = (bid + ask) / 2
        if mid > 0 and (ask - bid) / mid * 100.0 > max_spread:
            return None, "spread too wide"
    return intent, None


def risk_gates(intents, ctx):
    """The only path from an intent to an order. Returns `(allowed, dropped)`.

    Dropped intents are returned rather than discarded — a silent drop is indistinguishable from a
    strategy that never fired, which is exactly the ambiguity that makes a quiet failure last for
    weeks.
    """
    settings, strategy = ctx["settings"], ctx["strategy"]
    limits = strategy.get("limits") or {}
    allowed, dropped = [], []

    # An intent the sizing could not fill. It is carried this far rather than discarded upstream
    # so it lands in `dropped` with its reason, next to every other refusal.
    unsized = [i for i in intents if i.get("skip") or _num(i.get("qty")) <= 0]
    if unsized:
        dropped.extend({**i, "dropReason": i.get("skip") or "quantity came out at zero"}
                       for i in unsized)
        intents = [i for i in intents if i not in unsized]
        if not intents:
            return [], dropped

    if settings.get("killSwitch"):
        return [], [{**i, "dropReason": "kill switch is on"} for i in intents]
    if settings.get("_tripped"):
        return [], [{**i, "dropReason": "trading is halted (loss limit or unresolved order)"}
                    for i in intents]
    if (ctx["position"].get("state") or "active") == "degraded":
        # The broker reports fewer shares than we think we own. Selling down is still safe (it is
        # clamped to what is actually held); buying more would compound a discrepancy nobody has
        # explained yet.
        keep = []
        for i in intents:
            if i["side"] == "sell":
                keep.append(i)
            else:
                dropped.append({**i, "dropReason": "position degraded — selling only"})
        intents = keep
    per_cycle = int(_num(settings.get("maxOrdersPerCycle"), 4))

    for intent in intents:
        if len(allowed) >= per_cycle:
            dropped.append({**intent, "dropReason": f"more than {per_cycle} orders this cycle"})
            continue
        qty, price = _num(intent["qty"]), _num(intent.get("price"))
        if intent["side"] == "sell":
            held = _num(ctx["position"].get("qty"))
            if qty > held:
                qty = held
            if qty <= 0:
                dropped.append({**intent, "dropReason": "nothing held to sell"})
                continue
        notional = qty * price
        # Every cap below trims the quantity, and each has to trim to something the venue will
        # accept. Whole units here meant a coin priced above the cap became zero rather than a
        # fraction, which reads as "the cap refused it" when the cap had room.
        lot = (strategy.get("money") or {}).get("lotSize", 1)

        def refuse(reason, cap, room=None):
            """Say the arithmetic, not just the verdict.

            A cap that cannot afford one unit refuses the same order every cycle forever, and
            `{"why": "live order cap reached"}` leaves the reader to go and look up the cap, the
            price and the lot size before they can tell a temporary squeeze from a setting that
            can never work (2026-08-03: seventeen identical refusals over ninety minutes, because
            one share cost more than the whole per-order cap).
            """
            unaffordable = price > 0 and (room if room is not None else cap) < price * lot
            return {
                **intent,
                "dropReason": (f"{reason} — {'a single unit costs more than the limit allows'}"
                               if unaffordable else reason),
                "limit": round(cap, 2),
                "available": round(room, 2) if room is not None else round(cap, 2),
                "unitCost": round(price * lot, 2),
                "lot": lot,
            }

        max_order = _num(limits.get("maxOrderKrw"))
        if max_order > 0 and notional > max_order:
            qty = floor_to_lot(max_order / price, lot) if price > 0 else 0
            if qty <= 0:
                dropped.append(refuse("below the minimum tradable size", max_order))
                continue
            notional = qty * price
        if intent["side"] == "buy":
            cap = money_of(limits, "maxPosition", "maxPositionKrw")
            if cap > 0:
                held_value = _num(ctx["position"].get("qty")) * _num(ctx["position"].get("avg_price"))
                if held_value + notional > cap:
                    room = max(0.0, cap - held_value)
                    qty = floor_to_lot(room / price, lot) if price > 0 else 0
                    if qty <= 0:
                        dropped.append(refuse("position cap reached", cap, room))
                        continue
                    notional = qty * price
            acc_cap = _num(settings.get("accountMaxNotionalKrw"))
            if acc_cap > 0 and notional + _num(ctx.get("account_exposure")) > acc_cap:
                dropped.append(refuse("account exposure cap reached", acc_cap,
                                      max(0.0, acc_cap - _num(ctx.get("account_exposure")))))
                continue
            if ctx["mode"] == "real":
                real_cap = _num(settings.get("realMaxNotionalKrw"))
                if real_cap > 0 and notional > real_cap:
                    qty = floor_to_lot(real_cap / price, lot) if price > 0 else 0
                    if qty <= 0:
                        dropped.append(refuse("live order cap reached", real_cap))
                        continue
        checked, why = market_guard({**intent, "qty": qty}, strategy, ctx)
        if checked is None:
            dropped.append({**intent, "qty": qty, "dropReason": why})
            continue
        allowed.append(checked)
    return allowed, dropped
