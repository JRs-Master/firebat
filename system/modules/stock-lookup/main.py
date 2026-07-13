"""
Firebat System Module: stock-lookup (종목코드 검색)

Company name → official stock_code (6-digit) + DART corp_code (8-digit).
A single-purpose resolver surface: the weakest model can call it with one arg
({"query": "<name>"}) — no action field, no discovery ladder, no prose→tool mapping.

[INPUT]  stdin JSON: { "correlationId": "...", "data": { "query": "...", "limit": 10 } }
[OUTPUT] stdout JSON: { "success": true, "data": { matched, candidates, count } }
         or { "success": false, "error": "..." }

Data source = DART corpCode.xml (official, whole-market list). The download/cache/search
logic mirrors dart/lookup.py — an intentional duplicate: module isolation forbids
cross-module imports, and this module owns its own cache file + refresh cadence.
"""
import io
import json
import os
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


def main():
    payload = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    data = payload.get('data', {})
    query = str(data.get('query', '')).strip()
    limit = data.get('limit', 10)
    limit = max(1, min(int(limit) if isinstance(limit, (int, float)) else 10, 30))

    if not query:
        return out(False, error='query 가 비어 있습니다. {"query": "회사명"} 형태로 호출하세요.')

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
            f'{{"action": "search", "query": "{query} 종목코드"}} 로 6자리 코드를 확인해 그 코드를 그대로 사용하세요.'
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
