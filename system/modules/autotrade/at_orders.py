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
