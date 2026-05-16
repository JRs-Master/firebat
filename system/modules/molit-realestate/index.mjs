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
 */

const BASE = 'https://apis.data.go.kr/1613000';

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
