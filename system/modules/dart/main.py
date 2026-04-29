"""
Firebat System Module: dart (DART 전자공시시스템)
opendart.fss.or.kr API — 한국 기업 공시·재무·지분 정보 + 종목코드 lookup utility

[INPUT]  stdin JSON: { "correlationId": "...", "data": { "action": "...", ... } }
[OUTPUT] stdout JSON: { "success": true, "data": {...} } 또는 { "success": false, "error": "..." }

actions: lookup / list / company / financial / financialAll / majorStock / executiveStock / document
"""
import sys
import os
import json

# 같은 디렉토리의 helper module
from lookup import resolve_corp_code, lookup_query


API_BASE = 'https://opendart.fss.or.kr/api'


def out(success, data=None, error=None):
    msg = {'success': success}
    if data is not None:
        msg['data'] = data
    if error:
        msg['error'] = error
    sys.stdout.write(json.dumps(msg, ensure_ascii=False, default=str))
    sys.stdout.flush()


def apply_subquery(records, limit=None, fields=None, where=None):
    """공통 sub-query — limit / fields / where 적용. 토큰 절감 핵심."""
    result = records or []

    # where 필터 — 'field op value' 형식. op: ==, !=, >, <, >=, <=, contains
    if where:
        try:
            parts = where.strip().split(None, 2)
            if len(parts) == 3:
                field, op, value = parts
                # 숫자 비교 시도
                try:
                    num_value = float(value)
                except ValueError:
                    num_value = None

                def matches(r):
                    v = r.get(field)
                    if v is None:
                        return False
                    if op == 'contains':
                        return value in str(v)
                    if op in ('==', '!=', '>', '<', '>=', '<='):
                        # 숫자 비교 가능하면 숫자로
                        if num_value is not None:
                            try:
                                fv = float(v)
                                if op == '==': return fv == num_value
                                if op == '!=': return fv != num_value
                                if op == '>': return fv > num_value
                                if op == '<': return fv < num_value
                                if op == '>=': return fv >= num_value
                                if op == '<=': return fv <= num_value
                            except (ValueError, TypeError):
                                pass
                        # 문자열 비교
                        sv = str(v)
                        if op == '==': return sv == value
                        if op == '!=': return sv != value
                        if op == '>': return sv > value
                        if op == '<': return sv < value
                        if op == '>=': return sv >= value
                        if op == '<=': return sv <= value
                    return False

                result = [r for r in result if matches(r)]
        except Exception:
            pass  # where 파싱 실패 → 필터 skip

    # fields — 컬럼 선택
    if fields and isinstance(fields, list):
        result = [{k: r.get(k) for k in fields} for r in result]

    # limit — 마지막 N개 (정렬 가정 X — 받은 순서대로 처음 N)
    if limit and isinstance(limit, int) and len(result) > limit:
        result = result[:limit]

    return result


def call_dart(endpoint, params, api_key):
    """DART API 호출 helper."""
    import requests
    params = {'crtfc_key': api_key, **params}
    url = f"{API_BASE}/{endpoint}"
    res = requests.get(url, params=params, timeout=15)
    res.raise_for_status()
    data = res.json()
    # DART status: '000'=정상, '013'=조회된 데이터 없음, 그 외 에러
    status = data.get('status', '')
    if status == '013':
        return {'list': [], 'total_count': 0, 'total_page': 0}
    if status not in ('000', ''):
        msg = data.get('message', f'DART API 에러 status={status}')
        raise RuntimeError(f'DART {status}: {msg}')
    return data


