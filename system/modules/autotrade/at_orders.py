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


def broker_call(order, strategy):
    """One order row → the neutral order contract every broker module accepts."""
    call = {
        "action": "place_order",
        "side": order["side"],
        "symbol": order["symbol"],
        "qty": int(order["req_qty"]),
        "orderType": order.get("ord_type") or "limit",
        "clientOrderId": order["order_key"],
    }
    price = order.get("req_price")
    if call["orderType"] != "market" and price:
        call["price"] = int(price)
    exchange = (strategy.get("orders") or {}).get("exchange")
    if exchange:
        call["exchange"] = exchange
    if order.get("account"):
        call["account"] = order["account"]
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


ORDER_NO_KEYS = ("ord_no", "odno", "ODNO", "orderId", "order_id", "orderNo", "brokerOrderNo")


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
FILL_QTY_KEYS = ("cntr_qty", "ccld_qty", "CCLD_QTY", "filledQuantity", "executedQuantity",
                 "fill_qty", "qty")
FILL_PRICE_KEYS = ("cntr_uv", "cntr_pric", "ccld_prvs", "CCLD_PRVS", "avgPrice", "filledPrice",
                   "executedPrice", "price")
EXEC_ID_KEYS = ("cntr_no", "execId", "executionId", "CCLD_NO", "exec_no")
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
        order_no = _dig(row, *ORDER_NO_KEYS)
        if not qty or not price:
            unreadable.append(row)
            continue
        out.append({
            "brokerOrderNo": order_no,
            "qty": qty,
            "price": price,
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
POS_SYMBOL_KEYS = ("stk_cd", "pdno", "PDNO", "symbol", "code", "isin")
POS_QTY_KEYS = ("rmnd_qty", "hldg_qty", "cur_qty", "HLDG_QTY", "quantity", "qty", "balance")
POS_AVG_KEYS = ("pur_pric", "pchs_avg_pric", "avg_prc", "PCHS_AVG_PRIC", "avgPrice", "avg_price",
                "purchasePrice")


def _same_symbol(value, symbol):
    """A symbol matches its 6-digit core, whatever the broker hangs off it.

    The same holding comes back as `005930`, `005930_AL`, `A005930` or `AAPL.US` depending on the
    endpoint, and a strict comparison would read every one of those as "no position" — which
    reconciliation would then settle as a sale that never happened. Letters are kept: stripping to
    digits would leave every US ticker empty and make the whole account look sold.
    """
    a = "".join(ch for ch in str(value or "") if ch.isalnum()).upper()
    b = "".join(ch for ch in str(symbol or "") if ch.isalnum()).upper()
    if not a or not b:
        return False
    # The decoration hangs off the front or the back of the code we asked for, never replaces it.
    return a.startswith(b) or a.endswith(b)


def read_position(rows, symbol):
    """Balance rows → ({qty, avgPrice}, matchedRow) for this symbol, or (None, None).

    None means "could not be read" and never zero. A caller that treats it as zero would compare a
    real ledger against an imagined empty account.
    """
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        if not _same_symbol(_first(row, POS_SYMBOL_KEYS) or row.get("stk_cd"), symbol):
            continue
        qty = _num(_first(row, POS_QTY_KEYS))
        if qty is None:
            return None, row  # the row is ours but unreadable — report it, do not call it empty
        return {"qty": qty, "avgPrice": _num(_first(row, POS_AVG_KEYS)) or 0.0}, row
    return None, None
