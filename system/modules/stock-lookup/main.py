"""
Firebat System Module: stock-lookup (종목코드 검색)

Company name → official stock_code (6-digit) + DART corp_code (8-digit); a US ticker or an
English company name → the US listing ({symbol, name, exchange, etf}).
A single-purpose resolver surface: the weakest model can call it with one arg
({"query": "<name>"}) — no action field, no discovery ladder, no prose→tool mapping.

[INPUT]  stdin JSON: { "correlationId": "...", "data": { "query": "...", "limit": 10 } }
[OUTPUT] stdout JSON: { "success": true, "data": { matched, candidates, count } }
         or { "success": false, "error": "..." }

Data sources:
- KR = DART corpCode.xml (official, whole-market list). The download/cache/search logic mirrors
  dart/lookup.py — an intentional duplicate: module isolation forbids cross-module imports, and
  this module owns its own cache file + refresh cadence.
- US = Nasdaq Trader's symbol directory (nasdaqlisted + otherlisted: every Nasdaq, NYSE, NYSE
  American, NYSE Arca and Cboe listing, ETFs included), public and keyless, regenerated each
  trading day. Every broker action that takes a US ticker declares `needs: ["stock-lookup"]`, and
  a KR-only lookup could never satisfy that honestly — the chat path opened it by looking up an
  unrelated Korean company (2026-09-30, TQQQ).

Which list a query searches is read off the query itself: Hangul or a leading digit is a Korean
name or code and searches DART exactly as before; anything else is a ticker or a Latin name,
which can be either market (NAVER and LG are DART names), so it searches both.
"""
import io
import json
import os
import re
import sys
import time
import zipfile
import xml.etree.ElementTree as ET

CACHE_DIR = os.path.join(os.getcwd(), 'data', 'cache')
CACHE_PATH = os.path.join(CACHE_DIR, 'stock-lookup-corp-codes.json')

TTL_SEC = 7 * 86400        # normal cache TTL
# On a lookup MISS, force-refresh when the cache is older than this — new listings appear in
# DART corpCode same-day (실측 2026-07-13: 상장 당일 "레메디" miss — 24h floor blocked the
# refresh). Misses are rare, the refresh is one zip download → 1h floor is safe.
REFRESH_FLOOR_SEC = 3600

US_CACHE_PATH = os.path.join(CACHE_DIR, 'stock-lookup-us-symbols.json')
US_TTL_SEC = 86400  # the directory is regenerated every trading day
US_SOURCES = (
    ('https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt', 'Symbol', None),
    ('https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt', 'ACT Symbol', 'Exchange'),
)
# otherlisted's Exchange column, per the directory's own definitions.
US_EXCHANGES = {'A': 'NYSE American', 'N': 'NYSE', 'P': 'NYSE Arca', 'Z': 'Cboe BZX', 'V': 'IEX'}


def out(success, data=None, error=None):
    msg = {'success': success}
    if data is not None:
        msg['data'] = data
    if error:
        msg['error'] = error
    sys.stdout.write(json.dumps(msg, ensure_ascii=False, default=str))
    sys.stdout.flush()


def _cache_age_sec():
    if not os.path.exists(CACHE_PATH):
        return float('inf')
    return time.time() - os.path.getmtime(CACHE_PATH)


