#!/usr/bin/env node
/**
 * 국토교통부 실거래가 통합 sysmod — data.go.kr RTMSDataSvc 13 시리즈.
 *
 * 인증: ?serviceKey=<URL-encoded DATA_GO_KR_API_KEY>
 * 응답: dataType=JSON 강제
 *
 * 모든 action 공통 파라미터: LAWD_CD (시군구 5자리) + DEAL_YMD (YYYYMM)
 *
 * action 별 endpoint:
 *   apt-trade        — RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade
 *   apt-trade-detail — RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev (층·동)
 *   apt-rent         — RTMSDataSvcAptRent/getRTMSDataSvcAptRent
 *   apt-pre-trade    — RTMSDataSvcSilvTrade/getRTMSDataSvcSilvTrade (분양권 전매)
 *   rh-trade         — RTMSDataSvcRHTrade/getRTMSDataSvcRHTrade (연립다세대)
 *   rh-rent          — RTMSDataSvcRHRent/getRTMSDataSvcRHRent
 *   offi-trade       — RTMSDataSvcOffiTrade/getRTMSDataSvcOffiTrade (오피스텔)
 *   offi-rent        — RTMSDataSvcOffiRent/getRTMSDataSvcOffiRent
 *   sh-trade         — RTMSDataSvcSHTrade/getRTMSDataSvcSHTrade (단독·다가구)
 *   sh-rent          — RTMSDataSvcSHRent/getRTMSDataSvcSHRent
 *   land-trade       — RTMSDataSvcLandTrade/getRTMSDataSvcLandTrade
 *   commercial-trade — RTMSDataSvcNrgTrade/getRTMSDataSvcNrgTrade (상업업무용 매매)
 *   factory-trade    — RTMSDataSvcInduTrade/getRTMSDataSvcInduTrade (공장·창고 매매)
 *
 * lookup — 지역명 → 시군구 5자리 법정동코드(LAWD_CD). 행안부 행정표준코드(StanReginCd) API 라이브
 *   조회라 행정구역 개편(예: 2026-07 전남·광주·인천)도 원천에서 자동 반영 — 정적 테이블 없음.
 *   같은 DATA_GO_KR_API_KEY 사용 (포털에서 "행정표준코드_법정동코드" 활용신청 필요).
 */

const BASE = 'https://apis.data.go.kr/1613000';
const REGION_CD_API = 'https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList';

const ACTION_ENDPOINTS = {
  'apt-trade':        '/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade',
  'apt-trade-detail': '/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev',
  'apt-rent':         '/RTMSDataSvcAptRent/getRTMSDataSvcAptRent',
  'apt-pre-trade':    '/RTMSDataSvcSilvTrade/getRTMSDataSvcSilvTrade',
  'rh-trade':         '/RTMSDataSvcRHTrade/getRTMSDataSvcRHTrade',
  'rh-rent':          '/RTMSDataSvcRHRent/getRTMSDataSvcRHRent',
  'offi-trade':       '/RTMSDataSvcOffiTrade/getRTMSDataSvcOffiTrade',
  'offi-rent':        '/RTMSDataSvcOffiRent/getRTMSDataSvcOffiRent',
  'sh-trade':         '/RTMSDataSvcSHTrade/getRTMSDataSvcSHTrade',
  'sh-rent':          '/RTMSDataSvcSHRent/getRTMSDataSvcSHRent',
  'land-trade':       '/RTMSDataSvcLandTrade/getRTMSDataSvcLandTrade',
  'commercial-trade': '/RTMSDataSvcNrgTrade/getRTMSDataSvcNrgTrade',
  'factory-trade':    '/RTMSDataSvcInduTrade/getRTMSDataSvcInduTrade',
};