def main():
    raw = sys.stdin.buffer.read()
    payload = json.loads(raw.decode('utf-8'))
    data = payload.get('data', {})
    action = data.get('action', '')

    api_key = os.environ.get('DART_API_KEY', '').strip()
    if not api_key:
        return out(False, error='DART_API_KEY 환경변수 미설정. opendart.fss.or.kr 가입 후 발급.')

    # action='lookup' — corp_code 매핑 utility (DART API 호출 X, 디스크 cache 만 사용)
    if action == 'lookup':
        query = data.get('query', '').strip()
        if not query:
            return out(False, error="action='lookup' 에는 query 필수 (회사명/종목코드/corp_code)")
        result = lookup_query(query, api_key=api_key)
        if not result:
            return out(False, error=f'매칭 종목 없음: {query} (회사명·종목코드·corp_code 확인)')
        return out(True, result)

    # 다른 액션 — corp_code 자동 변환
    corp_code = data.get('corp_code', '').strip()
    stock_code = data.get('stock_code', '').strip()
    query = data.get('query', '').strip()
    if not corp_code and (stock_code or query):
        resolved = resolve_corp_code(stock_code or query, api_key=api_key)
        if not resolved:
            return out(False, error=f'corp_code 매핑 실패: {stock_code or query}')
        corp_code = resolved

    # action='list' — 공시 검색
    if action == 'list':
        params = {}
        if corp_code: params['corp_code'] = corp_code
        if data.get('bgn_de'): params['bgn_de'] = data['bgn_de']
        if data.get('end_de'): params['end_de'] = data['end_de']
        if data.get('pblntf_ty'): params['pblntf_ty'] = data['pblntf_ty']
        if data.get('corp_cls'): params['corp_cls'] = data['corp_cls']
        params['page_no'] = data.get('page_no', 1)
        # DART page_count default 10, max 100. limit 명시되면 그대로 (최대 100).
        params['page_count'] = min(100, data.get('limit', 10))
        result = call_dart('list.json', params, api_key)
        records = result.get('list', [])
        # sub-query 적용 (where/fields. limit 은 page_count 로 이미 처리)
        records = apply_subquery(records, fields=data.get('fields'), where=data.get('where'))
        # 100건+ → cache 모드 (DART 는 sub-query 로 줄이는 게 우선이나 안전망).
        if len(records) > 100:
            return out(True, {
                'corp_code': corp_code,
                'total_count': result.get('total_count', 0),
                'total_page': result.get('total_page', 0),
                '_cache': {
                    'records': records,
                    'sysmod': 'dart',
                    'action': 'list',
                    'params': {'corp_code': corp_code, 'bgn_de': data.get('bgn_de'), 'end_de': data.get('end_de')},
                    'ttlSec': 600,
                },
            })
        return out(True, {
            'list': records,
            'total_count': result.get('total_count', 0),
            'total_page': result.get('total_page', 0),
        })

    # action='company' — 기업개황
    if action == 'company':
        if not corp_code:
            return out(False, error="action='company' 에는 corp_code 필수 (또는 query/stock_code 로 자동 변환)")
        result = call_dart('company.json', {'corp_code': corp_code}, api_key)
        # 단일 record. fields 만 의미 있음.
        if data.get('fields'):
            result = {k: result.get(k) for k in data['fields']}
        return out(True, result)

    # action='financial' / 'financialAll' — 재무
    if action in ('financial', 'financialAll'):
        if not corp_code:
            return out(False, error=f"action='{action}' 에는 corp_code 필수")
        bsns_year = data.get('bsns_year')
        reprt_code = data.get('reprt_code')
        if not bsns_year or not reprt_code:
            return out(False, error="financial/financialAll 에는 bsns_year(YYYY) + reprt_code(1011/1012/1013/1014) 필수")
        endpoint = 'fnlttSinglAcnt.json' if action == 'financial' else 'fnlttSinglAcntAll.json'
        params = {'corp_code': corp_code, 'bsns_year': bsns_year, 'reprt_code': reprt_code}
        if action == 'financialAll':
            params['fs_div'] = data.get('fs_div', 'CFS')
        result = call_dart(endpoint, params, api_key)
        records = result.get('list', [])
        records = apply_subquery(records, limit=data.get('limit'), fields=data.get('fields'), where=data.get('where'))
        return out(True, {'list': records})

    # action='majorStock' — 대량보유 5%+
    if action == 'majorStock':
        if not corp_code:
            return out(False, error="action='majorStock' 에는 corp_code 필수")
        result = call_dart('majorstock.json', {'corp_code': corp_code}, api_key)
        records = result.get('list', [])
        records = apply_subquery(records, limit=data.get('limit'), fields=data.get('fields'), where=data.get('where'))
        return out(True, {'list': records})

    # action='executiveStock' — 임원·주요주주 소유
    if action == 'executiveStock':
        if not corp_code:
            return out(False, error="action='executiveStock' 에는 corp_code 필수")
        result = call_dart('elestock.json', {'corp_code': corp_code}, api_key)
        records = result.get('list', [])
        records = apply_subquery(records, limit=data.get('limit'), fields=data.get('fields'), where=data.get('where'))
        return out(True, {'list': records})

    # action='document' — 공시 원문 다운로드 URL (XBRL 또는 zip)
    if action == 'document':
        rcept_no = data.get('rcept_no', '').strip()
        if not rcept_no:
            return out(False, error="action='document' 에는 rcept_no 필수 (list 결과의 접수번호)")
        # document.xml endpoint 는 직접 다운로드 zip 반환. URL 만 구성해서 반환.
        return out(True, {
            'rcept_no': rcept_no,
            'download_url': f'{API_BASE}/document.xml?crtfc_key=<API_KEY>&rcept_no={rcept_no}',
            'note': '브라우저로 다운로드 가능. zip 안에 XBRL/PDF 포함.',
        })

    return out(False, error=f'unknown action: {action}')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        out(False, error=f'{type(e).__name__}: {e}')
