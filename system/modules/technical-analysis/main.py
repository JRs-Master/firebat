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
    """stdin 프로토콜 = `{correlationId, data:{...}}` 봉투 (sandbox.rs 가 감싸 보낸다).

    처음엔 봉투를 안 벗겨서 `action`·`bars` 가 전부 None 이었고, bars 검사가 먼저라
    "bars 가 비어 있거나…" 만 뱉었다(2026-07-28 실측 — 모델은 올바른 배열을 넘겼는데
    모듈이 못 읽은 것). 직접 stdin 테스트는 봉투 없이 먹여서 통과했기에 더 늦게 잡혔다.
    봉투가 없어도 동작하게 둔다(테스트·수동 호출 편의, 위험 0).
    """
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    payload = json.loads(raw)
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        return payload["data"]
    return payload


_TUPLE_ORDER = ("date", "open", "high", "low", "close", "volume")


def _pick(row, *names):
    """대소문자 무시 키 조회 — yfinance/pandas 계열은 `Close`, 우리 정규화는 `close` 로 온다.
    소스마다 케이스가 갈리는 건 흔한 일이라 받아준다(추측이 아니라 알려진 관례)."""
    lowered = {str(k).lower(): v for k, v in row.items()}
    for n in names:
        v = lowered.get(n.lower())
        if v is not None:
            return v
    return None


def _bars(data):
    """Normalize the OHLCV rows.

    Tolerates the shapes this codebase already emits: dict rows (any key case) and the
    tuple form `[date, open, high, low, close, volume]` that StockChart also accepts.
    Missing OHLC falls back to close (flat bar) — dropping a row would silently shift
    every pivot index.
    """
    out = []
    for i, b in enumerate(data or []):
        if isinstance(b, (list, tuple)):
            b = {k: v for k, v in zip(_TUPLE_ORDER, b)}
        if not isinstance(b, dict):
            continue
        try:
            close = float(_pick(b, "close", "c"))
        except (TypeError, ValueError):
            continue
        high = _pick(b, "high", "h")
        low = _pick(b, "low", "l")
        out.append({
            "i": i,
            "date": str(_pick(b, "date", "datetime", "time") or ""),
            "high": float(high) if high is not None else close,
            "low": float(low) if low is not None else close,
            "close": close,
        })
    return out


def _bars_error(data):
    """빈 결과의 **이유를 말하는** 에러. 옛 메시지("bars 가 비어 있거나 close 를 읽을 수
    없습니다")는 둘 중 무엇인지도, 무엇을 봤는지도 안 알려줘서 호출자가 고칠 수가 없었다
    (2026-07-28 실측: 모델이 올바른 shape 을 만들고도 두 번 실패하고 포기). 각 계단의
    응답이 다음 수를 스스로 말해야 한다."""
    if not isinstance(data, list):
        return f"bars 는 배열이어야 합니다 — 받은 타입: {type(data).__name__}. 시세 도구의 records 배열을 그대로 넣으세요."
    if not data:
        return "bars 가 빈 배열입니다. 캐시를 썼다면 cache_read 로 records 를 먼저 읽어 그 배열을 넣으세요."
    first = data[0]
    if isinstance(first, dict):
        keys = list(first.keys())[:12]
        return (
            f"행에서 종가를 못 찾았습니다. 첫 행 키: {keys} — 'close'(대소문자 무관) 또는 'c' 가 "
            f"필요하고 숫자여야 합니다(null 이면 전 행이 버려집니다). 첫 행 샘플: "
            f"{json.dumps(first, ensure_ascii=False)[:200]}"
        )
    return f"행이 객체도 배열도 아닙니다 — 첫 행 타입: {type(first).__name__}, 값: {str(first)[:120]}"


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


