#!/usr/bin/env node
/**
 * Firebat System Module: tago (public-transport)
 * 국가대중교통정보센터 (TAGO) — thirteen data.go.kr services behind one module.
 *
 * They are one module because their ladders cross: the stop id a bus arrival needs comes from the
 * bus STOP service, the route id a bus position needs comes from the bus ROUTE service, and the
 * vendor's own parameter notes say so. Split thirteen ways, that ladder is invisible.
 *
 * Auth: `serviceKey` query param — the DECODED key, since URLSearchParams encodes it. Same account
 * key as molit-realestate and kma-weather, and the same 1613000 (국토교통부) prefix.
 *
 * Envelope handling is ported from molit-realestate rather than rewritten: same portal, same
 * `response.header.resultCode` + `response.body.items.item`, same habit of answering XML when
 * `_type=json` was asked for, and the same trap where a single matching row arrives as an OBJECT
 * instead of a one-element array.
 */

const HOST = 'https://apis.data.go.kr/1613000';
const TIMEOUT = 20000;

/**
 * TAGO splits into two naming families and nothing in the product tells you which is which.
 * The four bus services use lowercase-initial operation paths and answer with all-lowercase field
 * names; the other nine use uppercase-initial paths and camelCase fields. Getting the path case
 * wrong is a 404, so the case is declared per operation rather than guessed.
 */
