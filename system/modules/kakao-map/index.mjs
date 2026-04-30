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
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  let json;
  try { json = await res.json(); }
  catch { return { ok: false, error: 'JSON 파싱 실패' }; }

  if (json?.errorType || json?.code) {
    return { ok: false, error: `API 오류: ${json?.message || json?.msg || JSON.stringify(json).slice(0, 200)}` };
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

async function main() {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); }
  catch { return out(false, undefined, 'stdin JSON 파싱 실패'); }

  const data = input.data ?? {};
  const { action, address, lat, lon, keyword, categoryGroupCode, lat_center, lon_center, radius, limit = 15 } = data;

  const restKey = process.env.KAKAO_REST_API_KEY;
  if (!restKey) return out(false, undefined, 'KAKAO_REST_API_KEY 미설정 (카카오톡 모듈과 같은 REST 키)');

  if (!action) return out(false, undefined, 'action 필수');
  const safeLimit = Math.max(1, Math.min(45, limit));

  try {
    if (action === 'geocoding' || action === 'search-address') {
      if (!address) return out(false, undefined, `${action} 은 address 필수`);
      const r = await callApi(restKey, '/search/address.json', {
        query: address,
        size: safeLimit,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items, total: r.total });
    }

    if (action === 'reverse-geocoding') {
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        return out(false, undefined, 'reverse-geocoding 은 lat/lon (number) 필수');
      }
      const r = await callApi(restKey, '/geo/coord2address.json', {
        x: lon,  // 카카오 API: x=경도, y=위도
        y: lat,
      });
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items, total: r.total });
    }

    if (action === 'search-keyword') {
      if (!keyword) return out(false, undefined, 'search-keyword 는 keyword 필수');
      const params = { query: keyword, size: safeLimit };
      if (categoryGroupCode) params.category_group_code = categoryGroupCode;
      if (typeof lat_center === 'number' && typeof lon_center === 'number') {
        params.x = lon_center;
        params.y = lat_center;
        if (radius) params.radius = Math.min(20000, radius);
      }
      const r = await callApi(restKey, '/search/keyword.json', params);
      if (!r.ok) return out(false, undefined, r.error);
      return out(true, { items: r.items, total: r.total });
    }

    return out(false, undefined, `알 수 없는 action: ${action}`);
  } catch (e) {
    return out(false, undefined, `예외: ${e?.message ?? String(e)}`);
  }
}

main();
