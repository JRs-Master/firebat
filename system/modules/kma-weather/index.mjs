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
 *   uv-index     — 자외선지수 V3 — LivingWthrIdxServiceV3/getUVIdxV3
 *   uv-index-v4  — 자외선지수 V4 (3시간×75h) — LivingWthrIdxServiceV4/getUVIdxV4
 *   thermal-index — 체감온도 V4 (5-9월, 1시간×78h) — LivingWthrIdxServiceV4/getSenTaIdxV4 (areaNo+time+requestCode)
 *   air-stagnation — 대기정체지수 V4 (3시간×78h) — LivingWthrIdxServiceV4/getAirDiffusionIdxV4
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
async function callApi(serviceKey, path, params) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('serviceKey', serviceKey);
  url.searchParams.set('dataType', 'JSON');
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}` };
  }
  const text = await res.text();
  // data.go.kr 일부 케이스 — XML 에러 메시지 (서비스키 미등록 등)
  if (text.trim().startsWith('<')) {
    const m = text.match(/<returnAuthMsg>([^<]+)<\/returnAuthMsg>/) || text.match(/<errMsg>([^<]+)<\/errMsg>/);
    return { ok: false, error: m ? m[1] : `XML 응답 (서비스키 미등록 또는 활용신청 미승인 가능): ${text.slice(0, 200)}` };
  }
  let json;
  try { json = JSON.parse(text); }
  catch { return { ok: false, error: `JSON 파싱 실패: ${text.slice(0, 200)}` }; }

  const header = json?.response?.header;
  if (header?.resultCode && header.resultCode !== '00') {
    return { ok: false, error: `API 오류 (${header.resultCode}): ${header.resultMsg ?? '알 수 없음'}` };
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

async function main() {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); }
  catch { return out(false, undefined, 'stdin JSON 파싱 실패'); }

  const data = input.data ?? {};
  const { action, lat, lon, nx: nxIn, ny: nyIn, regId, stnId, areaNo, tmFc, typhoonNo, fromTm, toTm, limit = 100 } = data;

  const serviceKey = process.env.DATA_GO_KR_API_KEY;
  if (!serviceKey) return out(false, undefined, 'DATA_GO_KR_API_KEY 환경변수 미설정');

  // 위경도 → 격자 변환 (lat/lon 박혀있고 nx/ny 미지정 시)
  let nx = nxIn, ny = nyIn;
  if (typeof lat === 'number' && typeof lon === 'number' && (nx == null || ny == null)) {
    const g = latLonToGrid(lat, lon);
    nx = g.nx; ny = g.ny;
  }

  try {
    if (action === 'short') {
      if (nx == null || ny == null) return out(false, undefined, 'short 는 lat/lon 또는 nx/ny 필요');
      const { baseDate, baseTime } = shortBaseTime();
      const r = await callApi(serviceKey, '/VilageFcstInfoService_2.0/getVilageFcst', {
        numOfRows: limit, pageNo: 1, base_date: baseDate, base_time: baseTime, nx, ny,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items, nx, ny, baseDate, baseTime });
    }

    if (action === 'ultra-now') {
      if (nx == null || ny == null) return out(false, undefined, 'ultra-now 는 lat/lon 또는 nx/ny 필요');
      const { baseDate, baseTime } = ultraNowBaseTime();
      const r = await callApi(serviceKey, '/VilageFcstInfoService_2.0/getUltraSrtNcst', {
        numOfRows: limit, pageNo: 1, base_date: baseDate, base_time: baseTime, nx, ny,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items, nx, ny, baseDate, baseTime });
    }

    if (action === 'ultra-short') {
      if (nx == null || ny == null) return out(false, undefined, 'ultra-short 는 lat/lon 또는 nx/ny 필요');
      const { baseDate, baseTime } = ultraShortBaseTime();
      const r = await callApi(serviceKey, '/VilageFcstInfoService_2.0/getUltraSrtFcst', {
        numOfRows: limit, pageNo: 1, base_date: baseDate, base_time: baseTime, nx, ny,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items, nx, ny, baseDate, baseTime });
    }

    if (action === 'medium-fcst') {
      if (!stnId) return out(false, undefined, 'medium-fcst 는 stnId 필요 (지점번호, 예: 108=전국, 109=서울·인천·경기)');
      const t = tmFc || mediumTmFc();
      const r = await callApi(serviceKey, '/MidFcstInfoService/getMidFcst', {
        numOfRows: limit, pageNo: 1, stnId, tmFc: t,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items, stnId, tmFc: t });
    }

    if (action === 'medium-land') {
      if (!regId) return out(false, undefined, 'medium-land 는 regId 필요 (예: 11B00000 서울·인천·경기)');
      const t = tmFc || mediumTmFc();
      const r = await callApi(serviceKey, '/MidFcstInfoService/getMidLandFcst', {
        numOfRows: limit, pageNo: 1, regId, tmFc: t,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items, regId, tmFc: t });
    }

    if (action === 'medium-ta') {
      if (!regId) return out(false, undefined, 'medium-ta 는 regId 필요 (예: 11B10101 서울)');
      const t = tmFc || mediumTmFc();
      const r = await callApi(serviceKey, '/MidFcstInfoService/getMidTa', {
        numOfRows: limit, pageNo: 1, regId, tmFc: t,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items, regId, tmFc: t });
    }

    if (action === 'medium-sea') {
      if (!regId) return out(false, undefined, 'medium-sea 는 regId 필요 (해상 코드, 예: 12A20000 서해중부)');
      const t = tmFc || mediumTmFc();
      const r = await callApi(serviceKey, '/MidFcstInfoService/getMidSeaFcst', {
        numOfRows: limit, pageNo: 1, regId, tmFc: t,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items, regId, tmFc: t });
    }

    if (action === 'fcst-version') {
      const ftypeIn = data.ftype;
      const baseDt = data.basedatetime;
      if (!ftypeIn) return out(false, undefined, 'fcst-version 은 ftype 필요 (ODAM/VSRT/SHRT)');
      if (!baseDt) return out(false, undefined, 'fcst-version 은 basedatetime 필요 (yyyyMMddHHmm)');
      const r = await callApi(serviceKey, '/VilageFcstInfoService_2.0/getFcstVersion', {
        numOfRows: limit, pageNo: 1, ftype: ftypeIn, basedatetime: baseDt,
      });
      if (!r.ok) return out(false, undefined, r.error);
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
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items });
    }

    // ── 생활기상지수 V3 (uv-index) ──
    if (action === 'uv-index') {
      if (!areaNo) return out(false, undefined, 'uv-index 는 areaNo 필요 (10자리 행정구역코드)');
      const t = data.time || ymdHm().slice(0, 10);
      const r = await callApi(serviceKey, '/LivingWthrIdxServiceV3/getUVIdxV3', {
        numOfRows: limit, pageNo: 1, areaNo, time: t,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items });
    }

    // ── 생활기상지수 V4 시리즈 (uv-index-v4 / thermal-index / air-stagnation) ──
    if (action === 'uv-index-v4' || action === 'air-stagnation') {
      if (!areaNo) return out(false, undefined, `${action} 은 areaNo 필요 (10자리 행정구역코드)`);
      const t = data.time || ymdHm().slice(0, 10);
      const path = action === 'uv-index-v4' ? '/LivingWthrIdxServiceV4/getUVIdxV4'
                                            : '/LivingWthrIdxServiceV4/getAirDiffusionIdxV4';
      const r = await callApi(serviceKey, path, {
        numOfRows: limit, pageNo: 1, areaNo, time: t,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items });
    }

    if (action === 'thermal-index') {
      if (!areaNo) return out(false, undefined, 'thermal-index 는 areaNo 필요 (10자리 행정구역코드)');
      const reqCode = data.requestCode;
      if (!reqCode) return out(false, undefined, 'thermal-index 는 requestCode 필요 (A41=노인, A42=어린이, A44=농촌, A45=비닐하우스, A46=취약, A47=도로, A48=건설, A49=조선소)');
      const t = data.time || ymdHm().slice(0, 10);
      const r = await callApi(serviceKey, '/LivingWthrIdxServiceV4/getSenTaIdxV4', {
        numOfRows: limit, pageNo: 1, areaNo, time: t, requestCode: reqCode,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items });
    }

    // ── 지진/해일 시리즈 (EqkInfoService) — fromTmFc/toTmFc 8자리 ──
    if (action === 'earthquake' || action === 'tsunami') {
      const fromYmd = fromTm || todayYmd(new Date(Date.now() - 30 * 86400000));
      const toYmd = toTm || todayYmd();
      const path = action === 'earthquake' ? '/EqkInfoService/getEqkMsg' : '/EqkInfoService/getTsunamiMsg';
      const r = await callApi(serviceKey, path, {
        numOfRows: limit, pageNo: 1, fromTmFc: fromYmd, toTmFc: toYmd,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items });
    }

    // ── 태풍 시리즈 (TyphoonInfoService) — spec 검증 후 정정 ──
    // typhoon-list: tmFc 단일 (8자리) — fromTmFc/toTmFc 아님
    // typhoon-info: fromTmFc/toTmFc (8자리) — tmFc 12자리 아님
    // typhoon-forecast: tmFc (12자리) + typSeq (typhoonSeq 아님)
    if (action === 'typhoon-list') {
      const t = tmFc || todayYmd();
      const r = await callApi(serviceKey, '/TyphoonInfoService/getTyphoonInfoList', {
        numOfRows: limit, pageNo: 1, tmFc: t,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items, tmFc: t });
    }

    if (action === 'typhoon-info') {
      const fromYmd = fromTm || todayYmd(new Date(Date.now() - 30 * 86400000));
      const toYmd = toTm || todayYmd();
      const r = await callApi(serviceKey, '/TyphoonInfoService/getTyphoonInfo', {
        numOfRows: limit, pageNo: 1, fromTmFc: fromYmd, toTmFc: toYmd,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items });
    }

    if (action === 'typhoon-forecast') {
      if (!tmFc) return out(false, undefined, 'typhoon-forecast 는 tmFc 필요 (yyyyMMddHHmm 12자리)');
      if (!typhoonNo) return out(false, undefined, 'typhoon-forecast 는 typhoonNo 필요 (typSeq, 예: 18)');
      const r = await callApi(serviceKey, '/TyphoonInfoService/getTyphoonFcst', {
        numOfRows: limit, pageNo: 1, tmFc, typSeq: typhoonNo,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items, tmFc, typhoonNo });
    }

    return out(false, undefined, `알 수 없는 action: ${action}`);
  } catch (e) {
    return out(false, undefined, `예외: ${e?.message ?? String(e)}`);
  }
}

main();
