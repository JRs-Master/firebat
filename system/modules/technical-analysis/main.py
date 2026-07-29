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
        row = {
            "date": str(_pick(b, "date", "datetime", "time") or ""),
            "high": float(high) if high is not None else close,
            "low": float(low) if low is not None else close,
            "close": close,
        }
        if "open" in b or "o" in b or "Open" in b:
            o = _pick(b, "open", "o")
            if o is not None:
                row["open"] = float(o)
        v = _pick(b, "volume", "v")
        if v is not None:
            try:
                row["volume"] = float(v)
            except (TypeError, ValueError):
                pass
        out.append(row)
    # **시간 오름차순 강제.** 브로커마다 순서가 다르다 — kiwoom 분봉(ka10080)은 최신순으로 준다.
    # 순서를 믿고 계산하면 EMA·RSI·MACD 가 통째로 거꾸로 나오고, 신호 페어링도 뒤집혀
    # "청산일이 진입일보다 빠른" 체결 기록이 만들어진다(2026-07-29 실측 스크린샷).
    # 날짜 문자열은 zero-padded 라 사전순 = 시간순(YYYY-MM-DD HH:MM / YYYYMMDD). 빈 날짜는 원래 자리 유지.
    if any(r["date"] for r in out):
        out.sort(key=lambda r: r["date"])
    for i, r in enumerate(out):
        r["i"] = i          # 인덱스는 **정렬 후** 부여 — 피벗·주석 좌표가 차트와 어긋나지 않게
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
    # 하한을 1.5% 로 박아뒀더니 **분봉에서 파동이 죽었다** — 하루 등락이 3~4% 인 1분봉에서
    # 1.5% 반전은 하루 두세 번뿐이라 피벗이 3~4개, 추진파와 조정파가 거의 동점이 되어 방문마다
    # 카운트가 뒤집혔다(2026-07-29 실측: "1파2파3파 됐다가 A파B파 됐다가"). 노이즈 기준은
    # 절대 % 가 아니라 **그 시리즈의 전형적인 봉 변동**이어야 기간·종목·주기가 바뀌어도 성립한다.
    moves = sorted(
        abs(b["close"] / a["close"] - 1) * 100.0
        for a, b in zip(bars, bars[1:])
        if a["close"] > 0
    )
    typical = moves[len(moves) // 2] if moves else 0.0
    floor = max(0.05, typical * 3.0)   # 전형 변동의 3배 = 잔물결과 스윙의 경계
    return max(floor, min(25.0, span_pct / 8.0))


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
        # 조정이 시작점 대비 어디로 갔나(순변화)로 판정 — 삼각형 첫 다리는 방향을 못 말한다.
        return {"price": round(p[0], 6),
                "beyond": "above" if p[-1] < p[0] else "below",
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
    elif structure == "triangle" and n >= 6:
        # 수렴 삼각형은 두 경계선이 **만난다**(apex) — 평행 채널이 아니다.
        # 옛 코드는 A-C 에 B 통과 평행선을 그어 위로 벌어지는 상단선을 만들고
        # 그 미래값(코스피 실측 7,235)을 "채널 목표"로 내놨다. 수렴 구조에 평행선은 없다.
        if idx[3] == idx[1] or idx[4] == idx[2]:
            return None
        s1 = (p[3] - p[1]) / (idx[3] - idx[1])   # A-C
        s2 = (p[4] - p[2]) / (idx[4] - idx[2])   # B-D
        end_i = last_i + project_bars
        out = {
            "label": "A-C · B-D 수렴 경계선 (평행 아님 — 두 선이 apex 에서 만난다)",
            "convergingSlopes": [round(s1, 6), round(s2, 6)],
            "base": [{"i": idx[1], "price": round(p[1], 6)},
                     {"barsAhead": project_bars, "price": round(p[1] + s1 * (end_i - idx[1]), 6)}],
            "parallel": [{"i": idx[2], "price": round(p[2], 6)},
                         {"barsAhead": project_bars, "price": round(p[2] + s2 * (end_i - idx[2]), 6)}],
        }
        if abs(s1 - s2) > 1e-12:
            ax = (p[2] - s2 * idx[2] - p[1] + s1 * idx[1]) / (s1 - s2)
            if ax > last_i:
                # apex = 시간 목표. 스러스트는 대개 apex 도달 전(약 60~80% 지점)에 나온다.
                out["apex"] = {"barsAhead": int(round(ax - last_i)),
                               "price": round(p[1] + s1 * (ax - idx[1]), 6)}
        return out
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
            next_ratio, next_label = None, "스러스트 목표(삼각형 최대 폭 A-B 를 E 에서 투영)"
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
        # 스러스트(thrust — 표준 용어)은 **삼각형에 들어오기 전 추세**를 잇는다 — 삼각형 자체는 횡보라
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


def _direction_ko(cand):
    """추진파·조정파의 **진행 방향**을 한국어로.

    엘리엇의 1-2-3-4-5 는 "상승"이 아니라 **큰 추세 방향**이라, 하락 추세에서는 1이 아래로 간다.
    표기는 맞는데 화면이 방향을 말하지 않으면 "1·2·3인데 왜 내려가냐"로 읽힌다(2026-07-29 사용자).
    추진파는 1파 방향 = 추세 방향, 조정파는 순변화로 판정한다.
    """
    p = [x["price"] for x in (cand.get("pivots") or [])]
    if len(p) < 2:
        return ""
    up = (p[1] > p[0]) if str(cand.get("structure", "")).startswith("impulse") else (p[-1] > p[0])
    return "상승" if up else "하락"


def chart_annotation_set(cand, structure_label=None):
    """후보 하나를 **stock_chart annotations 배열**로 바꾼다.

    왜 모듈이 이걸 하나: 지금은 모델이 매 턴 손으로 annotations JSON 을 조립하는데, 그러면
    빠뜨리는 턴이 생긴다(실측: 실시간 페이지가 분석을 본문 텍스트로만 싣고 차트엔 아무것도
    안 그림). 좌표는 전부 결정론이라 모듈이 만들어 주면 채팅·페이지가 같은 그림을 얻는다.
    모델 몫은 **어느 후보를 택하고 그게 무슨 뜻인지** 말하는 것으로 남는다.
    """
    # 색 = 의미 구분. 전부 같은 보라로 나가면 파동·채널·예상선이 한 덩어리로 보인다
    # (2026-07-29 사용자: "채널과 엘리어트 선 색도 구분해야 잘보일듯").
    #   선 **모양**이 시간을 나른다 — 실선 = 지나온 길 / 점선 = 갈 길
    #   파동 = 보라 굵은 선(주인공) / 채널 = 얇은 회색 실선(배경으로 물러남) / 무효화 = 빨강
    # 캔들(빨강·파랑)·신호 화살표(초록·주황)와 겹치지 않는 색만 골랐다.
    WAVE, CHANNEL = "#7c3aed", "#64748b"
    ann = []
    pivots = cand.get("pivots") or []
    if pivots:
        ann.append({
            "kind": "path",
            "label": structure_label or ("%s %s" % (_direction_ko(cand), cand.get("structure"))).strip(),
            "color": WAVE, "width": 2,
            "points": [{"i": pv["i"], "price": pv["price"], "label": pv.get("label")} for pv in pivots],
        })
    ch = cand.get("channel") or {}
    tri = str(cand.get("structure", "")).startswith("triangle")
    for key, name in (("base", "A-C" if tri else "기준선"), ("parallel", "B-D" if tri else "평행선")):
        pts = ch.get(key)
        if pts:
            # dashed=False 로 명시 — 미래로 연장되지만 배경 선이라 점선보다 얇은 실선이 낫다.
            ann.append({"kind": "path", "label": name, "color": CHANNEL, "points": pts,
                        "projected": True, "dashed": False, "width": 0.8})
    pp = (cand.get("projectedPath") or {}).get("points")
    if pp:
        # 라벨은 **가격**이 본체다. "3파 목표(1파의 1.618)" 처럼 근거를 길게 달면 차트에서
        # 글자가 선을 덮는다(2026-07-29 사용자). 근거는 summary 에 남고 차트엔 숫자만.
        for q in pp:
            lab = q.get("label") or ""
            if lab and q.get("price") is not None:
                head = lab.split("(")[0].strip() or lab
                # "이후 4파" 처럼 서술형으로 시작하면 다른 라벨과 형식이 어긋난다 — 전부 "N파 목표"로.
                if head.startswith("이후 "):
                    head = head[3:].strip()
                if head and not head.endswith("목표") and "무효" not in head and "이탈" not in head:
                    head += " 목표"
                q["label"] = "%s %s" % (head, format(int(round(q["price"])), ","))
        ann.append({"kind": "path", "label": "예상 경로", "color": WAVE, "width": 2,
                    "points": pp, "projected": True})
    inv = cand.get("invalidation") or {}
    if inv.get("price") is not None:
        arrow = "▲" if inv.get("beyond") == "above" else "▼"
        ann.append({"kind": "hline", "label": f"무효화 {arrow} {inv['price']:,.0f}",
                    "points": [{"price": inv["price"]}], "color": "#dc2626", "dashed": True})
    return ann


# ─────────────────────────────────────────────────────────────────────────────
# 고전 지표 — 전부 **순수 산술**이라 모듈이 소유한다(엘리엇의 결정론/판단 분리와 같은 원칙).
# 여기 있는 것에 "사야 한다/팔아야 한다"는 없다. 그건 전략이고, 전략은 선언 데이터다.
# ─────────────────────────────────────────────────────────────────────────────

def _ema(xs, n):
    """지수이동평균. 시드 = 첫 n개 단순평균(표준 관행 — 첫 값만 쓰면 초반이 왜곡된다)."""
    if len(xs) < n or n <= 0:
        return [None] * len(xs)
    out = [None] * (n - 1)
    k = 2.0 / (n + 1)
    prev = sum(xs[:n]) / n
    out.append(prev)
    for x in xs[n:]:
        prev = x * k + prev * (1 - k)
        out.append(prev)
    return out


def _sma(xs, n):
    out = [None] * len(xs)
    if n <= 0 or len(xs) < n:
        return out
    run = sum(xs[:n])
    out[n - 1] = run / n
    for i in range(n, len(xs)):
        run += xs[i] - xs[i - n]
        out[i] = run / n
    return out


def _stdev(xs, n):
    out = [None] * len(xs)
    for i in range(n - 1, len(xs)):
        w = xs[i - n + 1: i + 1]
        m = sum(w) / n
        out[i] = (sum((x - m) ** 2 for x in w) / n) ** 0.5
    return out


def macd(closes, fast=12, slow=26, signal=9):
    """MACD = EMA(fast) - EMA(slow), 시그널 = 그 EMA(signal), 히스토그램 = 차이."""
    ef, es = _ema(closes, fast), _ema(closes, slow)
    line = [(a - b) if (a is not None and b is not None) else None for a, b in zip(ef, es)]
    solid = [x for x in line if x is not None]
    sig_tail = _ema(solid, signal)
    sig = [None] * (len(line) - len(sig_tail)) + sig_tail
    hist = [(l - g) if (l is not None and g is not None) else None for l, g in zip(line, sig)]
    return {"macd": line, "signal": sig, "hist": hist}


def rsi(closes, n=14):
    """RSI — Wilder 평활(단순평균 아님). 표준 정의라 다른 차트와 값이 맞는다."""
    out = [None] * len(closes)
    if len(closes) <= n:
        return out
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0.0)
        losses += max(-d, 0.0)
    ag, al = gains / n, losses / n
    out[n] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (n - 1) + max(d, 0.0)) / n
        al = (al * (n - 1) + max(-d, 0.0)) / n
        out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def bollinger(closes, n=20, mult=2.0):
    mid = _sma(closes, n)
    sd = _stdev(closes, n)
    up = [(m + mult * s) if (m is not None and s is not None) else None for m, s in zip(mid, sd)]
    lo = [(m - mult * s) if (m is not None and s is not None) else None for m, s in zip(mid, sd)]
    # %B = 밴드 안 위치(0=하단, 1=상단), 밴드폭 = 변동성 수축/확장 판단 재료.
    pctb, width = [], []
    for c, u, l, m in zip(closes, up, lo, mid):
        if u is None or l is None or u == l or not m:
            pctb.append(None); width.append(None)
        else:
            pctb.append((c - l) / (u - l))
            width.append((u - l) / m)
    return {"mid": mid, "upper": up, "lower": lo, "percentB": pctb, "bandwidth": width}


