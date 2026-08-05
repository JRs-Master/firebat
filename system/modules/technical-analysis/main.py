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
import re
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
        # A source that STATES the previous session's close (brokers do) is kept — deriving it from
        # the series is guesswork once the series spans an extended session.
        pc = _pick(b, "prevClose", "prev_close")
        if pc is not None:
            try:
                row["prevClose"] = float(pc)
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


def _num_or(value, default):
    """숫자로 읽히면 그 값, 아니면 기본값. 선언을 못 읽었다고 기능이 사라지지는 않게."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _fmt_price(value):
    """사람이 읽는 가격 — 천 단위 구분, 원 단위면 소수점 없이."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return str(value)
    return f"{v:,.0f}" if abs(v) >= 100 else f"{v:,.4g}"


def _parse_rungs(spec, move_key, size_key):
    """A ladder of `{<move_key>, afterDays, <size_key>}` rungs, or the reason it cannot be read.

    A rung can name a price move, an elapsed time, or both — and naming both means both must
    hold. A pure time split falls out of the same shape rather than needing its own mechanism.
    `<size_key>` is cumulative against the position's full size, so the last rung is 100.

    The move can be written in percent (`<move_key>`) or in ATR multiples (`<move_key>Atr`).
    Percent names different things on different instruments — measured 2026-08-04, 8% is about
    0.5 ATR on KO and 3 ATR on TSLA, so a grid in percent is really a grid over volatility. A
    ladder must pick one unit: with both in play the ascending check would be comparing a
    percentage against a multiple.
    """
    rungs, last_move, last_filled, unit = [], None, 0.0, None
    for i, r in enumerate(spec):
        if not isinstance(r, dict):
            return None, f"{size_key} 사다리의 [{i}] 이 객체가 아닙니다."
        try:
            filled = float(r.get(size_key))
        except (TypeError, ValueError):
            return None, f"[{i}].{size_key} 를 숫자로 읽지 못했습니다."
        if not 0 < filled <= 100:
            return None, f"[{i}].{size_key} 는 0 초과 100 이하(전체 대비 누적)입니다."
        if filled <= last_filled:
            return None, (f"{size_key} 는 누적이라 늘기만 합니다 — [{i}] {filled} 가 앞 칸 "
                          f"{last_filled} 보다 크지 않습니다.")
        rung = {"filled": filled / 100.0}
        # gainPct -> gainAtr : 단위 이름이 두 번 붙지 않게.
        atr_key = (move_key[:-3] if move_key.endswith("Pct") else move_key) + "Atr"
        if r.get(move_key) is not None and r.get(atr_key) is not None:
            return None, f"[{i}] 은 {move_key} 와 {atr_key} 중 하나만 적습니다."
        for key, field, want in ((move_key, "move", "pct"), (atr_key, "moveAtr", "atr")):
            if r.get(key) is None:
                continue
            if unit is not None and unit != want:
                return None, (f"한 사다리는 한 단위로 적습니다 — [{i}] 이 {key} 인데 앞 칸은 "
                              f"{'퍼센트' if unit == 'pct' else 'ATR 배수'}입니다.")
            try:
                move = float(r.get(key))
            except (TypeError, ValueError):
                return None, f"[{i}].{key} 를 숫자로 읽지 못했습니다."
            if move <= 0:
                return None, f"[{i}].{key} 는 0보다 커야 합니다."
            if last_move is not None and move <= last_move:
                return None, (f"{key} 는 오름차순이어야 합니다 — [{i}] {move} 가 앞 칸 "
                              f"{last_move} 보다 크지 않습니다.")
            rung[field], last_move, unit = move, move, want
        if r.get("afterDays") is not None:
            try:
                days = float(r.get("afterDays"))
            except (TypeError, ValueError):
                return None, f"[{i}].afterDays 를 숫자로 읽지 못했습니다."
            if days < 0:
                return None, f"[{i}].afterDays 는 0 이상입니다."
            rung["afterDays"] = days
        if "move" not in rung and "moveAtr" not in rung and "afterDays" not in rung:
            return None, (f"[{i}] 에 조건이 없습니다 — {move_key}, {atr_key}, afterDays 중 "
                          f"하나는 있어야 합니다.")
        rungs.append(rung)
        last_filled = filled
    return rungs, None


def _parse_scale_out(spec, take_pct):
    """The exit ladder. A single take-profit target is the one-rung case, so the loop that uses
    it has one shape rather than two."""
    if not spec:
        return ([{"move": take_pct, "filled": 1.0}] if take_pct > 0 else []), None
    if not isinstance(spec, list):
        return [], "scaleOut 은 [{gainPct, sellPct}] 배열입니다."
    rungs, err = _parse_rungs(spec, "gainPct", "sellPct")
    return (rungs or []), (f"scaleOut: {err}" if err else None)


def _parse_scale_in(spec):
    """The entry ladder — `[{dropPct, afterDays, buyPct}]`. Absent means the whole position at
    the signal, which is what every measurement did before this existed."""
    if not spec:
        return [{"move": None, "filled": 1.0, "immediate": True}], None
    if not isinstance(spec, list):
        return [], "scaleIn 은 [{dropPct, buyPct}] 배열입니다."
    rungs, err = _parse_rungs(spec, "dropPct", "buyPct")
    return (rungs or []), (f"scaleIn: {err}" if err else None)


def _rung_due(rung, move_pct, age_days):
    if rung.get("immediate"):
        return True
    want_move, want_days = rung.get("move"), rung.get("afterDays")
    if want_move is not None and move_pct < want_move - 1e-9:
        return False
    if want_days is not None and age_days < want_days - 1e-9:
        return False
    return want_move is not None or want_days is not None


def _highest_due(rungs, move_pct, age_days, done):
    """The furthest rung whose condition is met and which is beyond where we already are."""
    target, idx = 0.0, None
    for i, rung in enumerate(rungs):
        if _rung_due(rung, move_pct, age_days) and rung["filled"] > target:
            target, idx = rung["filled"], i
    return (None, 0.0) if idx is None or target <= done + 1e-9 else (idx, target - done)


def _days_between(a, b):
    """Calendar days from date string `a` to `b`. Unparseable dates mean no elapsed time, which
    keeps a time-gated rung shut rather than opening it on a guess."""
    try:
        ya, ma, da = int(a[0:4]), int(a[5:7]), int(a[8:10])
        yb, mb, db = int(b[0:4]), int(b[5:7]), int(b[8:10])
    except (ValueError, IndexError, TypeError):
        return 0.0
    import datetime
    try:
        return (datetime.date(yb, mb, db) - datetime.date(ya, ma, da)).days
    except ValueError:
        return 0.0


def _apply_bar_range(bars, bar_range, spec):
    """Restrict the analysis to a slice of the bars.

    A rule tuned on the same bars it is measured on will look excellent and mean nothing, so the
    honest way to compare candidates is to fit on one window and score on another. Slicing has to
    happen here because only this module holds the rows — a pipeline can wire values between steps
    but cannot cut an array, and shipping two copies of six hundred candles to say "first 70%"
    would cost more than the analysis.

    `{from, to}` are fractions when <= 1 (`{from: 0, to: 0.7}` = the oldest 70%) and bar indices
    otherwise. Negative values count from the end, as elsewhere in this codebase.
    """
    if not isinstance(spec, dict) or not bars:
        return bars, bar_range
    n = len(bars)

    def edge(v, default):
        if v is None:
            return default
        try:
            f = float(v)
        except (TypeError, ValueError):
            return default
        if -1.0 <= f <= 1.0 and not float(f).is_integer():
            idx = int(round(f * n)) if f >= 0 else n + int(round(f * n))
        else:
            idx = int(f) if f >= 0 else n + int(f)
        return max(0, min(n, idx))

    start = edge(spec.get("from"), 0)
    end = edge(spec.get("to"), n)
    if end <= start:
        return bars, bar_range
    sliced = bars[start:end]
    if not sliced:
        return bars, bar_range
    return sliced, {
        "count": len(sliced),
        "from": sliced[0].get("date", ""),
        "to": sliced[-1].get("date", ""),
        "slicedFrom": bar_range.get("count", n),
    }


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
                # A target beyond a count already broken is meaningless, and drawn next to the
                # invalidation it reads as a prediction the pattern no longer supports. Measured
                # 2026-07-30: the chart showed "invalidation possible" at the current price and a
                # thrust target below it at the same time.
                next_ratio, next_label = None, None
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
        # "Invalidation" is the standard Elliott term, but rendered as "invalid price" in Korean it
        # reads like a price that has been voided. Naming the count makes it plain: the level is where
        # this count stops being a valid count, not where the price stops being valid.
        ann.append({"kind": "hline", "label": f"카운트 무효 {arrow} {inv['price']:,.0f}",
                    "points": [{"price": inv["price"]}], "color": "#dc2626", "dashed": True})
    return ann


# ─────────────────────────────────────────────────────────────────────────────
# 고전 지표 — 전부 **순수 산술**이라 모듈이 소유한다(엘리엇의 결정론/판단 분리와 같은 원칙).
# 여기 있는 것에 "사야 한다/팔아야 한다"는 없다. 그건 전략이고, 전략은 선언 데이터다.
# ─────────────────────────────────────────────────────────────────────────────

# `ma50` / `ema20` — a rule references a moving average by naming its period, so no period list is
# declared anywhere and both conventions (5/20/60/120 and 50/200) work.


