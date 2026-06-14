"""
Firebat System Module: dart (DART 전자공시시스템)
opendart.fss.or.kr API — 한국 기업 공시·재무·지분·정기보고서·주요사항·증권신고서 + 종목코드 lookup utility

[INPUT]  stdin JSON: { "correlationId": "...", "data": { "action": "...", ... } }
[OUTPUT] stdout JSON: { "success": true, "data": {...} } 또는 { "success": false, "error": "..." }

Design — 88개 DART endpoint 를 개별 함수 대신 선언형 레지스트리(ENDPOINTS) + kind 기반 제너릭
디스패처로 처리한다. DART API 가 거의 동일 패턴(GET /api/<name>.json + 같은 파라미터군 +
{status, list:[]} 응답)이라, 새 endpoint = 테이블 한 줄. corp_code 자동 변환·sub-query·캐시는 공통.

special action: lookup(오프라인 매핑) / list(공시검색, 캐시 분기) / company(단일 레코드) / document(URL).
"""
import sys
import os
import json

# 같은 디렉토리의 helper module
from lookup import resolve_corp_code, lookup_query


API_BASE = 'https://opendart.fss.or.kr/api'

# ── 파라미터 kind ─────────────────────────────────────────────────────────
# 각 endpoint 가 어떤 파라미터 셋·필수값을 쓰는지 데이터로 표현. 디스패처가 kind 로 분기.
PERIODIC = 'periodic'      # corp_code, bsns_year, reprt_code (정기보고서 주요정보)
FINANCIAL = 'financial'    # periodic + fs_div (재무제표; All 은 fs_div 필수 CFS)
FININDEX = 'finindex'      # periodic + fs_div + idx_cl_code (재무지표)
MULTI = 'multi'            # corp_code 복수(corp_codes) + bsns_year + reprt_code (+fs_div)
MULTIINDEX = 'multiindex'  # 복수 + idx_cl_code (다중회사 재무지표)
MAJOR = 'major'            # corp_code + bgn_de + end_de (주요사항보고서 / 증권신고서)
SIMPLE = 'simple'          # corp_code 만 (지분공시)
XBRL = 'xbrl'              # sj_div 만 (corp_code 불필요)

