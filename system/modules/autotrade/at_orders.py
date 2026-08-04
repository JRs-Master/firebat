"""Turning decided orders into broker calls, and reading what comes back without believing it.

The module cannot call a broker — the pipeline does that — so `cycle` writes each order down
first and hands back the calls to make. What returns is recorded but never treated as fact: the
acknowledgement schema is not documented for any of these brokers, and even a correct one only
says the order was accepted, not filled. Only a balance or fill query can say that, which is what
`reconcile` is for.

The write-ahead order matters more than it looks. A row exists before the call goes out, so a
crash between sending and confirming leaves a `sent` row the next cycle can resolve, instead of an
order nobody remembers placing.
"""



def _plain(v):
    """A number the broker will accept, whole or fractional.

    `int()` was here, and on a share it is invisible: one share is one. On a coin it is the order.
    0.00142857 ETH truncates to zero, and so does a limit price of 0.5 won — the sizing was fixed
    for fractions weeks before this call site was, and the dry-run path never reached here to show
    it (2026-08-02, found before the first real order rather than by it).

    Whole numbers stay whole so a broker that puts the quantity in a string sends "3" and not
    "3.0", and a fraction is written out in full rather than as 1e-08, which no exchange parses.
    """
    try:
        f = float(v)
    except (TypeError, ValueError):
        return v
    if f == int(f) and abs(f) < 1e15:
        return int(f)
    return float(("%.10f" % f).rstrip("0"))


def broker_call(order, strategy):
    """One order row → the neutral order contract every broker module accepts."""
    call = {
        "action": "place_order",
        "side": order["side"],
        "symbol": order["symbol"],
        "qty": _plain(order["req_qty"]),
        "orderType": order.get("ord_type") or "limit",
        "clientOrderId": order["order_key"],
    }
    # The price goes out even on a market order. Kiwoom drops it — a market order there carries no
    # unit price and sending one is refused — while Korea Investment's overseas endpoint has no
    # plain market order at all and prices a marketable limit off it. Stating what we know and
    # letting the dialect decide is the only version where a stop is executable at both.
    price = order.get("req_price")
    if price:
        call["price"] = _plain(price)
    exchange = (strategy.get("orders") or {}).get("exchange")
    if exchange:
        call["exchange"] = exchange
    if order.get("account"):
        call["account"] = order["account"]
    # Which market, when the trade said so. A broker fronting both routes on it; one that fronts
    # a single market ignores it.
    if strategy.get("market"):
        call["market"] = strategy["market"]
    # Mock is decided by the account the strategy names, and the framework resolves that — passing
    # it here too would be a second source of truth for the same thing.
    return {"module": order["broker"], "input": call}


def cancel_call(order):
    call = {
        "action": "cancel_order",
        "symbol": order["symbol"],
        "brokerOrderNo": order.get("broker_order_no"),
        "clientOrderId": order["order_key"],
    }
    if order.get("account"):
        call["account"] = order["account"]
    return {"module": order["broker"], "input": call}


def _dig(node, *names):
    """First value found under any of these keys, at any depth.

    Order acknowledgements are not documented, so the field holding the broker's order number is
    not known in advance — kiwoom answers `ord_no`, KIS `ODNO`, toss `orderId`. Searching by name
    reads all three without pretending to know which one arrived; when none matches, the row stays
    without a number and reconciliation matches on symbol, side and time instead.
    """
    if isinstance(node, dict):
        for k, v in node.items():
            if k in names and isinstance(v, (str, int)) and str(v).strip():
                return str(v).strip()
        for v in node.values():
            found = _dig(v, *names)
            if found:
                return found
    elif isinstance(node, list):
        for v in node:
            found = _dig(v, *names)
            if found:
                return found
    return None