# A timeframe in front of any operand: `w.slope10`, `d.rsi`, `M.ma12`, `4h.close`.
#
# Deliberately not a resample of the bars in hand. Folding three hundred hourly bars into weekly
# ones yields two, and two exact bars say nothing about a trend — the history is the point, so the
# higher series is fetched at its own length and handed in.
#
# `macd.hist` and `bollinger.mid` also contain a dot, so a prefix only counts when it looks like a
# timeframe *and* a series of that name was actually supplied.
_TF_PREFIX = re.compile(r"^(M|w|d|h|\d+[mhdwM])\.(.+)$")
_TF_ALIAS = {"M": "1M", "w": "1w", "d": "1d", "h": "1h"}


def _tf_key(prefix):
    return _TF_ALIAS.get(prefix, prefix)


def _bar_time(row):
    """A date comparable across formats — 'YYYY-MM-DD' and 'YYYY-MM-DD HH:MM:SS' sort together."""
    d = str((row or {}).get("date") or "")
    return (d + " 00:00:00")[:19] if len(d) <= 10 else d[:19]


def _align_to(native_bars, higher_bars, values):
    """Carry a higher-timeframe series onto the native bars, one closed bar behind.

    At any moment inside this week, the weekly bar that has *finished* is last week's. Taking the
    bar that contains the current moment would read a value still being written — it changes every
    day until the period ends, so a rule answers differently each run and a backtest sees a close
    that had not happened yet. Stepping back one bar is what "the last closed weekly bar" means.
    """
    if not higher_bars or not values:
        return [None] * len(native_bars)
    hi_times = [_bar_time(b) for b in higher_bars]
    out, j = [], 0
    for b in native_bars:
        t = _bar_time(b)
        while j + 1 < len(hi_times) and hi_times[j + 1] <= t:
            j += 1
        # `j` is the bar containing this moment; the one before it is the last that closed.
        k = j - 1 if hi_times[j] <= t else j - 1
        out.append(values[k] if 0 <= k < len(values) else None)
    return out


def _higher_series(higher_input, inp, refs_by_tf, native_bars):
    """Every prefixed operand, resolved on its own timeframe and aligned to the native bars.

    Returns `(series, missing)` — missing names the timeframes a rule asked for and nobody
    supplied, because "the condition was never true" and "the series was never fetched" look
    identical in a signal count and are not the same problem.
    """
    out, missing, unknown = {}, [], []
    for tf, refs in sorted(refs_by_tf.items()):
        raw = (higher_input or {}).get(tf)
        rows = _bars(raw) if isinstance(raw, list) else []
        if not rows:
            missing.append(tf)
            continue
        base = _base_series(rows, inp)
        _add_derived(base, [b["close"] for b in rows], sorted({r for _, r in refs}), rows)
        for full, sub in refs:
            if sub not in base:
                unknown.append(full)
                continue
            out[full] = _align_to(native_bars, rows, base[sub])
    return out, missing, unknown



def _candle_series(bars):
    """What a bar looks like, as numbers a rule can compare.

    Named patterns are deliberately absent. "Hammer" means a lower wick twice the body to one
    writer and two and a half to another, and a constant chosen here is a definition the search
    cannot question — the same reason slope and disparity are operands rather than a built-in
    "pullback" signal. Given the parts, a rule writes the pattern and a sweep tries the ratio:

        hammer          lowerWick > body * 2   AND upperWick < body
        engulfing       close > open[1]        AND open < close[1] AND body > body[1]
        morning star    close[2] < open[2]     AND bodyPct[1] < 30 AND close > bodyMid[2]

    `bodyPct` is the body as a percentage of the whole range, so "small body" survives a change
    of price scale — a 3,000 won body is large on a 10,000 won coin and nothing on Bitcoin.
    """
    o = [b.get("open", b["close"]) for b in bars]
    h = [b["high"] for b in bars]
    lo = [b["low"] for b in bars]
    c = [b["close"] for b in bars]
    rng = [h[i] - lo[i] for i in range(len(bars))]
    body = [abs(c[i] - o[i]) for i in range(len(bars))]
    top = [max(o[i], c[i]) for i in range(len(bars))]
    bot = [min(o[i], c[i]) for i in range(len(bars))]
    return {
        "range": rng,
        "body": [c[i] - o[i] for i in range(len(bars))],      # signed: up bar positive
        "bodyAbs": body,
        "bodyPct": [None if not rng[i] else body[i] / rng[i] * 100.0 for i in range(len(bars))],
        "upperWick": [h[i] - top[i] for i in range(len(bars))],
        "lowerWick": [bot[i] - lo[i] for i in range(len(bars))],
        "bodyTop": top, "bodyBottom": bot,
        "bodyMid": [(top[i] + bot[i]) / 2 for i in range(len(bars))],
        # Distance from the previous close to this open — a gap, signed, zero on the first bar.
        "gap": [0.0 if i == 0 else o[i] - c[i - 1] for i in range(len(bars))],
        # Where price sits inside the whole bar, 0 at the low and 100 at the high.
        "closePos": [None if not rng[i] else (c[i] - lo[i]) / rng[i] * 100.0
                     for i in range(len(bars))],
    }


def _range_pos(bars, n):
    """Where the close sits in the last n bars' range — 0 at the low, 100 at the high.

    "Monthly position" and "weekly position" are this with a timeframe in front. A number rather
    than a verdict: whether 80 is overextended or strong is what the rule and the sweep decide.
    """
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    closes = [b["close"] for b in bars]
    out = []
    for i in range(len(bars)):
        if i + 1 < n:
            out.append(None)
            continue
        hi = max(highs[i - n + 1:i + 1])
        lo = min(lows[i - n + 1:i + 1])
        out.append(None if hi == lo else (closes[i] - lo) / (hi - lo) * 100.0)
    return out


# `close[1]` — the same operand, one bar back. A pattern made of several bars cannot be written
# without it: engulfing and morning star are statements about what the previous bars did, and the
# grammar is one comparison of two values, so the past has to be nameable as a value.
_LAG_REF = re.compile(r"^(.+)\[(\d+)\]$")
_POS_REF = re.compile(r"^pos(?:ition)?(\d+)$", re.IGNORECASE)
# Periods the rule chooses, like the moving averages — so no period list is declared anywhere.
_VMA_REF = re.compile(r"^v(?:ol(?:ume)?)?ma(\d+)$", re.IGNORECASE)
_VRATIO_REF = re.compile(r"^vol(?:ume)?Ratio(\d+)$", re.IGNORECASE)
_VWAP_REF = re.compile(r"^vwap(\d+)$", re.IGNORECASE)
_ROC_REF = re.compile(r"^roc(\d+)$", re.IGNORECASE)
_MOM_REF = re.compile(r"^mom(?:entum)?(\d+)$", re.IGNORECASE)
_HV_REF = re.compile(r"^hv(?:ol)?(\d+)$", re.IGNORECASE)


def _lag(values, n):
    return [None] * min(n, len(values)) + list(values[:max(0, len(values) - n)])


def _base_series(bars, inp):
    """Every fixed indicator, over whatever bars it is handed.

    Pulled out of the action so the same set can be computed on a higher timeframe: a rule saying
    `w.rsi` wants the identical calculation over weekly bars, and a second implementation of it
    would be a second thing to keep correct.
    """
    closes = [b["close"] for b in bars]
    m = macd(closes, int(inp.get("macdFast") or 12), int(inp.get("macdSlow") or 26),
             int(inp.get("macdSignal") or 9))
    bb = bollinger(closes, int(inp.get("bbPeriod") or 20), float(inp.get("bbMult") or 2.0))
    st = stochastic(bars, int(inp.get("stochK") or 14), int(inp.get("stochD") or 3),
                    int(inp.get("stochSmooth") or 3))
    ic = ichimoku(bars, int(inp.get("tenkan") or 9), int(inp.get("kijun") or 26),
                  int(inp.get("senkouB") or 52))
    ad = adx(bars, int(inp.get("adxPeriod") or 14))
    sr = stoch_rsi(closes, int(inp.get("stochRsiPeriod") or 14),
                   int(inp.get("stochRsiK") or 3), int(inp.get("stochRsiD") or 3))
    ev = envelopes(closes, int(inp.get("envPeriod") or 20), float(inp.get("envPct") or 3.0))
    ar = aroon(bars, int(inp.get("aroonPeriod") or 25))
    stt = supertrend(bars, int(inp.get("supertrendPeriod") or 10),
                     float(inp.get("supertrendMult") or 3.0))
    kc = keltner(bars, int(inp.get("keltnerPeriod") or 20),
                 float(inp.get("keltnerMult") or 2.0))
    dc = donchian(bars, int(inp.get("donchianPeriod") or 20))
    pp = pivot_points(bars)
    vols = [b.get("volume", 0) or 0 for b in bars]
    return {
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
        "atr": atr(bars, int(inp.get("atrPeriod") or 14)),
        # ATR as a percentage of price, because a stop written in won means different things on
        # a ninety-million-won coin and a four-hundred-won one.
        "atrPct": [None if (a is None or not c) else a / c * 100.0
                   for a, c in zip(atr(bars, int(inp.get("atrPeriod") or 14)), closes)],
        "adx": ad["adx"], "adx.plusDI": ad["plusDI"], "adx.minusDI": ad["minusDI"],
        "cci": cci(bars, int(inp.get("cciPeriod") or 20)),
        "obv": obv(bars),
        "mfi": mfi(bars, int(inp.get("mfiPeriod") or 14)),
        "williamsR": williams_r(bars, int(inp.get("williamsPeriod") or 14)),
        "stochRsi.k": sr["k"], "stochRsi.d": sr["d"],
        "envelope.mid": ev["mid"], "envelope.upper": ev["upper"], "envelope.lower": ev["lower"],
        # volume
        "ad": ad_line(bars), "cmf": cmf(bars, int(inp.get("cmfPeriod") or 20)),
        "forceIndex": force_index(bars, int(inp.get("forcePeriod") or 13)),
        # 거래대금 — 코인·국내주식은 주수보다 이 금액으로 활발함을 본다.
        "turnover": [closes[i] * vols[i] for i in range(len(bars))],
        # trend
        "aroon.up": ar["up"], "aroon.down": ar["down"], "aroon.osc": ar["osc"],
        "psar": psar(bars, float(inp.get("psarStep") or 0.02),
                     float(inp.get("psarMax") or 0.2)),
        "supertrend": stt["line"], "supertrend.dir": stt["dir"],
        "trix": trix(closes, int(inp.get("trixPeriod") or 15)),
        # volatility
        "keltner.mid": kc["mid"], "keltner.upper": kc["upper"], "keltner.lower": kc["lower"],
        "donchian.mid": dc["mid"], "donchian.upper": dc["upper"], "donchian.lower": dc["lower"],
        # momentum
        "ultOsc": ultimate_osc(bars), "tsi": tsi(closes),
        # price levels
        "typical": [(b["high"] + b["low"] + b["close"]) / 3 for b in bars],
        "median": [(b["high"] + b["low"]) / 2 for b in bars],
        "weightedClose": [(b["high"] + b["low"] + 2 * b["close"]) / 4 for b in bars],
        "pivot.p": pp["p"], "pivot.r1": pp["r1"], "pivot.s1": pp["s1"],
        "pivot.r2": pp["r2"], "pivot.s2": pp["s2"],
        **_candle_series(bars),
    }