# ── 선언형 endpoint 레지스트리 ───────────────────────────────────────────────
# action 이름 → (DART endpoint(.json 제외), kind). 새 DART API = 한 줄 추가.
ENDPOINTS = {
    # 상장기업 재무정보
    'financial':            ('fnlttSinglAcnt',      FINANCIAL),   # 단일회사 주요계정 (매출/영업이익/자산 등)
    'financialAll':         ('fnlttSinglAcntAll',   FINANCIAL),   # 단일회사 전체 재무제표 (BS/IS/CF/CIS/SCE)
    'financialMulti':       ('fnlttMultiAcnt',      MULTI),       # 다중회사 주요계정 비교
    'financialIndex':       ('fnlttSinglIndx',      FININDEX),    # 단일회사 주요 재무지표
    'financialIndexMulti':  ('fnlttCmpnyIndx',      MULTIINDEX),  # 다중회사 주요 재무지표 비교
    'xbrlTaxonomy':         ('xbrlTaxonomy',        XBRL),        # XBRL 표준 계정과목 분류
    'dividend':             ('alotMatter',          PERIODIC),    # 배당에 관한 사항

    # 지분공시 종합정보
    'majorStock':           ('majorstock',          SIMPLE),      # 대량보유 상황보고 (5%+)
    'executiveStock':       ('elestock',            SIMPLE),      # 임원·주요주주 소유보고

    # 정기보고서 주요정보 — 주주
    'largestShareholder':       ('hyslrSttus',      PERIODIC),    # 최대주주 현황
    'largestShareholderChange': ('hyslrChgSttus',   PERIODIC),    # 최대주주 변동현황
    'minorityShareholder':      ('mrhlSttus',       PERIODIC),    # 소액주주 현황
    # 정기보고서 — 임원/직원
    'executiveStatus':      ('exctvSttus',          PERIODIC),    # 임원 현황
    'employeeStatus':       ('empSttus',            PERIODIC),    # 직원 현황
    'outsideDirector':      ('outcmpnyDrctrNdChangeSttus', PERIODIC),  # 사외이사 및 변동현황
    # 정기보고서 — 보수
    'individualCompensation':       ('hmvAuditIndvdlBySttus', PERIODIC),  # 이사·감사 개인별 보수
    'totalCompensation':            ('hmvAuditAllSttus',      PERIODIC),  # 이사·감사 전체 보수
    'top5Compensation':             ('indvdlByPay',           PERIODIC),  # 개인별 보수 상위 5인
    'unregisteredExecCompensation': ('unrstExctvMendngSttus', PERIODIC),  # 미등기임원 보수
    'compensationApproval':         ('mendngSttus',           PERIODIC),  # 이사·감사 보수 (주총 승인금액)
    # 정기보고서 — 주식
    'totalShares':          ('stockTotqySttus',     PERIODIC),    # 주식의 총수 현황
    'stockIssuance':        ('irdsSttus',           PERIODIC),    # 증자(감자) 현황
    'treasuryStockStatus':  ('tesstkAcqsDspsSttus', PERIODIC),    # 자기주식 취득·처분 현황
    # 정기보고서 — 감사
    'auditorOpinion':       ('accnutAdtorNmNdAdtOpinion', PERIODIC),  # 회계감사인 명칭·감사의견
    'auditServiceContract': ('adtServiCntrctSttus', PERIODIC),    # 감사용역 체결현황
    'nonAuditService':      ('nadtServiCntrctSttus', PERIODIC),   # 회계감사인과의 비감사용역 계약
    # 정기보고서 — 투자/자금
    'investmentInOthers':   ('otrCprInvstmntSttus', PERIODIC),    # 타법인 출자현황
    'publicOfferingFund':   ('pifndUseDtls',        PERIODIC),    # 공모자금 사용내역
    'privatePlacementFund': ('prfdUseDtls',         PERIODIC),    # 사모자금 사용내역
    # 정기보고서 — 채무증권
    'debtSecuritiesIssued': ('detScritsIsuAcmslt',  PERIODIC),    # 채무증권 발행실적
    'commercialPaper':      ('entrprsBilScritsNrdmpBlce', PERIODIC),  # 기업어음 미상환 잔액
    'shortTermBond':        ('srtpdPsndbtNrdmpBlce', PERIODIC),   # 단기사채 미상환 잔액
    'corporateBond':        ('cprndNrdmpBlce',      PERIODIC),    # 회사채 미상환 잔액
    'newCapitalSecurities': ('nwCptlScritsNrdmpBlce', PERIODIC),  # 신종자본증권 미상환 잔액
    'contingentCapital':    ('wdCocobdNrdmpBlce',   PERIODIC),    # 조건부 자본증권 미상환 잔액

    # 주요사항보고서 — 자본 변동
    'capitalIncrease':      ('piicDecsn',           MAJOR),       # 유상증자 결정
    'freeCapitalIncrease':  ('fricDecsn',           MAJOR),       # 무상증자 결정
    'mixedCapitalIncrease': ('pifricDecsn',         MAJOR),       # 유무상증자 결정
    'capitalDecrease':      ('crDecsn',             MAJOR),       # 감자 결정
    # 주요사항 — 조직 변경
    'merger':               ('cmpMgDecsn',          MAJOR),       # 회사합병 결정
    'division':             ('cmpDvDecsn',          MAJOR),       # 회사분할 결정
    'divisionMerger':       ('cmpDvmgDecsn',        MAJOR),       # 회사분할합병 결정
    # 주요사항 — 영업/자산 양수도
    'businessAcquisition':  ('bsnInhDecsn',         MAJOR),       # 영업양수 결정
    'businessTransfer':     ('bsnTrfDecsn',         MAJOR),       # 영업양도 결정
    'tangibleAssetAcquisition': ('tgastInhDecsn',   MAJOR),       # 유형자산 양수 결정
    'tangibleAssetTransfer':    ('tgastTrfDecsn',   MAJOR),       # 유형자산 양도 결정
    'otherStockAcquisition':    ('otcprStkInvscrInhDecsn', MAJOR),  # 타법인 주식·출자증권 양수
    'otherStockTransfer':       ('otcprStkInvscrTrfDecsn', MAJOR),  # 타법인 주식·출자증권 양도
    'assetTransferPutback':     ('astInhtrfEtcPtbkOpt', MAJOR),  # 자산양수도(기타)·풋백옵션
    # 주요사항 — 자기주식
    'stockExchangeTransfer':    ('stkExtrDecsn',    MAJOR),       # 주식교환·이전 결정
    'treasuryAcquisition':      ('tsstkAqDecsn',    MAJOR),       # 자기주식 취득 결정
    'treasuryDisposal':         ('tsstkDpDecsn',    MAJOR),       # 자기주식 처분 결정
    'treasuryTrustContract':    ('tsstkAqTrctrCnsDecsn', MAJOR),  # 자기주식 신탁계약 체결
    'treasuryTrustTermination': ('tsstkAqTrctrCcDecsn',  MAJOR),  # 자기주식 신탁계약 해지
    # 주요사항 — 사채
    'convertibleBond':          ('cvbdIsDecsn',     MAJOR),       # 전환사채 발행결정
    'bondWithWarrant':          ('bdwtIsDecsn',     MAJOR),       # 신주인수권부사채 발행결정
    'exchangeableBond':         ('exbdIsDecsn',     MAJOR),       # 교환사채 발행결정
    'contingentConvertibleBond': ('wdCocobdIsDecsn', MAJOR),      # 조건부 자본증권 발행결정
    'stockRelatedBondAcquisition': ('stkrtbdInhDecsn', MAJOR),    # 주권 관련 사채 양수
    'stockRelatedBondTransfer':    ('stkrtbdTrfDecsn', MAJOR),    # 주권 관련 사채 양도
    'stockDividendDecision':    ('stDecsn',         MAJOR),       # 주식배당 결정
    # 주요사항 — 해외상장
    'overseasListingDecision':   ('ovLstDecsn',     MAJOR),       # 해외 증권시장 상장 결정
    'overseasDelistingDecision': ('ovDlstDecsn',    MAJOR),       # 해외 증권시장 상장폐지 결정
    'overseasListing':          ('ovLst',           MAJOR),       # 해외상장 현황
    'overseasDelisting':        ('ovDlst',          MAJOR),       # 해외상장폐지 현황
    # 주요사항 — 법률/경영
    'creditorManagementStart':  ('bnkMngtPcbg',     MAJOR),       # 채권은행 관리절차 개시
    'creditorManagementStop':   ('bnkMngtPcsp',     MAJOR),       # 채권은행 관리절차 중단
    'defaultOccurrence':        ('dfOcr',           MAJOR),       # 부도 발생
    'lawsuit':                  ('lwstLg',          MAJOR),       # 소송 등의 제기
    'businessSuspension':       ('bsnSp',           MAJOR),       # 영업정지
    'rehabilitation':           ('ctrcvsBgrq',      MAJOR),       # 회생절차 개시신청
    'dissolution':              ('dsRsOcr',         MAJOR),       # 해산사유 발생

    # 증권신고서 주요정보
    'equitySecuritiesReg':      ('estkRs',          MAJOR),       # 지분증권 신고서
    'debtSecuritiesReg':        ('bdRs',            MAJOR),       # 채무증권 신고서
    'depositaryReceiptsReg':    ('stkdpRs',         MAJOR),       # 예탁증권 신고서
    'mergerReg':                ('mgRs',            MAJOR),       # 합병 신고서
    'stockExchangeReg':         ('extrRs',          MAJOR),       # 주식교환·이전 신고서
    'divisionReg':              ('dvRs',            MAJOR),       # 분할 신고서
}


