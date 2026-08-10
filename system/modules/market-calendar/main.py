"""Firebat System Module: market-calendar

Is this market open on this date, and between which hours — answered without any credential.

Why it exists: the trading windows were hand-written in config (kr 09:00~15:30, us 09:30~16:00)
and knew only weekday and clock, so a Korean holiday, Thanksgiving or Good Friday all read as
"open" and rules ran against a market that was not there.

Two engines, because the two markets are not the same problem:

- **US rules are deterministic** — fixed dates, the weekend-observation shift, Good Friday, and
  three early closes. Sixty lines, no dependency, exact.
- **Korea's 설날 and 추석 are LUNAR.** They cannot be computed without a lunar conversion, so
  there is no honest offline answer. A broker knows (toss `market-calendar`, KIS `국내주식-040`),
  and `exchange_calendars` knows if it happens to be installed. When neither is available this
  says **unknown** rather than "open": guessing "open" on 설날 is the silent wrong answer, and
  a caller that gets `open: null` can refuse to trade, which is the safe reading.

`exchange_calendars` is used when present (it also covers overseas venues), but it is not
required — it pulls pandas and numpy, which this box does not carry for a calendar alone.

⚠️ A US federal-holiday list is the wrong source and fails both ways: Good Friday is not a
federal holiday and the NYSE closes; Columbus Day and Veterans Day are, and it does not.
"""
import json
import os
import sys
from datetime import date as _date, datetime, timedelta

# Time is the framework's to tell, never the host's to leak: a "no date given" default read off
# the host clock would judge "is the market open TODAY" in whatever zone the box happens to run
# in — one hour off across a midnight boundary flips the verdict. FIREBAT_TZ via the shared tz
# helper is the owner's wall clock, the same one every other module reads.
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '_runtime'))
import tz as clock  # noqa: E402

MARKETS = {
    'kr': 'XKRX', 'krx': 'XKRX', 'kospi': 'XKRX', 'kosdaq': 'XKRX', '한국': 'XKRX',
    'us': 'XNYS', 'nyse': 'XNYS', 'nasdaq': 'XNAS', 'xnas': 'XNYS', '미국': 'XNYS',
    'jp': 'XTKS', 'hk': 'XHKG', 'cn': 'XSHG', 'uk': 'XLON', 'de': 'XFRA',
}
US_CODES = ('XNYS', 'XNAS')


def _fail(msg, **extra):
    # The output contract requires `action` on every reply, including refusals — an error that
    # also violates the schema becomes two errors (same class caught live on binance).
    print(json.dumps({'success': False, 'action': extra.pop('action', 'unknown'), 'error': msg, **extra}, ensure_ascii=False))
    sys.exit(1)


def _resolve(market):
    if not market:
        _fail('market 이 필요합니다 (kr · us · jp · hk · cn · uk · de 또는 거래소 코드).')
    return MARKETS.get(str(market).strip().lower(), str(market).strip().upper())


def _parse_date(v):
    if not v:
        return datetime.strptime(clock.today_ymd(), '%Y-%m-%d').date()
    try:
        return datetime.strptime(str(v).strip()[:10], '%Y-%m-%d').date()
    except ValueError:
        _fail("date 는 YYYY-MM-DD 형식입니다: '%s'" % v)


# ── US 규칙 ────────────────────────────────────────────────────────────────────
def _nth_weekday(year, month, weekday, n):
    """그 달의 n 번째 <weekday> (월=0). n<0 이면 뒤에서 센다."""
    if n > 0:
        d = _date(year, month, 1)
        d += timedelta(days=(weekday - d.weekday()) % 7)
        return d + timedelta(weeks=n - 1)
    d = _date(year, month + 1, 1) - timedelta(days=1) if month < 12 else _date(year, 12, 31)
    d -= timedelta(days=(d.weekday() - weekday) % 7)
    return d + timedelta(weeks=n + 1)