def _confidence(fit, pivot_count):
    """전형성 × 증거량. **정렬의 기준은 fit 단독이면 안 된다.**

    3피벗 조각(0-1-2)은 비율 하나만 맞아도 fit=1.0 이 나오는데, 설명하는 가격 구간이
    거의 없어 정보량이 사실상 0 이다. 그런데 fit 만으로 줄을 세우면 그런 조각이 완결
    5파나 ABC 조정을 밀어낸다(실측: 조정 테스트에서 3피벗 임펄스가 상위 3개 독차지).
    피벗을 많이 설명할수록 값어치가 크므로 증거량으로 가중한다.
    """
    w = max(0.0, min(1.0, (pivot_count - 2) / 4.0))  # 3→0.25, 4→0.5, 5→0.75, 6→1.0
    return round((fit if fit is not None else 0.0) * w, 3)


def _invalidation(pts, structure):
    """이 카운트가 **틀렸다고 판정되는 가격**.

    엘리엇 분석에서 목표가보다 실용적인 출력이다 — "어디까지 가면 내가 틀린 것인가"가
    손절·시나리오 전환의 기준이 된다. 하드룰에서 그대로 나오므로 결정론적이다.

      2파 진행: 1파 시작 이탈 = 2파가 100% 되돌린 것 → 무효
      3파 진행: 2파 저점 이탈 = 추진 구조가 깨짐
      4파 진행: 1파 영역 침범 = 4파-1파 미겹침 룰 위반
      5파 진행/완결: 4파 저점 이탈
      조정: 조정 시작점(0) 이탈 = 그 조정으로 볼 수 없음
    """
    p = [x["price"] for x in pts]
    n = len(p)
    sign = 1 if p[1] > p[0] else -1
    if structure != "impulse":
        return {"price": round(p[0], 6),
                "beyond": "below" if sign > 0 else "above",
                "reason": "조정 시작점 이탈 — 이 조정 구조로 볼 수 없음"}
    table = {
        2: (0, "1파 시작 이탈 — 2파가 1파를 100% 되돌림"),
        3: (2, "2파 저점 이탈 — 추진 구조 붕괴"),
        4: (1, "1파 영역 침범 — 4파는 1파와 겹칠 수 없음"),
        5: (4, "4파 저점 이탈 — 5파 무효"),
    }
    last = n - 1  # 마지막 라벨 번호
    idx, why = table.get(last, table[5])
    return {"price": round(p[idx], 6),
            "beyond": "below" if sign > 0 else "above",
            "reason": why}


def _channel(pts, structure, last_i, project_bars):
    """엘리엇 **채널** — 기준선 + 평행선으로 진행 구간을 가둔다.

    파동 비율이 정해져 있다는 성질의 직접적인 귀결이고, 교과서 작도법 그대로다:
      추진파(0..4 확보) — 2·4 를 잇는 기준선, 3 을 지나는 평행선 → **5파는 대개 평행선에서 끝난다**
      추진파(0..3 확보) — 1·3 기준선, 2 통과 평행선(초기 채널)
      조정파 A-B-C      — A·C 기준선, B 통과 평행선
    꺾은선(파동 골격)만 그리면 "다음이 어디냐"가 안 보이는데, 채널은 **미래 구간까지 연장**되어
    그 교점이 곧 목표가 된다(사용자 지적 2026-07-28: "비율이 정해져 있으니 추세선으로 표시").

    반환 좌표는 stock_chart annotations 규약 그대로 — 시작점은 `i`, 끝점은 `barsAhead`(마지막
    봉 기준)라 미래 여백에 그대로 얹힌다.
    """
    p = [x["price"] for x in pts]
    idx = [x["i"] for x in pts]
    n = len(p)
    if structure == "impulse":
        if n >= 5:
            a, b, thru, label = 2, 4, 3, "2-4 기준선 · 3 통과 평행선 (5파 종착 추정)"
        elif n >= 4:
            a, b, thru, label = 1, 3, 2, "1-3 기준선 · 2 통과 평행선 (초기 채널)"
        else:
            return None
    else:
        if n >= 4:
            a, b, thru, label = 1, 3, 2, "A-C 기준선 · B 통과 평행선"
        else:
            return None
    if idx[b] == idx[a]:
        return None
    slope = (p[b] - p[a]) / (idx[b] - idx[a])
    end_i = last_i + project_bars

    def at(i, ax, ay):
        return ay + slope * (i - ax)

    return {
        "label": label,
        "slopePerBar": round(slope, 6),
        "base": [
            {"i": idx[a], "price": round(p[a], 6)},
            {"barsAhead": project_bars, "price": round(at(end_i, idx[a], p[a]), 6)},
        ],
        "parallel": [
            {"i": idx[thru], "price": round(p[thru], 6)},
            {"barsAhead": project_bars, "price": round(at(end_i, idx[thru], p[thru]), 6)},
        ],
        # 평행선 위 투영값 = 이 채널이 말하는 목표. 미래값이므로 예측이다(관측 아님).
        "projectedTarget": round(at(end_i, idx[thru], p[thru]), 6),
    }