def _add_derived(series, closes, refs, bars=None):
    """Moving averages and the things read off them, at whatever periods the rules name.

    Returns the refs it could not measure — a period longer than the series it was given.
    """
    too_long = []
    for ref in refs:
        # Series that need the bars rather than only the closes.
        mb = None
        for rx, kind in ((_VMA_REF, "vma"), (_VRATIO_REF, "vratio"), (_VWAP_REF, "vwap"),
                         (_HV_REF, "hv")):
            mb = rx.match(ref)
            if mb:
                break
        if mb and bars is not None:
            n = int(mb.group(1))
            if n < 1 or n > len(bars):
                too_long.append((ref, n))
                continue
            vols = [b.get("volume", 0) or 0 for b in bars]
            if kind == "vma":
                series[ref] = _sma(vols, n)
            elif kind == "vratio":
                # 평소의 몇 배 — 절대 거래량은 종목마다 단위가 달라 비교가 안 된다.
                base = _sma(vols, n)
                series[ref] = [None if not base[i] else vols[i] / base[i]
                               for i in range(len(bars))]
            elif kind == "vwap":
                tp = [(b["high"] + b["low"] + b["close"]) / 3 for b in bars]
                out = [None] * len(bars)
                for i in range(n - 1, len(bars)):
                    v = sum(vols[i - n + 1:i + 1])
                    out[i] = (None if not v else
                              sum(tp[j] * vols[j] for j in range(i - n + 1, i + 1)) / v)
                series[ref] = out
            else:                                   # historical volatility, % per bar
                cl = [b["close"] for b in bars]
                rets = [None] + [None if not cl[i - 1] else (cl[i] / cl[i - 1] - 1)
                                 for i in range(1, len(cl))]
                out = [None] * len(bars)
                for i in range(n, len(bars)):
                    w = [r for r in rets[i - n + 1:i + 1] if r is not None]
                    if len(w) < 2:
                        continue
                    mean = sum(w) / len(w)
                    out[i] = (sum((x - mean) ** 2 for x in w) / (len(w) - 1)) ** 0.5 * 100.0
                series[ref] = out
            continue
        mc = _ROC_REF.match(ref) or _MOM_REF.match(ref)
        if mc:
            n = int(mc.group(1))
            if n < 1 or n >= len(closes):
                too_long.append((ref, n))
                continue
            is_roc = bool(_ROC_REF.match(ref))
            series[ref] = [None if i < n or (is_roc and not closes[i - n])
                           else ((closes[i] / closes[i - n] - 1) * 100.0 if is_roc
                                 else closes[i] - closes[i - n])
                           for i in range(len(closes))]
            continue
        mp = _POS_REF.match(ref)
        if mp and bars is not None:
            n = int(mp.group(1))
            if n < 1 or n > len(bars):
                too_long.append((ref, n))
            else:
                series[ref] = _range_pos(bars, n)
            continue
        m = _ACCEL_REF.match(ref)
        kind = "accel"
        if not m:
            m = _SLOPE_REF.match(ref)
            kind = "slope"
        if not m:
            m = _DISP_REF.match(ref)
            kind = "disp"
        if not m:
            m = _MA_REF.match(ref)
            kind = None
        if not m:
            continue
        if kind is None:
            ma_kind, period = m.groups()
            n = int(period)
            if n < 1 or n > len(closes):
                too_long.append((ref, n))
                continue
            series[ref] = _ema(closes, n) if ma_kind == "ema" else _sma(closes, n)
            continue
        ema_flag, period = m.groups()
        n = int(period)
        if n < 1 or n > len(closes):
            too_long.append((ref, n))
            continue
        base = _ema(closes, n) if ema_flag else _sma(closes, n)
        if kind == "disp":
            series[ref] = [None if (b is None or not b) else c / b * 100.0
                           for c, b in zip(closes, base)]
            continue
        sl = [None if (i == 0 or base[i] is None or not base[i - 1])
              else (base[i] - base[i - 1]) / base[i - 1] * 100.0
              for i in range(len(base))]
        if kind == "slope":
            series[ref] = sl
        else:
            series[ref] = [None if (i == 0 or sl[i] is None or sl[i - 1] is None)
                           else sl[i] - sl[i - 1]
                           for i in range(len(sl))]
    return too_long


_MA_REF = re.compile(r"^(ma|ema)(\d+)$")
# Two things every trend rule is actually made of, and neither could be written before.
#
# `slope20` — how fast the line is moving, in percent per bar. "Price above the average" says
# nothing about whether the average is rising; a rule that cannot ask ends up buying into decline.
# `disp20` — where price sits against the average, as a percentage (100 = on it). The gap itself
# is the signal in a mean-reversion rule, and comparing `close > ma20` only gives its sign.
#
# Both are derived from the same average the name asks for, so no period list is declared here
# either: `slopeEma50` and `disp5` bring their own.
_SLOPE_REF = re.compile(r"^slope(?:_?(ema))?(\d+)$", re.IGNORECASE)
_DISP_REF = re.compile(r"^disp(?:arity)?(?:_?(ema))?(\d+)$", re.IGNORECASE)
# `accel20` — the change in slope, in percentage points per bar. Slope says the line is rising;
# this says whether it is rising by less than it was.
#
# It exists because a crossover exit is late by construction: by the time a fast average crosses
# back under a slow one, the move it is reporting already happened. What a person watching the
# chart reacts to first is not the turn but the loss of pace — still up, but less each bar. A rule
# had no way to ask that: `slope20 > 0` and `slope20 < 0` are the only two questions available,
# and the interesting moment is between them.
_ACCEL_REF = re.compile(r"^accel(?:eration)?(?:_?(ema))?(\d+)$", re.IGNORECASE)


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



def _wilder(xs, n):
    """Wilder 평활 — RSI·ATR·ADX 가 공유하는 그 평균. 단순이동평균과 값이 다르고,
    표준 정의를 따라야 다른 차트와 숫자가 맞는다."""
    out = [None] * len(xs)
    vals = [x for x in xs if x is not None]
    if len(vals) < n:
        return out
    start = next(i for i in range(len(xs)) if xs[i] is not None)
    if start + n > len(xs):
        return out
    acc = sum(xs[start:start + n]) / n
    out[start + n - 1] = acc
    for i in range(start + n, len(xs)):
        acc = (acc * (n - 1) + (xs[i] or 0.0)) / n
        out[i] = acc
    return out


def true_range(bars):
    """오늘 고저폭과 전일 종가까지의 거리 중 큰 쪽 — 갭을 변동성으로 센다."""
    out = []
    for i, b in enumerate(bars):
        if i == 0:
            out.append(b["high"] - b["low"])
            continue
        pc = bars[i - 1]["close"]
        out.append(max(b["high"] - b["low"], abs(b["high"] - pc), abs(b["low"] - pc)))
    return out


def atr(bars, n=14):
    """평균 진폭. 방향이 아니라 크기라서, 손절 폭을 종목마다 고르는 데 쓰인다 —
    같은 3% 가 어떤 코인엔 잡음이고 어떤 코인엔 추세다."""
    return _wilder(true_range(bars), n)


def adx(bars, n=14):
    """추세의 세기. 방향은 말하지 않는다 — 오르든 내리든 강하면 높다.
    횡보에서 교차 규칙이 난도질당하는 걸 거르는 자리."""
    length = len(bars)
    plus_dm, minus_dm = [0.0] * length, [0.0] * length
    for i in range(1, length):
        up = bars[i]["high"] - bars[i - 1]["high"]
        down = bars[i - 1]["low"] - bars[i]["low"]
        plus_dm[i] = up if (up > down and up > 0) else 0.0
        minus_dm[i] = down if (down > up and down > 0) else 0.0
    tr_s = _wilder(true_range(bars), n)
    p_s, m_s = _wilder(plus_dm, n), _wilder(minus_dm, n)
    plus_di = [None if not tr_s[i] else 100.0 * (p_s[i] or 0) / tr_s[i] for i in range(length)]
    minus_di = [None if not tr_s[i] else 100.0 * (m_s[i] or 0) / tr_s[i] for i in range(length)]
    dx = []
    for i in range(length):
        if plus_di[i] is None or minus_di[i] is None:
            dx.append(None)
            continue
        tot = plus_di[i] + minus_di[i]
        dx.append(None if not tot else 100.0 * abs(plus_di[i] - minus_di[i]) / tot)
    return {"adx": _wilder(dx, n), "plusDI": plus_di, "minusDI": minus_di}