const OPS = {
  // ── 버스정류소정보 ─────────────────────────────────────────────────────────
  'bus-stop-search': { svc: 'BusSttnInfoInqireService', path: 'getSttnNoList', req: ['cityCode'], opt: ['nodeNm', 'nodeNo'], fresh: '일 1회' },
  'bus-stop-nearby': { svc: 'BusSttnInfoInqireService', path: 'getCrdntPrxmtSttnList', req: ['gpsLati', 'gpsLong'], fresh: '일 1회' },
  // `wire` renames a parameter on the way out. This one endpoint spells the stop id `nodeid` while
  // its siblings spell it `nodeId` — the same service family, two spellings, and the wrong one is
  // simply ignored, which shows up as an empty list rather than an error.
  'bus-stop-routes': { svc: 'BusSttnInfoInqireService', path: 'getSttnThrghRouteList', req: ['cityCode', 'nodeId'], wire: { nodeId: 'nodeid' }, fresh: '일 1회' },
  // ── 버스노선정보 ───────────────────────────────────────────────────────────
  'bus-route-search': { svc: 'BusRouteInfoInqireService', path: 'getRouteNoList', req: ['cityCode'], opt: ['routeNo'], fresh: '일 1회' },
  'bus-route-stops': { svc: 'BusRouteInfoInqireService', path: 'getRouteAcctoThrghSttnList', req: ['cityCode', 'routeId'], fresh: '일 1회' },
  'bus-route-info': { svc: 'BusRouteInfoInqireService', path: 'getRouteInfoIem', req: ['cityCode', 'routeId'], fresh: '일 1회' },
  // ── 버스도착정보 (실시간) ──────────────────────────────────────────────────
  'bus-arrivals': { svc: 'ArvlInfoInqireService', path: 'getSttnAcctoArvlPrearngeInfoList', req: ['cityCode', 'nodeId'], fresh: '실시간 10~20초' },
  'bus-arrival-route': { svc: 'ArvlInfoInqireService', path: 'getSttnAcctoSpcifyRouteBusArvlPrearngeInfoList', req: ['cityCode', 'nodeId', 'routeId'], fresh: '실시간 10~20초' },
  // ── 버스위치정보 (실시간) ──────────────────────────────────────────────────
  'bus-positions': { svc: 'BusLcInfoInqireService', path: 'getRouteAcctoBusLcList', req: ['cityCode', 'routeId'], fresh: '실시간 10~20초' },
  'bus-position-at-stop': { svc: 'BusLcInfoInqireService', path: 'getRouteAcctoSpcifySttnAccesBusLcInfo', req: ['cityCode', 'routeId', 'nodeId'], fresh: '실시간 10~20초' },
  // ── 고속버스도착정보 ───────────────────────────────────────────────────────
  'express-terminals-arr': { svc: 'ExpBusArrInfo', path: 'GetExpBusTmnList', opt: ['tmnNm'], fresh: '실시간 20분' },
  'express-destinations': { svc: 'ExpBusArrInfo', path: 'GetArrTmnFromDepTmn', req: ['depTmnCd'], fresh: '실시간 20분' },
  'express-arrivals': { svc: 'ExpBusArrInfo', path: 'GetExpBusArrPrdtInfo', req: ['depTmnCd', 'arrTmnCd'], fresh: '실시간 20분' },
  // ── 고속버스정보 ───────────────────────────────────────────────────────────
  'express-terminals': { svc: 'ExpBusInfo', path: 'GetExpBusTrminlList', opt: ['terminalNm'], fresh: '일 3회' },
  'express-grades': { svc: 'ExpBusInfo', path: 'GetExpBusGradList', fresh: '일 3회' },
  'express-schedule': { svc: 'ExpBusInfo', path: 'GetStrtpntAlocFndExpbusInfo', req: ['depTerminalId', 'arrTerminalId', 'depPlandTime'], opt: ['busGradeId'], fresh: '일 3회' },
  // ── 시외버스정보 ───────────────────────────────────────────────────────────
  'suburbs-terminals': { svc: 'SuburbsBusInfo', path: 'GetSuberbsBusTrminlList', opt: ['terminalNm', 'cityCode'], fresh: '일 1회' },
  'suburbs-grades': { svc: 'SuburbsBusInfo', path: 'GetSuberbsBusGradList', fresh: '일 1회' },
  'suburbs-schedule': { svc: 'SuburbsBusInfo', path: 'GetStrtpntAlocFndSuberbsBusInfo', req: ['depTerminalId', 'arrTerminalId', 'depPlandTime'], opt: ['busGradeId'], fresh: '일 1회' },
  // ── 열차정보 ───────────────────────────────────────────────────────────────
  'train-stations': { svc: 'TrainInfo', path: 'GetCtyAcctoTrainSttnList', req: ['cityCode'], fresh: '일 1회' },
  'train-grades': { svc: 'TrainInfo', path: 'GetVhcleKndList', fresh: '일 1회' },
  'train-schedule': { svc: 'TrainInfo', path: 'GetStrtpntAlocFndTrainInfo', req: ['depPlaceId', 'arrPlaceId'], opt: ['depPlandTime', 'trainGradeCode'], fresh: '일 1회' },
  // ── 지하철정보 ─────────────────────────────────────────────────────────────
  'subway-stations': { svc: 'SubwayInfo', path: 'GetKwrdFndSubwaySttnList', opt: ['subwayStationName'], fresh: '주 1회' },
  'subway-exit-buses': { svc: 'SubwayInfo', path: 'GetSubwaySttnExitAcctoBusRouteList', req: ['subwayStationId'], fresh: '주 1회' },
  'subway-exit-facilities': { svc: 'SubwayInfo', path: 'GetSubwaySttnExitAcctoCfrFcltyList', req: ['subwayStationId'], fresh: '주 1회' },
  'subway-timetable': { svc: 'SubwayInfo', path: 'GetSubwaySttnAcctoSchdulList', req: ['subwayStationId', 'dailyTypeCode', 'upDownTypeCode'], fresh: '주 1회' },
  // ── 국내항공운항정보 ───────────────────────────────────────────────────────
  'airports': { svc: 'DmstcFlightNvgInfo', path: 'GetArprtList', fresh: '실시간 1시간' },
  'airlines': { svc: 'DmstcFlightNvgInfo', path: 'GetAirmanList', fresh: '실시간 1시간' },
  'flight-schedule': { svc: 'DmstcFlightNvgInfo', path: 'GetFlightOpratInfoList', req: ['depAirportId', 'arrAirportId', 'depPlandTime'], opt: ['airlineId'], fresh: '실시간 1시간' },
  // ── 국내선박운항정보 ───────────────────────────────────────────────────────
  'ports': { svc: 'DmstcShipNvgInfo', path: 'GetPortList', opt: ['nodeNm'], fresh: '일 1회' },
  'ship-terminals': { svc: 'DmstcShipNvgInfo', path: 'GetPsnshipTrminlList', fresh: '일 1회' },
  'ship-kinds': { svc: 'DmstcShipNvgInfo', path: 'GetShipKndList', fresh: '일 1회' },
  'ship-schedule': { svc: 'DmstcShipNvgInfo', path: 'GetShipOpratInfoList', opt: ['depNodeId', 'depPlandTime'], fresh: '일 1회' },
  // ── 카셰어링정보 ───────────────────────────────────────────────────────────
  'carshare-by-name': { svc: 'CarSharingInfo', path: 'GetCarZoneListByName', req: ['zoneName'], fresh: '일 1회' },
  'carshare-by-address': { svc: 'CarSharingInfo', path: 'GetCarZoneListByAddr', req: ['zoneAddr'], fresh: '일 1회' },
  'carshare-nearby': { svc: 'CarSharingInfo', path: 'GetCarZoneListByCoord', req: ['latitude', 'longitude'], opt: ['radius'], fresh: '일 1회' },
  // ── 공유 퍼스널모빌리티정보 ────────────────────────────────────────────────
  'scooter-providers': { svc: 'PersonalMobilityInfo', path: 'GetPMProvider', opt: ['providerName', 'cityName'], fresh: '10초' },
  'scooters': { svc: 'PersonalMobilityInfo', path: 'GetPMListByProvider', req: ['providerName', 'cityCode'], fresh: '10초' },
};

