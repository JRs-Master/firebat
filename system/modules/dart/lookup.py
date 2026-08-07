"""
DART corp_code mapping utility.

Company name / stock code / corp_code → corp_code resolution.

Strategy:
1. Mapping cached at data/cache/dart-corp-codes.json (the Firebat data area).
2. TTL 7 days — refreshed ahead of expiry.
3. Lookup miss + cache 1 day old → suspect a new listing → force refresh + retry.

DART corpCode.xml.zip:
  https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=<API_KEY>
  → CORPCODE.xml inside the zip (every registered company, ~100k+ records).
  → parsed: <list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name>
            <stock_code>005930</stock_code><modify_date>20250101</modify_date></list>
"""
import os
import json
import time
import io
import zipfile
import xml.etree.ElementTree as ET


# The Firebat data area (sandbox allows read/write here).
# Modules run with cwd = the firebat root, so a relative path works.
CACHE_DIR = os.path.join(os.getcwd(), 'data', 'cache')
CACHE_PATH = os.path.join(CACHE_DIR, 'dart-corp-codes.json')

TTL_SEC = 7 * 86400      # 7 days — the ordinary cache TTL
REFRESH_FLOOR_SEC = 86400  # 1 day — a lookup miss forces a refresh once the cache is older than this


def _ensure_cache_dir():
    if not os.path.exists(CACHE_DIR):
        os.makedirs(CACHE_DIR, exist_ok=True)


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


def _save_cache(data):
    _ensure_cache_dir()
    with open(CACHE_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)


def _fetch_corp_code_xml(api_key):
    """Download and parse corpCode.xml.zip from the DART API."""
    import requests
    url = 'https://opendart.fss.or.kr/api/corpCode.xml'
    res = requests.get(url, params={'crtfc_key': api_key}, timeout=30)
    res.raise_for_status()
    # branch: zip payload vs bare XML (an error response)
    if res.headers.get('Content-Type', '').startswith('application/x-msdownload') or res.content[:2] == b'PK':
        # zip
        with zipfile.ZipFile(io.BytesIO(res.content)) as z:
            xml_name = next((n for n in z.namelist() if n.lower().endswith('.xml')), None)
            if not xml_name:
                raise RuntimeError('corpCode zip contains no XML')
            with z.open(xml_name) as xf:
                xml_content = xf.read()
    else:
        # bare XML (likely an error response)
        xml_content = res.content
    root = ET.fromstring(xml_content)
    # handle status/message error responses
    status_el = root.find('status')
    if status_el is not None and status_el.text not in ('000', None):
        msg_el = root.find('message')
        msg = msg_el.text if msg_el is not None else 'unknown'
        raise RuntimeError(f'DART corpCode {status_el.text}: {msg}')
    records = []
    for item in root.findall('list'):
        rec = {
            'corp_code': (item.findtext('corp_code') or '').strip(),
            'corp_name': (item.findtext('corp_name') or '').strip(),
            'stock_code': (item.findtext('stock_code') or '').strip(),
            'modify_date': (item.findtext('modify_date') or '').strip(),
        }
        if rec['corp_code']:
            records.append(rec)
    return records


def _refresh_cache(api_key):
    records = _fetch_corp_code_xml(api_key)
    _save_cache(records)
    return records


def _ensure_cache(api_key, force_refresh=False):
    """Refresh when needed; returns the cached record list."""
    age = _cache_age_sec()
    if force_refresh or age > TTL_SEC:
        return _refresh_cache(api_key)
    cache = _load_cache()
    if cache is None:
        return _refresh_cache(api_key)
    return cache


def _match(records, query):
    """query → matching record. Match ladder:
       1. corp_code exact (8 digits)
       2. stock_code exact (6 chars, alphanumeric)
       3. corp_name exact (listed record wins a name tie)
       4. corp_name partial (shortest name first)
    """
    q = query.strip()
    if not q:
        return None

    # 1) corp_code exact (8 digits)
    if q.isdigit() and len(q) == 8:
        for r in records:
            if r['corp_code'] == q:
                return r

    # 2) stock_code exact (6 chars, digits or alphanumeric)
    if len(q) == 6:
        for r in records:
            if r['stock_code'] and r['stock_code'].upper() == q.upper():
                return r

    # 3) corp_name exact match. DART's registry holds every filer, listed or not, and several can
    # share one name — "카카오" resolved to an unlisted 2017 shell (empty stock_code) while the
    # listed Kakao sat further down (measured 2026-08-08). A name query is almost always about the
    # listed company, so a listed record wins the tie; the unlisted one is still reachable by its
    # corp_code.
    exact = [r for r in records if r['corp_name'] == q]
    if exact:
        exact.sort(key=lambda r: (not r['stock_code'], r['corp_code']))
        return exact[0]

    # 4) corp_name partial match — shortest name first (most precise), listed first on a tie.
    candidates = [r for r in records if q in r['corp_name']]
    if candidates:
        candidates.sort(key=lambda r: (len(r['corp_name']), not r['stock_code']))
        return candidates[0]

    return None


def lookup_query(query, api_key):
    """Public API — query matching with an automatic new-listing fallback.

    1. Load the cache (refreshed ahead of the 7-day TTL).
    2. Try to match.
    3. Miss + cache 1 day old → force refresh + retry (covers new listings).
    4. Still nothing → None.
    """
    cache = _ensure_cache(api_key)
    result = _match(cache, query)
    if result is not None:
        return result
    # miss — check how fresh the cache is
    age = _cache_age_sec()
    if age > REFRESH_FLOOR_SEC:
        # a day old or more: suspect a new listing → force refresh + retry
        cache = _refresh_cache(api_key)
        result = _match(cache, query)
    return result


def resolve_corp_code(query, api_key):
    """Thin wrapper — returns only the corp_code (for quick use by other sysmods/actions)."""
    result = lookup_query(query, api_key)
    return result['corp_code'] if result else None