def norm_order_no(value):
    """A broker order number in the one form two of its own endpoints can be compared in.

    Korea Investment acknowledges an order as `0000047850` and reports the same order as `47850` when
    asked for it, so a string comparison never matches and every consequence follows: the fill is
    attributed to nothing, and an order sitting in the open list reads as absent and is written down
    as cancelled. Measured 2026-08-05 — AMZN filled 7 @ 278.72 while the ledger said cancelled with
    nothing filled, and two live orders were closed in our books while resting at the venue.

    Digits compare as a number, so the padding stops mattering. Anything else (an upbit uuid, a toss
    id) compares as itself, lower-cased — those are opaque strings and reformatting them would be
    inventing a rule the venue never stated. What is *stored* is untouched: the acknowledgement's own
    text stays verbatim, because it is the only record of what the broker said.
    """
    text = str(value or "").strip()
    if not text:
        return ""
    if text.isdigit():
        return str(int(text))
    return text.lower()


ORDER_NO_KEYS = ("ord_no", "odno", "ODNO", "orderId", "order_id", "orderNo", "brokerOrderNo",
                 "uuid")  # upbit identifies an order by uuid


def read_ack(ack):
    """What an acknowledgement is allowed to tell us: accepted or not, and an order number if any.

    Deliberately not: filled quantity, price, or status. Those come from the broker's own record
    via reconcile — an ack that says "accepted" and a fill are different events, and a module that
    conflates them books trades that never happened.
    """
    if not isinstance(ack, dict):
        return {"accepted": False, "error": "no response", "brokerOrderNo": None}
    payload = ack.get("data") if isinstance(ack.get("data"), dict) else ack
    accepted = ack.get("success")
    if accepted is None:
        accepted = payload.get("success", True)
    error = ack.get("error") or payload.get("error")
    return {
        "accepted": bool(accepted) and not error,
        "error": error,
        "brokerOrderNo": _dig(payload, *ORDER_NO_KEYS),
        "clientOrderId": payload.get("clientOrderId"),
    }


# Execution rows are as undocumented as acknowledgements, and every broker names the same three
# numbers differently. Read by name, keep what could not be read, and never infer a quantity that
# was not stated — a fill invented here becomes a position that does not exist.
FILL_QTY_KEYS = ("cntr_qty", "tot_ccld_qty", "ft_ccld_qty", "ccld_qty", "CCLD_QTY",
                 "filledQuantity", "executedQuantity", "executed_volume", "fill_qty",
                 "volume", "qty")
FILL_PRICE_KEYS = ("cntr_uv", "cntr_pric", "avg_prvs", "ft_ccld_unpr3", "ccld_prvs", "CCLD_PRVS",
                   "avgPrice", "filledPrice", "executedPrice", "price")
EXEC_ID_KEYS = ("cntr_no", "execId", "executionId", "CCLD_NO", "exec_no", "uuid")
# A stated total beats a stated unit price. `price` on an upbit order row is the **limit** the order
# was placed at, and a limit order that fills better than its limit is the normal good case — the
# first real BTC buy was limited at 90,833,000 and filled at 90,743,000, and reading `price` would
# have booked the cost basis 0.1% too high and understated the profit for as long as the position
# lived. The exchange states the truth as a total (`executed_funds`), which divided by the executed
# quantity is the average the account actually paid — it agrees with the balance's avg_buy_price to
# the won. Brokers that state an executed unit price (kiwoom `cntr_uv`) need none of this.
FILL_FUNDS_KEYS = ("executed_funds",)
# What the venue actually charged, when it says so. Booking a live fill with no fee while the
# backtest charges one is the asymmetry that makes a strategy look promotable — the same reason
# `adopt` refuses cost-free measurements. Unknown stays zero rather than estimated from a rate:
# a guessed fee in the ledger is indistinguishable from a charged one.
FILL_FEE_KEYS = ("paid_fee",)
# upbit says `bid`/`ask`; the reader below only needs to find *a* side, not decode it.
SIDE_KEYS = ("sell_tp", "io_tp_nm", "SLL_BUY_DVSN_CD", "side", "trde_tp_nm")