def stochastic(bars_hlc, k=14, d=3, smooth=3):
    """스토캐스틱 slow — 원시 %K 를 smooth 로 한 번 평활한 뒤 %D = 그 SMA(d)."""
    highs = [b["high"] for b in bars_hlc]
    lows = [b["low"] for b in bars_hlc]
    closes = [b["close"] for b in bars_hlc]
    raw = [None] * len(closes)
    for i in range(k - 1, len(closes)):
        hh, ll = max(highs[i - k + 1: i + 1]), min(lows[i - k + 1: i + 1])
        raw[i] = 50.0 if hh == ll else (closes[i] - ll) / (hh - ll) * 100
    solid = [x for x in raw if x is not None]
    ktail = _sma(solid, smooth)
    kline = [None] * (len(raw) - len(ktail)) + ktail
    ksolid = [x for x in kline if x is not None]
    dtail = _sma(ksolid, d)
    dline = [None] * (len(kline) - len(dtail)) + dtail
    return {"k": kline, "d": dline}


def ichimoku(bars_hlc, tenkan=9, kijun=26, senkou_b=52):
    """일목균형표. 선행스팬은 **미래로 kijun 만큼 shift** — 차트 미래 구간(futureSlots)에 그대로 얹힌다."""
    highs = [b["high"] for b in bars_hlc]
    lows = [b["low"] for b in bars_hlc]
    closes = [b["close"] for b in bars_hlc]

    def mid(n):
        out = [None] * len(highs)
        for i in range(n - 1, len(highs)):
            out[i] = (max(highs[i - n + 1: i + 1]) + min(lows[i - n + 1: i + 1])) / 2
        return out

    t, k = mid(tenkan), mid(kijun)
    a = [((x + y) / 2) if (x is not None and y is not None) else None for x, y in zip(t, k)]
    b = mid(senkou_b)
    return {
        "tenkan": t, "kijun": k,
        "senkouA": a, "senkouB": b,
        "shift": kijun,          # 선행스팬 A·B 를 오른쪽으로 이 만큼 민다
        "chikou": closes, "chikouShift": -kijun,   # 후행스팬 = 종가를 왼쪽으로
    }


