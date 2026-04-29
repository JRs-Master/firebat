"""
DART corp_code 매핑 utility.

회사명 / 종목코드 / corp_code → corp_code 변환.

전략:
1. data/cache/dart-corp-codes.json (Firebat data 영역) 에 매핑 cache.
2. TTL 7일 — 만료 시 미리 refresh.
3. lookup 실패 + cache 1일+ 면 신규 상장 의심 → 강제 refresh + 재시도.

DART corpCode.xml.zip:
  https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=<API_KEY>
  → zip 안에 CORPCODE.xml (전체 회사 list, ~1만+ records).
  → 파싱: <list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name>
          <stock_code>005930</stock_code><modify_date>20250101</modify_date></list>
"""
import os
import json
import time
import io
import zipfile
import xml.etree.ElementTree as ET


# Firebat data 영역 (sandbox 가 read/write 허용)
# 모듈이 실행되는 cwd 가 보통 firebat root 이므로 상대경로 사용.
CACHE_DIR = os.path.join(os.getcwd(), 'data', 'cache')
CACHE_PATH = os.path.join(CACHE_DIR, 'dart-corp-codes.json')

TTL_SEC = 7 * 86400      # 7일 — 평소 cache TTL
REFRESH_FLOOR_SEC = 86400  # 1일 — lookup 실패 시 cache 가 이 이상 됐으면 강제 refresh


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
    """DART API 에서 corpCode.xml.zip 다운로드 + 파싱."""
    import requests
    url = 'https://opendart.fss.or.kr/api/corpCode.xml'
    res = requests.get(url, params={'crtfc_key': api_key}, timeout=30)
    res.raise_for_status()
    # zip 또는 XML(에러 응답) 분기
    if res.headers.get('Content-Type', '').startswith('application/x-msdownload') or res.content[:2] == b'PK':
        # zip
        with zipfile.ZipFile(io.BytesIO(res.content)) as z:
            xml_name = next((n for n in z.namelist() if n.lower().endswith('.xml')), None)
            if not xml_name:
                raise RuntimeError('corpCode zip 안에 XML 없음')
            with z.open(xml_name) as xf:
                xml_content = xf.read()
    else:
        # 직접 XML (에러 응답일 가능성)
        xml_content = res.content
    root = ET.fromstring(xml_content)
    # status/message 에러 응답 처리
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
    """필요 시 refresh. cache list 반환."""
    age = _cache_age_sec()
    if force_refresh or age > TTL_SEC:
        return _refresh_cache(api_key)
    cache = _load_cache()
    if cache is None:
        return _refresh_cache(api_key)
    return cache


def _match(records, query):
    """query → 매칭 record. 매칭 우선순위:
       1. corp_code 정확 일치 (8자리 숫자)
       2. stock_code 정확 일치 (6자리, 영문/숫자)
       3. corp_name 정확 일치
       4. corp_name 부분 일치 (가장 짧은 매칭 우선)
    """
    q = query.strip()
    if not q:
        return None

    # 1) corp_code 정확 일치 (8자리 숫자)
    if q.isdigit() and len(q) == 8:
        for r in records:
            if r['corp_code'] == q:
                return r

    # 2) stock_code 정확 일치 (6자리, 숫자 또는 영문 포함)
    if len(q) == 6:
        for r in records:
            if r['stock_code'] and r['stock_code'].upper() == q.upper():
                return r

    # 3) corp_name 정확 일치
    for r in records:
        if r['corp_name'] == q:
            return r

    # 4) corp_name 부분 일치 — 가장 짧은 매칭 (정밀 우선)
    candidates = [r for r in records if q in r['corp_name']]
    if candidates:
        candidates.sort(key=lambda r: len(r['corp_name']))
        return candidates[0]

    return None


def lookup_query(query, api_key):
    """공개 API — query 매칭 + 신규 상장 자동 fallback.

    1. cache load (TTL 7일 만료 시 미리 refresh)
    2. 매칭 시도
    3. 매칭 실패 + cache 1일+ → 강제 refresh + 재시도 (신규 상장 cover)
    4. 그래도 실패 → None
    """
    cache = _ensure_cache(api_key)
    result = _match(cache, query)
    if result is not None:
        return result
    # 매칭 실패 — cache 신선도 확인
    age = _cache_age_sec()
    if age > REFRESH_FLOOR_SEC:
        # 1일+ 됐으면 신규 상장 의심 → 강제 refresh + 재시도
        cache = _refresh_cache(api_key)
        result = _match(cache, query)
    return result


def resolve_corp_code(query, api_key):
    """단순 wrapper — corp_code 만 반환 (다른 sysmod·액션에서 빠른 사용)."""
    result = lookup_query(query, api_key)
    return result['corp_code'] if result else None
