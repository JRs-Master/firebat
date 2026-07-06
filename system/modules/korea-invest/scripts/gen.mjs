#!/usr/bin/env node
/**
 * 한투 sysmod codegen — `_apis.json` 입력 → `config.json` + `index.mjs` 생성.
 *
 * 출력: `system/modules/korea-invest/{config.json, index.mjs}` — 278 APIs, 9 domains.
 *
 * 사용:
 *   cd system/modules/korea-invest && node scripts/gen.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = resolve(__dirname, '..');

const DOMAIN_MAP = {
  '[국내주식] 주문/계좌': 'stock-account',
  '[국내주식] 기본시세': 'stock-quote',
  '[국내주식] 종목정보': 'stock-quote',
  '[국내주식] 업종/기타': 'stock-quote',
  '[국내주식] 순위분석': 'stock-ranking',
  '[국내주식] 시세분석': 'stock-analysis',
  '[국내주식] ELW 시세': 'stock-elw',
  '[국내주식] 실시간시세': 'stock-realtime',
  '[국내선물옵션] 기본시세': 'futures',
  '[국내선물옵션] 주문/계좌': 'futures',
  '[장내채권] 기본시세': 'bond',
  '[장내채권] 주문/계좌': 'bond',
  '[해외주식] 기본시세': 'overseas-stock',
  '[해외주식] 시세분석': 'overseas-stock',
  '[해외주식] 주문/계좌': 'overseas-stock',
  '[해외선물옵션] 기본시세': 'overseas-futures',
  '[해외선물옵션] 주문/계좌': 'overseas-futures',
};

const DOMAIN_DESC = {
  'stock-account': '한국투자증권 국내주식 주문/계좌 (잔고·매수가능·정정취소·예약주문·수익현황)',
  'stock-quote': '한국투자증권 국내주식 기본시세 + 종목정보 + 업종/기타 (현재가·호가·체결·일자별·종목정보)',
  'stock-ranking': '한국투자증권 국내주식 순위분석 (거래량·등락률·시가총액·수익자산지표 등)',
  'stock-analysis': '한국투자증권 국내주식 시세분석 (투자자·프로그램매매·신용잔고·체결강도·매물대 등). 주의: 종목별 투자자매매동향(일별)(FHPTJ04160001) 은 당일분이 장 마감 집계(~15:40) 후에만 제공 — 장중 당일 날짜로 호출하면 OPSQ2001 (TIME LIMIT 00:00 ~ 15:40) 오류. 장중 당일 종목 수급은 kiwoom 을 쓰고, 이 TR 은 과거 영업일 또는 15:40 이후에만 호출.',
  'stock-elw': '한국투자증권 국내주식 ELW 시세 (현재가·민감도·변동성·기초자산·조건검색)',
  'futures': '한국투자증권 국내선물옵션 (시세 + 주문/계좌) — 야간 포함',
  'bond': '한국투자증권 장내채권 (시세 + 주문/계좌)',
  'overseas-stock': '한국투자증권 해외주식 (시세 + 시세분석 + 주문/계좌) — 미국·아시아 포함',
  'overseas-futures': '한국투자증권 해외선물옵션 (시세 + 주문/계좌)',
};

const DOMAIN_CAPABILITY = {
  'stock-account': 'stock-trading',
  'stock-quote': 'stock-quote',
  'stock-ranking': 'stock-quote',
  'stock-analysis': 'stock-quote',
  'stock-elw': 'stock-quote',
  'futures': 'stock-trading',
  'bond': 'stock-trading',
  'overseas-stock': 'stock-trading',
  'overseas-futures': 'stock-trading',
};

function build(apis) {
  const apiTable = {};
  for (const api of apis) {
    apiTable[api.id] = {
      method: api.method,
      path: api.path,
      trIdReal: api.trIdReal || '',
      trIdMock: api.trIdMock || '',
      name: api.name,
    };
  }

  const byDomain = {};
  for (const api of apis) {
    if (api.menu === 'OAuth인증') continue;
    const domain = DOMAIN_MAP[api.menu];
    if (!domain || domain === 'stock-realtime') continue;
    (byDomain[domain] ||= []).push(api);
  }

  const domains = Object.entries(byDomain)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, apis]) => ({
      name,
      description: DOMAIN_DESC[name] || `한투 ${name}`,
      capability: DOMAIN_CAPABILITY[name] || 'stock-quote',
      actions: apis.map((a) => a.id).sort(),
      actionsCount: apis.length,
      actionsDetail: apis
        .map((a) => {
          // 필수 query+body 파라미터(+값 가이드 60자) 동봉 — AI 가 호출 전 필수 인자를 알게 (실패 prevention).
          const reqParams = [...(a.request?.query || []), ...(a.request?.body || [])]
            .filter((f) => f.required)
            .map((f) => {
              const d = (f.desc || '').replace(/\s+/g, ' ').trim().slice(0, 60);
              return d ? `${f.name}(${d})` : f.name;
            });
          const reqStr = reqParams.length ? ` [필수: ${reqParams.join(', ')}]` : '';
          return `  ${a.id} (TR_ID: ${a.trIdReal || 'N/A'}) — ${a.name}${reqStr}`;
        })
        .join('\n'),
    }));

  const allActions = apis
    .filter((a) => a.menu !== 'OAuth인증')
    .map((a) => a.id)
    .sort();

  const config = {
    name: 'korea-invest',
    type: 'module',
    scope: 'system',
    version: '1.0.0',
    description: '한국투자증권 OPEN API 통합 sysmod — 278 REST API + 9 도메인 (국내주식: 계좌/시세/순위/시세분석/ELW + 선물옵션·채권·해외주식·해외선물옵션). 도메인별 별도 LLM 도구로 노출.',
    runtime: 'node',
    capability: 'stock-trading',
    providerType: 'api',
    secrets: [
      { name: 'KIS_APP_KEY',      type: 'key' },
      { name: 'KIS_APP_SECRET',   type: 'key' },
      {
        name: 'KIS_ACCESS_TOKEN', type: 'token', lifetimeSec: 85800,
        // 토큰 생명주기는 인프라 TokenProvider 가 본 oauth 스펙으로 관리 (발급·선제갱신·재발급·Vault 영속).
        // sysmod 는 env 로 주입된 raw 토큰을 받아쓰기만 — 토큰 코드 0.
        oauth: {
          base: 'https://openapi.koreainvestment.com:9443',
          baseMock: 'https://openapivts.koreainvestment.com:29443',
          path: '/oauth2/tokenP', method: 'POST', contentType: 'application/json',
          body: { grant_type: 'client_credentials', appkey: '${KIS_APP_KEY}', appsecret: '${KIS_APP_SECRET}' },
          tokenField: 'access_token',
          invalidWhen: { match: 'all', conditions: [
            { field: 'rt_cd', equals: '1' },
            { field: 'msg1', regex: 'token|토큰' },
          ] },
        },
      },
    ],
    domains: domains.map(({ name, description, capability, actions, actionsCount, actionsDetail }) => ({
      name,
      description: `${description}\n총 ${actionsCount}개 API. action 으로 API ID 직접 호출:\n${actionsDetail}`,
      capability,
      actions,
    })),
    input: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: allActions,
          description: '한투 API ID 직접 호출 (예: v1_국내주식-008). 도메인별 LLM 도구로 분리 노출.',
        },
        query: {
          type: 'object',
          description: '한투 API request query parameter (GET API 의 필수).',
        },
        body: {
          type: 'object',
          description: '한투 API request body (POST API 의 필수).',
        },
        mock: {
          type: 'boolean',
          description: 'true 면 모의투자 도메인 호출. 기본 false (실전).',
        },
      },
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { apiId: { type: 'string' }, trId: { type: 'string' }, name: { type: 'string' } },
    },
  };

  const index = `#!/usr/bin/env node
/**
 * Firebat System Module: korea-invest — codegen 자동 생성 (scripts/gen.mjs).
 * 한국투자증권 OPEN API 통합 (278 REST API).
 *
 * LLM 시점: config.json 의 domains[] 가 9개 별도 도구로 분리 등록.
 * 단일 모듈로 라우팅 — action 으로 API ID 직접 호출, tr_id 자동 분기 (실전/모의).
 */

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