def _num(v):
    try:
        f = float(str(v).replace(",", "").lstrip("+"))
        return abs(f)
    except (TypeError, ValueError):
        return None


def _first(row, names):
    for k in names:
        if k in row and str(row[k]).strip() not in ("", "0"):
            return row[k]
    return None


def read_fills(rows):
    """Broker execution rows → {brokerOrderNo, qty, price, execId, raw}, plus what was unreadable.

    A row missing a quantity or a price is not guessed at: it goes to `unreadable` so the field
    names can be added once a real response shows what they are. Silently skipping it would leave
    the ledger short and the reconciliation would then blame the strategy.
    """
    out, unreadable = [], []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        qty = _num(_first(row, FILL_QTY_KEYS))
        price = _num(_first(row, FILL_PRICE_KEYS))
        funds = _num(_first(row, FILL_FUNDS_KEYS))
        if funds and qty:
            price = funds / qty
        order_no = _dig(row, *ORDER_NO_KEYS)
        if not qty or not price:
            unreadable.append(row)
            continue
        out.append({
            "brokerOrderNo": order_no,
            "qty": qty,
            "price": price,
            "fee": _num(_first(row, FILL_FEE_KEYS)) or 0.0,
            # Without an execution id the same fill cannot be recognised twice, so one is made from
            # what identifies it — reconcile runs every cycle and must not double-book.
            "execId": str(_first(row, EXEC_ID_KEYS) or f"{order_no}:{qty}:{price}"),
            "sideHint": str(_first(row, SIDE_KEYS) or ""),
            "raw": row,
        })
    return out, unreadable


# The balance answers with one row per symbol, and names the two numbers that matter differently
# per broker. Same discipline as the execution rows: read by name, and when the holding for this
# symbol cannot be read, say so instead of reporting zero — "no row" and "zero shares" are opposite
# instructions to a reconciler, and guessing between them either invents a sale or hides one.
POS_SYMBOL_KEYS = ("stk_cd", "pdno", "PDNO", "symbol", "code", "isin", "currency", "market")
POS_QTY_KEYS = ("rmnd_qty", "hldg_qty", "cur_qty", "HLDG_QTY", "quantity", "qty", "balance")
# Shares the account holds that are committed to a resting order. Upbit moves them out of `balance`
# into `locked`, so a holding with an order on it reads short by exactly the order size — measured
# 2026-08-05: 4.47093889 ENSO showed as `balance 1.87093889, locked 2.6` while one sell rested. The
# ledger claims the whole position, so reconciliation would call that a shortfall and stop the
# strategy from buying, for no reason other than that it had an order open. A holding is what the
# account owns, not what is currently free to sell.
POS_LOCKED_KEYS = ("locked", "locked_qty", "ord_psbl_qty_sub")
POS_AVG_KEYS = ("pur_pric", "pchs_avg_pric", "avg_prc", "PCHS_AVG_PRIC", "avgPrice", "avg_price",
                "avg_buy_price", "purchasePrice")


def _symbol_core(text):
    """The instrument's name with our venue notation and punctuation taken off.

    `005930_AL` and `005930_NX` are the same company at two exchanges — the suffix says which book
    a quote came from, and an order or a holding has no such thing. Written without `re` because
    this module deliberately imports nothing.
    """
    s = str(text or "").strip()
    at = s.rfind("_")
    if 0 < at and s[at + 1:].isalpha() and len(s) - at - 1 <= 4:
        s = s[:at]
    return "".join(ch for ch in s if ch.isalnum()).upper()


