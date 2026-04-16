/**
 * Firebat System Module: law-search (law-search)
 * 국가법령정보 Open API — 법령/판례/행정규칙/자치법규/헌재결정례/법령해석례/조약
 *
 * [INPUT]  stdin JSON: {
 *           "correlationId": "...",
 *           "data": {
 *             "action": "search" | "detail",
 *             "target?": "law" | "prec" | "admrul" | "ordin" | "detc" | "expc" | "trty",
 *             "query?": "검색어",
 *             "id?": "법령ID 또는 판례일련번호",
 *             "search?": 1 | 2,
 *             "display?": 20,
 *             "page?": 1,
 *             "sort?": "lasc" | "ldes" | "dasc" | "ddes" | "efasc" | "efdes"
 *           }
 *         }
 * [OUTPUT] stdout JSON: { "success": true, "data": { ... } }
 *         또는 { "success": false, "error": "..." }
 */

const BASE_URL = 'http://www.law.go.kr/DRF';

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action;
    if (!action) {
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다. (search 또는 detail)' }));
      return;
    }

    const OC = process.env['LAW_API_OC'];
    if (!OC) {
      console.log(JSON.stringify({ success: false, error: 'LAW_API_OC가 설정되지 않았습니다. 설정 > 시스템 모듈 > law-search에서 API 인증값을 등록해주세요. (국가법령정보 공동활용 신청: open.law.go.kr)' }));
      return;
    }

    const target = data.target || 'law';

    if (action === 'search') {
      await handleSearch(OC, target, data);
    } else if (action === 'detail') {
      await handleDetail(OC, target, data);
    } else {
      console.log(JSON.stringify({ success: false, error: `알 수 없는 action: ${action}. search 또는 detail을 사용하세요.` }));
    }
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

// ── 목록 검색 ────────────────────────────────────────────────────────────────
async function handleSearch(OC, target, data) {
  const query = data.query;
  if (!query) {
    console.log(JSON.stringify({ success: false, error: 'search 액션에는 query(검색어)가 필요합니다.' }));
    return;
  }

  const params = new URLSearchParams({
    OC,
    target,
    type: 'JSON',
    query,
  });

  if (data.search) params.set('search', String(data.search));
  if (data.display) params.set('display', String(Math.min(Math.max(data.display, 1), 100)));
  if (data.page) params.set('page', String(Math.max(data.page, 1)));
  if (data.sort) params.set('sort', data.sort);

  const url = `${BASE_URL}/lawSearch.do?${params}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.log(JSON.stringify({ success: false, error: `법령 API ${resp.status}: ${errText}`.trim() }));
    return;
  }

  const json = await resp.json();

  // 에러 응답 처리
  if (json.result) {
    console.log(JSON.stringify({ success: false, error: `${json.result}: ${json.msg || ''}`.trim() }));
    return;
  }

  // target별 응답 구조가 다름
  const parsed = parseSearchResult(target, json);
  console.log(JSON.stringify({ success: true, data: parsed }));
}

// ── 본문 조회 ────────────────────────────────────────────────────────────────
async function handleDetail(OC, target, data) {
  const id = data.id;
  if (!id) {
    console.log(JSON.stringify({ success: false, error: 'detail 액션에는 id(법령ID 또는 판례일련번호)가 필요합니다.' }));
    return;
  }

  const params = new URLSearchParams({
    OC,
    target,
    type: 'JSON',
    ID: id,
  });

  const url = `${BASE_URL}/lawService.do?${params}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.log(JSON.stringify({ success: false, error: `법령 API ${resp.status}: ${errText}`.trim() }));
    return;
  }

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // JSON 파싱 실패 시 텍스트 그대로 반환
    console.log(JSON.stringify({ success: true, data: { rawText: text.slice(0, 8000) } }));
    return;
  }

  if (json.result) {
    console.log(JSON.stringify({ success: false, error: `${json.result}: ${json.msg || ''}`.trim() }));
    return;
  }

  const parsed = parseDetailResult(target, json);
  console.log(JSON.stringify({ success: true, data: parsed }));
}

