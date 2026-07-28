"""Technical analysis — pure computation over an OHLCV array (no network, no keys).

Why a module and not chart code or core: the numbers must come from a TOOL RESULT so the
answer's figures have provenance (a model reading swings off a chart by eye invents them),
and so any price source can feed it. The split is deliberate:

    deterministic here  →  pivots, Elliott hard-rule validation, fibonacci arithmetic
    judgment in the model →  WHICH labeling to adopt, and what it means

The model can therefore never produce a wave count that breaks the rules — it only picks
from candidates this module already validated.
"""
import json
import sys


def _read_input():
    raw = sys.stdin.read()
    return json.loads(raw) if raw.strip() else {}


def _bars(data):
    """Normalize the OHLCV rows. Missing OHLC falls back to close (flat bar) — broker
    payloads vary, and dropping a row would silently shift every pivot index."""
    out = []
    for i, b in enumerate(data or []):
        if not isinstance(b, dict):
            continue
        try:
            close = float(b.get("close"))
        except (TypeError, ValueError):
            continue
        high = b.get("high")
        low = b.get("low")
        out.append({
            "i": i,
            "date": str(b.get("date") or b.get("datetime") or ""),
            "high": float(high) if high is not None else close,
            "low": float(low) if low is not None else close,
            "close": close,
        })
    return out


def zigzag(bars, threshold_pct):
    """Swing pivots by percent reversal (ZigZag).

    Alternating high/low turning points: extend the current leg while price keeps going,
    and commit a pivot once price reverses by `threshold_pct` from the running extreme.
    Deterministic — same bars + same threshold always give the same pivots, which is the
    point (a wave skeleton that changes on every redraw is worthless).
    """
    if len(bars) < 3:
        return []
    thr = max(threshold_pct, 0.01) / 100.0
    pivots = []
    # 첫 레그 방향이 정해질 때까지 고·저 후보를 함께 추적한다.
    hi_i, hi_p = 0, bars[0]["high"]
    lo_i, lo_p = 0, bars[0]["low"]
    direction = 0  # 1 = 상승 레그(고점 갱신 중) / -1 = 하락 레그 / 0 = 미정

    for b in bars[1:]:
        if b["high"] > hi_p:
            hi_i, hi_p = b["i"], b["high"]
        if b["low"] < lo_p:
            lo_i, lo_p = b["i"], b["low"]

        if direction >= 0 and hi_p > 0 and (hi_p - b["low"]) / hi_p >= thr:
            # 고점에서 thr 만큼 되밀림 → 그 고점을 확정하고 하락 레그로 전환
            if direction == 0 or pivots[-1]["kind"] == "low":
                pivots.append({"i": hi_i, "price": hi_p, "kind": "high"})
            elif hi_p > pivots[-1]["price"]:
                pivots[-1] = {"i": hi_i, "price": hi_p, "kind": "high"}
            direction = -1
            lo_i, lo_p = b["i"], b["low"]
        elif direction <= 0 and lo_p > 0 and (b["high"] - lo_p) / lo_p >= thr:
            if direction == 0 or pivots[-1]["kind"] == "high":
                pivots.append({"i": lo_i, "price": lo_p, "kind": "low"})
            elif lo_p < pivots[-1]["price"]:
                pivots[-1] = {"i": lo_i, "price": lo_p, "kind": "low"}
            direction = 1
            hi_i, hi_p = b["i"], b["high"]

    # 마지막 극점은 반전이 아직 안 와서 확정되지 않는다 — 그런데 파동 분석에서 "지금 어디냐"가
    # 바로 그 점이라, 빼면 진행 중인 5파가 통째로 안 보인다(합성 데이터 검증에서 후보 0개).
    # 잠정(tentative)으로 표시해 붙인다 — 다음 봉에서 갱신될 수 있다는 뜻이고, 실제로 커밋된
    # 피벗과 구분되므로 "확정 사실"로 오독되지 않는다.
    last_kind = pivots[-1]["kind"] if pivots else None
    if direction >= 0 and last_kind != "high" and (not pivots or hi_p > pivots[-1]["price"]):
        pivots.append({"i": hi_i, "price": hi_p, "kind": "high", "tentative": True})
    elif direction <= 0 and last_kind != "low" and (not pivots or lo_p < pivots[-1]["price"]):
        pivots.append({"i": lo_i, "price": lo_p, "kind": "low", "tentative": True})

    by_i = {b["i"]: b for b in bars}
    for p in pivots:
        p["date"] = by_i.get(p["i"], {}).get("date", "")
    return pivots


