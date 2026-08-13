#!/usr/bin/env node
/**
 * Kakao Map integration sysmod — REST API.
 *
 * actions:
 *   geocoding         — address → coordinates (search/address)
 *   reverse-geocoding — coordinates → address (geo/coord2address)
 *   search-address    — address autocomplete/search (search/address)
 *   search-keyword    — place keyword search (search/keyword)
 *
 * Auth: Authorization: KakaoAK ${KAKAO_REST_API_KEY}
 *
 * The JS SDK key (KAKAO_MAP_JS_KEY) is NOT used by this module — Core reads it from the sysmod
 * settings and injects it into the user site's head at SSR time; the render_map component uses it.
 *
 * The REST key shares a key group with sysmod_kakao-talk — one app on Kakao Developers.
 */

import fs from 'node:fs';
import path from 'node:path';

const HOST = 'https://dapi.kakao.com';
const BASE = `${HOST}/v2/local`;

/** Coordinate systems the local and routing endpoints accept. Routing takes a subset. */
const COORDS_LOCAL = ['WGS84', 'WCONGNAMUL', 'CONGNAMUL', 'WTM', 'TM', 'KTM', 'UTM', 'BESSEL', 'WKTM', 'WUTM'];
const COORDS_ROUTING = ['WGS84', 'WTM', 'TM', 'WCONGNAMUL'];

/**
 * Category group codes for category place search. Naming the set here is the point: the parameter
 * is useless without it, and the vendor publishes the list only in prose.
 */
const CATEGORY_GROUPS = {
  MT1: '대형마트', CS2: '편의점', PS3: '어린이집·유치원', SC4: '학교', AC5: '학원',
  PK6: '주차장', OL7: '주유소·충전소', SW8: '지하철역', BK9: '은행', CT1: '문화시설',
  AG2: '중개업소', PO3: '공공기관', AT4: '관광명소', AD5: '숙박', FD6: '음식점',
  CE7: '카페', HP8: '병원', PM9: '약국',
};

/** Where the static map image is written before the framework carries it into the media store. */
const MEDIA_SCRATCH = path.join('data', 'kakao-map');

function buildUrl(base, params) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    // `markers` repeats — one parameter per marker, joined by the server, not overwritten.
    if (Array.isArray(v)) for (const one of v) url.searchParams.append(k, String(one));
    else url.searchParams.set(k, String(v));
  }
  return url;
}