/**
 * Six services each expose their own 도시코드 목록 under their own base. Rather than six
 * near-identical actions, one action takes the service name — which also keeps visible that they
 * are separate endpoints. Whether they return the same table has NOT been measured, so they are
 * not merged into one.
 */
const CITY_CODE_SOURCES = {
  'bus-route': { svc: 'BusRouteInfoInqireService', path: 'getCtyCodeList' },
  'bus-arrival': { svc: 'ArvlInfoInqireService', path: 'getCtyCodeList' },
  'bus-location': { svc: 'BusLcInfoInqireService', path: 'getCtyCodeList' },
  'bus-stop': { svc: 'BusSttnInfoInqireService', path: 'getCtyCodeList' },
  'express': { svc: 'ExpBusInfo', path: 'GetCtyCodeList' },
  'suburbs': { svc: 'SuburbsBusInfo', path: 'GetCtyCodeList' },
  'train': { svc: 'TrainInfo', path: 'GetCtyCodeList' },
};

/**
 * Where an id comes from. An empty result is the failure mode across all of TAGO — a wrong-but
 * well-formed id answers 200 with zero rows — so a zero-row response names the action that mints
 * the ids it was given instead of reading as "nothing runs here".
 */
const ID_SOURCE = {
  cityCode: 'the city-codes action, reading the list for THIS service',
  nodeId: 'bus-stop-search or bus-stop-nearby',
  nodeid: 'bus-stop-search or bus-stop-nearby',
  routeId: 'bus-route-search',
  depTmnCd: 'express-terminals-arr (a bare number like 010)',
  arrTmnCd: 'express-destinations (a bare number like 700)',
  depTerminalId: 'express-terminals or suburbs-terminals (a prefixed id like NAEK010)',
  arrTerminalId: 'express-terminals or suburbs-terminals (a prefixed id like NAEK300)',
  depPlaceId: 'train-stations',
  arrPlaceId: 'train-stations',
  subwayStationId: 'subway-stations',
  depAirportId: 'airports',
  arrAirportId: 'airports',
  airlineId: 'airlines',
  depNodeId: 'ports',
  busGradeId: 'express-grades or suburbs-grades',
  trainGradeCode: 'train-grades',
  providerName: 'scooter-providers',
};

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => { raw += c; });

function out(ok, d) { console.log(JSON.stringify(ok ? { success: true, data: d } : { success: false, error: d })); }

/** i18n error response — resolve_sysmod_error maps module.tago.{key}. */
function outErr(key, params) {
  const r = { success: false, errorKey: key };
  if (params && Object.keys(params).length > 0) r.errorParams = params;
  console.log(JSON.stringify(r));
}

process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(raw);
    const data = input.data ?? {};
    const action = data.action;

    const serviceKey = process.env.DATA_GO_KR_API_KEY;
    if (!serviceKey) return outErr('error.api_key_missing', {});
    if (!action) return outErr('error.action_required', {});

    if (action === 'city-codes') return await handleCityCodes(serviceKey, data);

    const op = OPS[action];
    if (!op) {
      return outErr('error.unknown_action', { action: String(action), actions: Object.keys(OPS).join(', ') });
    }

    const missing = (op.req ?? []).filter(p => data[p] === undefined || data[p] === null || data[p] === '');
    if (missing.length > 0) {
      return outErr('error.params_required', {
        action,
        missing: missing.map(p => (ID_SOURCE[p] ? `${p} (from ${ID_SOURCE[p]})` : p)).join(', '),
      });
    }

    const params = {};
    for (const p of [...(op.req ?? []), ...(op.opt ?? [])]) {
      if (data[p] !== undefined && data[p] !== null && data[p] !== '') params[op.wire?.[p] ?? p] = data[p];
    }
    if (data.pageNo) params.pageNo = data.pageNo;
    params.numOfRows = Math.max(1, Math.min(1000, Number(data.limit) || 100));

    const r = await callApi(serviceKey, op.svc, op.path, params);
    if (!r.ok) return outErr(r.errorKey, r.errorParams);

    const notes = [`Data freshness for this action: ${op.fresh}.`];
    if (r.items.length === 0) {
      // Zero rows is TAGO's answer to a well-formed id that does not exist, so it must not read as
      // "the service is empty" — the ids it was handed are the thing to check.
      const given = [...(op.req ?? []), ...(op.opt ?? [])]
        .filter(p => ID_SOURCE[p] && params[op.wire?.[p] ?? p] !== undefined);
      notes.push('No rows matched. TAGO answers 200 with an empty list for an id that is well-formed but wrong, so this usually means one of the ids is from the wrong list'
        + (given.length > 0 ? `: ${given.map(p => `${p}=${params[op.wire?.[p] ?? p]} should come from ${ID_SOURCE[p]}`).join('; ')}.` : '.'));
    }
    if (action === 'scooters') {
      notes.push('`cityCode` here is the 지역번호 from scooter-providers — NOT the 도시코드 from city-codes. They are different numbering schemes under the same field name.');
    }

    out(true, { items: r.items, totalCount: r.totalCount, _note: notes.join(' ') });
  } catch (e) {
    outErr('error.runtime', { message: e?.message ?? String(e) });
  }
});