// ── 검색 결과 파싱 ──────────────────────────────────────────────────────────
function parseSearchResult(target, json) {
  // 국가법령정보 API 응답은 target에 따라 키 이름이 다름
  const root = json[target] || json.LawSearch || json.PrecSearch || json;
  if (!root) return { totalCnt: 0, page: 1, items: [] };

  const totalCnt = parseInt(root.totalCnt || root.totalCount || '0', 10);
  const page = parseInt(root.page || '1', 10);

  // 결과 배열 추출
  let rawItems = root.law || root.prec || root.admrul || root.ordin ||
                 root.detc || root.expc || root.trty || [];
  if (!Array.isArray(rawItems)) rawItems = [rawItems];

  const items = rawItems.map(item => {
    const base = {};
    // 공통 필드
    for (const [k, v] of Object.entries(item)) {
      if (v !== undefined && v !== null && v !== '') {
        // 한글 키명 그대로 유지 (AI가 이해하기 쉬움)
        base[k] = typeof v === 'string' ? v.trim() : v;
      }
    }
    return base;
  });

  return { totalCnt, page, items };
}

// ── 본문 결과 파싱 ──────────────────────────────────────────────────────────
function parseDetailResult(target, json) {
  // 본문 응답은 단일 객체
  const root = json[target] || json.law || json.prec || json.admrul || json;

  if (target === 'law') {
    return parseLawDetail(root);
  } else if (target === 'prec') {
    return parsePrecDetail(root);
  }

  // 기타 target — 필드를 그대로 정리
  const result = {};
  for (const [k, v] of Object.entries(root)) {
    if (v !== undefined && v !== null && v !== '') {
      result[k] = v;
    }
  }
  return result;
}

// 법령 본문 파싱 — 조문 추출
function parseLawDetail(root) {
  const result = {
    법령명: root['법령명_한글'] || root['법령명한글'] || '',
    법령약칭: root['법령약칭명'] || '',
    시행일자: root['시행일자'] || '',
    공포일자: root['공포일자'] || '',
    소관부처: root['소관부처명'] || '',
    법령구분: root['법령구분명'] || '',
  };

  // 조문 배열
  let articles = root['조문'] || root['조문단위'] || [];
  if (!Array.isArray(articles)) articles = [articles];

  result.조문 = articles.map(a => {
    const art = {
      조문번호: a['조문번호'] || '',
      조문제목: a['조문제목'] || '',
      조문내용: a['조문내용'] || '',
    };
    // 항 (하위)
    let items = a['항'] || [];
    if (!Array.isArray(items)) items = [items];
    if (items.length > 0) {
      art.항 = items.map(h => ({
        항번호: h['항번호'] || '',
        항내용: h['항내용'] || '',
      })).filter(h => h.항내용);
    }
    return art;
  }).filter(a => a.조문내용 || a.조문제목);

  // 부칙
  let addenda = root['부칙'] || [];
  if (!Array.isArray(addenda)) addenda = [addenda];
  if (addenda.length > 0 && addenda[0]) {
    result.부칙 = addenda.map(a => ({
      부칙번호: a['부칙번호'] || '',
      부칙내용: a['부칙내용'] || '',
    })).filter(a => a.부칙내용);
  }

  return result;
}

// 판례 본문 파싱
function parsePrecDetail(root) {
  return {
    사건명: root['사건명'] || '',
    사건번호: root['사건번호'] || '',
    선고일자: root['선고일자'] || '',
    법원명: root['법원명'] || '',
    판결유형: root['판결유형'] || root['사건종류명'] || '',
    판시사항: root['판시사항'] || '',
    판결요지: root['판결요지'] || '',
    참조조문: root['참조조문'] || '',
    참조판례: root['참조판례'] || '',
    판례내용: root['판례내용'] || root['전문'] || '',
  };
}