async function callApi(serviceKey, path, params) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('serviceKey', serviceKey);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) return { ok: false, errorKey: 'error.http_status', errorParams: { status: String(res.status) } };
  const text = await res.text();

  // data.go.kr 의 RTMSDataSvc 시리즈는 기본 XML 응답 (dataType=JSON 무시되는 경우 있음)
  // → 둘 다 처리
  let json = null;
  if (text.trim().startsWith('{')) {
    try { json = JSON.parse(text); } catch { /* fallthrough */ }
  }

  // XML 응답 — DOM 파서 없이 정규식으로 items 추출 (Node.js 환경)
  if (!json) {
    // 에러 체크
    const errMatch = text.match(/<returnAuthMsg>([^<]+)<\/returnAuthMsg>/) || text.match(/<errMsg>([^<]+)<\/errMsg>/);
    if (errMatch) return { ok: false, errorKey: 'error.xml_auth', errorParams: { message: errMatch[1] } };

    const resultCodeMatch = text.match(/<resultCode>([^<]+)<\/resultCode>/);
    if (resultCodeMatch && resultCodeMatch[1] !== '00' && resultCodeMatch[1] !== '000') {
      const msgMatch = text.match(/<resultMsg>([^<]+)<\/resultMsg>/);
      return { ok: false, errorKey: 'error.api_error', errorParams: { code: resultCodeMatch[1], message: msgMatch?.[1] ?? '' } };
    }

    // items 추출 — <item>...</item> 블록을 객체로
    const items = [];
    const itemPattern = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemPattern.exec(text)) !== null) {
      const itemBody = m[1];
      const fieldPattern = /<(\w+)>([^<]*)<\/\1>/g;
      const obj = {};
      let f;
      while ((f = fieldPattern.exec(itemBody)) !== null) {
        obj[f[1]] = f[2].trim();
      }
      items.push(obj);
    }
    const totalCountMatch = text.match(/<totalCount>(\d+)<\/totalCount>/);
    return { ok: true, items, totalCount: totalCountMatch ? parseInt(totalCountMatch[1], 10) : items.length };
  }

  // JSON 응답
  const header = json?.response?.header;
  if (header?.resultCode && header.resultCode !== '00' && header.resultCode !== '000') {
    return { ok: false, errorKey: 'error.api_error', errorParams: { code: header.resultCode, message: header.resultMsg ?? '' } };
  }
  const items = json?.response?.body?.items?.item ?? [];
  const itemArr = Array.isArray(items) ? items : (items && typeof items === 'object' ? [items] : []);
  return { ok: true, items: itemArr, totalCount: json?.response?.body?.totalCount ?? itemArr.length };
}

/**
 * 지역명 → 시군구 후보 (행안부 StanReginCd). 응답은 type=json 요청 시
 * {"StanReginCd":[{"head":[{totalCount},{RESULT:{resultCode}}]},{"row":[{region_cd(10자리),
 * sido_cd,sgg_cd,umd_cd,ri_cd,locatadd_nm,...}]}]} — 단 인증 오류는 XML 로 오고, no-data 는
 * {"RESULT":{...}} 평면 shape 라 전부 방어 파싱.
 */