def cci(bars, n=20):
    """전형가가 자기 평균에서 얼마나 떨어졌나 — 평균편차로 나눠 무차원."""
    tp = [(b["high"] + b["low"] + b["close"]) / 3 for b in bars]
    out = [None] * len(bars)
    for i in range(n - 1, len(bars)):
        window = tp[i - n + 1:i + 1]
        mean = sum(window) / n
        dev = sum(abs(x - mean) for x in window) / n
        out[i] = None if not dev else (tp[i] - mean) / (0.015 * dev)
    return out


def obv(bars):
    """거래량을 방향에 따라 누적. 값 자체보다 기울기가 뜻을 갖는다 — `slope` 를 붙여 쓰라고
    시리즈로 둔다."""
    out = [0.0]
    for i in range(1, len(bars)):
        v = bars[i].get("volume") or 0
        c, pc = bars[i]["close"], bars[i - 1]["close"]
        out.append(out[-1] + (v if c > pc else -v if c < pc else 0.0))
    return out


def mfi(bars, n=14):
    """거래량을 실은 RSI — 오른 날 돈이 얼마나 들어왔나."""
    tp = [(b["high"] + b["low"] + b["close"]) / 3 for b in bars]
    flow = [tp[i] * (bars[i].get("volume") or 0) for i in range(len(bars))]
    out = [None] * len(bars)
    for i in range(n, len(bars)):
        pos = sum(flow[j] for j in range(i - n + 1, i + 1) if tp[j] > tp[j - 1])
        neg = sum(flow[j] for j in range(i - n + 1, i + 1) if tp[j] < tp[j - 1])
        out[i] = 100.0 if neg == 0 else 100 - 100 / (1 + pos / neg)
    return out


def williams_r(bars, n=14):
    """고점 대비 현재 위치, −100(바닥) ~ 0(천장). 스토캐스틱 %K 를 뒤집은 눈금."""
    out = [None] * len(bars)
    for i in range(n - 1, len(bars)):
        hi = max(b["high"] for b in bars[i - n + 1:i + 1])
        lo = min(b["low"] for b in bars[i - n + 1:i + 1])
        out[i] = None if hi == lo else -100.0 * (hi - bars[i]["close"]) / (hi - lo)
    return out


def stoch_rsi(closes, n=14, k=3, d=3):
    """RSI 에 스토캐스틱을 다시 씌운 것 — RSI 자신의 범위 안에서 지금 어디쯤인가.
    RSI 가 40~60 만 오가는 구간에서도 과매수·과매도를 가른다."""
    r = rsi(closes, n)
    raw = [None] * len(closes)
    for i in range(len(closes)):
        window = [x for x in r[max(0, i - n + 1):i + 1] if x is not None]
        if len(window) < n or r[i] is None:
            continue
        hi, lo = max(window), min(window)
        raw[i] = None if hi == lo else (r[i] - lo) / (hi - lo) * 100.0
    kk = _sma([x if x is not None else 0.0 for x in raw], k)
    kk = [None if raw[i] is None else kk[i] for i in range(len(raw))]
    dd = _sma([x if x is not None else 0.0 for x in kk], d)
    dd = [None if kk[i] is None else dd[i] for i in range(len(kk))]
    return {"k": kk, "d": dd}


def envelopes(closes, n=20, pct=3.0):
    """이동평균 ± 고정 비율. 볼린저가 변동성으로 넓어지는 반면 이건 폭이 일정해서,
    "평균에서 3% 벗어남"이 언제나 같은 뜻이다."""
    mid = _sma(closes, n)
    f = pct / 100.0
    return {"mid": mid,
            "upper": [None if m is None else m * (1 + f) for m in mid],
            "lower": [None if m is None else m * (1 - f) for m in mid]}



# ── volume ──────────────────────────────────────────────────────────────────────────────────

def _ema_of(xs, n):
    """EMA over a series that starts with blanks.

    Stacked averages — TRIX is three, TSI is four — feed one EMA's output into the next, and that
    output begins with `None` until its own warm-up is over. `_ema` sums its first window
    directly, so the second layer would add a number to nothing. Skip to where the data starts and
    pad the front back on, so a stacked indicator lines up with the bars it came from.
    """
    first = next((i for i, x in enumerate(xs) if x is not None), None)
    if first is None:
        return [None] * len(xs)
    tail = _ema([x for x in xs[first:] if x is not None], n)
    return [None] * first + tail + [None] * (len(xs) - first - len(tail))


def ad_line(bars):
    """누적/분산 — 봉 안에서 종가가 어디에 닫혔나로 거래량을 배분해 누적.
    OBV 가 방향만 보는 반면 이건 봉 안의 위치를 본다(꼬리 긴 봉을 덜 센다)."""
    out, acc = [], 0.0
    for b in bars:
        rng = b["high"] - b["low"]
        mult = 0.0 if not rng else ((b["close"] - b["low"]) - (b["high"] - b["close"])) / rng
        acc += mult * (b.get("volume") or 0)
        out.append(acc)
    return out


def cmf(bars, n=20):
    """차이킨 자금흐름 — A/D 를 기간 거래량으로 정규화해 −1~+1. 누적값과 달리 비교 가능하다."""
    out = [None] * len(bars)
    mfv = []
    for b in bars:
        rng = b["high"] - b["low"]
        mult = 0.0 if not rng else ((b["close"] - b["low"]) - (b["high"] - b["close"])) / rng
        mfv.append(mult * (b.get("volume") or 0))
    for i in range(n - 1, len(bars)):
        vol = sum((bars[j].get("volume") or 0) for j in range(i - n + 1, i + 1))
        out[i] = None if not vol else sum(mfv[i - n + 1:i + 1]) / vol
    return out


def force_index(bars, n=13):
    """가격 변화 × 거래량 — 움직임이 거래를 동반했는지. 거래 없는 급등을 걸러낸다."""
    raw = [0.0] + [(bars[i]["close"] - bars[i - 1]["close"]) * (bars[i].get("volume") or 0)
                   for i in range(1, len(bars))]
    return _ema_of(raw, n)


# ── trend ───────────────────────────────────────────────────────────────────────────────────
def aroon(bars, n=25):
    """마지막 고점·저점이 얼마나 최근인가 — 추세의 나이. ADX 가 세기를 재는 자리에서
    이건 신선도를 잰다."""
    up, down = [None] * len(bars), [None] * len(bars)
    for i in range(n, len(bars)):
        window = bars[i - n:i + 1]
        hi = max(range(len(window)), key=lambda j: window[j]["high"])
        lo = min(range(len(window)), key=lambda j: window[j]["low"])
        up[i] = 100.0 * hi / n
        down[i] = 100.0 * lo / n
    return {"up": up, "down": down,
            "osc": [None if up[i] is None else up[i] - down[i] for i in range(len(bars))]}


def psar(bars, step=0.02, cap=0.2):
    """포물선 SAR — 추세를 따라 올라오는 손절선. 값 자체가 청산 가격이라 규칙이 바로 쓴다."""
    n = len(bars)
    out = [None] * n
    if n < 2:
        return out
    rising = bars[1]["close"] >= bars[0]["close"]
    sar = bars[0]["low"] if rising else bars[0]["high"]
    ep = bars[0]["high"] if rising else bars[0]["low"]
    af = step
    for i in range(1, n):
        sar = sar + af * (ep - sar)
        if rising:
            sar = min(sar, bars[i - 1]["low"], bars[max(0, i - 2)]["low"])
            if bars[i]["low"] < sar:
                rising, sar, ep, af = False, ep, bars[i]["low"], step
            elif bars[i]["high"] > ep:
                ep, af = bars[i]["high"], min(af + step, cap)
        else:
            sar = max(sar, bars[i - 1]["high"], bars[max(0, i - 2)]["high"])
            if bars[i]["high"] > sar:
                rising, sar, ep, af = True, ep, bars[i]["high"], step
            elif bars[i]["low"] < ep:
                ep, af = bars[i]["low"], min(af + step, cap)
        out[i] = sar
    return out


def supertrend(bars, n=10, mult=3.0):
    """ATR 폭의 추세선. 값은 지지·저항선이고 `dir` 은 +1/−1 — 방향을 숫자로 물을 수 있다."""
    a = atr(bars, n)
    line, direction = [None] * len(bars), [None] * len(bars)
    prev_up = prev_dn = None
    up_trend = True
    for i, b in enumerate(bars):
        if a[i] is None:
            continue
        mid = (b["high"] + b["low"]) / 2
        up, dn = mid - mult * a[i], mid + mult * a[i]
        if prev_up is not None:
            up = max(up, prev_up) if bars[i - 1]["close"] > prev_up else up
            dn = min(dn, prev_dn) if bars[i - 1]["close"] < prev_dn else dn
            up_trend = True if b["close"] > prev_dn else False if b["close"] < prev_up else up_trend
        line[i] = up if up_trend else dn
        direction[i] = 1.0 if up_trend else -1.0
        prev_up, prev_dn = up, dn
    return {"line": line, "dir": direction}


def trix(closes, n=15):
    """삼중 지수평활의 변화율 — 잡음을 세 번 걷어낸 모멘텀."""
    e = _ema_of(_ema_of(_ema(closes, n), n), n)
    return [None if (i == 0 or e[i] is None or not e[i - 1]) else (e[i] - e[i - 1]) / e[i - 1] * 100.0
            for i in range(len(e))]