def _load_cache():
    if not os.path.exists(CACHE_PATH):
        return None
    try:
        with open(CACHE_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def _save_cache(records):
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(CACHE_PATH, 'w', encoding='utf-8') as f:
        json.dump(records, f, ensure_ascii=False)


def _fetch_corp_codes(api_key):
    import requests
    res = requests.get(
        'https://opendart.fss.or.kr/api/corpCode.xml',
        params={'crtfc_key': api_key},
        timeout=30,
    )
    res.raise_for_status()
    if res.content[:2] == b'PK':
        with zipfile.ZipFile(io.BytesIO(res.content)) as z:
            xml_name = next((n for n in z.namelist() if n.lower().endswith('.xml')), None)
            if not xml_name:
                raise RuntimeError('corpCode zip contains no XML')
            with z.open(xml_name) as xf:
                xml_content = xf.read()
    else:
        xml_content = res.content
    root = ET.fromstring(xml_content)
    status_el = root.find('status')
    if status_el is not None and status_el.text not in ('000', None):
        msg_el = root.find('message')
        raise RuntimeError(
            f'DART corpCode {status_el.text}: {msg_el.text if msg_el is not None else "unknown"}'
        )
    records = []
    for item in root.findall('list'):
        rec = {
            'corp_code': (item.findtext('corp_code') or '').strip(),
            'corp_name': (item.findtext('corp_name') or '').strip(),
            'stock_code': (item.findtext('stock_code') or '').strip(),
        }
        if rec['corp_code']:
            records.append(rec)
    return records


def _refresh_cache(api_key):
    records = _fetch_corp_codes(api_key)
    _save_cache(records)
    return records


def _ensure_cache(api_key):
    if _cache_age_sec() > TTL_SEC:
        return _refresh_cache(api_key)
    cache = _load_cache()
    return cache if cache is not None else _refresh_cache(api_key)


def _search(records, query, limit):
    """Match priority: 8-digit corp_code exact > 6-digit stock_code exact (code verification)
    > listed exact name > listed partial name (shortest first = most precise).
    Unlisted companies (empty stock_code) are excluded from name search — this module
    exists to feed broker APIs, which only take listed codes."""
    q = query.strip()
    if not q:
        return []

    if q.isdigit() and len(q) == 8:
        return [r for r in records if r['corp_code'] == q][:1]

    if len(q) == 6:
        hit = [r for r in records if r['stock_code'] and r['stock_code'].upper() == q.upper()]
        if hit:
            return hit[:1]

    listed = [r for r in records if r['stock_code']]
    exact = [r for r in listed if r['corp_name'] == q]
    if exact:
        return exact[:limit]
    partial = [r for r in listed if q in r['corp_name']]
    partial.sort(key=lambda r: len(r['corp_name']))
    return partial[:limit]


def _fetch_us_symbols():
    """Both directory files → [{symbol, name, exchange, etf}]. Test issues are left out. A file
    whose header lacks the columns read here is refused rather than parsed into nothing — an error
    page or a changed layout must not become an empty cache that answers "no such stock"."""
    import requests
    records = []
    for url, sym_col, exch_col in US_SOURCES:
        res = requests.get(url, timeout=30, headers={'User-Agent': 'Mozilla/5.0 (Firebat stock-lookup)'})
        res.raise_for_status()
        lines = res.text.splitlines()
        head = lines[0].split('|') if lines else []
        need = [sym_col, 'Security Name', 'ETF', 'Test Issue'] + ([exch_col] if exch_col else [])
        missing = [c for c in need if c not in head]
        if missing:
            raise RuntimeError(f'{url}: header lacks {missing}')
        col = {name: i for i, name in enumerate(head)}
        for line in lines[1:]:
            cells = line.split('|')
            if len(cells) < len(head) or line.startswith('File Creation Time'):
                continue
            cell = lambda name: cells[col[name]].strip()
            if cell('Test Issue') == 'Y':
                continue
            symbol, name = cell(sym_col), cell('Security Name')
            if not symbol or not name:
                continue
            exchange = US_EXCHANGES.get(cell(exch_col), cell(exch_col)) if exch_col else 'NASDAQ'
            records.append({'symbol': symbol, 'name': name, 'exchange': exchange, 'etf': cell('ETF') == 'Y'})
    return records


def _us_cache_age_sec():
    if not os.path.exists(US_CACHE_PATH):
        return float('inf')
    return time.time() - os.path.getmtime(US_CACHE_PATH)


def _refresh_us():
    records = _fetch_us_symbols()
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = US_CACHE_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(records, f, ensure_ascii=False)
    os.replace(tmp, US_CACHE_PATH)
    return records


def _ensure_us():
    """A stale list beats none: when the refresh fails, the cached one still answers."""
    cached = None
    if os.path.exists(US_CACHE_PATH):
        try:
            with open(US_CACHE_PATH, 'r', encoding='utf-8') as f:
                cached = json.load(f)
        except Exception:
            cached = None
    if cached is not None and _us_cache_age_sec() <= US_TTL_SEC:
        return cached
    try:
        return _refresh_us()
    except Exception:
        if cached is not None:
            return cached
        raise


_WORD = re.compile(r'[a-z0-9]+')
# The directory spells the issue after the company: "Apple Inc. - Common Stock",
# "Agilent Technologies, Inc. Common Stock". The company is what a person searches for.
_ISSUE_TAIL = re.compile(r'\s+-\s+.*$|\s+(Common Stock|Ordinary Shares|Class [A-Z]\b).*$', re.I)
# Issues that are not the company's shares — ranked after the ones that are.
_NOT_THE_SHARE = re.compile(r'\b(Warrants?|Rights?|Units?|Preferred|Notes?|Debentures?)\b', re.I)


def _us_search(records, query):
    """Ticker first (as typed, then with punctuation ignored — BRK-B finds BRK.B), then names
    whose company part starts with the query's words, then names containing them anywhere.
    Within a tier the company's own shares come before its warrants and preferreds, shorter
    names before longer."""
    q = query.strip()
    qu = q.upper()
    squash = lambda s: re.sub(r'[^A-Z0-9]', '', s.upper())
    exact = [r for r in records if r['symbol'].upper() == qu]
    if not exact and squash(q):
        exact = [r for r in records if squash(r['symbol']) == squash(q)]
    qw = _WORD.findall(q.lower())
    prefix, partial = [], []
    if qw:
        n = len(qw)
        for r in records:
            if r in exact:
                continue
            company = _WORD.findall(_ISSUE_TAIL.sub('', r['name']).lower())
            if company[:n] == qw:
                prefix.append(r)
                continue
            words = _WORD.findall(r['name'].lower())
            if any(words[i:i + n] == qw for i in range(len(words) - n + 1)):
                partial.append(r)
    rank = lambda r: (bool(_NOT_THE_SHARE.search(r['name'])), len(r['name']))
    prefix.sort(key=rank)
    partial.sort(key=rank)
    tag = lambda rs: [dict(r, market='us') for r in rs]
    return tag(exact), tag(prefix), tag(partial)


def _kr_by_name(records, query):
    """DART names for a Latin query, case-insensitive — NAVER, LG, SK are DART names too."""
    q = query.strip().lower()
    listed = [r for r in records if r['stock_code']]
    exact = [r for r in listed if r['corp_name'].lower() == q]
    partial = [r for r in listed if q in r['corp_name'].lower() and r not in exact]
    partial.sort(key=lambda r: len(r['corp_name']))
    return exact, partial


_HANGUL = re.compile(r'[\uac00-\ud7a3\u3131-\u318e]')


def _answer(hits, single_note):
    result = {'matched': hits[0], 'count': len(hits)}
    if len(hits) == 1:
        result['note'] = single_note(hits[0])
    else:
        result['candidates'] = hits
        result['note'] = (
            '여러 종목이 일치합니다. matched 가 최적 후보이지만 확실하지 않으면 '
            'suggest 피커로 사용자에게 확인한 뒤 진행하세요.'
        )
    return out(True, result)


def _single_note(hit):
    if hit.get('market') == 'us':
        return 'symbol 이 미국 티커입니다 — 그대로 사용하세요 (exchange = 상장 거래소).'
    return 'stock_code 를 그대로 사용하세요 (키움 stk_cd / 한투 FID_INPUT_ISCD·PDNO 등).'


def _latin(query, limit):
    """A ticker or a Latin name: both markets, one list."""
    try:
        us = _ensure_us()
    except Exception as e:
        us, us_error = [], f'{type(e).__name__}: {e}'
    else:
        us_error = None
    us_exact, us_prefix, us_partial = _us_search(us, query)
    if not (us_exact or us_prefix or us_partial) and us and _us_cache_age_sec() > REFRESH_FLOOR_SEC:
        # a miss on a day-old list may be today's listing — refresh once, like the KR side
        try:
            us_exact, us_prefix, us_partial = _us_search(_refresh_us(), query)
        except Exception:
            pass

    api_key = os.environ.get('DART_API_KEY', '').strip()
    kr_exact, kr_partial = [], []
    if api_key:
        try:
            kr_exact, kr_partial = _kr_by_name(_ensure_cache(api_key), query)
        except Exception:
            kr_exact, kr_partial = [], []

    # An exact hit ends the search, the rule the KR side has always had — and the Korean one leads,
    # because 17 of 43 Latin DART names are also US tickers (KT, KB, GS, HD, …; measured 2026-09-30).
    # Whatever resolved to a Korean company before still resolves to it; the ticker it shares a
    # spelling with rides along as the second candidate instead of taking its place.
    exact = kr_exact + us_exact
    hits = (exact or (us_prefix + kr_partial + us_partial))[:limit]
    if hits:
        return _answer(hits, _single_note)
    if us_error and not api_key:
        return out(False, error=f'미국 종목 목록을 받지 못했습니다 ({us_error}).')
    searched = '국내 상장사·미국 종목' if api_key else '미국 종목(DART_API_KEY 가 없어 국내 상장사는 찾지 않았습니다)'
    return out(False, error=(
        f'"{query}" 에 일치하는 {searched}이 없습니다. 미국 종목은 티커(예 "TQQQ")나 영문 회사명(예 "Tesla")으로, '
        f'국내 종목은 한글 회사명으로 다시 조회하세요.'
    ))


def main():
    payload = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    data = payload.get('data', {})
    query = str(data.get('query', '')).strip()
    limit = data.get('limit', 10)
    limit = max(1, min(int(limit) if isinstance(limit, (int, float)) else 10, 30))

    if not query:
        return out(False, error='query 가 비어 있습니다. {"query": "회사명"} 형태로 호출하세요.')

    if not _HANGUL.search(query) and not query[0].isdigit():
        return _latin(query, limit)

    api_key = os.environ.get('DART_API_KEY', '').strip()
    if not api_key:
        return out(False, error='DART_API_KEY 시크릿이 설정되지 않았습니다. 설정 → 시크릿에서 등록하세요.')

    records = _ensure_cache(api_key)
    hits = _search(records, query, limit)
    if not hits and _cache_age_sec() > REFRESH_FLOOR_SEC:
        # miss on a stale-ish cache → suspect a new listing, force refresh once
        records = _refresh_cache(api_key)
        hits = _search(records, query, limit)

    if not hits:
        return out(False, error=(
            f'"{query}" 에 일치하는 상장사가 없습니다. 회사명 표기를 바꿔 재시도하거나 '
            f'(약칭/정식명, 예: "LG엔솔" → "LG에너지솔루션"), 사용자에게 정확한 회사명을 확인하세요. '
            f'오늘 신규 상장한 종목이면 DART 목록에 아직 없을 수 있습니다 — sysmod_naver-search '
            f'{{"action": "search", "query": "{query} 종목코드"}} 로 6자리 코드를 확인해 그 코드를 그대로 사용하세요. '
            f'미국 종목이면 티커(예 "TSLA")나 영문 회사명(예 "Tesla")으로 조회하세요.'
        ))

    result = {
        'matched': hits[0],
        'count': len(hits),
    }
    if len(hits) == 1:
        result['note'] = 'stock_code 를 그대로 사용하세요 (키움 stk_cd / 한투 FID_INPUT_ISCD·PDNO 등).'
    else:
        result['candidates'] = hits
        result['note'] = (
            '여러 회사가 일치합니다. matched 가 최적 후보이지만 확실하지 않으면 '
            'suggest 피커로 사용자에게 확인한 뒤 진행하세요.'
        )
    return out(True, result)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        out(False, error=f'{type(e).__name__}: {e}')
