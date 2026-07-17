#!/usr/bin/env node
/**
 * 카카오 지도 통합 sysmod — REST API.
 *
 * actions:
 *   geocoding         — 주소 → 좌표 (search/address)
 *   reverse-geocoding — 좌표 → 주소 (geo/coord2address)
 *   search-address    — 주소 자동완성·검색 (search/address)
 *   search-keyword    — 장소 키워드 검색 (search/keyword)
 *
 * 인증: Authorization: KakaoAK ${KAKAO_REST_API_KEY}
 *
 * JS SDK 키 (KAKAO_MAP_JS_KEY) 는 이 모듈에서 사용 X — Core 가 sysmod settings 읽어
 * SSR 시 사용자 사이트 head 에 inject. render_map 컴포넌트가 활용.
 *
 * REST API 키는 sysmod_kakao-talk 와 같은 키 그룹 — 카카오 디벨로퍼스 1 앱 안.
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

/** i18n 에러 응답 — errorKey + errorParams. resolve_sysmod_error 가 module.kakao-map.{key} 로 변환. */
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
      // N tool rounds. 2026-07-18 실측: 13개 단지 지오코딩이 13콜 순차로 돌던 것). Cap 30.
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
      return out(true, { items: r.items, total: r.total });
    }

    if (action === 'reverse-geocoding') {
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        return outErr('error.reverse_lat_lon_required', {});
      }
      const r = await callApi(restKey, '/geo/coord2address.json', {
        x: lon,  // 카카오 API: x=경도, y=위도
        y: lat,
      });
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items, total: r.total });
    }

    if (action === 'search-keyword') {
      if (!keyword) return outErr('error.keyword_required', {});
      const params = { query: keyword, size: safeLimit };
      if (categoryGroupCode) params.category_group_code = categoryGroupCode;
      if (typeof lat_center === 'number' && typeof lon_center === 'number') {
        params.x = lon_center;
        params.y = lat_center;
        if (radius) params.radius = Math.min(20000, radius);
      }
      const r = await callApi(restKey, '/search/keyword.json', params);
      if (!r.ok) return outErr(r.errorKey, r.errorParams);
      return out(true, { items: r.items, total: r.total });
    }

    return outErr('error.unknown_action', { action: String(action) });
  } catch (e) {
    return outErr('error.runtime', { message: e?.message ?? String(e) });
  }
}

main();