async function lookupRegion(serviceKey, query) {
  const url = new URL(REGION_CD_API);
  url.searchParams.set('serviceKey', serviceKey);
  url.searchParams.set('type', 'json');
  url.searchParams.set('flag', 'Y');
  url.searchParams.set('pageNo', '1');
  url.searchParams.set('numOfRows', '300');
  url.searchParams.set('locatadd_nm', query);

  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) return { ok: false, errorKey: 'error.http_status', errorParams: { status: String(res.status) } };
  const text = await res.text();

  let rows = null;
  let totalCount = 0;
  if (text.trim().startsWith('{')) {
    let json = null;
    try { json = JSON.parse(text); } catch { /* fallthrough to XML branch */ }
    const parts = json?.StanReginCd;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (Array.isArray(part?.head)) {
          for (const h of part.head) {
            if (h?.totalCount != null) totalCount = parseInt(h.totalCount, 10) || 0;
            const rc = h?.RESULT?.resultCode;
            // INFO-0 = 정상 / INFO-200·INFO-3 = 데이터 없음(정상 빈 결과 — 실측 2026-07-18:
            // 미매칭 지역명에 INFO-3 "데이터없음"이 옴. 에러가 아니라 빈 결과로 취급해야 재시도 사다리가 돈다).
            if (rc && rc !== 'INFO-0' && rc !== 'INFO-200' && rc !== 'INFO-3') {
              return { ok: false, errorKey: 'error.api_error', errorParams: { code: rc, message: h?.RESULT?.resultMsg ?? '' } };
            }
          }
        }
        if (Array.isArray(part?.row)) rows = part.row;
      }
      if (!rows) rows = [];
    } else if (json?.RESULT) {
      const rc = String(json.RESULT.resultCode ?? '');
      if (rc === 'INFO-200' || rc === 'INFO-3') rows = [];
      else return { ok: false, errorKey: 'error.api_error', errorParams: { code: rc || '?', message: json.RESULT.resultMsg ?? '' } };
    }
  }
  if (rows == null) {
    // XML 응답 (인증 오류는 type=json 이어도 XML) — 기존 정규식 파싱 재사용.
    const errMatch = text.match(/<returnAuthMsg>([^<]+)<\/returnAuthMsg>/) || text.match(/<errMsg>([^<]+)<\/errMsg>/);
    if (errMatch) return { ok: false, errorKey: 'error.xml_auth', errorParams: { message: errMatch[1] } };
    rows = [];
    const rowPattern = /<row>([\s\S]*?)<\/row>/g;
    let m;
    while ((m = rowPattern.exec(text)) !== null) {
      const body = m[1];
      const fieldPattern = /<(\w+)>([^<]*)<\/\1>/g;
      const obj = {};
      let f;
      while ((f = fieldPattern.exec(body)) !== null) obj[f[1]] = f[2].trim();
      rows.push(obj);
    }
    const tc = text.match(/<totalCount>(\d+)<\/totalCount>/);
    if (tc) totalCount = parseInt(tc[1], 10);
  }

  // 시군구(LAWD_CD 5자리) 단위 dedup — 시도 단독 행(sgg_cd=000)은 실거래가 조회에 못 쓰니 제외,
  // 읍면동 히트는 소속 시군구로 승격(시군구 레벨 행의 이름 우선, 없으면 매칭된 동 이름 그대로).
  const bySgg = new Map();
  for (const r of rows) {
    const regionCd = String(r.region_cd ?? '');
    if (!/^\d{10}$/.test(regionCd)) continue;
    const sgg = String(r.sgg_cd ?? '');
    if (!sgg || sgg === '000') continue; // 시도 레벨 행
    const lawdCd = regionCd.slice(0, 5);
    const umd = String(r.umd_cd ?? '');
    const ri = String(r.ri_cd ?? '');
    const isSggLevel = umd === '000' && (ri === '00' || ri === '');
    const prev = bySgg.get(lawdCd);
    if (!prev || (isSggLevel && !prev.isSggLevel)) {
      bySgg.set(lawdCd, { lawdCd, name: String(r.locatadd_nm ?? ''), isSggLevel });
    }
  }
  const candidates = [...bySgg.values()].map(({ lawdCd, name }) => ({ lawdCd, name }));
  return { ok: true, candidates, totalCount };
}

/** 시도 축약 표기 → 공식 명칭 (StanReginCd locatadd_nm 은 공식 전체 명칭 기준 매칭이라
 *  "서울 동작구" 류 구어 표기가 미스남 — 표준 17개 시도 축약 = 유한 참조 데이터). */
const SIDO_FULL = {
  '서울': '서울특별시', '부산': '부산광역시', '대구': '대구광역시', '인천': '인천광역시',
  '광주': '광주광역시', '대전': '대전광역시', '울산': '울산광역시', '세종': '세종특별자치시',
  '경기': '경기도', '강원': '강원특별자치도', '충북': '충청북도', '충남': '충청남도',
  '전북': '전북특별자치도', '전남': '전라남도', '경북': '경상북도', '경남': '경상남도',
  '제주': '제주특별자치도',
};

/**
 * lookup 재시도 사다리 — 원 쿼리 미스 시 표기 변형으로 자동 재조회 (모델 왕복 절약):
 *   ① 원 쿼리 → ② 첫 토큰 시도 축약 → 공식명 확장(2+ 토큰일 때만 — "광주" 단독은
 *   광역시/경기 광주시 모호라 확장 안 함) → ③ 왼쪽 토큰 drop(최대 2회 — "동작구 대방동" → "대방동").
 *   실측 2026-07-18: "서울 동작구 대방동" 이 INFO-3 로 죽어 모델이 검색으로 후퇴하던 것.
 */