def _impulse_rules(pts):
    """Elliott's three HARD rules over 6 pivots (0-1-2-3-4-5). Objective given a labeling —
    this is exactly the part that must not be left to a language model."""
    if len(pts) != 6:
        return False, ["needs 6 pivots (0..5)"]
    p = [x["price"] for x in pts]
    up = p[1] > p[0]
    sign = 1 if up else -1
    w1, w3, w5 = (p[1] - p[0]) * sign, (p[3] - p[2]) * sign, (p[5] - p[4]) * sign
    fails = []
    if w1 <= 0 or w3 <= 0 or w5 <= 0:
        fails.append("추진파 방향 불일치")
    # 2파는 1파 시작점을 넘어 되돌리지 않는다
    if (p[2] - p[0]) * sign <= 0:
        fails.append("2파가 1파 시작을 넘어 되돌림")
    # 3파는 1·3·5 중 최단이 아니다
    if w3 < w1 and w3 < w5:
        fails.append("3파가 최단")
    # 4파는 1파 영역과 겹치지 않는다
    if (p[4] - p[1]) * sign <= 0:
        fails.append("4파가 1파 영역과 겹침")
    return (not fails), fails


def elliott_candidates(pivots, limit):
    """Every 6-pivot window that survives the hard rules, most-recent first.

    Windows only (no arbitrary subsets): waves are consecutive swings, and enumerating
    subsets would explode combinatorially for no analytic gain.
    """
    out = []
    for start in range(len(pivots) - 5, -1, -1):
        window = pivots[start:start + 6]
        ok, fails = _impulse_rules(window)
        if not ok:
            continue
        labels = ["0", "1", "2", "3", "4", "5"]
        out.append({
            "labels": labels,
            "pivots": [
                {"i": w["i"], "price": w["price"], "label": lb, "date": w.get("date", "")}
                for w, lb in zip(window, labels)
            ],
            "direction": "up" if window[1]["price"] > window[0]["price"] else "down",
            "rulesPassed": True,
            "notes": "하드룰 3개 통과 — 채택 여부는 상위 시간틀·맥락 판단",
        })
        if len(out) >= limit:
            break
    return out


RETRACE = [0.236, 0.382, 0.5, 0.618, 0.786]
EXTEND = [1.0, 1.272, 1.618, 2.618]


def fib_targets(pts):
    """Retracements of the last leg + extensions projected beyond it. Pure arithmetic on
    the pivots the caller picked — the FUTURE side is a projection, not observed data."""
    if len(pts) < 2:
        return []
    a = float(pts[-2]["price"])
    b = float(pts[-1]["price"])
    span = b - a
    if span == 0:
        return []
    out = [
        {"ratio": r, "price": round(b - span * r, 6), "kind": "retracement"}
        for r in RETRACE
    ]
    out += [
        {"ratio": r, "price": round(a + span * r, 6), "kind": "extension"}
        for r in EXTEND
    ]
    return out


def main():
    inp = _read_input()
    action = inp.get("action")
    bars = _bars(inp.get("bars"))
    if not bars:
        print(json.dumps({"success": False, "error": "bars 가 비어 있거나 close 를 읽을 수 없습니다."}, ensure_ascii=False))
        return
    threshold = float(inp.get("threshold") or 5)

    if action == "pivots":
        pv = zigzag(bars, threshold)
        print(json.dumps({"success": True, "data": {"pivots": pv, "count": len(pv), "threshold": threshold}}, ensure_ascii=False))
        return

    if action == "elliott_candidates":
        pv = zigzag(bars, threshold)
        limit = int(inp.get("maxCandidates") or 5)
        cands = elliott_candidates(pv, limit)
        print(json.dumps({
            "success": True,
            "data": {
                "candidates": cands,
                "count": len(cands),
                "pivotCount": len(pv),
                "threshold": threshold,
                "note": (
                    "후보가 0개면 그 임계에서는 룰을 통과하는 추진파가 없다는 뜻입니다 — "
                    "threshold 를 낮춰 더 잔 스윙을 보거나, 조정 국면으로 읽으세요. "
                    "목록에 없는 카운트를 지어내지 마세요."
                ),
            },
        }, ensure_ascii=False))
        return

    if action == "fib_targets":
        idxs = inp.get("pivotIndices") or []
        by_i = {p["i"]: p for p in zigzag(bars, threshold)}
        pts = [by_i[i] for i in idxs if i in by_i]
        if len(pts) < 2:
            # 인덱스를 못 찾으면 봉에서 직접 집는다 — 호출자가 임의 좌표를 줘도 동작.
            pts = [{"i": i, "price": next((b["close"] for b in bars if b["i"] == i), None)} for i in idxs]
            pts = [p for p in pts if p["price"] is not None]
        print(json.dumps({"success": True, "data": {"targets": fib_targets(pts), "basis": pts}}, ensure_ascii=False))
        return

    print(json.dumps({"success": False, "error": f"알 수 없는 action: {action}"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