def _easter(year):
    """Anonymous Gregorian algorithm — Good Friday 를 얻으려고만 쓴다."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return _date(year, month, day)


def _observed(d):
    """주말에 걸린 고정 공휴일의 관측일 — 토요일은 금요일, 일요일은 월요일."""
    if d.weekday() == 5:
        return d - timedelta(days=1)
    if d.weekday() == 6:
        return d + timedelta(days=1)
    return d


def _us_holidays(year):
    """그 해 NYSE 휴장일 → {날짜: 이름}."""
    h = {
        _observed(_date(year, 1, 1)): "New Year's Day",
        _nth_weekday(year, 1, 0, 3): 'Martin Luther King Jr. Day',
        _nth_weekday(year, 2, 0, 3): "Washington's Birthday",
        _easter(year) - timedelta(days=2): 'Good Friday',
        _nth_weekday(year, 5, 0, -1): 'Memorial Day',
        _observed(_date(year, 6, 19)): 'Juneteenth',
        _observed(_date(year, 7, 4)): 'Independence Day',
        _nth_weekday(year, 9, 0, 1): 'Labor Day',
        _nth_weekday(year, 11, 3, 4): 'Thanksgiving',
        _observed(_date(year, 12, 25)): 'Christmas',
    }
    # 1월 1일이 토요일이면 그 전해 12/31 로 당겨지지 않는다 — NYSE 는 그냥 열지 않는다.
    if _date(year, 1, 1).weekday() == 5:
        h.pop(_date(year, 1, 1) - timedelta(days=1), None)
    return h


def _us_early_closes(year):
    """13:00 조기 마감 — 휴장일 목록에는 없지만 마감 시각으로 규칙을 재는 쪽엔 휴장만큼 중요하다."""
    out = {}
    jul3 = _date(year, 7, 3)
    if jul3.weekday() < 5 and _observed(_date(year, 7, 4)) == _date(year, 7, 4):
        out[jul3] = 'day before Independence Day'
    out[_nth_weekday(year, 11, 3, 4) + timedelta(days=1)] = 'day after Thanksgiving'
    dec24 = _date(year, 12, 24)
    if dec24.weekday() < 5:
        out[dec24] = 'Christmas Eve'
    return out


def _us_day(code, d):
    row = {'date': d.isoformat(), 'market': code, 'source': 'builtin-us-rules'}
    if d.weekday() >= 5:
        return dict(row, open=False, reason='weekend')
    hol = _us_holidays(d.year)
    if d in hol:
        return dict(row, open=False, reason='holiday', holiday=hol[d])
    early = _us_early_closes(d.year)
    close = '13:00' if d in early else '16:00'
    row.update(open=True, regularStart='09:30', regularEnd=close, timezone='America/New_York')
    if d in early:
        row['earlyClose'] = early[d]
    return row


# ── exchange_calendars (있으면) ────────────────────────────────────────────────
def _xcals_day(code, d):
    try:
        import exchange_calendars as xcals
        import pandas as pd
    except ImportError:
        return None
    try:
        cal = xcals.get_calendar(code)
    except Exception:
        return None
    ts = pd.Timestamp(d)
    row = {'date': d.isoformat(), 'market': code, 'source': 'exchange_calendars'}
    if not cal.is_session(ts):
        return dict(row, open=False, reason='weekend' if d.weekday() >= 5 else 'holiday')
    row.update(
        open=True,
        regularStart=cal.session_open(ts).isoformat(),
        regularEnd=cal.session_close(ts).isoformat(),
    )
    return row


def _unknown(code, d, note):
    return {
        'date': d.isoformat(), 'market': code, 'open': None, 'source': 'none',
        'note': note,
        'next': '토스 market-calendar(KR·US) 또는 한투 국내주식-040(KR) 로 물어보십시오. '
                'open:null 은 "열렸다"가 아니라 "모른다" 이므로, 매매 판단은 보류하는 것이 맞습니다.',
    }


def _day(code, d):
    got = _xcals_day(code, d)
    if got:
        return got
    if code in US_CODES:
        return _us_day(code, d)
    if code == 'XKRX':
        return _unknown(
            code, d,
            '설날·추석이 음력이라 자격증명 없이는 계산할 수 없습니다. '
            '주말 여부만 확실합니다: ' + ('주말' if d.weekday() >= 5 else '평일'),
        )
    return _unknown(code, d, "'%s' 는 내장 규칙이 없는 거래소입니다." % code)


def main(inp):
    inp = inp or {}
    action = inp.get('action') or 'is_trading_day'
    code = _resolve(inp.get('market'))

    if action == 'is_trading_day':
        d = _parse_date(inp.get('date'))
        row = _day(code, d)
        if row.get('open') is not None:
            prev_d, next_d = d - timedelta(days=1), d + timedelta(days=1)
            for _ in range(12):
                if _day(code, prev_d).get('open'):
                    break
                prev_d -= timedelta(days=1)
            for _ in range(12):
                if _day(code, next_d).get('open'):
                    break
                next_d += timedelta(days=1)
            row['previousTradingDay'] = prev_d.isoformat()
            row['nextTradingDay'] = next_d.isoformat()
        return {'action': action, 'data': row}

    if action == 'sessions':
        start = _parse_date(inp.get('start') or inp.get('date'))
        end = _parse_date(inp.get('end')) if inp.get('end') else start + timedelta(days=30)
        if end < start:
            _fail('end 가 start 보다 앞섭니다.')
        days, cur = [], start
        while cur <= end and len(days) < 400:
            days.append(_day(code, cur))
            cur += timedelta(days=1)
        return {'action': action, 'data': {
            'market': code, 'start': start.isoformat(), 'end': end.isoformat(),
            'count': len(days),
            'tradingDays': sum(1 for x in days if x.get('open')),
            'unknownDays': sum(1 for x in days if x.get('open') is None),
            'records': days,
        }}

    _fail("'%s' 은 이 모듈의 액션이 아닙니다. 쓸 수 있는 액션: is_trading_day, sessions." % action)


if __name__ == '__main__':
    try:
        raw = sys.stdin.read()
        parsed = json.loads(raw) if raw.strip() else {}
        out = main(parsed.get('data', parsed))
        print(json.dumps({'success': True, **out}, ensure_ascii=False))
    except SystemExit:
        raise
    except Exception as err:  # noqa: BLE001
        print(json.dumps({'success': False, 'action': 'unknown', 'error': str(err)}, ensure_ascii=False))
        sys.exit(1)
