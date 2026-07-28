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


def auto_threshold(bars):
    """데이터에 비례하는 기본 임계(%).

    **왜 고정값이면 안 되나**: 임계는 "얼마짜리 반전을 스윙으로 칠 것인가" = 급(degree)인데,
    같은 5% 가 20일 차트에선 큰 파동이고 240일 차트에선 잔물결이다. 고정하면 짧은 차트는
    피벗 0개, 긴 차트는 수십 개가 찍혀 파동이 안 보인다(사용자 지적 2026-07-28).
    전체 변동폭에 비례시키면 **기간이 바뀔 때 급이 따라 바뀌어** 그 차트에서 눈에 보이는
    파동이 자동으로 잡힌다.

    총 고저 폭의 1/8 을 기준으로 삼는다 — 5파 구조가 담기려면 한 다리가 전체의 1/5~1/3 이니
    그보다 확실히 작아야 다리를 안 삼키고, 잔물결은 걸러진다. [1.5%, 25%] 로 클램프.
    """
    if len(bars) < 2:
        return 5.0
    hi = max(b["high"] for b in bars)
    lo = min(b["low"] for b in bars)
    if lo <= 0 or hi <= lo:
        return 5.0
    span_pct = (hi - lo) / lo * 100.0
    return max(1.5, min(25.0, span_pct / 8.0))


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
    """Elliott's hard rules over 3..6 pivots (0-1 … 0-1-2-3-4-5).

    **A rule is applied only once its verdict can no longer change.** A count in progress
    must not be rejected by a rule about waves that have not finished: "wave 3 is not the
    shortest" needs wave 5 to exist, so judging it at wave 3 would kill counts that are
    still growing. Wave-2 retracement and wave-4 overlap, by contrast, are about waves
    already complete — those are final the moment their pivots exist.

    This is what makes "we are currently in wave 3" expressible at all: the old version
    only accepted complete 6-pivot impulses, so the most common real question returned
    nothing (사용자 지적 2026-07-28).
    """
    n = len(pts)
    if n < 3:
        return False, ["needs at least 3 pivots (0,1,2)"]
    p = [x["price"] for x in pts]
    sign = 1 if p[1] > p[0] else -1
    fails = []
    # 방향 — 존재하는 추진 다리는 전부 같은 방향이어야
    for k, idx in enumerate([(0, 1), (2, 3), (4, 5)]):
        a, b = idx
        if b < n and (p[b] - p[a]) * sign <= 0:
            fails.append(f"{2 * k + 1}파 방향 불일치")
    # 2파는 1파 시작점을 넘어 되돌리지 않는다 (2파 존재 시 확정)
    if n >= 3 and (p[2] - p[0]) * sign <= 0:
        fails.append("2파가 1파 시작을 넘어 되돌림")
    # 4파는 1파 영역과 겹치지 않는다 (4파 존재 시 확정)
    if n >= 5 and (p[4] - p[1]) * sign <= 0:
        fails.append("4파가 1파 영역과 겹침")
    # 3파는 최단이 아니다 — **5파가 나와야 판정 가능**. 진행 중엔 적용하지 않는다.
    if n >= 6:
        w1, w3, w5 = (p[1] - p[0]) * sign, (p[3] - p[2]) * sign, (p[5] - p[4]) * sign
        if w3 < w1 and w3 < w5:
            fails.append("3파가 최단")
    return (not fails), fails


def _closeness(actual, ideal, tol):
    """|actual-ideal| 가 tol 이내면 1 → 2·tol 에서 0 으로 선형 감쇠. 0..1."""
    if ideal <= 0 or actual is None:
        return None
    d = abs(actual - ideal)
    if d <= tol:
        return 1.0
    return max(0.0, 1.0 - (d - tol) / tol)