async function handleCityCodes(serviceKey, data) {
  const which = data.service || 'bus-route';
  const src = CITY_CODE_SOURCES[which];
  if (!src) {
    return outErr('error.city_code_service_unknown', { service: String(which), services: Object.keys(CITY_CODE_SOURCES).join(', ') });
  }
  const r = await callApi(serviceKey, src.svc, src.path, { numOfRows: Math.max(1, Math.min(1000, Number(data.limit) || 300)) });
  if (!r.ok) return outErr(r.errorKey, r.errorParams);
  // The bus family answers `citycode`/`cityname`, the rest `cityCode`/`cityName` — same table,
  // two spellings. Both are normalised so a caller does not have to know which family it asked.
  const items = r.items.map(row => ({
    cityCode: row.citycode ?? row.cityCode,
    cityName: row.cityname ?? row.cityName,
  })).filter(row => row.cityCode !== undefined);
  out(true, {
    service: which, items, totalCount: r.totalCount,
    _note: 'Each TAGO service publishes its own 도시코드 list under its own base. Whether they are identical has not been measured here, so `service` names which one was read — use the list belonging to the service you are about to call. The scooter service is NOT in this list: its cityCode is a 지역번호 from scooter-providers.',
  });
}

/**
 * One request, both response dialects. Ported from molit-realestate: same portal, same envelope,
 * same habit of returning XML for a JSON request.
 */
async function callApi(serviceKey, svc, path, params) {
  const url = new URL(`${HOST}/${svc}/${path}`);
  // The stored key is the DECODED form; searchParams encodes it. Setting an already-encoded key
  // here would double-encode it and fail authentication.
  url.searchParams.set('serviceKey', serviceKey);
  url.searchParams.set('_type', 'json');
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  let res;
  try {
    res = await fetch(url.toString(), { method: 'GET', signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    return { ok: false, errorKey: 'error.network', errorParams: { message: e?.message ?? String(e) } };
  }
  if (!res.ok) return { ok: false, errorKey: 'error.http_status', errorParams: { status: String(res.status) } };
  const text = await res.text();

  let json = null;
  if (text.trim().startsWith('{')) {
    try { json = JSON.parse(text); } catch { /* fall through to the XML reader */ }
  }

  if (!json) {
    const authMatch = text.match(/<returnAuthMsg>([^<]+)<\/returnAuthMsg>/) || text.match(/<errMsg>([^<]+)<\/errMsg>/);
    if (authMatch) return { ok: false, errorKey: 'error.auth_rejected', errorParams: { message: authMatch[1] } };
    const codeMatch = text.match(/<resultCode>([^<]+)<\/resultCode>/);
    if (codeMatch && !isOk(codeMatch[1])) {
      const msg = text.match(/<resultMsg>([^<]+)<\/resultMsg>/);
      return { ok: false, errorKey: 'error.api_error', errorParams: { code: codeMatch[1], message: msg?.[1] ?? '' } };
    }
    const items = [];
    for (const m of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const obj = {};
      for (const f of m[1].matchAll(/<(\w+)>([^<]*)<\/\1>/g)) obj[f[1]] = f[2].trim();
      items.push(obj);
    }
    const total = text.match(/<totalCount>(\d+)<\/totalCount>/);
    return { ok: true, items, totalCount: total ? parseInt(total[1], 10) : items.length };
  }

  const header = json?.response?.header;
  if (header?.resultCode && !isOk(header.resultCode)) {
    return { ok: false, errorKey: 'error.api_error', errorParams: { code: String(header.resultCode), message: header.resultMsg ?? '' } };
  }
  const raw = json?.response?.body?.items?.item ?? json?.response?.body?.items ?? [];
  // One matching row arrives as an OBJECT, not a one-element array — the portal's oldest trap, and
  // the reason a caller that indexes [0] gets a character instead of a record.
  const items = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  return { ok: true, items, totalCount: json?.response?.body?.totalCount ?? items.length };
}

function isOk(code) {
  const c = String(code);
  return c === '00' || c === '000' || c === '0';
}