def _same_symbol(value, symbol):
    """A symbol matches its 6-digit core, whatever the broker hangs off it.

    The same holding comes back as `005930`, `005930_AL`, `A005930` or `AAPL.US` depending on the
    endpoint, and a strict comparison would read every one of those as "no position" — which
    reconciliation would then settle as a sale that never happened. Letters are kept: stripping to
    digits would leave every US ticker empty and make the whole account look sold.
    """
    a, b = _symbol_core(value), _symbol_core(symbol)
    if not a or not b:
        return False
    if a == b:
        return True
    # Decoration hangs off the front or the back, and **either side may be the decorated one** —
    # measured 2026-08-04: our ledger said `114800_AL` while the balance said `A114800`, and the
    # one-sided test read that as a holding that had been sold. It degraded the position and put
    # the same 520 shares in the unassigned bucket at the same time, counting one holding twice
    # under two names. The venue suffix is stripped first because it is our own notation for where
    # the quote came from, not part of the instrument's name.
    if a.startswith(b) or a.endswith(b):
        return True
    # The reverse direction is the new half, so it carries the new caution: a one-character name
    # would otherwise be a prefix of half the market. Real codes are three or more.
    return len(a) >= 3 and (b.startswith(a) or b.endswith(a))


def is_cash_row(row):
    """A balance line that is money rather than a holding.

    Upbit answers `/v1/accounts` with every balance it keeps, and the account's own currency is
    one of them — `{"currency": "KRW", "balance": "33998", "unit_currency": "KRW"}`. Reconciling
    that as an instrument would file 33,998 won as shares nobody claims. A line priced in itself
    is cash: that is what "unit currency" means, and it holds for any venue that says so.
    """
    if not isinstance(row, dict):
        return False
    unit = str(row.get("unit_currency") or row.get("unitCurrency") or "").strip().upper()
    name = str(row.get("currency") or "").strip().upper()
    return bool(unit) and bool(name) and unit == name


def position_symbol(row):
    """The instrument a balance row is about, as the broker wrote it — None if unreadable.

    Reconciliation is driven by what the account holds, so it has to be able to name a holding the
    ledger has never heard of (bought by hand, transferred in). The same key vocabulary the matcher
    uses, read forwards.
    """
    if not isinstance(row, dict):
        return None
    value = _first(row, POS_SYMBOL_KEYS) or row.get("stk_cd")
    text = str(value or "").strip()
    return text or None


def read_position(rows, symbol):
    """Balance rows → ({qty, avgPrice}, matchedRow) for this symbol, or (None, None).

    None means "could not be read" and never zero. A caller that treats it as zero would compare a
    real ledger against an imagined empty account.

    Cash is skipped here and not only where rows are enumerated. `KRW` is a prefix of every KRW
    market, so the cash line matches `KRW-ENSO` under the decorated-name rule, and this returned the
    **first** match — measured 2026-08-04: reconciliation read 27,986 won of cash as 27,986 ENSO and
    filed it as shares nobody claims. BTC had survived the same bug only because its coin row
    happened to come before the cash row. A guard on the listing is not a guard on the matching.

    An exact match wins over a decorated one for the same reason: with several rows able to match,
    "first in the response" is not a rule, it is whatever the venue felt like sending.
    """
    exact, loose = None, None
    for row in rows or []:
        if not isinstance(row, dict) or is_cash_row(row):
            continue
        value = _first(row, POS_SYMBOL_KEYS) or row.get("stk_cd")
        if not _same_symbol(value, symbol):
            continue
        if _symbol_core(value) == _symbol_core(symbol):
            exact = row
            break
        if loose is None:
            loose = row
    row = exact if exact is not None else loose
    if row is None:
        return None, None
    qty = _num(_first(row, POS_QTY_KEYS))
    if qty is None:
        return None, row  # the row is ours but unreadable — report it, do not call it empty
    # `_first` skips a zero, which is right for reading a holding and wrong for adding to one: a
    # position with nothing locked would then fall through to whatever key came next.
    locked = 0.0
    for k in POS_LOCKED_KEYS:
        if k in row:
            locked = _num(row[k]) or 0.0
            break
    return {"qty": qty + locked, "avgPrice": _num(_first(row, POS_AVG_KEYS)) or 0.0,
            "free": qty, "locked": locked}, row
