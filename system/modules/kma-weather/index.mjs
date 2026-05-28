#!/usr/bin/env node
/**
 * 기상청 (KMA) 통합 sysmod — data.go.kr 6 서비스.
 *
 * actions:
 *   short        — 단기예보 (3일, 1시간 단위) — VilageFcstInfoService_2.0/getVilageFcst
 *   ultra-now    — 초단기실황 (현재) — VilageFcstInfoService_2.0/getUltraSrtNcst
 *   ultra-short  — 초단기예보 (6시간) — VilageFcstInfoService_2.0/getUltraSrtFcst
 *   medium-fcst  — 중기 전망 (요약 텍스트) — MidFcstInfoService/getMidFcst (stnId)
 *   medium-land  — 중기 육상예보 (4-10일) — MidFcstInfoService/getMidLandFcst (regId)
 *   medium-ta    — 중기 기온 — MidFcstInfoService/getMidTa (regId)
 *   medium-sea   — 중기 해상예보 (날씨·파고) — MidFcstInfoService/getMidSeaFcst (regId 해상)
 *   fcst-version — 예보 수정버전 — VilageFcstInfoService_2.0/getFcstVersion (ftype + basedatetime)
 *   alerts       — 기상특보 목록 — WthrWrnInfoService/getWthrWrnList
 *   alerts-news  — 기상속보 — WthrWrnInfoService/getWthrBrkNews
 *   alerts-prelim — 기상예비특보 — WthrWrnInfoService/getWthrPwn
 *   uv-index     — 자외선지수 V3 — LivingWthrIdxServiceV3/getUVIdxV3 (legacy 호환)
 *   uv-index-v5  — 자외선지수 V5 — LivingWthrIdxServiceV5/getUVIdxV5 (옛 V4 endpoint 폐기, 2026-05 기상청 변경)
 *   air-stagnation — 대기정체지수 V5 — LivingWthrIdxServiceV5/getAirDiffusionIdxV5 (옛 V4 endpoint 폐기, 2026-05 기상청 변경)
 *   체감온도 (thermal-index / getSenTaIdxV4) — 2026-05 기상청 데이터 생산중단으로 API 서비스 폐기됨
 *   earthquake   — 지진통보문 — EqkInfoService/getEqkMsg
 *   tsunami      — 지진해일통보문 — EqkInfoService/getTsunamiMsg
 *   typhoon-list — 태풍 통보문 목록 — TyphoonInfoService/getTyphoonInfoList (tmFc 단일)
 *   typhoon-info — 태풍 통보문 상세 — TyphoonInfoService/getTyphoonInfo (fromTmFc/toTmFc)
 *   typhoon-forecast — 태풍 예상정보 — TyphoonInfoService/getTyphoonFcst (tmFc + typSeq)
 *
 * 인증: ?serviceKey=<URL-encoded DATA_GO_KR_API_KEY>
 * 응답: dataType=JSON 강제. items 배열 추출 후 반환.
 *
 * 격자 변환: 위경도 → KMA LCC (Lambert Conformal Conic) → nx/ny
 */

import { readFileSync } from 'node:fs';

const BASE = 'https://apis.data.go.kr/1360000';

// ─────────────────────────────────────────────────────────────────────────
// LCC 격자 변환 — KMA 공식 알고리즘
// 위경도 (lat, lon) → 기상청 격자 (nx, ny)
// ─────────────────────────────────────────────────────────────────────────
function latLonToGrid(lat, lon) {
  const RE = 6371.00877;     // 지구 반경 km
  const GRID = 5.0;          // 격자 간격 km
  const SLAT1 = 30.0;        // 표준위도 1
  const SLAT2 = 60.0;        // 표준위도 2
  const OLON = 126.0;        // 기준점 경도
  const OLAT = 38.0;         // 기준점 위도
  const XO = 43;             // 기준점 X
  const YO = 136;            // 기준점 Y

  const DEGRAD = Math.PI / 180.0;
  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD;
  const slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD;
  const olat = OLAT * DEGRAD;

  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = Math.pow(sf, sn) * Math.cos(slat1) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = re * sf / Math.pow(ro, sn);

  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  ra = re * sf / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  const nx = Math.floor(ra * Math.sin(theta) + XO + 0.5);
  const ny = Math.floor(ro - ra * Math.cos(theta) + YO + 0.5);
  return { nx, ny };
}