# ── volatility ──────────────────────────────────────────────────────────────────────────────
def keltner(bars, n=20, mult=2.0, atr_n=10):
    """EMA ± ATR 배수. 볼린저가 표준편차를 쓰는 자리에 진폭을 쓴다 — 갭을 반영한다."""
    closes = [b["close"] for b in bars]
    mid = _ema(closes, n)
    a = atr(bars, atr_n)
    return {"mid": mid,
            "upper": [None if (mid[i] is None or a[i] is None) else mid[i] + mult * a[i]
                      for i in range(len(bars))],
            "lower": [None if (mid[i] is None or a[i] is None) else mid[i] - mult * a[i]
                      for i in range(len(bars))]}


def donchian(bars, n=20):
    """n기간 최고·최저. 돌파 전략이 묻는 바로 그 선."""
    up, lo = [None] * len(bars), [None] * len(bars)
    for i in range(n - 1, len(bars)):
        up[i] = max(b["high"] for b in bars[i - n + 1:i + 1])
        lo[i] = min(b["low"] for b in bars[i - n + 1:i + 1])
    return {"upper": up, "lower": lo,
            "mid": [None if up[i] is None else (up[i] + lo[i]) / 2 for i in range(len(bars))]}


# ── momentum ────────────────────────────────────────────────────────────────────────────────
def ultimate_osc(bars, s=7, m=14, l=28):
    """세 기간을 가중 합산 — 한 기간만 보는 오실레이터의 기간 의존성을 줄인다."""
    bp, tr = [], []
    for i, b in enumerate(bars):
        pc = bars[i - 1]["close"] if i else b["close"]
        bp.append(b["close"] - min(b["low"], pc))
        tr.append(max(b["high"], pc) - min(b["low"], pc))
    out = [None] * len(bars)
    for i in range(l, len(bars)):
        def avg(k):
            t = sum(tr[i - k + 1:i + 1])
            return None if not t else sum(bp[i - k + 1:i + 1]) / t
        a1, a2, a3 = avg(s), avg(m), avg(l)
        if None in (a1, a2, a3):
            continue
        out[i] = 100.0 * (4 * a1 + 2 * a2 + a3) / 7
    return out


