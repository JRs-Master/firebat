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

const BASE = 'https://dapi.kakao.com/v2/local';

async function callApi(restKey, path, params) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Authorization': `KakaoAK ${restKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorKey: 'error.http_status', errorParams: { status: String(res.status), body: text.slice(0, 200) } };
  }
  let json;
  try { json = await res.json(); }
  catch { return { ok: false, errorKey: 'error.json_parse', errorParams: {} }; }

  if (json?.errorType || json?.code) {
    return { ok: false, errorKey: 'error.api_error', errorParams: { message: json?.message || json?.msg || JSON.stringify(json).slice(0, 200) } };
  }

  return { ok: true, items: json.documents ?? [], total: json.meta?.total_count ?? 0 };
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
  const safeLimit = Math.max(1, Math.min(45, limit));

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

    return outErr('error.unknown_action', { action: String(action) });
  } catch (e) {
    return outErr('error.runtime', { message: e?.message ?? String(e) });
  }
}

main();