async function request(restKey, base, params) {
  const res = await fetch(buildUrl(base, params).toString(), {
    method: 'GET',
    headers: { 'Authorization': `KakaoAK ${restKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorKey: 'error.http_status', errorParams: { status: String(res.status), body: text.slice(0, 200) } };
  }
  return { ok: true, res };
}

async function callApi(restKey, apiPath, params) {
  const r = await request(restKey, `${BASE}${apiPath}`, params);
  if (!r.ok) return r;
  let json;
  try { json = await r.res.json(); }
  catch { return { ok: false, errorKey: 'error.json_parse', errorParams: {} }; }

  if (json?.errorType || json?.code) {
    return { ok: false, errorKey: 'error.api_error', errorParams: { message: json?.message || json?.msg || JSON.stringify(json).slice(0, 200) } };
  }

  return { ok: true, items: json.documents ?? [], total: json.meta?.total_count ?? 0, meta: json.meta ?? {} };
}

/** Routing answers with its own envelope (`status` + `routes`/`route`), not `documents`. */
async function callRaw(restKey, fullPath, params) {
  const r = await request(restKey, `${HOST}${fullPath}`, params);
  if (!r.ok) return r;
  try { return { ok: true, json: await r.res.json() }; }
  catch { return { ok: false, errorKey: 'error.json_parse', errorParams: {} }; }
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

/** i18n error envelope — errorKey + errorParams; resolve_sysmod_error maps it to module.kakao-map.{key}. */
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
  const { action, address, lat, lon, keyword, categoryGroupCode, lat_center, lon_center, radius, limit = 15 } = data;

  const restKey = process.env.KAKAO_REST_API_KEY;
  if (!restKey) return outErr('error.rest_key_missing', {});

  if (!action) return outErr('error.action_required', {});
  // `size` caps differ per endpoint and 45 is neither of them — that is the `page` cap. Address
  // search takes 30, place search takes 15, and asking for more is a 400, not a truncation.
  const SIZE_CAP = { 'geocoding': 30, 'search-address': 30, 'search-keyword': 15, 'search-category': 15 };
  const cap = SIZE_CAP[action] ?? 15;
  const safeLimit = Math.max(1, Math.min(cap, limit));
  const limitNote = limit > cap ? `limit was capped at ${cap} — that is this endpoint's maximum page size.` : undefined;

  try {
    if (action === 'geocoding' || action === 'search-address') {
      // Batch mode — `addresses` array (multi-marker maps: N places → one call instead of
      // N tool rounds. Measured 2026-07-18: geocoding 13 apartment complexes ran as 13
      // sequential calls). Cap 30.
      const batch = Array.isArray(data.addresses) ? data.addresses.filter((a) => typeof a === 'string' && a.trim()) : null;
      if (batch && batch.length > 0) {
        const results = [];
        for (const q of batch.slice(0, 30)) {
          const r = await callApi(restKey, '/search/address.json', { query: q, size: 3 });
          results.push(r.ok ? { query: q, items: r.items } : { query: q, items: [], error: r.errorParams?.message ?? r.errorKey });
        }
        return out(true, { results, note: batch.length > 30 ? 'capped at 30 addresses per call' : undefined });
      }
      if (!address) return outErr('error.address_required', { action });
      const r = await callApi(restKey, '/search/address.json', {
        query: address,
        size: safeLimit,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      // Kakao's address endpoint resolves ADDRESSES, not place names — "서울시청" comes back as
      // an empty success, which reads like "no such place" and dead-ends the caller (measured
      // 2026-08-08). An empty result names the next step instead: the same query one action over.
      if (r.items.length === 0) {
        return out(true, { items: [], total: 0,
          note: `'${address}' 는 주소로 해석되지 않았습니다 — 장소·건물 이름이면 같은 질의를 `
              + `search-keyword 로 호출하세요 (주소 검색은 도로명·지번만 받습니다).` });
      }
      return out(true, { items: r.items, total: r.total });
    }

    if (action === 'reverse-geocoding') {
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        return outErr('error.reverse_lat_lon_required', {});
      }
      const r = await callApi(restKey, '/geo/coord2address.json', {
        x: lon,  // Kakao API: x = longitude, y = latitude
        y: lat,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items, total: r.total });
    }

    if (action === 'search-keyword') {
      // Batch mode — `keywords` array (multi-marker maps: N places → one call. Measured
      // 2026-07-19: locating 17 Yeouido complexes by name ran as 17 sequential calls — a
      // complex NAME is a keyword search, so the geocoding batch alone did not cover it).
      // Cap 30. Shared options (center/radius/category) apply to every keyword.
      const kwBatch = Array.isArray(data.keywords) ? data.keywords.filter((k) => typeof k === 'string' && k.trim()) : null;
      const baseParams = {};
      if (categoryGroupCode) baseParams.category_group_code = categoryGroupCode;
      if (typeof lat_center === 'number' && typeof lon_center === 'number') {
        baseParams.x = lon_center;
        baseParams.y = lat_center;
        if (radius) baseParams.radius = Math.min(20000, radius);
      }
      if (kwBatch && kwBatch.length > 0) {
        const results = [];
        for (const q of kwBatch.slice(0, 30)) {
          const r = await callApi(restKey, '/search/keyword.json', { ...baseParams, query: q, size: 3 });
          results.push(r.ok ? { query: q, items: r.items } : { query: q, items: [], error: r.errorParams?.message ?? r.errorKey });
        }
        return out(true, { results, note: kwBatch.length > 30 ? 'capped at 30 keywords per call' : undefined });
      }
      if (!keyword) return outErr('error.keyword_required', {});
      const r = await callApi(restKey, '/search/keyword.json', { ...baseParams, query: keyword, size: safeLimit });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items, total: r.total });
    }

    if (action === 'coord2region') {
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        return outErr('error.reverse_lat_lon_required', {});
      }
      const r = await callApi(restKey, '/geo/coord2regioncode.json', {
        x: lon, y: lat,
        input_coord: data.inputCoord, output_coord: data.outputCoord,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      // Two rows come back for one point, not one: the administrative division (H) and the legal
      // division (B) have different names and different codes for the same ground. Taking
      // documents[0] silently picks whichever the vendor listed first.
      return out(true, {
        items: r.items, total: r.total,
        note: 'region_type "H" is the 행정동 (administrative, used for public services) and "B" is the 법정동 (legal, used in addresses and deeds). Both are returned for the same point and their names and codes can differ — pick by region_type, not by position.',
      });
    }

    if (action === 'transcoord') {
      // x and y are raw values in `inputCoord`, which may not be degrees at all — TM and WTM are
      // metres. They are deliberately not called lat/lon here.
      if (typeof data.x !== 'number' || typeof data.y !== 'number') {
        return outErr('error.transcoord_xy_required', {});
      }
      const outputCoord = data.outputCoord;
      if (!outputCoord || !COORDS_LOCAL.includes(outputCoord)) {
        return outErr('error.coord_system_invalid', { field: 'outputCoord', systems: COORDS_LOCAL.join(', ') });
      }
      if (data.inputCoord && !COORDS_LOCAL.includes(data.inputCoord)) {
        return outErr('error.coord_system_invalid', { field: 'inputCoord', systems: COORDS_LOCAL.join(', ') });
      }
      const r = await callApi(restKey, '/geo/transcoord.json', {
        x: data.x, y: data.y, input_coord: data.inputCoord, output_coord: outputCoord,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items, total: r.total });
    }

    if (action === 'search-category') {
      if (!categoryGroupCode || !CATEGORY_GROUPS[categoryGroupCode]) {
        return outErr('error.category_code_invalid', {
          code: String(categoryGroupCode ?? ''),
          codes: Object.entries(CATEGORY_GROUPS).map(([c, n]) => `${c}=${n}`).join(', '),
        });
      }
      const params = { category_group_code: categoryGroupCode, size: safeLimit };
      if (data.page) params.page = Math.max(1, Math.min(45, data.page));
      if (typeof lat_center === 'number' && typeof lon_center === 'number') {
        params.x = lon_center;
        params.y = lat_center;
        if (radius) params.radius = Math.min(20000, radius);
      }
      if (data.rect) params.rect = data.rect;
      if (data.sort) params.sort = data.sort;
      // `distance` sorting without a centre is meaningless and the vendor rejects it, so say which
      // field is missing rather than forwarding a request that cannot succeed.
      if (params.sort === 'distance' && params.x === undefined) {
        return outErr('error.distance_sort_needs_center', {});
      }
      if (params.x === undefined && !params.rect) {
        return outErr('error.category_area_required', { code: categoryGroupCode });
      }
      const r = await callApi(restKey, '/search/category.json', params);
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, {
        items: r.items, total: r.total, categoryName: CATEGORY_GROUPS[categoryGroupCode],
        note: limitNote,
      });
    }

    if (action === 'route-transit' || action === 'route-walk' || action === 'route-bicycle') {
      return await handleRouting(restKey, action, data);
    }

    if (action === 'static-map') {
      return await handleStaticMap(restKey, data);
    }

    return outErr('error.unknown_action', { action: String(action) });
  } catch (e) {
    return outErr('error.runtime', { message: e?.message ?? String(e) });
  }
}

/** Endpoint, and whether it accepts waypoints and a search mode. */
const ROUTES = {
  'route-transit': { path: '/v2/routing/publictraffic', via: false, modes: null },
  'route-walk': { path: '/v2/routing/walk', via: true, modes: ['BROAD_FIRST', 'SHORTEST', 'ACCESSIBLE'] },
  'route-bicycle': { path: '/v2/routing/bicycle', via: true, modes: ['BIKE_ONLY', 'SHORTEST', 'ACCESSIBLE'] },
};

async function handleRouting(restKey, action, data) {
  const spec = ROUTES[action];
  const { startLat, startLon, endLat, endLon } = data;
  for (const [name, v] of [['startLat', startLat], ['startLon', startLon], ['endLat', endLat], ['endLon', endLon]]) {
    if (typeof v !== 'number') return outErr('error.route_coords_required', { missing: name });
  }

  const params = {
    start_x: startLon, start_y: startLat,   // Kakao: x = longitude, y = latitude
    end_x: endLon, end_y: endLat,
    s_name: data.startName, e_name: data.endName,
    input_coord: data.inputCoord, output_coord: data.outputCoord,
  };
  for (const field of ['inputCoord', 'outputCoord']) {
    if (data[field] && !COORDS_ROUTING.includes(data[field])) {
      return outErr('error.coord_system_invalid', { field, systems: COORDS_ROUTING.join(', ') });
    }
  }

  const notes = [];
  if (Array.isArray(data.via) && data.via.length > 0) {
    if (!spec.via) notes.push('via waypoints were dropped: transit routing does not take them.');
    else {
      const stops = data.via.slice(0, 5).filter(p => typeof p?.lat === 'number' && typeof p?.lon === 'number');
      if (stops.length > 0) {
        params.via_x = stops.map(p => p.lon).join(',');
        params.via_y = stops.map(p => p.lat).join(',');
        const names = stops.map(p => p.name).filter(Boolean);
        if (names.length === stops.length) params.v_name = names.join(',');
      }
      if (data.via.length > 5) notes.push(`Only the first 5 of ${data.via.length} waypoints were sent.`);
    }
  }
  if (data.routeMode) {
    if (!spec.modes) notes.push('routeMode was dropped: transit routing has no search mode.');
    else if (!spec.modes.includes(data.routeMode)) notes.push(`routeMode "${data.routeMode}" was dropped: ${action} accepts ${spec.modes.join(' | ')}.`);
    else params.route_mode = data.routeMode;
  }

  const r = await callRaw(restKey, spec.path, params);
  if (!r.ok) return outErr(r.errorKey, r.errorParams);
  const json = r.json ?? {};

  // A failed search still answers 200 with a status word and no route. Passing that through as a
  // success leaves the caller to infer "no route" from a missing key.
  if (json.status && json.status !== 'OK') {
    return outErr('error.route_not_found', { action, status: String(json.status) });
  }

  // The geometry is the bulk of the response and also the reason to call it — those point arrays
  // draw straight onto a Polyline. Dropping them is offered, not imposed.
  if (data.includePath === false) {
    stripPaths(json);
    notes.push('Path geometry was omitted (includePath:false); distances, times and guidance remain.');
  } else {
    notes.push('Each step carries `path.points` as [longitude, latitude] pairs — note the order, which is the reverse of how coordinates are usually written here. They render directly as a map Polyline.');
  }
  if (action === 'route-transit') {
    notes.push('`fare.value` is the fare in KRW for that route; `transfers` counts changes. Routes are listed per option, not ranked.');
  }

  return out(true, { ...json, note: notes.length > 0 ? notes.join(' ') : undefined });
}

/** Removes `path.points` wherever it appears, leaving the itinerary intact. */
function stripPaths(node) {
  if (Array.isArray(node)) { for (const v of node) stripPaths(v); return; }
  if (!node || typeof node !== 'object') return;
  if (node.path && typeof node.path === 'object') delete node.path;
  for (const v of Object.values(node)) stripPaths(v);
}

/**
 * A map as a PNG. The interactive component cannot go into a pptx, a pdf or a chat notification;
 * this can. The file is written to the module's scratch directory and declared via `_mediaImport`,
 * so the framework carries it into the media store on the same gated path every other produced
 * file takes.
 */
async function handleStaticMap(restKey, data) {
  const markers = Array.isArray(data.markers) ? data.markers.filter(m => typeof m?.lat === 'number' && typeof m?.lon === 'number') : [];
  const hasCenter = typeof data.centerLat === 'number' && typeof data.centerLon === 'number';
  if (!hasCenter && markers.length === 0) {
    return outErr('error.static_map_center_required', {});
  }

  const width = Math.max(1, Math.min(2048, Number(data.width) || 640));
  const height = Math.max(1, Math.min(1024, Number(data.height) || 480));
  const format = data.format === 'jpg' ? 'jpg' : 'png';

  const params = { size: `${width}x${height}`, format };
  if (hasCenter) params.center = `${data.centerLon},${data.centerLat}`;
  if (markers.length > 0) {
    params.markers = markers.slice(0, 5).map(m => `location:${m.lon},${m.lat}|option:${m.excludeFromBounds ? 'true' : 'false'}`);
  }
  if (data.level !== undefined) params.lv = Math.max(1, Math.min(15, Number(data.level)));
  if (data.scale !== undefined) params.scale = Number(data.scale) === 1 ? 1 : 2;
  if (data.logoPos) params.logo_pos = data.logoPos;
  if (data.coord) params.coord = data.coord;

  const r = await request(restKey, `${HOST}/v2/maps/staticmap`, params);
  if (!r.ok) return outErr(r.errorKey, r.errorParams);
  const bytes = Buffer.from(await r.res.arrayBuffer());

  const stem = (data.name && String(data.name).trim())
    || (markers[0] ? `map-${markers[0].lat.toFixed(4)}-${markers[0].lon.toFixed(4)}` : `map-${data.centerLat}-${data.centerLon}`);
  const safeStem = String(stem).replace(/[\\/:*?"<>|]/g, '-').slice(0, 60);
  const file = path.join(MEDIA_SCRATCH, `${safeStem}.${format}`);
  fs.mkdirSync(MEDIA_SCRATCH, { recursive: true });
  fs.writeFileSync(file, bytes);

  const notes = [
    'This is a still image, not a map component — it cannot be panned or zoomed. Use it where an interactive map cannot go: documents, notifications, saved files. For a page or a chat answer, render the map component instead.',
    'The Kakao logo is burned into the image and cannot be removed; logoPos only moves it.',
  ];
  if (markers.length > 5) notes.push(`Only the first 5 of ${markers.length} markers were drawn — that is the vendor's limit.`);

  out(true, {
    width, height, format, markers: Math.min(markers.length, 5),
    _mediaImport: {
      path: file.split(path.sep).join('/'),
      contentType: format === 'jpg' ? 'image/jpeg' : 'image/png',
      filenameHint: `${safeStem}.${format}`,
    },
    note: notes.join(' '),
  });
}

main();