def tsi(closes, long_n=25, short_n=13):
    """진짜 강도 지수 — 가격 변화를 두 번 평활해 부호까지 안정시킨다."""
    diff = [0.0] + [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    d1 = _ema_of(_ema(diff, long_n), short_n)
    a1 = _ema_of(_ema([abs(x) for x in diff], long_n), short_n)
    return [None if (d1[i] is None or not a1[i]) else 100.0 * d1[i] / a1[i]
            for i in range(len(closes))]


def pivot_points(bars):
    """전일 고저종으로 낸 고전 피벗 — 오늘의 지지·저항. 값이 가격이라 규칙이 바로 비교한다."""
    p = [None] * len(bars)
    r1 = [None] * len(bars); s1 = [None] * len(bars)
    r2 = [None] * len(bars); s2 = [None] * len(bars)
    for i in range(1, len(bars)):
        h, l, c = bars[i - 1]["high"], bars[i - 1]["low"], bars[i - 1]["close"]
        pv = (h + l + c) / 3
        p[i] = pv
        r1[i] = 2 * pv - l
        s1[i] = 2 * pv - h
        r2[i] = pv + (h - l)
        s2[i] = pv - (h - l)
    return {"p": p, "r1": r1, "s1": s1, "r2": r2, "s2": s2}


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
    """The previous session's official close — stated by the source when it says so, inferred otherwise.

    The live scoreboard needs a fixed baseline: a client that only carries today's bars cannot know
    yesterday's close, and realtime frames carry change only while the market is open, so after the
    close the figure would simply vanish.

    Prefer a stated value. Inferring it as "the last bar of the previous calendar day" is wrong the
    moment the series covers an extended session: on SOR (KRX+NXT) the last bar of yesterday is an
    after-hours print at 18:57, not the 15:30 close, which showed SK Hynix at +23.11% against
    1,359,000 when the real close was 1,322,000 (2026-07-31). Cutting by clock time instead would
    put one market's trading hours into a module that must not know any.
    """
    if not bars:
        return None
    stated = bars[-1].get("prevClose")
    if isinstance(stated, (int, float)) and stated > 0:
        return float(stated)
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

    if action in ("signals", "backtest"):
        # 데이 트레이딩 뷰 — 마지막 거래일 봉만. 시계·타임존에 의존하지 않고 **데이터의 최신
        # 날짜**로 자른다(장 시작 전엔 전일이 마지막 세션이라 그대로 맞다). 지표는 잘린 구간만
        # 보고 계산하므로 warmup 이 부족할 수 있다 — 그 사실을 응답에 밝힌다.
        prev_close = _prev_session_close(bars)
        bars, bar_range = _apply_bar_range(bars, bar_range, inp.get("barRange"))
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
        series = _base_series(bars, inp)

        # Moving averages, at whatever periods the rules actually name.
        #
        # The vocabulary above had none — bollinger.mid is an SMA(20) and ichimoku carries midpoints,
        # but the plainest trend line in technical analysis was absent, so the most common strategy
        # there is could not be written at all: `ma50 crossUp ma200` was rejected as an unknown path
        # (2026-07-31, a golden-cross request). Periods are read off the rules instead of declared,
        # so 5/20/60/120 and 50/200 all work without this module choosing a convention.
        written_refs = [str(c.get(side)) for r in rules for c in (r.get("when") or [])
                        for side in ("a", "b") if isinstance(c.get(side), str)]
        # `close[1]` is `close`, shifted. Resolve the name first and shift afterwards, so the lag
        # composes with everything — a moving average, a higher timeframe, a candle part — instead
        # of being a third list of things that support it.
        lagged = {}
        every_ref = []
        for ref in written_refs:
            ml = _LAG_REF.match(ref)
            if ml:
                lagged[ref] = (ml.group(1), int(ml.group(2)))
                every_ref.append(ml.group(1))
            else:
                every_ref.append(ref)

        # Operands carrying a timeframe, grouped so each higher series is computed once.
        higher_in = inp.get("higher") if isinstance(inp.get("higher"), dict) else {}
        refs_by_tf = {}
        for ref in set(every_ref):
            mm = _TF_PREFIX.match(ref)
            if not mm:
                continue
            key = _tf_key(mm.group(1))
            if key not in higher_in and mm.group(1) not in higher_in:
                refs_by_tf.setdefault(key, set())
                continue
            refs_by_tf.setdefault(key if key in higher_in else mm.group(1),
                                  set()).add((ref, mm.group(2)))
        hi_series, hi_missing, hi_unknown = _higher_series(higher_in, inp, refs_by_tf, bars)
        series.update(hi_series)
        if hi_unknown:
            print(json.dumps({"success": False, "error":
                "상위 주기에 없는 경로: %s — 접두사 뒤는 평소 쓰는 이름 그대로입니다"
                % ", ".join(sorted(hi_unknown))}, ensure_ascii=False))
            return
        if hi_missing:
            print(json.dumps({"success": False, "error":
                "규칙이 %s 주기를 쓰는데 `higher` 에 그 봉이 없습니다 — 조건이 거짓인 것과 "
                "봉을 안 받은 것은 다른 문제라 조용히 넘어가지 않습니다."
                % ", ".join(sorted(hi_missing))}, ensure_ascii=False))
            return
        ma_refs = sorted({r for r in every_ref if _MA_REF.match(r)})
        derived = sorted({r for r in every_ref
                          if _SLOPE_REF.match(r) or _DISP_REF.match(r)
                          or _ACCEL_REF.match(r) or _POS_REF.match(r)
                          or _VMA_REF.match(r) or _VRATIO_REF.match(r) or _VWAP_REF.match(r)
                          or _ROC_REF.match(r) or _MOM_REF.match(r) or _HV_REF.match(r)})
        # One implementation, used here and for every higher timeframe.
        ma_used = [(_MA_REF.match(r).groups()[0], int(_MA_REF.match(r).groups()[1]))
                   for r in ma_refs if _MA_REF.match(r)]
        too_long = _add_derived(series, closes, list(ma_refs) + list(derived), bars)

        if too_long:
            print(json.dumps({"success": False, "error":
                "이동평균 기간이 봉 수(%d)보다 깁니다: %s — 그만큼의 과거 봉을 더 실어 주십시오"
                % (len(closes), ", ".join("%s(%d)" % (r, n) for r, n in too_long))},
                ensure_ascii=False))
            return

        def val(ref, i):
            if isinstance(ref, (int, float)):
                return float(ref)
            sq = series.get(str(ref))
            if sq is None or i >= len(sq):
                return None
            v = sq[i]
            return None if v is None else float(v)

        # The shift, applied last, so `close[1]`, `ma20[2]` and `w.body[1]` all work without any
        # of them knowing about the others.
        for ref, (inner, n) in lagged.items():
            if inner in series:
                series[ref] = _lag(series[inner], n)

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
                    # `side` travels with the point. buyPoints/sellPoints keep it separate, but
                    # `firedOnLastClosedBar` merges both lists, and a caller reading that one had
                    # no way back to the rule — it had to guess the direction from the label text.
                    # A rule that declared side "buy" and labelled itself "ma5 crossUp ma20" then
                    # traded nothing, and looked exactly like a quiet day.
                    bucket.append({"date": b["date"], "price": round(b["close"], 6), "side": side,
                                   "label": label, "note": r.get("note") or None})
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
        # ── 분할청산 사다리 ──
        # 익절 목표가 하나뿐이면 폭을 넓힐수록 승률이 떨어지고 좁힐수록 추세를 못 먹는다 —
        # 격자 탐색이 그 둘 사이에서 타협하고 있었다. 사다리는 그 타협을 없앤다: 일부는 일찍
        # 확정하고 나머지는 끌고 간다. `sellPct` 는 **원래 수량 기준 누적**이라 "12%에서 전량"이
        # 곧 100 이고, 칸이 겹치거나 총합이 넘는 선언은 여기서 거부한다.
        # 목표 하나짜리는 사다리 한 칸으로 흡수한다 — 청산 경로가 둘로 갈리지 않게.
        ladder, ladder_err = _parse_scale_out(inp.get("scaleOut"), take_pct * 100)
        # 진입 사다리 — 신호 한 번에 전량이 아니라 "일부 지금, 더 빠지면 더". 실거래 엔진과 같은
        # 어휘를 여기서도 써야 측정한 것과 거래하는 것이 같아진다.
        entry_rungs, entry_err = _parse_scale_in(inp.get("scaleIn"))
        if ladder_err or entry_err:
            print(json.dumps({"success": False, "error": ladder_err or entry_err},
                             ensure_ascii=False))
            return
        # ── ATR 단위 → 진입 시점에 한 번 % 로 확정 ──
        # 폭을 %로 적으면 종목마다 다른 것을 같은 이름으로 부르게 된다. **진입 시점의 ATR 로 한 번
        # 환산해 고정한다** — 매 봉 다시 환산하면 칸이 포지션 밑에서 움직여, 평단을 기준으로 삼은
        # 진입 사다리가 스스로를 쫓아 내려가던 것과 같은 사고가 난다. 앵커는 움직이지 않는다.
        atr_series = atr(bars, int(inp.get("atrPeriod") or 14))
        atr_pct_at = {}
        for i, b in enumerate(bars):
            a, c = atr_series[i], b.get("close")
            atr_pct_at[b["date"]] = None if (a is None or not c) else a / c * 100.0
        stop_atr = float(inp.get("stopLossAtr") or 0.0)
        take_atr = float(inp.get("takeProfitAtr") or 0.0)
        trail_atr = float(inp.get("trailingStopAtr") or 0.0)
        if take_atr > 0 and not inp.get("scaleOut"):
            ladder = [{"moveAtr": take_atr, "filled": 1.0}]

        def _resolve(rungs, apct):
            """ATR 로 적힌 칸을 이 진입의 %로. %로 적힌 칸은 그대로 지나간다."""
            if not any(r.get("moveAtr") is not None for r in rungs):
                return rungs
            out = []
            for r in rungs:
                if r.get("moveAtr") is None:
                    out.append(r)
                    continue
                c = dict(r)
                c["move"] = r["moveAtr"] * apct
                out.append(c)
            return out

        def _needs_atr(rungs):
            return any(r.get("moveAtr") is not None for r in rungs)

        buy_at = {p["date"]: p for p in buy}
        sell_at = {p["date"]: p for p in sell}

        _HIDE = ("peak", "held", "sold", "acquired", "anchorPrice",
                 "ladder", "entryRungs", "stopPct", "trailPct")

        def _close_trade(pos, date, raw_px, label, reason, portion=None):
            exit_px = max(raw_px * (1 - slip) - tick_slip, 0.0)
            # 곱셈으로 — 매입원가 = 체결가×(1+수수료), 매도수취 = 체결가×(1-수수료-세금).
            cost = pos["entryPrice"] * (1 + fee)
            proceeds = exit_px * (1 - fee - tax)
            net = proceeds / cost - 1 if cost else 0.0
            part = pos["held"] if portion is None else portion
            return {**{k: v for k, v in pos.items() if k not in _HIDE},
                    "exitDate": date, "exitPrice": round(exit_px, 6),
                    "exitLabel": label, "exitReason": reason,
                    # 이 체결이 **전체 계획 규모**의 얼마였나. 사다리를 안 쓰면 항상 1이고, 진입을
                    # 나눠 담았으면 그만큼 자본이 덜 들어가 있었다는 뜻이라 자본 반영도 그 몫만큼.
                    "portion": round(part, 6),
                    "closesPosition": (pos["held"] - part) <= 1e-9,
                    "returnPct": round(net * 100, 4),
                    "grossPct": round((exit_px / pos["entryPrice"] - 1) * 100, 4)}

        # Where a signal is assumed to fill.
        #
        # The signal is computed FROM the close, so the close is the one price you could not have
        # traded at: you learn the rule fired at the instant the bar ends. Filling at the next
        # bar's open is what actually happens, and at scalping frequency the gap between the two
        # is routinely larger than any slippage assumption. `close` remains available for
        # comparison, but it flatters every rule and is not the default.
        fill_at = str(inp.get("fillAt") or "nextOpen")
        if fill_at not in ("nextOpen", "close"):
            print(json.dumps({"success": False,
                              "error": f"fillAt='{fill_at}' 은 nextOpen 또는 close 입니다."},
                             ensure_ascii=False))
            return
        next_open = {}
        if fill_at == "nextOpen":
            for i in range(len(bars) - 1):
                nxt = bars[i + 1]
                try:
                    px = float(nxt.get("open", nxt.get("Open", nxt.get("close"))))
                except (TypeError, ValueError):
                    continue
                if px > 0:
                    next_open[bars[i]["date"]] = px

        def fill_price(date, signalled):
            # A signal on the final bar has no next bar to fill in — the trade never happened.
            return next_open.get(date) if fill_at == "nextOpen" else signalled

        trades, pos = [], None
        for b in bars:
            date = b["date"]
            if pos is not None:
                entry = pos["entryPrice"]
                pos["peak"] = max(pos.get("peak", entry), b["high"])
                # 같은 봉에서 손절·익절이 다 닿을 수 있다 — 봉 안 순서는 알 수 없으므로
                # **손절이 먼저 닿았다고 본다**(낙관 금지). 손절·트레일링·룰매도는 남은 전부를
                # 정리한다: 사다리는 이익을 나눠 걷는 장치이지 손실을 나눠 무는 장치가 아니다.
                # 폭은 이 포지션이 열릴 때 확정된 값이다 — 선언이 ATR 로 쓰였으면 그때의 변동성.
                p_stop, p_trail = pos["stopPct"], pos["trailPct"]
                if p_stop > 0 and b["low"] <= entry * (1 - p_stop):
                    trades.append(_close_trade(pos, date, entry * (1 - p_stop), "손절", "stop"))
                    pos = None
                elif p_trail > 0 and b["low"] <= pos["peak"] * (1 - p_trail):
                    trades.append(_close_trade(pos, date, pos["peak"] * (1 - p_trail),
                                               "트레일링", "trailing"))
                    pos = None
                else:
                    age = _days_between(pos["entryDate"], date)
                    # 진입 사다리 — 아직 다 담지 않았고, 이 봉의 **저가**가 다음 칸까지 내려왔다면
                    # 거기서 더 담는다. 기준은 첫 진입가다(평단은 담을 때마다 내려가므로 평단을
                    # 기준으로 하면 칸이 스스로를 쫓아 내려가 끝나지 않는다).
                    if pos["acquired"] < 1.0 - 1e-9:
                        drop = (pos["anchorPrice"] - b["low"]) / pos["anchorPrice"] * 100.0
                        idx, add = _highest_due(pos["entryRungs"], drop, age, pos["acquired"])
                        if idx is not None and add > 1e-9:
                            rung = pos["entryRungs"][idx]
                            at_px = (pos["anchorPrice"] * (1 - rung["move"] / 100.0)
                                     if rung.get("move") is not None else b["open"])
                            add_px = at_px * (1 + slip) + tick_slip
                            total = pos["acquired"] + add
                            pos["entryPrice"] = (pos["entryPrice"] * pos["acquired"]
                                                 + add_px * add) / total
                            pos["acquired"], pos["held"] = total, pos["held"] + add
                            entry = pos["entryPrice"]
                    # 청산 사다리 — 이 봉의 고가가 닿은 칸을 낮은 것부터. 한 봉이 두 칸을 뛰어넘을
                    # 수 있고, 그때 두 번 파는 게 맞다(칸마다 가격이 다르다). 누적 비율의 기준은
                    # **실제로 담은 만큼**이라, 마지막 칸 100% 는 언제나 전량 청산이다.
                    for k, rung in enumerate(pos["ladder"]):
                        if pos is None:
                            break
                        sold_frac = 1.0 - pos["held"] / pos["acquired"] if pos["acquired"] else 1.0
                        if rung["filled"] <= sold_frac + 1e-9:
                            continue
                        if not _rung_due(rung, (b["high"] / entry - 1) * 100.0, age):
                            # `continue`, not `break`: a later rung may be timed rather than
                            # priced, and a price this bar did not reach says nothing about it.
                            continue
                        target = (entry * (1 + rung["move"] / 100.0)
                                  if rung.get("move") is not None else b["open"])
                        part = min((rung["filled"] - sold_frac) * pos["acquired"], pos["held"])
                        if part <= 1e-9:
                            continue
                        n_rungs = len(pos["ladder"])
                        label = "익절" if n_rungs == 1 else "분할익절 %d/%d" % (k + 1, n_rungs)
                        trades.append(_close_trade(pos, date, target, label, "take", part))
                        pos["sold"] += part
                        pos["held"] -= part
                        if pos["held"] <= 1e-9:
                            pos = None
                    if pos is not None and date in sell_at:
                        m = sell_at[date]
                        px = fill_price(date, m["price"])
                        if px is not None:
                            trades.append(_close_trade(pos, date, px, m["label"], "rule"))
                            pos = None
            if pos is None and date in buy_at:
                m = buy_at[date]
                px = fill_price(date, m["price"])
                if px is not None:
                    apct = atr_pct_at.get(date)
                    # 변동성을 못 읽으면 칸을 정할 수 없다 — 폭을 추측해서 여는 것보다 안 여는
                    # 게 낫다. %로만 적힌 선언은 ATR 이 없어도 그대로 돈다.
                    if apct is None and (_needs_atr(ladder) or _needs_atr(entry_rungs)
                                         or stop_atr > 0 or trail_atr > 0):
                        continue
                    opened = px * (1 + slip) + tick_slip
                    pos_ladder = _resolve(ladder, apct)
                    pos_entry = _resolve(entry_rungs, apct)
                    first = pos_entry[0]["filled"] if pos_entry else 1.0
                    pos = {"entryDate": date, "entryPrice": opened, "anchorPrice": opened,
                           "entryLabel": m["label"], "peak": px,
                           "acquired": first, "held": first, "sold": 0.0,
                           "ladder": pos_ladder, "entryRungs": pos_entry,
                           "stopPct": stop_pct if stop_pct > 0 else (stop_atr * apct / 100.0
                                                                     if stop_atr > 0 else 0.0),
                           "trailPct": trail_pct if trail_pct > 0 else (trail_atr * apct / 100.0
                                                                        if trail_atr > 0 else 0.0)}
        wins = [t for t in trades if t["returnPct"] > 0]
        # 각 체결이 원래 수량의 일부일 수 있으므로 **그 몫만큼만** 자본에 반영한다. 사다리를 안
        # 쓰면 portion 이 1 이라 옛 계산과 같은 값이 나온다.
        equity = 1.0
        for t in trades:
            equity *= 1 + t["returnPct"] / 100 * t["portion"]
        peak = run = 1.0
        mdd = 0.0
        for t in trades:
            run *= 1 + t["returnPct"] / 100 * t["portion"]
            peak = max(peak, run)
            mdd = min(mdd, run / peak - 1)
        backtest = {
            "trades": trades,
            "openPosition": ({k: v for k, v in pos.items() if k != "peak"}
                             if pos else None),
            "tradeCount": len(trades),
            "winRate": round(len(wins) / len(trades) * 100, 2) if trades else None,
            "totalReturnPct": round((equity - 1) * 100, 4) if trades else None,
            "avgReturnPct": round(sum(t["returnPct"] for t in trades) / len(trades), 4) if trades else None,
            "bestPct": max((t["returnPct"] for t in trades), default=None),
            "worstPct": min((t["returnPct"] for t in trades), default=None),
            "maxDrawdownPct": round(mdd * 100, 4) if trades else None,
            # What holding the thing would have done over the same bars. A return without this is
            # not a result: a rule that made 138% in a window where the stock made 189% lost money
            # against doing nothing, and the raw number reads like a triumph (measured 2026-08-01,
            # 삼성전자 1년). Always the same window the rules were evaluated on.
            "buyHoldPct": round((bars[-1]["close"] / bars[0]["close"] - 1) * 100, 4)
                          if len(bars) > 1 and bars[0].get("close") else None,
            "feeRate": fee, "taxRate": tax, "slippageRate": slip, "fillAt": fill_at,
            "stopLossPct": stop_pct * 100, "takeProfitPct": take_pct * 100,
            "scaleOut": ([{k: v for k, v in (("gainPct", r.get("move")),
                                             ("afterDays", r.get("afterDays")),
                                             ("sellPct", round(r["filled"] * 100, 4)))
                            if v is not None} for r in ladder] or None),
            "scaleIn": ([{k: v for k, v in (("dropPct", r.get("move")),
                                            ("afterDays", r.get("afterDays")),
                                            ("buyPct", round(r["filled"] * 100, 4)))
                          if v is not None} for r in entry_rungs]
                        if inp.get("scaleIn") else None),
            # 왕복 횟수 — 사다리를 쓰면 체결 수가 왕복 수보다 많다. 둘을 섞으면 "체결 20건 이상"
            # 같은 바가 실제보다 쉽게 통과한다.
            "roundTrips": sum(1 for t in trades if t.get("closesPosition")),
            "trailingStopPct": trail_pct * 100,
            "tickSize": tick_size, "slippageTicks": slip_ticks,
            "assumptions": ("롱 전용·1포지션·전량, 신호 봉 종가 체결 가정. 비용은 부과 시점이 달라 "
                            "따로 받습니다 — 수수료(feeRate)=매수·매도 양쪽 / 세금(taxRate)=**매도에만** / "
                            "슬리피지(slippageRate)=체결가 자체가 밀리는 폭. 셋 다 0이면 실제보다 좋게 "
                            "나옵니다. 각 체결의 grossPct(비용 전)와 returnPct(비용 후)를 비교하면 "
                            "비용이 얼마나 먹는지 보이고, 1분봉처럼 체결이 잦을수록 그 차이가 커집니다. "
                            "실매매처럼 한 틱 위/아래 지정가를 가정하려면 tickSize + slippageTicks 로 "
                            "절대금액을 주세요(비율만 쓰면 가격대에 따라 크게 어긋납니다). "
                            "**사다리 칸은 목표가에 정확히 체결됐다고 봅니다** — 봉의 고가·저가가 "
                            "그 값을 지났으면 거기서 체결된 것으로 칩니다. 실거래는 사이클이 도는 "
                            "순간의 가격 하나로 판단하므로 칸을 지나쳐 있으면 그 가격에 나갑니다 — "
                            "즉 이 백테스트는 분할 체결가에 대해 낙관적입니다. "
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
        # Whoever produced the signal knows which averages it turned on, so it says so rather than
        # leaving the caller to guess: a golden-cross answer whose chart draws MA5 and MA20 does not
        # show the cross it is describing. Same rule as the annotations — the side that emits the
        # coordinates emits what they refer to.
        chart_indicators = ["MA%d" % n for kind, n in sorted(set(ma_used), key=lambda x: x[1])
                            if kind == "ma"]
        blocks = [
            {"type": "stock_chart", "props": {
                "buyPoints": buy, "sellPoints": sell,
                **({"indicators": chart_indicators} if chart_indicators else {}),
                **({"prevClose": prev_close} if prev_close is not None else {}),
                # No bar array here. Entries and exits are placed BY DATE, so this action has no
                # reason to own the display range, and owning it would let a deliberately narrow
                # analysis window overwrite the whole chart — measured: a wave count needs history
                # to find pivots at all, and it was left with 32 bars of the current session.
            }},
        ]
        # 한 줄에 하나씩 쌓이면 스크롤만 길어진다 — 관련된 것끼리 Grid 한 줄로 묶어 내보낸다.
        # The four indicators (RSI, MACD histogram, Bollinger %B, stochastic %K) belong to the live
        # board. Emitting them as cards here too would put a figure frozen at page-load time next to
        # one moving with every tick, leaving the reader to work out which is current.
        _ = live_now
        # No win-rate, cumulative-return or drawdown cards: those are computed from the fills in
        # this window alone, so they change whenever the window does. Whoever holds the accumulated
        # record should present them; the records below are the material for it.
        blocks.append({"type": "paper_trades", "props": {"records": trades}})
        if action == "backtest":
            # Same computation, different question. `signals` is asked "what fired, and where do
            # I draw it"; `backtest` is asked "would this rule have made money" — so the numbers
            # come first and the chart coordinates are dropped. Keeping it an alias rather than a
            # separate path means the rule that gets measured is exactly the rule that trades.
            print(json.dumps({"success": True, "data": {
                "backtest": backtest,
                "barRange": bar_range,
                "counts": {"buy": len(buy), "sell": len(sell)},
                "trades": trades,
                "note": (
                    "체결 수가 적으면 승률·수익률은 우연과 구분되지 않습니다. 고른 구간에서만 "
                    "좋은 규칙을 피하려면 `barRange` 로 한 구간에서 고르고 다른 구간에서 채점하세요."
                ),
            }}, ensure_ascii=False))
            return
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
        prev_close = _prev_session_close(bars)
        if inp.get("lastSessionOnly"):
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
                "label": "카운트 무효 기준", "value": inv.get("price"),
                "subLabel": ("이 위로 가면 카운트 무효" if inv.get("beyond") == "above"
                             else "이 아래로 가면 카운트 무효")}},
        ]
        print(json.dumps({"success": True, "data": {
            "blocks": [{"type": "stock_chart", "props": {
                "annotations": ann,
                **({"prevClose": prev_close} if prev_close is not None else {}),
                # 여백은 **주석이 실제로 쓰는 만큼**. 옛 코드는 project_bars 를 그대로 넣었는데,
                # 예상 경로의 시간 좌표는 앞선 다리 길이에서 나오므로 그보다 멀리 갈 수 있다
                # (실측: futureSlots 16 인데 예상선이 +20·+41봉 → 화면 밖이라 아예 안 보임).
                "futureSlots": future_slots,
                # Annotation coordinates are bar INDICES, so whoever emits them must also emit the
                # array they index — a chart holding a different range would draw the wave on the
                # wrong candles.
                "data": [{"date": b["date"], "open": b.get("open", b["close"]), "high": b["high"],
                          "low": b["low"], "close": b["close"], "volume": b.get("volume", 0)}
                         for b in bars],
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

    if action == "reach_levels":
        # 고점은 못 맞힌다 — 거울선·정배열·가속·칼만 넷을 26종목 58,928 일봉에서 재고 전부
        # 떨어뜨렸다(2026-08-04). 맞힐 수 있는 건 "여기까지 올 확률"이다. 그래서 이 액션은 점을
        # 찍지 않고 **가격마다 확률을 붙인다** — 매도가 "지금이 꼭대기인가" 대신 "이 값까지
        # 얼마나 팔아 놓을까"가 된다.
        #
        # 폭의 단위는 퍼센트가 아니라 ATR 이다. 같은 3% 가 어떤 종목에선 숨 한 번, 어떤
        # 종목에선 며칠치라 퍼센트 눈금은 종목마다 다른 것을 같은 이름으로 부른다.
        horizon = max(1, min(2000, int(_num_or(inp.get("horizonBars"), 60))))
        n_atr = max(2, min(200, int(_num_or(inp.get("atrPeriod"), 20))))
        mults = inp.get("atrMultiples")
        if not isinstance(mults, list) or not mults:
            mults = [1, 2, 3]
        try:
            mults = sorted({round(float(m), 3) for m in mults if float(m) > 0})
        except (TypeError, ValueError):
            print(json.dumps({"success": False,
                              "error": "atrMultiples 는 0 보다 큰 숫자 배열입니다."}, ensure_ascii=False))
            return
        a_ser = atr(bars, n_atr)
        highs = [b["high"] for b in bars]
        lows = [b["low"] for b in bars]
        # 표본은 겹친다(하루씩 밀며 같은 미래를 본다) — 점추정에는 쓰되 **유효 표본은 지평으로
        # 나눈 값**이라 그 숫자를 같이 내보낸다. 오늘 이 함정으로 +8%p 짜리 결과가 한 번 증발했다.
        #
        # 위아래를 같이 센다. 위만 세면 이 화면은 "얼마나 팔아 놓을까" 에만 답하고 매수 사다리를
        # 놓을 때는 아무 말도 안 한다 — 떨어지면 사는 전략에 정작 하락 확률이 없는 것이다.
        # 아래쪽은 저가로 재고 부호만 뒤집는다(하락 폭도 양수로 센다).
        samples, paths = [], []
        dn_samples, dn_paths = [], []
        for t in range(len(bars) - horizon - 1):
            a, c = a_ser[t], bars[t]["close"]
            if not a or not c:
                continue
            # 경로를 ATR 단위로 그대로 들고 간다 — 조건부 확률은 "먼저 닿은 시점 이후"만 봐야 해서
            # 최고값 하나로는 못 센다. 남은 시간이 줄어든다는 게 그 조건의 핵심이다.
            walk = [(h - c) / a for h in highs[t + 1:t + 1 + horizon]]
            samples.append(max(walk))
            paths.append(walk)
            dwalk = [(c - l) / a for l in lows[t + 1:t + 1 + horizon]]
            dn_samples.append(max(dwalk))
            dn_paths.append(dwalk)
        last, last_atr = bars[-1], a_ser[-1]
        if not samples or not last_atr:
            print(json.dumps({"success": True, "data": {
                "blocks": [{"type": "stock_chart", "props": {"annotations": []}}],
                "levels": [], "records": [],
                "summary": {"reason": ("봉이 지평보다 적어 확률을 낼 수 없습니다 — "
                                       f"봉 {len(bars)}개, 지평 {horizon}봉."),
                            "horizonBars": horizon, "bars": len(bars)},
                "barRange": bar_range,
            }}, ensure_ascii=False))
            return
        px = last["close"]
        at_ms = int(_num_or(inp.get("asOfMs"), 0)) or None
        levels, records = [], []

        def _rungs(sample_set, path_set, sign):
            """한 방향의 칸들. sign=+1 위(고가로 잼) / −1 아래(저가로 잼)."""
            out, prev = [], None
            for m in mults:
                hit = sum(1 for v in sample_set if v >= m)
                # 돌파 후 다음 칸 — **앞 칸에 닿은 그 시점부터** 남은 봉만 보고 센다. 무조건부
                # 확률의 비율로 구하면 남은 시간이 줄어든 걸 안 세서 실제보다 후하게 나온다.
                nxt = None
                if prev is not None:
                    reach = after = 0
                    for walk in path_set:
                        at = next((i for i, v in enumerate(walk) if v >= prev), None)
                        if at is None:
                            continue
                        reach += 1
                        if any(v >= m for v in walk[at + 1:]):
                            after += 1
                    if reach >= 20:
                        nxt = round(100.0 * after / reach, 1)
                target = px + sign * m * last_atr
                row = {"atrMultiple": m, "direction": "up" if sign > 0 else "down",
                       # 브라우저가 새 봉마다 가격을 다시 잡을 수 있게 **오프셋도 같이** 낸다.
                       # 확률은 과거 빈도라 천천히 변하지만 가격은 매 틱 움직인다 — 둘을 같이
                       # 서버에서 굳히면 F5 를 눌러야만 선이 따라온다.
                       "atrOffset": round(sign * m, 3),
                       "price": round(target, 4),
                       "gainPct": round((target / px - 1) * 100, 3) if px else None,
                       "probability": round(100.0 * hit / len(sample_set), 1)}
                if nxt is not None:
                    row["nextProbability"] = nxt
                    row["nextFrom"] = prev
                out.append(row)
                prev = m
            return out

        ups = _rungs(samples, paths, 1)
        downs = _rungs(dn_samples, dn_paths, -1)
        levels = ups + downs
        # 누적은 **봉당 한 줄** — 칸마다 한 줄이면 같은 시각이 다섯 번이라 키가 겹친다. 그리고
        # 여기 적히는 값이 **예측을 기록 시점에 못 박는 것**이다. 나중에 실제로 닿았는지 채점할
        # 수 있어야 이 화면이 의견이 아니라 기록이 된다.
        records.append({
            "at": last["date"], "asOfMs": at_ms, "close": px, "atr": round(last_atr, 4),
            "levels": " · ".join("%s%gATR %s %s%%" % ("▲" if r["direction"] == "up" else "▼",
                                                      r["atrMultiple"], _fmt_price(r["price"]),
                                                      r["probability"]) for r in levels),
        })
        # 확률이 낮을수록 옅게 — 선 하나하나가 "여기까지 올 가능성"이라 굵기·색이 곧 값이다.
        def _shade(p):
            if p >= 60: return "#059669", 2
            if p >= 30: return "#0891b2", 2
            if p >= 12: return "#6366f1", 1
            return "#94a3b8", 1
        # 선은 **지금부터 앞으로만** 긋는다. 차트 전폭에 그으면 과거 캔들 위를 가로질러 다섯 줄이
        # 지나가고, 값이 안 보이면 그냥 줄무늬가 된다(2026-08-04 사용자: "선만 겁나 생겼노").
        # 그리고 라벨은 **점에** 달아야 그려진다 — 주석의 label 은 범례용이다.
        last_i = last["i"]
        ahead = max(3, round(horizon * 0.15))
        ann = []
        # 지평만큼 뒤로 ±1ATR 띠를 얇게 깐다 — 확률이 어디서 나온 숫자인지 눈으로 보이라고.
        # 60봉 안에 닿을 확률이라면 지난 60봉 동안 그 띠가 어디 있었고 가격이 몇 번 뚫었는지가
        # 그 확률의 재료다. 선을 앞으로만 그으면 값의 출처가 화면에 없다.
        back = min(horizon, len(bars) - 1)
        if back >= 5:
            for sign in (1, -1):
                pts = []
                step = max(1, back // 30)
                for t in range(len(bars) - back, len(bars), step):
                    a, c = a_ser[t], bars[t]["close"]
                    if not a or not c:
                        continue
                    pts.append({"i": bars[t]["i"], "price": round(c + sign * a, 4)})
                if len(pts) >= 2:
                    ann.append({"kind": "path", "color": "#cbd5e1", "width": 1, "dashed": True,
                                "points": pts})
        for idx, row in enumerate(levels):
            color, width = _shade(row["probability"])
            # 짧게 — 칸이 셋만 되어도 긴 문장 셋이 캔들 위에 쌓이면 차트가 안 보인다
            # (2026-08-04 사용자: "보기가 어렵노"). 조건부는 화살표 하나로 줄이고, 무슨 뜻인지는
            # 표(levels)와 페이지 본문이 말한다.
            arrow = "▲" if row["direction"] == "up" else "▼"
            text = "%s%gATR %s · %s%%" % (arrow, row["atrMultiple"], _fmt_price(row["price"]),
                                          round(row["probability"]))
            if row.get("nextProbability") is not None:
                text += " → %s%%" % round(row["nextProbability"])
            # 라벨이 전부 같은 x 에 모이면 여섯 줄이 한 자리에 겹쳐 읽을 수가 없다. 칸마다 선 길이를
            # 달리해 라벨을 계단처럼 흩는다 — 위 칸은 짧게, 아래 칸은 길게.
            span = max(2, ahead - (idx % len(mults)) * max(1, ahead // (len(mults) + 1)))
            ann.append({
                "kind": "path", "color": color, "width": width, "label": text,
                "points": [{"i": last_i, "price": row["price"]},
                           {"i": last_i + span, "price": row["price"], "label": text}],
            })
        print(json.dumps({"success": True, "data": {
            "blocks": [{"type": "stock_chart",
                        "props": {"annotations": ann, "futureSlots": ahead}}],
            "levels": levels, "records": records,
            "summary": {
                "lastClose": px, "atr": round(last_atr, 4),
                "atrPct": round(last_atr / px * 100, 3) if px else None,
                "horizonBars": horizon, "atrPeriod": n_atr,
                "samples": len(samples),
                # 겹치는 창을 정직하게 고지한다 — 이 숫자가 실제 독립 관측 수다.
                "independentSamples": max(1, len(samples) // horizon),
                "note": ("확률은 이 봉들 자신의 과거에서 센 빈도입니다. 표본이 겹치므로 "
                         "구간추정이 아니라 점추정으로만 읽으십시오."),
            },
            "barRange": bar_range,
        }}, ensure_ascii=False))
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