// ─────────────────────────────────────────────────────────────────────────
// 시각 헬퍼
// ─────────────────────────────────────────────────────────────────────────
function pad(n) { return n < 10 ? `0${n}` : `${n}`; }
function todayYmd(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
function ymdHm(d = new Date()) {
  return `${todayYmd(d)}${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** 단기예보 base_time — 02 05 08 11 14 17 20 23 (그 시각 +10분 후 발표).
 *  현재 시각 직전 발표 시각 자동 선택. */
function shortBaseTime(d = new Date()) {
  const slots = [2, 5, 8, 11, 14, 17, 20, 23];
  const h = d.getHours();
  const m = d.getMinutes();
  // 발표 시각 + 10분 후부터 사용 가능
  let usable = slots.filter(s => h > s || (h === s && m >= 10));
  if (usable.length === 0) {
    // 자정 직후 — 어제 23시 발표
    const yesterday = new Date(d);
    yesterday.setDate(yesterday.getDate() - 1);
    return { baseDate: todayYmd(yesterday), baseTime: '2300' };
  }
  return { baseDate: todayYmd(d), baseTime: `${pad(usable[usable.length - 1])}00` };
}

/** 초단기실황 base_time — 매시 정각, 매시 40분 후 발표 시작 */
function ultraNowBaseTime(d = new Date()) {
  const m = d.getMinutes();
  let h = d.getHours();
  if (m < 40) h -= 1;
  if (h < 0) {
    const yesterday = new Date(d);
    yesterday.setDate(yesterday.getDate() - 1);
    return { baseDate: todayYmd(yesterday), baseTime: '2300' };
  }
  return { baseDate: todayYmd(d), baseTime: `${pad(h)}00` };
}

/** 초단기예보 base_time — 매시 30분, 매시 45분 후 발표 시작 */
function ultraShortBaseTime(d = new Date()) {
  const m = d.getMinutes();
  let h = d.getHours();
  if (m < 45) h -= 1;
  if (h < 0) {
    const yesterday = new Date(d);
    yesterday.setDate(yesterday.getDate() - 1);
    return { baseDate: todayYmd(yesterday), baseTime: '2330' };
  }
  return { baseDate: todayYmd(d), baseTime: `${pad(h)}30` };
}

/** 중기예보 발표 시각 — 매일 06시·18시 발표 */
function mediumTmFc(d = new Date()) {
  const h = d.getHours();
  if (h >= 18) return `${todayYmd(d)}1800`;
  if (h >= 6) return `${todayYmd(d)}0600`;
  const yesterday = new Date(d);
  yesterday.setDate(yesterday.getDate() - 1);
  return `${todayYmd(yesterday)}1800`;
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP 호출
// ─────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callApi(serviceKey, path, params) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('serviceKey', serviceKey);
  url.searchParams.set('dataType', 'JSON');
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  // 기상청 서버 5xx 일시 오류 (502/503/504) + 네트워크 fail = 짧은 간격 retry (최대 3 시도).
  // 옛에 AI 가 502 받고 매 turn 6 번 호출하던 영역 — 모듈 자체 retry 로 간헐 오류 흡수.
  // 4xx (키 미등록 등) 는 retry 무의미 → 즉시 반환.
  const MAX_TRIES = 3;
  let res;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    try {
      res = await fetch(url.toString(), { method: 'GET' });
    } catch (e) {
      if (attempt < MAX_TRIES - 1) { await sleep(800 * (attempt + 1)); continue; }
      return { ok: false, errorKey: 'error.runtime', errorParams: { message: e.message || String(e) } };
    }
    if (res.status >= 500 && res.status < 600 && attempt < MAX_TRIES - 1) {
      await sleep(800 * (attempt + 1));
      continue;
    }
    break;
  }
  if (!res.ok) {
    return { ok: false, errorKey: 'error.http_status', errorParams: { status: String(res.status) } };
  }
  const text = await res.text();
  // data.go.kr 일부 케이스 — XML 에러 메시지 (서비스키 미등록 등)
  if (text.trim().startsWith('<')) {
    const m = text.match(/<returnAuthMsg>([^<]+)<\/returnAuthMsg>/) || text.match(/<errMsg>([^<]+)<\/errMsg>/);
    if (m) return { ok: false, errorKey: 'error.xml_auth', errorParams: { message: m[1] } };
    return { ok: false, errorKey: 'error.xml_unknown', errorParams: { body: text.slice(0, 200) } };
  }
  let json;
  try { json = JSON.parse(text); }
  catch { return { ok: false, errorKey: 'error.json_parse', errorParams: { body: text.slice(0, 200) } }; }

  const header = json?.response?.header;
  if (header?.resultCode && header.resultCode !== '00') {
    return { ok: false, errorKey: 'error.api_error', errorParams: { code: header.resultCode, message: header.resultMsg ?? '' } };
  }
  const items = json?.response?.body?.items?.item ?? [];
  return { ok: true, items: Array.isArray(items) ? items : [items] };
}

// ─────────────────────────────────────────────────────────────────────────
// stdin → action dispatch
// ─────────────────────────────────────────────────────────────────────────
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

/** i18n 에러 응답 — errorKey + errorParams. resolve_sysmod_error 가 module.kma-weather.{key} 로 변환. */
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
  const { action, lat, lon, nx: nxIn, ny: nyIn, regId, stnId, areaNo, tmFc, typhoonNo, fromTm, toTm, limit = 100 } = data;

  const serviceKey = process.env.DATA_GO_KR_API_KEY;
  if (!serviceKey) return outErr('error.api_key_missing', {});

  // 위경도 → 격자 변환 (lat/lon 정의되어 있고 nx/ny 미지정 시)
  let nx = nxIn, ny = nyIn;
  if (typeof lat === 'number' && typeof lon === 'number' && (nx == null || ny == null)) {
    const g = latLonToGrid(lat, lon);
    nx = g.nx; ny = g.ny;
  }

  try {
    if (action === 'short') {
      if (nx == null || ny == null) return outErr('error.coords_required', { action });
      const { baseDate, baseTime } = shortBaseTime();
      const r = await callApi(serviceKey, '/VilageFcstInfoService_2.0/getVilageFcst', {
        numOfRows: limit, pageNo: 1, base_date: baseDate, base_time: baseTime, nx, ny,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items, nx, ny, baseDate, baseTime });
    }

    if (action === 'ultra-now') {
      if (nx == null || ny == null) return outErr('error.coords_required', { action });
      const { baseDate, baseTime } = ultraNowBaseTime();
      const r = await callApi(serviceKey, '/VilageFcstInfoService_2.0/getUltraSrtNcst', {
        numOfRows: limit, pageNo: 1, base_date: baseDate, base_time: baseTime, nx, ny,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items, nx, ny, baseDate, baseTime });
    }

    if (action === 'ultra-short') {
      if (nx == null || ny == null) return outErr('error.coords_required', { action });
      const { baseDate, baseTime } = ultraShortBaseTime();
      const r = await callApi(serviceKey, '/VilageFcstInfoService_2.0/getUltraSrtFcst', {
        numOfRows: limit, pageNo: 1, base_date: baseDate, base_time: baseTime, nx, ny,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items, nx, ny, baseDate, baseTime });
    }

    if (action === 'medium-fcst') {
      if (!stnId) return outErr('error.medium_fcst_stnId_required', {});
      const t = tmFc || mediumTmFc();
      const r = await callApi(serviceKey, '/MidFcstInfoService/getMidFcst', {
        numOfRows: limit, pageNo: 1, stnId, tmFc: t,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items, stnId, tmFc: t });
    }

    if (action === 'medium-land') {
      if (!regId) return outErr('error.medium_land_regId_required', {});
      const t = tmFc || mediumTmFc();
      const r = await callApi(serviceKey, '/MidFcstInfoService/getMidLandFcst', {
        numOfRows: limit, pageNo: 1, regId, tmFc: t,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items, regId, tmFc: t });
    }

    if (action === 'medium-ta') {
      if (!regId) return outErr('error.medium_ta_regId_required', {});
      const t = tmFc || mediumTmFc();
      const r = await callApi(serviceKey, '/MidFcstInfoService/getMidTa', {
        numOfRows: limit, pageNo: 1, regId, tmFc: t,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items, regId, tmFc: t });
    }

    if (action === 'medium-sea') {
      if (!regId) return outErr('error.medium_sea_regId_required', {});
      const t = tmFc || mediumTmFc();
      const r = await callApi(serviceKey, '/MidFcstInfoService/getMidSeaFcst', {
        numOfRows: limit, pageNo: 1, regId, tmFc: t,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items, regId, tmFc: t });
    }

    if (action === 'fcst-version') {
      const ftypeIn = data.ftype;
      const baseDt = data.basedatetime;
      if (!ftypeIn) return outErr('error.fcst_version_ftype_required', {});
      if (!baseDt) return outErr('error.fcst_version_basedatetime_required', {});
      const r = await callApi(serviceKey, '/VilageFcstInfoService_2.0/getFcstVersion', {
        numOfRows: limit, pageNo: 1, ftype: ftypeIn, basedatetime: baseDt,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items });
    }

    // ── 기상특보 시리즈 (WthrWrnInfoService) ──
    // 모든 endpoint 가 stnId(옵션) + fromTmFc/toTmFc (yyyyMMdd 8자리) 표준
    if (action === 'alerts' || action === 'alerts-news' || action === 'alerts-prelim') {
      const fromYmd = fromTm || todayYmd(new Date(Date.now() - 7 * 86400000));
      const toYmd = toTm || todayYmd();
      const path = action === 'alerts' ? '/WthrWrnInfoService/getWthrWrnList'
                 : action === 'alerts-news' ? '/WthrWrnInfoService/getWthrBrkNews'
                 : '/WthrWrnInfoService/getWthrPwn';
      const params = { numOfRows: limit, pageNo: 1, fromTmFc: fromYmd, toTmFc: toYmd };
      if (stnId) params.stnId = stnId;
      const r = await callApi(serviceKey, path, params);
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items });
    }

    // ── 생활기상지수 V3 (uv-index) ──
    if (action === 'uv-index') {
      if (!areaNo) return outErr('error.uv_index_areaNo_required', {});
      const t = data.time || ymdHm().slice(0, 10);
      const r = await callApi(serviceKey, '/LivingWthrIdxServiceV3/getUVIdxV3', {
        numOfRows: limit, pageNo: 1, areaNo, time: t,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items });
    }

    // ── 생활기상지수 V5 시리즈 (uv-index-v5 / air-stagnation) — 2026-05 기상청 V4→V5 endpoint 변경 ──
    if (action === 'uv-index-v5' || action === 'air-stagnation') {
      if (!areaNo) return outErr('error.areaNo_required', { action });
      const t = data.time || ymdHm().slice(0, 10);
      const path = action === 'uv-index-v5' ? '/LivingWthrIdxServiceV5/getUVIdxV5'
                                            : '/LivingWthrIdxServiceV5/getAirDiffusionIdxV5';
      const r = await callApi(serviceKey, path, {
        numOfRows: limit, pageNo: 1, areaNo, time: t,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items });
    }

    // 옛 'uv-index-v4' / 'thermal-index' action — 2026-05 기상청 변경으로 폐기.
    // 옛 cron / 사용자 호출 호환 위해 명시 에러 응답.
    if (action === 'uv-index-v4') {
      return outErr('error.uv_index_v4_deprecated', {});
    }
    if (action === 'thermal-index') {
      return outErr('error.thermal_index_deprecated', {});
    }

    // ── 지진/해일 시리즈 (EqkInfoService) — fromTmFc/toTmFc 8자리 ──
    if (action === 'earthquake' || action === 'tsunami') {
      const fromYmd = fromTm || todayYmd(new Date(Date.now() - 30 * 86400000));
      const toYmd = toTm || todayYmd();
      const path = action === 'earthquake' ? '/EqkInfoService/getEqkMsg' : '/EqkInfoService/getTsunamiMsg';
      const r = await callApi(serviceKey, path, {
        numOfRows: limit, pageNo: 1, fromTmFc: fromYmd, toTmFc: toYmd,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items });
    }

    // ── 태풍 시리즈 (TyphoonInfoService) — spec 검증 후 정정 ──
    // typhoon-list: tmFc 단일 (8자리) — fromTmFc/toTmFc 아님
    // typhoon-info: fromTmFc/toTmFc (8자리) — tmFc 12자리 아님
    // typhoon-forecast: tmFc (12자리) + typSeq (typhoonSeq 아님)
    // 태풍 NO_DATA 영역 처리 — 한국 영역 태풍 시즌 7~10 월 중심. 5~6 월 / 11~3 월 = 통보문 0 건 정공.
    // 옛 = outErr 박은 영역 → AI 입장 "에러" 해석 → 사용자에게 잘못된 안내. 정공 = 빈 items 박는 영역.
    // 기상청 API 영역 NO_DATA = resultCode='03' + resultMsg='NO_DATA' (callApi line 169).
    const isNoData = (r) => !r.ok && r.errorKey === 'error.api_error' && r.errorParams?.code === '03';

    if (action === 'typhoon-list') {
      const t = tmFc || todayYmd();
      const r = await callApi(serviceKey, '/TyphoonInfoService/getTyphoonInfoList', {
        numOfRows: limit, pageNo: 1, tmFc: t,
      });
      if (isNoData(r)) return out(true, { items: [], tmFc: t, note: '발표시각 당일 태풍 통보문 박지 못한 영역 (한국 영역 태풍 시즌 = 7~10 월 중심)' });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items, tmFc: t });
    }

    if (action === 'typhoon-info') {
      const fromYmd = fromTm || todayYmd(new Date(Date.now() - 30 * 86400000));
      const toYmd = toTm || todayYmd();
      const r = await callApi(serviceKey, '/TyphoonInfoService/getTyphoonInfo', {
        numOfRows: limit, pageNo: 1, fromTmFc: fromYmd, toTmFc: toYmd,
      });
      if (isNoData(r)) return out(true, { items: [], fromTmFc: fromYmd, toTmFc: toYmd, note: '본 기간 태풍 통보문 박지 못한 영역' });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items });
    }

    if (action === 'typhoon-forecast') {
      if (!tmFc) return outErr('error.typhoon_forecast_tmFc_required', {});
      if (!typhoonNo) return outErr('error.typhoon_forecast_typhoonNo_required', {});
      const r = await callApi(serviceKey, '/TyphoonInfoService/getTyphoonFcst', {
        numOfRows: limit, pageNo: 1, tmFc, typSeq: typhoonNo,
      });
      if (isNoData(r)) return out(true, { items: [], tmFc, typhoonNo, note: '본 태풍 박힌 예상 정보 박지 못한 영역' });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items, tmFc, typhoonNo });
    }

    return outErr('error.unknown_action', { action: String(action) });
  } catch (e) {
    return outErr('error.runtime', { message: e?.message ?? String(e) });
  }
}

main();
