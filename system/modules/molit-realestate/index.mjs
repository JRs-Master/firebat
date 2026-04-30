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
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
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
    if (errMatch) return { ok: false, error: errMatch[1] };

    const resultCodeMatch = text.match(/<resultCode>([^<]+)<\/resultCode>/);
    if (resultCodeMatch && resultCodeMatch[1] !== '00' && resultCodeMatch[1] !== '000') {
      const msgMatch = text.match(/<resultMsg>([^<]+)<\/resultMsg>/);
      return { ok: false, error: `API 오류 (${resultCodeMatch[1]}): ${msgMatch?.[1] ?? '알 수 없음'}` };
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
    return { ok: false, error: `API 오류 (${header.resultCode}): ${header.resultMsg ?? '알 수 없음'}` };
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

async function main() {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); }
  catch { return out(false, undefined, 'stdin JSON 파싱 실패'); }

  const data = input.data ?? {};
  const { action, lawdCd, dealYmd, pageNo = 1, limit = 1000 } = data;

  const serviceKey = process.env.DATA_GO_KR_API_KEY;
  if (!serviceKey) return out(false, undefined, 'DATA_GO_KR_API_KEY 환경변수 미설정');

  if (!action) return out(false, undefined, 'action 필수');
  if (!lawdCd) return out(false, undefined, 'lawdCd 필수 (시군구 5자리, 예: 11680=서울 강남구)');
  if (!dealYmd) return out(false, undefined, 'dealYmd 필수 (계약년월 6자리 YYYYMM, 예: 202604)');

  const endpoint = ACTION_ENDPOINTS[action];
  if (!endpoint) return out(false, undefined, `알 수 없는 action: ${action}. 유효: ${Object.keys(ACTION_ENDPOINTS).join(', ')}`);

  // 파라미터 검증
  if (!/^\d{5}$/.test(String(lawdCd))) {
    return out(false, undefined, 'lawdCd 는 5자리 숫자 필수 (예: 11680)');
  }
  if (!/^\d{6}$/.test(String(dealYmd))) {
    return out(false, undefined, 'dealYmd 는 YYYYMM 6자리 필수 (예: 202604)');
  }

  try {
    const r = await callApi(serviceKey, endpoint, {
      LAWD_CD: lawdCd,
      DEAL_YMD: dealYmd,
      pageNo,
      numOfRows: limit,
    });
    if (!r.ok) return out(false, undefined, r.error);

    return out(true, {
      items: r.items,
      totalCount: r.totalCount,
      pageNo,
      lawdCd,
      dealYmd,
    });
  } catch (e) {
    return out(false, undefined, `예외: ${e?.message ?? String(e)}`);
  }
}

main();