def out(success, data=None, error=None):
    msg = {'success': success}
    if data is not None:
        msg['data'] = data
    if error:
        msg['error'] = error
    sys.stdout.write(json.dumps(msg, ensure_ascii=False, default=str))
    sys.stdout.flush()


def out_err(key, params=None):
    """i18n 에러 응답 — errorKey + errorParams. resolve_sysmod_error 가 module.dart.{key} 로 변환."""
    msg = {'success': False, 'errorKey': key}
    if params:
        msg['errorParams'] = params
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

    # limit — 처음 N개 (받은 순서대로)
    if limit and isinstance(limit, int) and len(result) > limit:
        result = result[:limit]

    return result


def call_dart(endpoint, params, api_key):
    """DART API 호출 helper. endpoint = '.json' 포함 경로."""
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


def resolve_codes(raw_codes, fallback, api_key):
    """다중회사 — corp_codes(배열/콤마문자열)의 각 항목을 corp_code 8자리로 변환해 콤마 결합.
    8자리 숫자는 그대로, 그 외(회사명·종목코드)는 resolve_corp_code 로 변환."""
    if isinstance(raw_codes, str):
        raw_codes = [c.strip() for c in raw_codes.split(',') if c.strip()]
    if not isinstance(raw_codes, list):
        raw_codes = []
    resolved = []
    for c in raw_codes:
        c = str(c).strip()
        if not c:
            continue
        if len(c) == 8 and c.isdigit():
            resolved.append(c)
        else:
            rc = resolve_corp_code(c, api_key=api_key)
            if rc:
                resolved.append(rc)
    if not resolved and fallback:
        resolved = [fallback]
    return resolved