const API_TABLE = ${JSON.stringify(apiTable, null, 2)};

// 토큰 발급·갱신은 인프라 TokenProvider 가 config.json 의 oauth 스펙으로 처리한다.
// sysmod 는 env 로 주입된 raw 토큰(KIS_ACCESS_TOKEN)을 받아쓰기만 한다 — 토큰 코드 0.

const RATE_LIMIT = 20;
const WINDOW_MS = 1000;
const _reqTimes = [];
async function acquireSlot() {
  while (true) {
    const now = Date.now();
    while (_reqTimes.length > 0 && now - _reqTimes[0] >= WINDOW_MS) _reqTimes.shift();
    if (_reqTimes.length < RATE_LIMIT) { _reqTimes.push(now); return; }
    await new Promise(r => setTimeout(r, WINDOW_MS - (now - _reqTimes[0]) + 5));
  }
}

async function callApi(base, token, appKey, appSecret, action, query = {}, body = {}, isMock = false, retry = 2) {
  const meta = API_TABLE[action];
  if (!meta) throw new Error(\`알 수 없는 API ID: \${action} — 이 값을 지어내지 마세요. 유효한 API ID 는 get_module_config('korea-invest') 로 확인하세요. 단순 시세·차트·과거 데이터는 yfinance(action='history')가 더 쉽고, 종합 분석은 get_skill('stock-report') 를 참고하세요.\`);
  const trId = isMock && meta.trIdMock ? meta.trIdMock : meta.trIdReal;
  if (isMock && !meta.trIdMock) throw new Error(\`\${action} (\${meta.name}) 은 모의투자 미지원입니다.\`);
  let url = \`\${base}\${meta.path}\`;
  if (meta.method === 'GET' && Object.keys(query).length > 0) {
    const qs = new URLSearchParams(query).toString();
    url += \`?\${qs}\`;
  }
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'authorization': \`Bearer \${token}\`,
    'appkey': appKey,
    'appsecret': appSecret,
    'tr_id': trId,
    'custtype': 'P',
  };
  await acquireSlot();
  const init = { method: meta.method, headers, signal: AbortSignal.timeout(15000) };
  if (meta.method !== 'GET' && Object.keys(body).length > 0) init.body = JSON.stringify(body);
  const resp = await fetch(url, init);
  if (resp.status === 429 && retry > 0) {
    await new Promise(r => setTimeout(r, 1100));
    return callApi(base, token, appKey, appSecret, action, query, body, isMock, retry - 1);
  }
  if (!resp.ok) {
    // KIS 는 토큰 만료(EGW00123) 등 일부 오류를 HTTP 500 + JSON 바디(rt_cd/msg1/msg_cd)로 준다.
    // 바디가 KIS 에러 envelope 면 throw 말고 반환 → 상위 rt_cd 검사(인프라 reactive)가 토큰 무효를 감지.
    const errText = await resp.text().catch(() => '');
    try {
      const j = JSON.parse(errText);
      if (j && (j.rt_cd !== undefined || j.msg_cd !== undefined)) return j;
    } catch { /* JSON 아님 — 아래 throw */ }
    throw new Error(\`KIS API \${resp.status}: \${resp.statusText} \${errText}\`.trim());
  }
  return await resp.json();
}

// Standard OHLCV normalization — rename KIS candle vocabulary to the cross-broker standard
// {date, open, high, low, close, volume} so stock_chart dataCacheKey injection, the timeseries
// store, and cache_grep all speak one vocabulary (yfinance already does). Field-signature
// detection (no per-action enum): a row is a candle when it carries a date field together with a
// close-price field. Covers 국내 일/주/월(stck_bsop_date+stck_clpr), 국내 분봉(stck_cntg_hour+
// stck_prpr), 해외(xymd+clos). Values arrive as strings — Number() them.
function kisNum(v) {
  const n = Number(String(v ?? '').replace(/^[+\-]/, ''));
  return Number.isFinite(n) ? n : v;
}
function kisDate8(s) {
  s = String(s ?? '');
  return /^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s;
}
function normalizeCandleRow(row) {
  // 해외 기간별시세 (HHDFS76240000 류): xymd + clos (+open/high/low/tvol)
  if ('xymd' in row && 'clos' in row) {
    row.date = kisDate8(row.xymd); delete row.xymd;
    row.close = kisNum(row.clos); delete row.clos;
    if ('open' in row) row.open = kisNum(row.open);
    if ('high' in row) row.high = kisNum(row.high);
    if ('low' in row) row.low = kisNum(row.low);
    if ('tvol' in row) { row.volume = kisNum(row.tvol); delete row.tvol; }
    return;
  }
  // 국내: stck_bsop_date + (stck_clpr 일/주/월 | stck_prpr 분봉)
  if ('stck_bsop_date' in row && ('stck_clpr' in row || 'stck_prpr' in row)) {
    const day = kisDate8(row.stck_bsop_date); delete row.stck_bsop_date;
    if ('stck_cntg_hour' in row) {
      const t = String(row.stck_cntg_hour).padStart(6, '0');
      row.date = day + ' ' + t.slice(0, 2) + ':' + t.slice(2, 4);
      delete row.stck_cntg_hour;
    } else {
      row.date = day;
    }
    if ('stck_oprc' in row) { row.open = kisNum(row.stck_oprc); delete row.stck_oprc; }
    if ('stck_hgpr' in row) { row.high = kisNum(row.stck_hgpr); delete row.stck_hgpr; }
    if ('stck_lwpr' in row) { row.low = kisNum(row.stck_lwpr); delete row.stck_lwpr; }
    if ('stck_clpr' in row) { row.close = kisNum(row.stck_clpr); delete row.stck_clpr; }
    else if ('stck_prpr' in row) { row.close = kisNum(row.stck_prpr); delete row.stck_prpr; }
    if ('acml_vol' in row) { row.volume = kisNum(row.acml_vol); delete row.acml_vol; }
    else if ('cntg_vol' in row) { row.volume = kisNum(row.cntg_vol); delete row.cntg_vol; }
  }
}
function normalizeCandles(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return;
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const row of v) { if (row && typeof row === 'object') normalizeCandleRow(row); }
    } else if (v && typeof v === 'object') {
      normalizeCandles(v, depth + 1);
    }
  }
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action;
    if (!action) {
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다. 한투 API ID (v1_국내주식-008 등) 를 지정하세요.' }));
      return;
    }
    const appKey = process.env['KIS_APP_KEY'];
    const appSecret = process.env['KIS_APP_SECRET'];
    if (!appKey || !appSecret) {
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > korea-invest 에서 등록하세요.' }));
      return;
    }
    // 토큰 = 인프라(TokenProvider)가 발급·선제갱신해 env 로 주입한 raw 토큰. 무효 시엔 인프라가
    // 응답의 rt_cd/msg1 을 보고 재발급 후 1회 재시도하므로, sysmod 는 받아쓰기만 한다 (토큰 코드 0).
    const token = process.env['KIS_ACCESS_TOKEN'];
    if (!token) {
      console.log(JSON.stringify({ success: false, error: 'KIS 접근 토큰 미발급 — 인프라 토큰 발급 실패 또는 앱키 미설정.' }));
      return;
    }
    const isMock = data.mock === true;
    const base = isMock ? BASE_MOCK : BASE_REAL;
    const query = data.query || {};
    const body = data.body || {};
    const result = await callApi(base, token, appKey, appSecret, action, query, body, isMock);
    normalizeCandles(result);
    const meta = API_TABLE[action];
    // KIS rt_cd: "0"=정상, 그 외=오류. HTTP 200 이라 envelope success:true 로 가려졌던 것 →
    // "0" 만 success (kiwoom return_code 와 동일 의도 — AI 가 실패를 모르고 fabricate 차단).
    const rtCd = result?.rt_cd;
    const ok = rtCd === undefined || rtCd === null || rtCd === '0';
    const output = { success: ok, data: { apiId: action, trId: isMock && meta.trIdMock ? meta.trIdMock : meta.trIdReal, name: meta.name, ...result } };
    if (!ok) output.error = result?.msg1 || \`한투 API 오류 (rt_cd=\${rtCd})\`;
    console.log(JSON.stringify(output));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});
`;

  return { config, index };
}

const apisPath = resolve(MODULE_DIR, '_apis.json');
const apis = JSON.parse(readFileSync(apisPath, 'utf8'));
const { config, index } = build(apis);

writeFileSync(resolve(MODULE_DIR, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
writeFileSync(resolve(MODULE_DIR, 'index.mjs'), index, 'utf8');

const allCount = config.input.properties.action.enum.length;
console.log(`✓ korea-invest — ${allCount} actions / ${config.domains.length} domains`);
for (const d of config.domains) {
  console.log(`  ${d.name}: ${d.actions.length} actions (${d.capability})`);
}