async function lookupRegionSmart(serviceKey, query) {
  const tokens = query.split(/\s+/).filter(Boolean);
  const attempts = [query];
  if (tokens.length >= 2 && SIDO_FULL[tokens[0]]) {
    attempts.push([SIDO_FULL[tokens[0]], ...tokens.slice(1)].join(' '));
  }
  for (let i = 1; i <= Math.min(2, tokens.length - 1); i++) {
    attempts.push(tokens.slice(i).join(' '));
  }
  const seen = new Set();
  let last = null;
  for (const q of attempts) {
    if (seen.has(q)) continue;
    seen.add(q);
    const r = await lookupRegion(serviceKey, q);
    if (!r.ok) return r; // 실제 API 에러(인증 등)는 즉시 반환 — no-data 는 ok+빈 candidates
    if (r.candidates.length > 0) return { ...r, matchedQuery: q };
    last = r;
  }
  return last ?? { ok: true, candidates: [], totalCount: 0 };
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk.toString('utf-8'); });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function out(success, data, error) {
  const result = { success };
  if (data !== undefined) result.data = data;
  if (error) result.error = error;
  process.stdout.write(JSON.stringify(result));
}

/** i18n 에러 응답 — errorKey + errorParams. resolve_sysmod_error 가 module.molit-realestate.{key} 로 변환. */
function outErr(key, params) {
  const r = { success: false, errorKey: key };
  if (params && Object.keys(params).length > 0) r.errorParams = params;
  process.stdout.write(JSON.stringify(r));
}

async function main() {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); }
  catch { return outErr('error.stdin_parse', {}); }

  const data = input.data ?? {};
  const { action, lawdCd, dealYmd, pageNo = 1, limit = 1000 } = data;

  const serviceKey = process.env.DATA_GO_KR_API_KEY;
  if (!serviceKey) return outErr('error.api_key_missing', {});

  if (!action) return outErr('error.action_required', {});

  // lookup — 지역명 → lawdCd resolver (실거래가 파라미터 불필요, grounding exempt).
  if (action === 'lookup') {
    const query = String(data.query ?? '').trim();
    if (!query) return outErr('error.query_required', {});
    try {
      const r = await lookupRegionSmart(serviceKey, query);
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      const note = r.candidates.length === 0
        ? 'no region matched (abbreviation/token-drop variants were retried too) — try a broader or official name (e.g. "강남구", "수원시")'
        : r.candidates.length > 1
          ? 'multiple regions matched — ask the user with a suggest picker, do not pick arbitrarily'
          : 'single match — use this lawdCd directly';
      const payload = { candidates: r.candidates, totalCount: r.totalCount, note };
      if (r.matchedQuery && r.matchedQuery !== query) payload.matchedQuery = r.matchedQuery;
      return out(true, payload);
    } catch (e) {
      return outErr('error.runtime', { message: e?.message ?? String(e) });
    }
  }

  if (!lawdCd) return outErr('error.lawdCd_required', {});
  if (!dealYmd) return outErr('error.dealYmd_required', {});

  const endpoint = ACTION_ENDPOINTS[action];
  if (!endpoint) return outErr('error.unknown_action', { action: String(action), valid: Object.keys(ACTION_ENDPOINTS).join(', ') });

  // 파라미터 검증
  if (!/^\d{5}$/.test(String(lawdCd))) {
    return outErr('error.lawdCd_format', {});
  }
  if (!/^\d{6}$/.test(String(dealYmd))) {
    return outErr('error.dealYmd_format', {});
  }

  try {
    const r = await callApi(serviceKey, endpoint, {
      LAWD_CD: lawdCd,
      DEAL_YMD: dealYmd,
      pageNo,
      numOfRows: limit,
    });
    if (!r.ok) return outErr(r.errorKey, r.errorParams);

    return out(true, {
      items: r.items,
      totalCount: r.totalCount,
      pageNo,
      lawdCd,
      dealYmd,
    });
  } catch (e) {
    return outErr('error.runtime', { message: e?.message ?? String(e) });
  }
}

main();