def guideline_fit(pts):
    """엘리엇 **가이드라인** 적합도 — 하드룰과 다르다.

    룰(3개)은 후보를 탈락시키고, 가이드라인은 **전형성을 점수화**한다. 가이드라인을 어겼다고
    틀린 카운트가 아니다(실제 시장에서 흔히 벗어난다) — 다만 전형적인 비율에 가까운 카운트가
    더 그럴듯하므로, 후보 정렬의 근거가 된다. 옛 정렬은 "최신 순"이라 근거가 없었다.

    표준 비율(교과서적):
      2파 되돌림 = 1파의 0.5~0.618 / 3파 = 1파의 1.618 / 4파 되돌림 = 3파의 0.382
      5파 = 1파와 동등(1.0) / 교대 = 2파가 깊으면 4파는 얕게
    """
    p = [x["price"] for x in pts]
    n = len(p)
    sign = 1 if p[1] > p[0] else -1
    scores, detail = [], {}

    w1 = (p[1] - p[0]) * sign
    if n >= 3 and w1 > 0:
        r2 = ((p[1] - p[2]) * sign) / w1
        detail["wave2Retrace"] = round(r2, 3)
        s = _closeness(r2, 0.559, 0.12)  # 0.5~0.618 중앙
        if s is not None:
            scores.append(s)
    if n >= 4 and w1 > 0:
        r3 = ((p[3] - p[2]) * sign) / w1
        detail["wave3ExtOfWave1"] = round(r3, 3)
        s = _closeness(r3, 1.618, 0.6)
        if s is not None:
            scores.append(s)
    if n >= 5:
        w3 = (p[3] - p[2]) * sign
        if w3 > 0:
            r4 = ((p[3] - p[4]) * sign) / w3
            detail["wave4Retrace"] = round(r4, 3)
            s = _closeness(r4, 0.382, 0.15)
            if s is not None:
                scores.append(s)
            # 교대 — 2파와 4파의 되돌림 깊이가 달라야 전형적
            if "wave2Retrace" in detail:
                alt = abs(detail["wave2Retrace"] - r4)
                detail["alternation"] = round(alt, 3)
                scores.append(min(1.0, alt / 0.25))
    if n >= 6 and w1 > 0:
        r5 = ((p[5] - p[4]) * sign) / w1
        detail["wave5OfWave1"] = round(r5, 3)
        s = _closeness(r5, 1.0, 0.4)
        if s is not None:
            scores.append(s)
    fit = round(sum(scores) / len(scores), 3) if scores else None
    return fit, detail