def dispatch_endpoint(action, data, corp_code, api_key):
    """선언형 ENDPOINTS 레지스트리 기반 제너릭 디스패처. kind 가 파라미터·필수값을 결정."""
    endpoint, kind = ENDPOINTS[action]
    params = {}

    # XBRL — corp_code 불필요, sj_div 만.
    if kind == XBRL:
        sj_div = (data.get('sj_div') or '').strip()
        if not sj_div:
            return out_err('error.sj_div_required')
        params['sj_div'] = sj_div
        result = call_dart(f'{endpoint}.json', params, api_key)
        records = apply_subquery(result.get('list', []), limit=data.get('limit'),
                                 fields=data.get('fields'), where=data.get('where'))
        return out(True, {'list': records})

    # 다중회사 — corp_codes 복수.
    if kind in (MULTI, MULTIINDEX):
        codes = resolve_codes(data.get('corp_codes'), corp_code, api_key)
        if not codes:
            return out_err('error.corp_codes_required')
        params['corp_code'] = ','.join(codes)
    else:
        if not corp_code:
            return out_err('error.corp_code_required', {'action': action})
        params['corp_code'] = corp_code

    # 기간 파라미터.
    if kind in (PERIODIC, FINANCIAL, FININDEX, MULTI, MULTIINDEX):
        bsns_year = data.get('bsns_year')
        reprt_code = data.get('reprt_code')
        if not bsns_year or not reprt_code:
            return out_err('error.period_required')
        params['bsns_year'] = bsns_year
        params['reprt_code'] = reprt_code
    if kind == MAJOR:
        # bgn_de/end_de 는 선택 — 미지정 시 DART 가 최근 공시 반환.
        if data.get('bgn_de'):
            params['bgn_de'] = data['bgn_de']
        if data.get('end_de'):
            params['end_de'] = data['end_de']

    # fs_div — 재무제표 구분.
    if kind in (FINANCIAL, FININDEX, MULTI, MULTIINDEX):
        if data.get('fs_div'):
            params['fs_div'] = data['fs_div']
        elif endpoint == 'fnlttSinglAcntAll':
            params['fs_div'] = 'CFS'  # 전체 재무제표는 fs_div 필수.

    # idx_cl_code — 재무지표 분류.
    if kind in (FININDEX, MULTIINDEX):
        idx = (data.get('idx_cl_code') or '').strip()
        if not idx:
            return out_err('error.idx_cl_code_required')
        params['idx_cl_code'] = idx

    result = call_dart(f'{endpoint}.json', params, api_key)
    records = apply_subquery(result.get('list', []), limit=data.get('limit'),
                             fields=data.get('fields'), where=data.get('where'))
    return out(True, {'list': records})


def main():
    raw = sys.stdin.buffer.read()
    payload = json.loads(raw.decode('utf-8'))
    data = payload.get('data', {})
    action = data.get('action', '')

    api_key = os.environ.get('DART_API_KEY', '').strip()
    if not api_key:
        return out_err('error.api_key_missing')

    # action='lookup' — corp_code 매핑 utility (DART API 호출 X, 디스크 cache 만 사용)
    if action == 'lookup':
        query = data.get('query', '').strip()
        if not query:
            return out_err('error.lookup_query_required')
        result = lookup_query(query, api_key=api_key)
        if not result:
            return out_err('error.lookup_not_found', {'query': query})
        return out(True, result)

    # 다른 액션 — corp_code 자동 변환 (다중회사는 dispatch 내부에서 corp_codes 처리)
    corp_code = data.get('corp_code', '').strip()
    stock_code = data.get('stock_code', '').strip()
    query = data.get('query', '').strip()
    if not corp_code and (stock_code or query):
        resolved = resolve_corp_code(stock_code or query, api_key=api_key)
        if resolved:
            corp_code = resolved

    # action='list' — 공시 검색 (캐시 분기 — special)
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
        # 50건+ → cache 모드. limit=100 정확히 받아도 발동 (DART API max page_count=100).
        if len(records) >= 50:
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

    # action='company' — 기업개황 (단일 레코드 — special)
    if action == 'company':
        if not corp_code:
            return out_err('error.corp_code_required', {'action': action})
        result = call_dart('company.json', {'corp_code': corp_code}, api_key)
        # 단일 record. fields 만 의미 있음.
        if data.get('fields'):
            result = {k: result.get(k) for k in data['fields']}
        return out(True, result)

    # action='document' — 공시 원문 다운로드 URL (XBRL 또는 zip — special)
    if action == 'document':
        rcept_no = data.get('rcept_no', '').strip()
        if not rcept_no:
            return out_err('error.document_rcept_no_required')
        # document.xml endpoint 는 직접 다운로드 zip 반환. URL 만 구성해서 반환.
        return out(True, {
            'rcept_no': rcept_no,
            'download_url': f'{API_BASE}/document.xml?crtfc_key=<API_KEY>&rcept_no={rcept_no}',
            'note': '브라우저로 다운로드 가능. zip 안에 XBRL/PDF 포함.',
        })

    # 선언형 레지스트리 — 나머지 모든 endpoint (재무/지분/정기보고서/주요사항/증권신고서)
    if action in ENDPOINTS:
        return dispatch_endpoint(action, data, corp_code, api_key)

    return out_err('error.unknown_action', {'action': action})


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        out_err('error.runtime', {'type': type(e).__name__, 'message': str(e)})