def _tail(xs, n):
    """직렬화 절감 — 시리즈는 뒤 n개만(차트·판정에 필요한 건 최근 구간)."""
    return xs[-n:] if n and len(xs) > n else xs


def _prev_session_close(bars):
    """Close of the trading day before the newest one, or None when the data holds a single day.

    The live scoreboard needs a fixed baseline: a client that only carries today's bars cannot know
    yesterday's close, and frames only carry change/changeRate while the market is open, so after
    the close the figure would simply vanish. This comes from REST and never moves.
    """
    if not bars:
        return None
    day = bars[-1]["date"][:10]
    for b in reversed(bars):
        if b["date"][:10] != day:
            return b["close"]
    return None


def _last_session(bars, bar_range):
    """Keep only the most recent trading day's bars, re-indexed from 0.

    Judged from the data's newest date, never the clock — no timezone or pre-open edge cases. The
    re-index matters: annotation and pivot coordinates are bar indices, so a filtered series must
    renumber or every overlay lands on the wrong candle.
    """
    if not bars:
        return bars, bar_range
    day = bars[-1]["date"][:10]
    kept = [b for b in bars if b["date"][:10] == day]
    if not kept:
        return bars, bar_range
    for i, b in enumerate(kept):
        b["i"] = i
    return kept, {"count": len(kept), "from": kept[0]["date"], "to": kept[-1]["date"]}


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

    if action == "signals":
        # 데이 트레이딩 뷰 — 마지막 거래일 봉만. 시계·타임존에 의존하지 않고 **데이터의 최신
        # 날짜**로 자른다(장 시작 전엔 전일이 마지막 세션이라 그대로 맞다). 지표는 잘린 구간만
        # 보고 계산하므로 warmup 이 부족할 수 있다 — 그 사실을 응답에 밝힌다.
        prev_close = _prev_session_close(bars) if inp.get("lastSessionOnly") else None
        bars, bar_range = _last_session(bars, bar_range) if inp.get("lastSessionOnly") else (bars, bar_range)
        # **규칙은 데이터로 받는다.** 전략을 모듈 코드에 넣으면 그 순간 프레임워크가 투자 의견을
        # 갖게 되고, 사용자가 바꾸려면 배포를 해야 한다. 여기가 하는 일은 딱 두 가지 —
        # ① 지표를 계산하고 ② 선언된 조건이 참인 봉을 찾아 차트가 그대로 쓸 좌표로 돌려준다.
        # 좋은 전략인지는 판정하지 않는다(그건 백테스트와 사람 몫).
        rules = inp.get("rules")
        if not isinstance(rules, list) or not rules:
            print(json.dumps({"success": False, "error":
                "rules 가 필요합니다 — 예: [{\"side\":\"buy\",\"label\":\"골든크로스\","
                "\"when\":[{\"a\":\"macd.hist\",\"op\":\"crossUp\",\"b\":0},"
                "{\"a\":\"rsi\",\"op\":\"<\",\"b\":45}]}]. "
                "a/b = 지표 경로 또는 숫자. op = > < >= <= crossUp crossDown. "
                "한 rule 의 when 은 전부 참일 때(AND) 신호. OR 는 rule 을 여러 개 두세요. "
                "경로: close/open/high/low/volume, rsi, macd.macd|signal|hist, "
                "bollinger.mid|upper|lower|percentB|bandwidth, stochastic.k|d, "
                "ichimoku.tenkan|kijun|senkouA|senkouB"}, ensure_ascii=False))
            return
        closes = [b["close"] for b in bars]
        m = macd(closes, int(inp.get("macdFast") or 12), int(inp.get("macdSlow") or 26), int(inp.get("macdSignal") or 9))
        bb = bollinger(closes, int(inp.get("bbPeriod") or 20), float(inp.get("bbMult") or 2.0))
        st = stochastic(bars, int(inp.get("stochK") or 14), int(inp.get("stochD") or 3), int(inp.get("stochSmooth") or 3))
        ic = ichimoku(bars, int(inp.get("tenkan") or 9), int(inp.get("kijun") or 26), int(inp.get("senkouB") or 52))
        series = {
            # 정규화된 봉이 open 을 안 실을 수 있다 — 없으면 종가로 대체(경로는 유지해 규칙이 안 깨지게).
            "close": closes, "open": [b.get("open", b["close"]) for b in bars],
            "high": [b["high"] for b in bars], "low": [b["low"] for b in bars],
            "volume": [b.get("volume", 0) or 0 for b in bars],
            "rsi": rsi(closes, int(inp.get("rsiPeriod") or 14)),
            "macd.macd": m["macd"], "macd.signal": m["signal"], "macd.hist": m["hist"],
            "bollinger.mid": bb["mid"], "bollinger.upper": bb["upper"], "bollinger.lower": bb["lower"],
            "bollinger.percentB": bb["percentB"], "bollinger.bandwidth": bb["bandwidth"],
            "stochastic.k": st["k"], "stochastic.d": st["d"],
            "ichimoku.tenkan": ic["tenkan"], "ichimoku.kijun": ic["kijun"],
            "ichimoku.senkouA": ic["senkouA"], "ichimoku.senkouB": ic["senkouB"],
        }

        def val(ref, i):
            if isinstance(ref, (int, float)):
                return float(ref)
            sq = series.get(str(ref))
            if sq is None or i >= len(sq):
                return None
            v = sq[i]
            return None if v is None else float(v)

        unknown = sorted({str(c.get(side)) for r in rules for c in (r.get("when") or [])
                          for side in ("a", "b")
                          if not isinstance(c.get(side), (int, float)) and str(c.get(side)) not in series})
        if unknown:
            print(json.dumps({"success": False, "error":
                "알 수 없는 지표 경로: %s — 사용 가능: %s" % (", ".join(unknown), ", ".join(sorted(series)))},
                ensure_ascii=False))
            return

        def holds(cond, i):
            op = str(cond.get("op", ">"))
            a, b = val(cond.get("a"), i), val(cond.get("b"), i)
            if a is None or b is None:
                return False
            if op in ("crossUp", "crossDown"):
                if i == 0:
                    return False
                pa, pb = val(cond.get("a"), i - 1), val(cond.get("b"), i - 1)
                if pa is None or pb is None:
                    return False
                # 교차 = 직전엔 반대쪽, 지금은 이쪽. 같은 값 유지는 교차가 아니다.
                return (pa <= pb and a > b) if op == "crossUp" else (pa >= pb and a < b)
            return {">": a > b, "<": a < b, ">=": a >= b, "<=": a <= b}.get(op, False)

        buy, sell = [], []
        for r in rules:
            side = str(r.get("side", "buy")).lower()
            when = r.get("when") or []
            if not when:
                continue
            label = str(r.get("label") or ("매수" if side == "buy" else "매도"))
            bucket = buy if side == "buy" else sell
            for i, b in enumerate(bars):
                if all(holds(c, i) for c in when):
                    bucket.append({"date": b["date"], "price": round(b["close"], 6), "label": label,
                                   "note": r.get("note") or None})
        last_i = len(bars) - 1
        fired_now = [p for p in buy + sell if p["date"] == bars[last_i]["date"]]
        # **마지막 봉은 아직 안 닫혔을 수 있다.** 형성 중인 봉으로 판정한 신호는 그 분이
        # 끝나면서 사라질 수 있고(repainting), 자동매매가 그걸 보고 주문하면 없던 신호에
        # 체결한 게 된다. 모듈은 시계를 모르므로 **둘 다 준다** — 확정 신호는 이쪽을 쓴다.
        fired_closed = ([p for p in buy + sell if p["date"] == bars[last_i - 1]["date"]]
                        if last_i >= 1 else [])

        # ── 체결 기록 + 수익률 (규칙을 그대로 따라갔다면?) ──
        # 이게 없으면 신호는 그냥 화살표다. 규칙을 주문에 연결하기 전에 **과거에 어땠는지**를
        # 같은 답에서 보여 준다 — 좋아 보이는 규칙과 실제로 벌었던 규칙은 다르다.
        # 규칙: 매수 신호에 없으면 진입, 매도 신호에 있으면 청산(1포지션·전량, 롱 전용).
        # 수수료·슬리피지는 선언값(기본 0) — 넣지 않으면 실제보다 좋게 보인다는 걸 답에 밝힌다.
        # 비용 3종은 **부과 시점이 다르다** — 섞으면 결과가 틀린다.
        #   수수료 = 매수·매도 양쪽 / 세금(증권거래세) = **매도에만** / 슬리피지 = 체결가 자체가 밀림
        # 옛 코드는 수수료만 양쪽에서 빼서, 사용자가 세금을 feeRate 에 섞어 넣으면 매수에도
        # 세금이 붙었다(2026-07-29 사용자 질문에서 드러남).
        fee = float(inp.get("feeRate") or 0.0)          # 편도 비율 (예: 0.00015)
        tax = float(inp.get("taxRate") or 0.0)          # 매도에만 (증권거래세)
        slip = float(inp.get("slippageRate") or 0.0)    # 편도 비율
        # 틱 기준 슬리피지 — 실매매는 시장가가 아니라 **한 틱 위/아래 지정가**로 넣으므로 밀리는
        # 폭이 비율이 아니라 호가단위의 정수배다. 비율만 쓰면 가격대에 따라 크게 어긋난다
        # (삼성전자 224,000원의 1틱 500원 = 0.22% vs 5,000원짜리 1틱 5원 = 0.1%).
        # 호가단위 표는 시장마다 달라 **모듈에 넣지 않는다** — 아는 쪽(호출자)이 tickSize 로 선언한다.
        tick_size = float(inp.get("tickSize") or 0.0)
        slip_ticks = float(inp.get("slippageTicks") or 0.0)
        tick_slip = tick_size * slip_ticks              # 편도 절대금액
        # ── 포지션 기준 청산 ──
        # 규칙(`rules`)은 봉 지표만 보므로 "진입가 대비 몇 %" 를 표현할 수 없다. 그런데 실측에서
        # 이게 결정적이었다(2026-07-29): 진입 7건 중 5건은 +1.4~2.2% 익절 기회가 있었는데 손절이
        # 없어 두 건이 −6% 까지 끌려가며 전부를 삼켰다. 진입가를 아는 건 이 루프뿐이라 여기서 판정한다.
        stop_pct = float(inp.get("stopLossPct") or 0.0) / 100.0
        take_pct = float(inp.get("takeProfitPct") or 0.0) / 100.0
        trail_pct = float(inp.get("trailingStopPct") or 0.0) / 100.0
        buy_at = {p["date"]: p for p in buy}
        sell_at = {p["date"]: p for p in sell}

        def _close_trade(pos, date, raw_px, label, reason):
            exit_px = max(raw_px * (1 - slip) - tick_slip, 0.0)
            # 곱셈으로 — 매입원가 = 체결가×(1+수수료), 매도수취 = 체결가×(1-수수료-세금).
            cost = pos["entryPrice"] * (1 + fee)
            proceeds = exit_px * (1 - fee - tax)
            net = proceeds / cost - 1 if cost else 0.0
            return {**pos, "exitDate": date, "exitPrice": round(exit_px, 6),
                    "exitLabel": label, "exitReason": reason,
                    "returnPct": round(net * 100, 4),
                    "grossPct": round((exit_px / pos["entryPrice"] - 1) * 100, 4)}

        trades, pos = [], None
        for b in bars:
            date = b["date"]
            if pos is not None:
                entry = pos["entryPrice"]
                pos["peak"] = max(pos.get("peak", entry), b["high"])
                # 같은 봉에서 손절·익절이 다 닿을 수 있다 — 봉 안 순서는 알 수 없으므로
                # **손절이 먼저 닿았다고 본다**(낙관 금지).
                if stop_pct > 0 and b["low"] <= entry * (1 - stop_pct):
                    trades.append(_close_trade(pos, date, entry * (1 - stop_pct), "손절", "stop"))
                    pos = None
                elif trail_pct > 0 and b["low"] <= pos["peak"] * (1 - trail_pct):
                    trades.append(_close_trade(pos, date, pos["peak"] * (1 - trail_pct), "트레일링", "trailing"))
                    pos = None
                elif take_pct > 0 and b["high"] >= entry * (1 + take_pct):
                    trades.append(_close_trade(pos, date, entry * (1 + take_pct), "익절", "take"))
                    pos = None
                elif date in sell_at:
                    m = sell_at[date]
                    trades.append(_close_trade(pos, date, m["price"], m["label"], "rule"))
                    pos = None
            if pos is None and date in buy_at:
                m = buy_at[date]
                pos = {"entryDate": date, "entryPrice": m["price"] * (1 + slip) + tick_slip,
                       "entryLabel": m["label"], "peak": m["price"]}
        wins = [t for t in trades if t["returnPct"] > 0]
        equity = 1.0
        for t in trades:
            equity *= 1 + t["returnPct"] / 100
        peak = run = 1.0
        mdd = 0.0
        for t in trades:
            run *= 1 + t["returnPct"] / 100
            peak = max(peak, run)
            mdd = min(mdd, run / peak - 1)
        backtest = {
            "trades": trades,
            "openPosition": {k: v for k, v in pos.items() if k != "peak"} if pos else None,
            "tradeCount": len(trades),
            "winRate": round(len(wins) / len(trades) * 100, 2) if trades else None,
            "totalReturnPct": round((equity - 1) * 100, 4) if trades else None,
            "avgReturnPct": round(sum(t["returnPct"] for t in trades) / len(trades), 4) if trades else None,
            "bestPct": max((t["returnPct"] for t in trades), default=None),
            "worstPct": min((t["returnPct"] for t in trades), default=None),
            "maxDrawdownPct": round(mdd * 100, 4) if trades else None,
            "feeRate": fee, "taxRate": tax, "slippageRate": slip,
            "stopLossPct": stop_pct * 100, "takeProfitPct": take_pct * 100,
            "trailingStopPct": trail_pct * 100,
            "tickSize": tick_size, "slippageTicks": slip_ticks,
            "assumptions": ("롱 전용·1포지션·전량, 신호 봉 종가 체결 가정. 비용은 부과 시점이 달라 "
                            "따로 받습니다 — 수수료(feeRate)=매수·매도 양쪽 / 세금(taxRate)=**매도에만** / "
                            "슬리피지(slippageRate)=체결가 자체가 밀리는 폭. 셋 다 0이면 실제보다 좋게 "
                            "나옵니다. 각 체결의 grossPct(비용 전)와 returnPct(비용 후)를 비교하면 "
                            "비용이 얼마나 먹는지 보이고, 1분봉처럼 체결이 잦을수록 그 차이가 커집니다. "
                            "실매매처럼 한 틱 위/아래 지정가를 가정하려면 tickSize + slippageTicks 로 "
                            "절대금액을 주세요(비율만 쓰면 가격대에 따라 크게 어긋납니다). "
                            "**비체결은 모델에 없습니다** — 지정가는 안 채워질 수 있는데 이 백테스트는 "
                            "모든 신호가 체결됐다고 봅니다. 어떤 비용값으로도 이 낙관은 지워지지 않으니 "
                            "실매매 기대치는 여기서 한 번 더 깎아 보세요. "
                            "같은 구간으로 규칙을 고르면 과최적화이니, 규칙을 만든 구간 밖에서 다시 재세요."),
        }
        # 페이지 바인딩 계약(`blocks`) — 첫 블록 props 는 차트에 병합되고, 나머지는 차트 아래에
        # 그대로 얹힌다. **모의투자 표를 모델이 매번 손으로 조립하지 않게** 모듈이 만들어 준다
        # (좌표·수치가 전부 결정론이라 모듈이 만드는 게 맞다 — chart_annotations 와 같은 이유).
        def _pct(x):
            return "—" if x is None else ("%+.2f%%" % x)
        rows = [[t["entryDate"], "%,.2f" % t["entryPrice"] if False else round(t["entryPrice"], 2),
                 t["exitDate"], round(t["exitPrice"], 2), _pct(t["grossPct"]), _pct(t["returnPct"]),
                 t["entryLabel"], t["exitLabel"]]
                for t in trades]
        if pos:
            rows.append([pos["entryDate"], round(pos["entryPrice"], 2), "보유 중", "—", "—", "—",
                         pos["entryLabel"], "—"])
        asof = bar_range.get("to") if isinstance(bar_range, dict) else None

        def _last(seq):
            for v in reversed(seq):
                if v is not None:
                    return v
            return None

        def _r(v, n=2):
            return None if v is None else round(v, n)

        # Current values of the indicators the rules actually evaluated. Pulled from the same series
        # rather than recomputed, so the numbers on screen can never disagree with the signal.
        live_now = [
            {"type": "metric", "props": {"label": "RSI", "value": _r(_last(series["rsi"])),
                                         "subLabel": "14 · %s 기준" % (asof[-5:] if asof else "-")}},
            {"type": "metric", "props": {"label": "MACD 히스토그램", "value": _r(_last(series["macd.hist"]), 3),
                                         "subLabel": "0 상향 = 매수 조건"}},
            {"type": "metric", "props": {"label": "볼린저 %B", "value": _r(_last(series["bollinger.percentB"]), 3),
                                         "subLabel": "0=하단 1=상단"}},
            {"type": "metric", "props": {"label": "스토캐스틱 %K", "value": _r(_last(series["stochastic.k"])),
                                         "subLabel": "%D " + str(_r(_last(series["stochastic.d"])))}},
        ]
        blocks = [
            {"type": "stock_chart", "props": {
                "buyPoints": buy, "sellPoints": sell,
                **({"prevClose": prev_close} if prev_close is not None else {}),
                # 분석에 쓴 봉을 그대로 차트에도 — lastSessionOnly 로 잘랐을 때 차트와 표가
                # 다른 구간을 보여 주면 수치가 어긋난 것처럼 읽힌다.
                **({"data": [{"date": b["date"], "open": b.get("open", b["close"]), "high": b["high"],
                              "low": b["low"], "close": b["close"], "volume": b.get("volume", 0)}
                             for b in bars]} if inp.get("lastSessionOnly") else {}),
            }},
        ]
        # 한 줄에 하나씩 쌓이면 스크롤만 길어진다 — 관련된 것끼리 Grid 한 줄로 묶어 내보낸다.
        blocks.append({"type": "grid", "props": {"columns": 4, "children": live_now}})
        blocks.append({"type": "grid", "props": {"columns": 4, "children": [
            {"type": "metric", "props": {"label": "체결", "value": len(trades), "unit": "건",
                                         "subLabel": "미청산 %d" % (1 if pos else 0)}},
            {"type": "metric", "props": {"label": "승률", "value": backtest["winRate"] if trades else "—", "unit": "%"}},
            {"type": "metric", "props": {"label": "누적 수익", "value": backtest["totalReturnPct"] if trades else "—",
                                         "unit": "%",
                                         "deltaType": "up" if (backtest["totalReturnPct"] or 0) > 0 else "down"}},
            {"type": "metric", "props": {"label": "최대 낙폭", "value": backtest["maxDrawdownPct"] if trades else "—", "unit": "%"}},
        ]}})
        blocks.append({"type": "table", "props": {
            "headers": ["진입일", "진입가", "청산일", "청산가", "수익률(비용전)", "수익률(비용후)",
                        "진입 신호", "청산 신호"],
            "rows": rows, "stickyCol": False, "striped": True, "sortable": True}})
        print(json.dumps({"success": True, "data": {
            "barRange": bar_range,
            "blocks": blocks,
            "buyPoints": buy, "sellPoints": sell,
            "counts": {"buy": len(buy), "sell": len(sell)},
            "backtest": backtest,
            # 자동매매가 볼 곳 — **마지막 봉에서 방금 발생한 것만**. 과거 신호를 지금 주문으로
            # 착각하지 않게 분리한다.
            "firedOnLastBar": fired_now,
            "firedOnLastClosedBar": fired_closed,
            "lastBarDate": bars[last_i]["date"],
            "lastClosedBarDate": bars[last_i - 1]["date"] if last_i >= 1 else None,
            "note": ("`buyPoints`/`sellPoints` 를 stock_chart·live_stock_chart 에 그대로 넣으면 봉 아래 ↑ / "
                     "위 ↓ 화살표로 표시됩니다. **주문 판단은 이 액션이 하지 않습니다** — 규칙이 참인 봉을 "
                     "표시할 뿐이고, 규칙이 좋은지는 백테스트와 사람이 정합니다. 지금 시점 주문 판단에는 "
                     "지금 시점 판단에는 마지막 두 필드만 보세요 — `firedOnLastBar` 는 **형성 중일 수 있는** "
                     "봉이라 신호가 떴다 사라질 수 있고(repainting), 확정 판단은 "
                     "**`firedOnLastClosedBar`**(직전 닫힌 봉)입니다. 모듈은 시계를 모르니 둘 다 주고 "
                     "고르는 건 호출자 몫입니다 — 화면 표시는 앞엣것, 주문은 뒤엣것. `backtest` = 그 규칙을 "
                     "그대로 따라갔을 때의 체결 기록·승률·누적수익·MDD — 표로 보여 주면 규칙의 값어치가 "
                     "화살표보다 훨씬 잘 읽힙니다. 가정(assumptions)을 반드시 함께 밝히세요."),
        }}, ensure_ascii=False))
        return

    if action == "indicators":
        # 고전 지표 묶음. **신호 판정은 하지 않는다** — 여기 나오는 건 전부 계산된 값이고,
        # "그래서 사야 하나"는 전략(선언 데이터)과 사람 몫이다. 값과 판단을 섞지 않는 것이
        # 엘리엇 쪽과 같은 원칙이고, 섞으면 모듈이 조용히 투자 의견을 갖게 된다.
        closes = [b["close"] for b in bars]
        want = inp.get("which")
        want = [str(w) for w in want] if isinstance(want, list) and want else                ["macd", "rsi", "bollinger", "stochastic", "ichimoku"]
        keep = int(inp.get("seriesTail") or 120)
        out, latest = {}, {}
        if "macd" in want:
            m = macd(closes, int(inp.get("macdFast") or 12), int(inp.get("macdSlow") or 26),
                     int(inp.get("macdSignal") or 9))
            out["macd"] = {k: _tail(v, keep) for k, v in m.items()}
            latest["macd"] = {k: (v[-1] if v and v[-1] is not None else None) for k, v in m.items()}
        if "rsi" in want:
            r = rsi(closes, int(inp.get("rsiPeriod") or 14))
            out["rsi"] = _tail(r, keep)
            latest["rsi"] = r[-1] if r and r[-1] is not None else None
        if "bollinger" in want:
            bb = bollinger(closes, int(inp.get("bbPeriod") or 20), float(inp.get("bbMult") or 2.0))
            out["bollinger"] = {k: _tail(v, keep) for k, v in bb.items()}
            latest["bollinger"] = {k: (v[-1] if v and v[-1] is not None else None) for k, v in bb.items()}
        if "stochastic" in want:
            st = stochastic(bars, int(inp.get("stochK") or 14), int(inp.get("stochD") or 3),
                            int(inp.get("stochSmooth") or 3))
            out["stochastic"] = {k: _tail(v, keep) for k, v in st.items()}
            latest["stochastic"] = {k: (v[-1] if v and v[-1] is not None else None) for k, v in st.items()}
        if "ichimoku" in want:
            ic = ichimoku(bars, int(inp.get("tenkan") or 9), int(inp.get("kijun") or 26),
                          int(inp.get("senkouB") or 52))
            out["ichimoku"] = {k: (_tail(v, keep) if isinstance(v, list) else v) for k, v in ic.items()}
            latest["ichimoku"] = {k: (v[-1] if isinstance(v, list) and v and v[-1] is not None else
                                      (v if not isinstance(v, list) else None)) for k, v in ic.items()}
        print(json.dumps({"success": True, "data": {
            "barRange": bar_range,
            "latest": latest,
            "series": out,
            "seriesTail": keep,
            "note": ("`latest` = 마지막 봉 기준 값(답변 문장은 이걸로), `series` = 차트 오버레이용 뒤 "
                     f"{keep}봉. 일목의 senkouA/B 는 `shift` 만큼 **미래로** 밀어 그린다(futureSlots 확보). "
                     "**이 액션은 신호를 내지 않는다** — 매수·매도 판정은 전략 규칙과 사람 몫이고, "
                     "값만 보고 단정하지 말 것. 과매수/과매도 같은 관용 해석을 붙이려면 근거 수치를 함께 밝힐 것."),
        }}, ensure_ascii=False))
        return

    if action == "chart_annotations":
        # 신호(signals)와 한 차트에 겹칠 때 **같은 구간**을 봐야 한다 — 주석 좌표가 봉 인덱스라
        # 구간이 다르면 파동이 엉뚱한 캔들에 얹힌다.
        prev_close = None
        if inp.get("lastSessionOnly"):
            prev_close = _prev_session_close(bars)
            bars, bar_range = _last_session(bars, bar_range)
        # 차트에 바로 얹을 주석 한 벌 — 급(threshold) 하나, 후보 하나(기본 = 최고 confidence).
        # pageBinding 계약(`blocks`)으로 반환하므로 **페이지 바인딩이 방문마다 재계산**할 수 있고,
        # 채팅에서도 같은 배열을 그대로 stock_chart 에 넣으면 된다.
        last_i = bars[-1]["i"]
        project_bars = int(inp.get("projectBars") or max(5, min(60, round(len(bars) * 0.2))))
        try:
            t = float(inp.get("threshold") or threshold)
        except (TypeError, ValueError):
            t = threshold
        t = round(max(0.05, min(25.0, t)), 2)
        pv = zigzag(bars, t)
        cands = sorted(
            elliott_candidates(pv, 8, last_i, project_bars, bars)
            + corrective_candidates(pv, 8, last_i, project_bars, bars),
            key=lambda c: c["confidence"], reverse=True,
        )
        pick = int(inp.get("candidateIndex") or 0)
        cand = cands[pick] if 0 <= pick < len(cands) else (cands[0] if cands else None)
        if not cand:
            # 후보가 없는 것도 정직한 답 — 빈 주석을 주고 이유를 말한다(억지 카운트 금지).
            print(json.dumps({"success": True, "data": {
                "blocks": [{"type": "stock_chart", "props": {"annotations": [], "futureSlots": project_bars}}],
                "summary": {"structure": None, "threshold": t, "pivotCount": len(pv),
                            "reason": "이 급에서 엘리엇 규칙을 만족하는 후보가 없습니다 — threshold 를 바꿔 보세요."},
                "barRange": bar_range,
            }}, ensure_ascii=False))
            return
        ann = chart_annotation_set(cand)
        # 미래 지평선 = **예상 경로가 필요로 하는 만큼**. 채널은 project_bars(기간의 20%)까지
        # 뻗도록 계산되는데 그게 예상 경로보다 훨씬 멀면(실측: 예상 +6봉 / 채널 +40봉) 화면이
        # 빈 여백으로 채워지고 봉이 잘게 눌린다. 채널은 경계선이라 얼마나 길지가 본질이 아니므로
        # 예상 경로에 맞춰 잘라 준다 — 선 위의 점이라 선형 보간으로 정확히 줄일 수 있다.
        proj_need = max(
            (pt["barsAhead"] for a in ann if a.get("label") == "예상 경로"
             for pt in a["points"] if "barsAhead" in pt),
            default=0,
        )
        horizon = int(proj_need) + 2 if proj_need else project_bars
        for a in ann:
            pts = a.get("points") or []
            if len(pts) != 2 or "barsAhead" not in pts[-1] or "i" not in pts[0]:
                continue
            h = pts[-1]["barsAhead"]
            if h <= horizon:
                continue
            x0, y0 = pts[0]["i"], pts[0]["price"]
            span = (last_i + h) - x0
            if span <= 0:
                continue
            slope = (pts[-1]["price"] - y0) / span
            pts[-1]["barsAhead"] = horizon
            pts[-1]["price"] = round(y0 + slope * ((last_i + horizon) - x0), 6)
        need = max((pt["barsAhead"] for a in ann for pt in a["points"] if "barsAhead" in pt), default=0)
        future_slots = max(int(need) + 2, 5)
        inv = cand.get("invalidation") or {}
        wave_cards = [
            {"type": "metric", "props": {
                "label": "현재 파동",
                "value": cand.get("inProgress") or (cand["labels"][-1] if cand.get("labels") else "-"),
                "subLabel": ("%s %s" % (_direction_ko(cand), cand["structure"])).strip()}},
            {"type": "metric", "props": {
                "label": "카운트 신뢰도", "value": round(cand["confidence"] * 100, 1), "unit": "%",
                "subLabel": "급 %.2f%%" % t}},
            {"type": "metric", "props": {
                "label": "무효화 가격", "value": inv.get("price"),
                "subLabel": ("이 위로 가면 무효" if inv.get("beyond") == "above" else "이 아래로 가면 무효")}},
        ]
        print(json.dumps({"success": True, "data": {
            "blocks": [{"type": "stock_chart", "props": {
                "annotations": ann,
                **({"prevClose": prev_close} if prev_close is not None else {}),
                # 여백은 **주석이 실제로 쓰는 만큼**. 옛 코드는 project_bars 를 그대로 넣었는데,
                # 예상 경로의 시간 좌표는 앞선 다리 길이에서 나오므로 그보다 멀리 갈 수 있다
                # (실측: futureSlots 16 인데 예상선이 +20·+41봉 → 화면 밖이라 아예 안 보임).
                "futureSlots": future_slots,
                **({"data": [{"date": b["date"], "open": b.get("open", b["close"]), "high": b["high"],
                              "low": b["low"], "close": b["close"], "volume": b.get("volume", 0)}
                             for b in bars]} if inp.get("lastSessionOnly") else {}),
            }}, {"type": "grid", "props": {"columns": 3, "children": wave_cards}}],
            "summary": {
                "structure": cand["structure"], "labels": cand["labels"],
                "inProgress": cand.get("inProgress"), "complete": cand.get("complete"),
                "confidence": cand["confidence"], "threshold": t,
                "invalidation": cand.get("invalidation"),
                "projectedPath": cand.get("projectedPath"),
                "notes": cand.get("notes"),
                "candidateCount": len(cands),
            },
            "barRange": bar_range,
            "note": ("차트 주석은 `blocks[0].props` 를 그대로 쓰세요(annotations + futureSlots). "
                     "이 답은 barRange(기간) + threshold(급) 쌍에 대해서만 유효합니다 — 답변에 둘 다 밝히세요. "
                     "다른 카운트를 보려면 candidateIndex 또는 threshold 를 바꿔 재호출하세요."),
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
            thresholds = sorted({round(max(0.05, min(25.0, t)), 2) for t in ladder})
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