def elliott_candidates(pivots, limit):
    """Counts that survive the applicable hard rules — complete AND in-progress.

    Windows of consecutive pivots only (waves are consecutive swings; enumerating subsets
    would explode combinatorially for no analytic gain). Longer windows first so a complete
    5-wave count outranks a partial one over the same pivots.

    The last pivot may be `tentative` (the running extreme, not yet reversed) — when it is,
    the final labelled wave is *in progress*, which is reported as `inProgress`.
    """
    out = []
    seen = set()
    for size in (6, 5, 4, 3):
        for start in range(len(pivots) - size, -1, -1):
            window = pivots[start:start + size]
            ok, fails = _impulse_rules(window)
            if not ok:
                continue
            key = (window[0]["i"], window[-1]["i"])
            if key in seen:
                continue
            seen.add(key)
            labels = [str(k) for k in range(size)]
            last_tentative = bool(window[-1].get("tentative"))
            fit, fit_detail = guideline_fit(window)
            out.append({
                "guidelineFit": fit,
                "ratios": fit_detail,
                "labels": labels,
                "pivots": [
                    {"i": w["i"], "price": w["price"], "label": lb, "date": w.get("date", ""),
                     "tentative": bool(w.get("tentative"))}
                    for w, lb in zip(window, labels)
                ],
                "direction": "up" if window[1]["price"] > window[0]["price"] else "down",
                "complete": size == 6,
                # 진행 중인 파동 번호 — 마지막 피벗이 잠정이면 그 파동은 아직 안 끝났다.
                "inProgress": labels[-1] if last_tentative else None,
                "rulesPassed": True,
                "notes": (
                    "하드룰 통과(끝난 파동에 대해서만 판정). "
                    + (
                        ("5파 구조 완성 — 다만 5파 꼭짓점이 잠정이라 아직 연장될 수 있음."
                         if last_tentative else "5파 완결 — 조정 국면 가능성.")
                        if size == 6
                        else f"{labels[-1]}파 진행 중으로 읽히는 부분 카운트."
                    )
                ),
            })
            if len(out) >= limit * 3:  # 후보를 넉넉히 모은 뒤 전형성으로 추린다
                break
        if len(out) >= limit * 3:
            break
    # 정렬 근거 = 가이드라인 전형성(없으면 0) → 완결 여부 → 최신. 옛 "최신 순"은 근거가 없었다.
    out.sort(key=lambda c: (c.get("guidelineFit") or 0, c["complete"], c["pivots"][-1]["i"]), reverse=True)
    return out[:limit]


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
    # 임계 미지정 = 데이터에 비례하는 자동값. 기간(20일·120일·240일)이 바뀌면 급도 따라 바뀐다.
    threshold = float(inp["threshold"]) if inp.get("threshold") else auto_threshold(bars)
    # 답이 어느 (기간, 급) 기준인지 응답이 스스로 말해야 한다 — "지금 3파"는 그 쌍이 없으면
    # 의미가 없는 문장이다.
    bar_range = {
        "count": len(bars),
        "from": bars[0].get("date", ""),
        "to": bars[-1].get("date", ""),
    }

    if action == "pivots":
        pv = zigzag(bars, threshold)
        print(json.dumps({"success": True, "data": {
            "pivots": pv, "count": len(pv), "threshold": round(threshold, 2), "barRange": bar_range,
        }}, ensure_ascii=False))
        return

    if action == "elliott_candidates":
        limit = int(inp.get("maxCandidates") or 5)
        # 급(degree) — 엘리엇은 프랙탈이라 임계 하나로는 "지금이 몇 파"가 정해지지 않는다.
        # 5% 로 잡힌 5파 전체가 15% 로 보면 그냥 1파일 수 있다. 같은 계산을 임계별로 돌려
        # 급마다 답을 주면 "잔 급에선 3파 진행, 큰 급에선 그게 1파" 라는 정직한 답이 된다.
        thresholds = inp.get("thresholds")
        if not isinstance(thresholds, list) or not thresholds:
            # 급을 안 고르면 자동값 기준 3단(잔 급 / 기준 / 큰 급)을 함께 본다 — 어느 하나가
            # 정답이 아니라, 급마다 다른 게 정상이라는 걸 응답 자체가 보여주게.
            # 사다리에도 auto_threshold 와 같은 클램프 — 하한 아래로 내려가면 봉마다 피벗이
            # 찍혀 파동이 아니라 노이즈가 된다(20일 차트에서 0.75% → 피벗 20개 실측).
            ladder = [threshold * 0.5, threshold, threshold * 2]
            thresholds = sorted({round(max(1.5, min(25.0, t)), 2) for t in ladder})
        degrees = []
        for t in thresholds:
            try:
                t = float(t)
            except (TypeError, ValueError):
                continue
            pv = zigzag(bars, t)
            degrees.append({
                "threshold": t,
                "pivotCount": len(pv),
                "pivots": pv,
                "candidates": elliott_candidates(pv, limit),
            })
        print(json.dumps({
            "success": True,
            "data": {
                "barRange": bar_range,
                "degrees": degrees,
                "note": (
                    "이 답은 barRange(기간) + threshold(급) 쌍에 대해서만 유효합니다 — "
                    "답변에 반드시 둘 다 밝히세요('240일 일봉, 8% 급 기준 3파'). "
                    "급(threshold)마다 카운트가 다른 것이 정상입니다 — 엘리엇은 프랙탈이라 "
                    "잔 급의 5파 전체가 큰 급의 1파일 수 있습니다. 어느 급으로 말하는지 "
                    "반드시 밝히세요. `complete:false` + `inProgress:'3'` 은 그 파동이 아직 "
                    "진행 중이라는 뜻이고, 마지막 피벗의 `tentative:true` 는 다음 봉에서 "
                    "갱신될 수 있다는 뜻입니다. 후보가 0개면 그 급에서는 룰을 통과하는 "
                    "추진파가 없다는 뜻이니, 조정 국면으로 읽거나 다른 급을 보세요 — "
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