def _median(xs):
    s = sorted(xs)
    return s[len(s) // 2] if s else 0


def _projected_path(pts, structure, last_i, bars=None):
    """**예상 경로** — 진행 중인 파동의 남은 구간 + 그 다음 반등을 비율로 이어 그린다.

    채널(평행선)은 "구간"을 보여주지만 "이 다음에 어디로 가는가"를 한 줄로 말해주진 않는다.
    사용자가 원한 건 후자다 — 지금 E파 진행 중이면 **E 가 어디서 끝나고, 거기서 반등이 어디까지**
    가는지가 현재 위치에서 쭉 이어진 선으로 보여야 한다(2026-07-28).

    각 구간의 목표는 교과서 비율에서 그대로 나온다:
      추진 3파 = 1파의 1.618 / 추진 5파 = 1파와 동등 / 조정 C = A와 동등
      삼각형 E = A-C 추세선 위 / 구조 완료 후 반등 = 전체 되돌림 0.5
    시간축은 엘리엇에서 느슨하므로 **앞선 다리들의 봉 수 중앙값**을 쓴다(추정임을 명시).
    """
    p = [x["price"] for x in pts]
    idx = [x["i"] for x in pts]
    n = len(p)
    if n < 3:
        return None
    sign = 1 if p[1] > p[0] else -1
    leg_bars = [idx[k + 1] - idx[k] for k in range(n - 1)]
    span = max(3, int(_median(leg_bars) or 5))
    elapsed = max(0, last_i - idx[-1])
    remain = max(3, span - elapsed)

    w1 = (p[1] - p[0]) * sign
    cur = p[-1]

    def first_beyond(base, unit, ratios, dirn):
        """현재가를 **이미 지난** 비율은 건너뛴다. 3파가 1.618 을 넘었는데 그 값을 목표로 주면
        선이 뒤로 그어진다(실측: 현재 150.3 인데 목표 142.9). 다음 단계로 올린다."""
        for r in ratios:
            t = base + unit * r * dirn
            if (t - cur) * dirn > 0:
                return t, r
        t = base + unit * ratios[-1] * dirn
        return t, ratios[-1]

    target = None
    label = None
    # 두 번째 구간(반등)은 구조마다 뜻이 다르다 — 뭉뚱그리면 틀린 그림이 된다.
    next_ratio, next_label = 0.5, "이후 반등 목표(전체 0.5 되돌림)"
    if structure == "impulse":
        if n == 6:
            target, r = first_beyond(p[4], w1, [1.0, 1.618, 2.618], sign)
            label = f"5파 목표(1파의 {r})"
            next_ratio, next_label = 0.5, "5파 완결 후 조정(전체 0.5 되돌림)"
        elif n == 5:
            w3 = (p[3] - p[2]) * sign
            target, r = first_beyond(p[3], w3, [0.382, 0.5, 0.618], -sign)
            label = f"4파 목표(3파의 {r} 되돌림)"
            next_ratio, next_label = -1.0, "이후 5파(4파 저점에서 1파 동등)"
        elif n == 4:
            target, r = first_beyond(p[2], w1, [1.618, 2.618, 4.236], sign)
            label = f"3파 목표(1파의 {r})"
            next_ratio, next_label = 0.382, "이후 4파(3파의 0.382 되돌림)"
    elif structure == "triangle":
        if idx[3] != idx[1]:
            slope = (p[3] - p[1]) / (idx[3] - idx[1])
            line = p[1] + slope * (last_i + remain - idx[1])
            e_dir = 1 if p[5] - p[4] > 0 else -1   # E 가 가는 방향
            if (line - cur) * e_dir < 0:
                # E 가 A-C 추세선을 이미 뚫었다 = 수렴 이탈 → **삼각형 무효 신호**.
                # 뒤에 있는 선값을 목표로 주면 화살표가 거꾸로 그어진다(실측: 현재 6205 / 목표 6389).
                target = cur
                label = "A-C 추세선 이탈 — 삼각형 무효 가능(E 가 선을 넘었음)"
            else:
                target = line
                label = "E 목표(A-C 추세선)"
            next_ratio, next_label = None, "삼각형 이탈 목표(A-B 폭만큼 돌파)"
    else:
        if n >= 4:
            wa = (p[1] - p[0]) * sign
            target, r = first_beyond(p[2], wa, [1.0, 1.618], sign)
            label = f"C 목표(A의 {r})"
            next_ratio, next_label = 0.5, "조정 완료 후 반등(조정 전체의 0.5)"
    if target is None:
        return None

    points = [
        {"i": idx[-1], "price": round(p[-1], 6), "label": None},
        {"barsAhead": remain, "price": round(target, 6), "label": label},
    ]
    if structure == "triangle":
        # 삼각형 이탈(thrust)은 **삼각형에 들어오기 전 추세**를 잇는다 — 삼각형 자체는 횡보라
        # 자기 다리 방향으로는 알 수 없다. 앞선 봉들의 흐름을 보고, 없으면 삼각형 순변화로 대체.
        # 옛 식은 A 다리 방향을 뒤집어 써서 하락 뒤 삼각형인데 위로 돌파를 그렸다(실측 7,364).
        trend = 1 if p[-1] > p[0] else -1
        if bars:
            back = max(0, idx[0] - span)
            prev_close = next((b["close"] for b in bars if b["i"] == back), None)
            start_close = next((b["close"] for b in bars if b["i"] == idx[0]), None)
            if prev_close is not None and start_close is not None and prev_close != start_close:
                trend = 1 if start_close > prev_close else -1
        width = abs(p[2] - p[1])  # A-B 폭 = 가장 넓은 구간
        second = target + width * trend
    elif next_ratio is None:
        second = target
    elif next_ratio < 0:
        second = target + w1 * sign  # 4파 뒤 5파 = 1파 동등
    else:
        second = target - (target - p[0]) * next_ratio
    points.append({
        "barsAhead": remain + span,
        "price": round(second, 6),
        "label": next_label,
    })
    return {
        "points": points,
        "barsEstimated": True,
        "note": (
            "가격 목표는 교과서 비율에서 나온 값이고 **시간축은 앞선 다리들의 봉 수 중앙값 추정**"
            "이다(엘리엇은 시간 비율을 규정하지 않는다). 예측이므로 차트엔 projected:true 로."
        ),
    }


def _corrective(pts):
    """조정 구조 판별 — A-B-C(지그재그/플랫) 또는 A-B-C-D-E(삼각수렴).

    조정은 추진파보다 룰이 훨씬 느슨하다. 확정적으로 쓸 수 있는 건 **방향 정합**(A·C 는 같은
    방향, B 는 반대)과 **B 되돌림 상한**뿐이고, 나머지는 유형 분류와 전형성 점수의 몫이다.

    유형은 B 가 A 를 얼마나 되돌렸는지로 갈린다 — 교과서 구분 그대로:
        < 0.9      지그재그(sharp, 5-3-5)
        0.9~1.05   플랫(3-3-5)
        1.05~1.38  확장 플랫(expanded flat)
        > 1.38     조정으로 보기 어려움 → 탈락
    C 가 A 끝을 못 넘으면 running 변형으로 표시한다.
    """
    n = len(pts)
    p = [x["price"] for x in pts]
    if n < 4:
        return None
    sign = 1 if p[1] > p[0] else -1  # A 다리 방향
    wa = abs(p[1] - p[0])
    if wa <= 0:
        return None

    # 삼각수렴 — 5개 다리가 번갈아 가며 점점 좁아진다.
    if n >= 6:
        legs = [(p[k + 1] - p[k]) for k in range(5)]
        if all(legs[k] * legs[k + 1] < 0 for k in range(4)):
            mags = [abs(x) for x in legs]
            contracting = all(mags[k + 2] < mags[k] for k in range(3))
            if contracting:
                return {
                    "structure": "triangle",
                    "labels": ["0", "A", "B", "C", "D", "E"],
                    "ratios": {"legs": [round(m / wa, 3) for m in mags]},
                    "fit": 1.0,
                    "notes": "수렴 삼각형 — 보통 마지막 조정 국면(이후 추진 재개)",
                }

    # A-B-C
    if (p[2] - p[1]) * sign >= 0:
        return None  # B 가 A 를 되돌리지 않음
    if (p[3] - p[2]) * sign <= 0:
        return None  # C 가 A 와 다른 방향
    rb = abs(p[2] - p[1]) / wa
    if rb > 1.38:
        return None
    wc = abs(p[3] - p[2])
    rc = wc / wa
    if rb < 0.9:
        kind, ideal_b, ideal_c = "zigzag", 0.559, 1.0
    elif rb <= 1.05:
        kind, ideal_b, ideal_c = "flat", 1.0, 1.0
    else:
        kind, ideal_b, ideal_c = "expanded-flat", 1.236, 1.618
    running = (p[3] - p[1]) * sign < 0  # C 가 A 끝을 못 넘음
    scores = [s for s in (_closeness(rb, ideal_b, 0.15), _closeness(rc, ideal_c, 0.4)) if s is not None]
    return {
        "structure": kind + ("-running" if running else ""),
        "labels": ["0", "A", "B", "C"],
        "ratios": {"waveBRetrace": round(rb, 3), "waveCOfWaveA": round(rc, 3)},
        "fit": round(sum(scores) / len(scores), 3) if scores else None,
        "notes": (
            {"zigzag": "지그재그 — 날카로운 조정",
             "flat": "플랫 — 횡보형 조정",
             "expanded-flat": "확장 플랫 — B 가 A 시작을 넘어선 조정"}[kind]
            + (" (running: C 가 A 끝에 못 미침 — 추세 방향 압력이 강함)" if running else "")
        ),
    }


def corrective_candidates(pivots, limit, last_i=0, project_bars=0, bars_ref=None):
    """조정 구조 후보 — 진행 중(부분)도 포함.

    5파가 끝나면 다음은 조정이라, 추진파만 세면 그 구간 전체가 "후보 0"이 된다(사용자 지적
    2026-07-28). 창은 삼각형(6) → ABC(4) 순으로 보고, 마지막 피벗이 잠정이면 그 파동이 진행 중.
    """
    out, seen = [], set()
    for size in (6, 4):
        for start in range(len(pivots) - size, -1, -1):
            window = pivots[start:start + size]
            info = _corrective(window)
            if not info:
                continue
            labels = info["labels"]
            # 6피벗 창이 삼각형이 아니면 앞 4개만 써서 ABC 로 분류된다 — 그때 증거량을 창 크기(6)로
            # 세면 신뢰도가 부풀어 완결 구조를 밀어낸다. **실제로 쓴 피벗 수**로 센다.
            used = window[:len(labels)]
            key = (used[0]["i"], used[-1]["i"])
            if key in seen:
                continue
            seen.add(key)
            last_tentative = bool(used[-1].get("tentative"))
            out.append({
                "structure": info["structure"],
                "guidelineFit": info["fit"],
                "confidence": _confidence(info["fit"], len(used)),
                "evidencePivots": len(used),
                "invalidation": _invalidation(used, info["structure"]),
                "channel": _channel(used, info["structure"], last_i, project_bars),
                "projectedPath": _projected_path(used, info["structure"].split("-")[0], last_i, bars_ref),
                "ratios": info["ratios"],
                "labels": labels,
                "pivots": [
                    {"i": w["i"], "price": w["price"], "label": lb, "date": w.get("date", ""),
                     "tentative": bool(w.get("tentative"))}
                    for w, lb in zip(used, labels)
                ],
                "direction": "up" if used[1]["price"] > used[0]["price"] else "down",
                "complete": not last_tentative,
                "inProgress": labels[-1] if last_tentative else None,
                "rulesPassed": True,
                "notes": info["notes"],
            })
    out.sort(key=lambda c: (c["confidence"], c["pivots"][-1]["i"]), reverse=True)
    return out[:limit]


def elliott_candidates(pivots, limit, last_i=0, project_bars=0, bars_ref=None):
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
                "structure": "impulse",
                "guidelineFit": fit,
                "confidence": _confidence(fit, size),
                "evidencePivots": size,
                "invalidation": _invalidation(window, "impulse"),
                "channel": _channel(window, "impulse", last_i, project_bars),
                "projectedPath": _projected_path(window, "impulse", last_i, bars_ref),
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
    out.sort(key=lambda c: (c["confidence"], c["complete"], c["pivots"][-1]["i"]), reverse=True)
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
        print(json.dumps({"success": False, "error": _bars_error(inp.get("bars"))}, ensure_ascii=False))
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
        last_i = bars[-1]["i"]
        # 투영 길이 = 기간의 20%(5~60봉). 차트 futureSlots 와 맞춰 쓰면 채널이 여백을 정확히 채운다.
        project_bars = int(inp.get("projectBars") or max(5, min(60, round(len(bars) * 0.2))))
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
            imp = elliott_candidates(pv, limit, last_i, project_bars, bars)
            cor = corrective_candidates(pv, limit, last_i, project_bars, bars)
            # 조정이 어느 추진파 뒤에 붙는지 — 5파 끝 피벗 == 조정 시작 피벗이면 이어진다.
            # "5파 완결 후 ABC 조정 중"이 한 번에 읽히게(분석의 실제 값어치가 여기 있다).
            imp_ends = {c["pivots"][-1]["i"]: c["labels"][-1] for c in imp}
            for c in cor:
                prev = imp_ends.get(c["pivots"][0]["i"])
                if prev:
                    c["followsImpulseEndingAt"] = c["pivots"][0]["i"]
                    c["notes"] += f" · 직전 추진파 {prev}파 종료점에서 이어짐"
            degrees.append({
                "threshold": t,
                "pivotCount": len(pv),
                "pivots": pv,
                "candidates": sorted(imp + cor, key=lambda c: c["confidence"], reverse=True)[:limit],
            })
        print(json.dumps({
            "success": True,
            "data": {
                "barRange": bar_range,
                "projectBars": project_bars,
                "degrees": degrees,
                "note": (
                    "각 후보의 **`projectedPath`** 는 현재 위치에서 이어지는 예상 경로다(진행 중 파동의 남은 "
                    "구간 → 그 다음 반등). **차트에 kind:\"path\", projected:true 로 그대로 넣으세요** — 사용자가 "
                    "보고 싶은 건 '다음에 어디로'라 이게 제일 중요합니다. `channel` 은 기준선·평행선 두 줄이며 끝점이 barsAhead 라 차트 미래 구간까지 "
                    "이어집니다 — stock_chart annotations 에 kind:\"path\", projected:true 로 두 줄을 넣고 "
                    f"futureSlots 를 {project_bars} 이상으로 주세요. "
                    "이 답은 barRange(기간) + threshold(급) 쌍에 대해서만 유효합니다 — "
                    "답변에 반드시 둘 다 밝히세요('240일 일봉, 8% 급 기준 3파'). "
                    "급(threshold)마다 카운트가 다른 것이 정상입니다 — 엘리엇은 프랙탈이라 "
                    "잔 급의 5파 전체가 큰 급의 1파일 수 있습니다. 어느 급으로 말하는지 "
                    "반드시 밝히세요. `complete:false` + `inProgress:'3'` 은 그 파동이 아직 "
                    "진행 중이라는 뜻이고, 마지막 피벗의 `tentative:true` 는 다음 봉에서 "
                    "갱신될 수 있다는 뜻입니다. 후보가 0개면 그 급에서는 룰을 통과하는 "
                    "추진파도 조정 구조도 없다는 뜻이니 다른 급을 보세요 — "
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
