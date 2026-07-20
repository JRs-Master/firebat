/**
 * Firebat System Module: law-search
 * 국가법령정보 Open API (open.law.go.kr)
 *
 * 3가지 액션:
 *   search  — 목록 검색   (lawSearch.do)
 *   detail  — 본문 조회   (lawService.do)
 *   article — 조항호목 조회 (lawService.do?target=lawjosub)
 *
 * 7가지 target: law, prec, admrul, ordin, detc, expc, trty
 */

const BASE = 'https://www.law.go.kr/DRF';
// law.go.kr 국가법령 Open API 는 응답이 느릴 때가 잦다. 옛 원본엔 타임아웃이 없어
// (끝까지 대기) 느려도 결과를 받았는데, 속도 최적화 리팩터(25e0eea)에서 20s 상한이
// 들어가며 느린 응답이 자주 잘렸다. 넉넉히 45s — sandbox/watchdog(2분) 안쪽이라 안전.
const TIMEOUT = 45000;
// law.go.kr(정부 서버)이 node 기본 UA 의 연결을 리셋(ECONNRESET)하는 사례 대비 — 브라우저 유사 UA.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => { raw += c; });
/** i18n 에러 — main 의 catch 에서 errorKey/errorParams 추출. */
class I18nError extends Error {
  constructor(key, params) {
    super(key);
    this.errorKey = key;
    this.errorParams = params || {};
  }
}

process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action;
    if (!action) return outErr('error.action_required', {});

    const OC = process.env['LAW_API_OC'];
    if (!OC) return outErr('error.oc_missing', {});

    if (action === 'search') await handleSearch(OC, data);
    else if (action === 'detail') await handleDetail(OC, data);
    else if (action === 'article') await handleArticle(OC, data);
    else outErr('error.unknown_action', { action: String(action) });
  } catch (e) {
    if (e instanceof I18nError) outErr(e.errorKey, e.errorParams);
    else outErr('error.runtime', { message: e.message });
  }
});

function out(success, dataOrError) {
  console.log(JSON.stringify(success ? { success: true, data: dataOrError } : { success: false, error: dataOrError }));
}

/** i18n 에러 응답 — errorKey + errorParams. resolve_sysmod_error 가 module.law-search.{key} 로 변환. */
function outErr(key, params) {
  const r = { success: false, errorKey: key };
  if (params && Object.keys(params).length > 0) r.errorParams = params;
  console.log(JSON.stringify(r));
}

// ── 공통 fetch ──────────────────────────────────────────────────────────────
async function apiFetch(url) {
  const MAX_TRY = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
    let resp;
    try {
      resp = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT),
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      });
    } catch (e) {
      // 네트워크 장애 (ECONNRESET / DNS / 타임아웃 등). ECONNRESET 류는 일시적이라 backoff 재시도.
      // 타임아웃(AbortError)은 이미 45s 대기했으니 재시도 안 함 (watchdog 2분 초과 방지).
      lastErr = e;
      const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';
      if (!isTimeout && attempt < MAX_TRY) {
        await new Promise(r => setTimeout(r, attempt * 800)); // 0.8s → 1.6s backoff
        continue;
      }
      const cause = e.cause?.code || e.cause?.message || '';
      throw new I18nError('error.network', { message: e.message, cause });
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new I18nError('error.api_status', { status: String(resp.status), body: t });
    }
    const text = await resp.text();
    try {
      const json = JSON.parse(text);
      if (json.result) throw new I18nError('error.api_result', { result: String(json.result), message: json.msg || '' });
      return json;
    } catch (e) {
      if (e instanceof I18nError) throw e;
      // JSON 파싱 실패 — HTML/XML 응답일 수 있음. 전체 반환 — 길면 sandbox auto-cache 가 처리.
      return { _raw: text };
    }
  }
  // 루프가 정상 종료될 일은 없지만(성공 return / throw), 타입 안전망.
  const cause = lastErr?.cause?.code || lastErr?.cause?.message || '';
  throw new I18nError('error.network', { message: lastErr?.message || 'fetch failed', cause });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  1. search — 목록 검색 (lawSearch.do)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleSearch(OC, data) {
  const target = data.target || 'law';
  const query = data.query;
  if (!query) return outErr('error.search_query_required', {});

  const p = new URLSearchParams({ OC, target, type: 'JSON', query });

  // 공통 파라미터
  if (data.search) p.set('search', String(data.search));
  if (data.display) p.set('display', String(Math.min(Math.max(data.display, 1), 100)));
  if (data.page) p.set('page', String(Math.max(data.page, 1)));
  if (data.sort) p.set('sort', data.sort);
  if (data.gana) p.set('gana', data.gana);
  if (data.popYn) p.set('popYn', data.popYn);

  // target별 고유 파라미터
  if (target === 'law') {
    if (data.date) p.set('date', String(data.date));
    if (data.efYd) p.set('efYd', data.efYd);
    if (data.ancYd) p.set('ancYd', data.ancYd);
    if (data.ancNo) p.set('ancNo', data.ancNo);
    if (data.rrClsCd) p.set('rrClsCd', data.rrClsCd);
    if (data.nb) p.set('nb', String(data.nb));
    if (data.org) p.set('org', data.org);
    if (data.knd) p.set('knd', data.knd);
    if (data.lsChapNo) p.set('lsChapNo', data.lsChapNo);
  } else if (target === 'prec') {
    if (data.org) p.set('org', data.org);       // 법원종류 (400201=대법원, 400202=하위법원)
    if (data.curt) p.set('curt', data.curt);     // 법원명
    if (data.JO) p.set('JO', data.JO);           // 참조조문 법령명
    if (data.date) p.set('date', String(data.date));
    if (data.prncYd) p.set('prncYd', data.prncYd); // 선고일자 범위
    if (data.nb) p.set('nb', String(data.nb));    // 사건번호
    if (data.datSrcNm) p.set('datSrcNm', data.datSrcNm);
  } else if (target === 'admrul') {
    if (data.nw) p.set('nw', String(data.nw));   // 1=현행, 2=연혁
    if (data.org) p.set('org', data.org);
    if (data.knd) p.set('knd', data.knd);         // 1=훈령, 2=예규, 3=고시, 4=공고, 5=지침, 6=기타
    if (data.date) p.set('date', String(data.date));
    if (data.prmlYd) p.set('prmlYd', data.prmlYd); // 발령일자 범위
    if (data.modYd) p.set('modYd', data.modYd);
    if (data.nb) p.set('nb', String(data.nb));
  } else if (target === 'ordin') {
    if (data.nw) p.set('nw', String(data.nw));
    if (data.org) p.set('org', data.org);         // 지자체코드 (6110000 등)
    if (data.sborg) p.set('sborg', data.sborg);   // 시군구코드
    if (data.knd) p.set('knd', data.knd);          // 30001~30011
    if (data.rrClsCd) p.set('rrClsCd', data.rrClsCd);
    if (data.ordinFd) p.set('ordinFd', String(data.ordinFd));
    if (data.lsChapNo) p.set('lsChapNo', data.lsChapNo);
    if (data.date) p.set('date', String(data.date));
    if (data.efYd) p.set('efYd', data.efYd);
    if (data.ancYd) p.set('ancYd', data.ancYd);
    if (data.ancNo) p.set('ancNo', data.ancNo);
    if (data.nb) p.set('nb', String(data.nb));
  } else if (target === 'detc') {
    if (data.date) p.set('date', String(data.date));
    if (data.edYd) p.set('edYd', data.edYd);     // 종국일자 범위
    if (data.nb) p.set('nb', String(data.nb));
  } else if (target === 'expc') {
    if (data.inq) p.set('inq', data.inq);         // 질의기관
    if (data.rpl) p.set('rpl', String(data.rpl));  // 회신기관
    if (data.itmno) p.set('itmno', String(data.itmno)); // 안건번호
    if (data.regYd) p.set('regYd', data.regYd);
    if (data.explYd) p.set('explYd', data.explYd);
  } else if (target === 'trty') {
    if (data.eftYd) p.set('eftYd', data.eftYd);   // 발효일자 범위
    if (data.concYd) p.set('concYd', data.concYd); // 체결일자 범위
    if (data.cls) p.set('cls', String(data.cls));   // 1=양자, 2=다자
    if (data.natCd) p.set('natCd', String(data.natCd)); // 국가코드
  } else if (target === 'lsHistory') {
    if (data.date) p.set('date', String(data.date));
    if (data.efYd) p.set('efYd', data.efYd);
    if (data.ancYd) p.set('ancYd', data.ancYd);
    if (data.org) p.set('org', data.org);
    if (data.knd) p.set('knd', data.knd);
  }

  const json = await apiFetch(`${BASE}/lawSearch.do?${p}`);
  if (json._raw) return out(true, { rawText: json._raw });

  const searchResult = parseSearchResult(target, json);
  // 0건 = 검색어 문제인 경우가 대부분 (법제처 검색은 AND 매칭이라 긴 복합어가 통째로 0건).
  // 빈 배열만 돌려주면 모델이 원인을 몰라 파라미터를 변주하며 재시도한다 → 다음 수를 명시.
  if (searchResult.totalCnt === 0 && searchResult.items.length === 0) {
    searchResult.note = 'no results — this API matches ALL words (AND). Retry with a SHORTER core term (1-2 words, e.g. "폭행치사" instead of "폭행치사 예견가능성"); adding words narrows, never broadens. Legal doctrine keywords are often absent from case titles.';
  }
  out(true, searchResult);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  2. detail — 본문 조회 (lawService.do)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleDetail(OC, data) {
  // target=law → eflaw 자동 전환 (시행법령: 조문 내용이 더 완전하게 반환됨)
  const rawTarget = data.target || 'law';
  const target = rawTarget === 'law' ? 'eflaw' : rawTarget;
  const id = data.ID || data.id;
  const mst = data.MST || data.mst;

  // query를 LM으로 폴백 (AI가 query로 보내는 경우 대응)
  if (!data.LM && data.query) data.LM = data.query;

  if (!id && !mst && !data.LM) {
    return outErr('error.detail_id_required', {});
  }

  const p = new URLSearchParams({ OC, target, type: 'JSON' });
  if (id) p.set('ID', String(id));
  if (mst) p.set('MST', String(mst));

  // target별 고유 파라미터
  if (target === 'eflaw' || target === 'law') {
    if (data.LM) p.set('LM', data.LM);
    if (data.LD) p.set('LD', String(data.LD));
    if (data.LN) p.set('LN', String(data.LN));
    if (data.JO) p.set('JO', data.JO);           // 조문번호 6자리 (제2조=000200)
    if (data.LANG) p.set('LANG', data.LANG);     // KO=한글, ORI=원문
  } else if (target === 'prec') {
    if (data.LM) p.set('LM', data.LM);
  } else if (target === 'admrul') {
    if (data.LID) p.set('LID', data.LID);         // 행정규칙ID
    if (data.LM) p.set('LM', data.LM);
  } else if (target === 'ordin') {
    // ID 또는 MST
  } else if (target === 'detc') {
    if (data.LM) p.set('LM', data.LM);
  } else if (target === 'expc') {
    if (data.LM) p.set('LM', data.LM);
  } else if (target === 'trty') {
    if (data.chrClsCd) p.set('chrClsCd', data.chrClsCd); // 010202=한글, 010203=영문
  }

  const json = await apiFetch(`${BASE}/lawService.do?${p}`);
  if (json._raw) return out(true, { rawText: json._raw });

  const result = parseDetailResult(target, json);
  // 빈 본문에 success:true 를 주면 모델은 "본문을 확보했다"로 오인한 채 진행한다
  // (2026-07-20 실측: 판례 detail 이 {} 인데 성공으로 보여, 본문 없이 답변이 작성됨).
  // 호출 자체는 성공이므로 에러 대신 found:false + 다음 수를 명시한다.
  if (!result || Object.keys(result).length === 0) {
    return out(true, {
      found: false,
      requested: { target, ID: id ?? null, MST: mst ?? null },
      note: 'the API returned an empty body for this id — do NOT treat this as content. Re-check the id against the search result field (판례일련번호 / 법령일련번호 of THAT target), or open 판례상세링크 from the search item.',
    });
  }
  // 조문이 빈 경우 디버그용 키 목록 포함
  if ((target === 'law' || target === 'eflaw') && result && !result.조문) {
    result._debugKeys = Object.keys(json).slice(0, 10);
    const rootObj = findRoot(json, target);
    if (rootObj && rootObj !== json) {
      result._debugRootKeys = Object.keys(Array.isArray(rootObj) ? rootObj[0] || {} : rootObj).slice(0, 20);
    }
  }
  out(true, result);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  3. article — 조항호목 개별 조회 (lawService.do?target=lawjosub)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleArticle(OC, data) {
  let id = data.ID || data.id;
  let mst = data.MST || data.mst;
  const jo = data.JO || data.jo;
  const lm = data.LM || data.query;  // 법령명으로도 조회 가능

  // ID/MST 없으면 법령명으로 자동 검색
  if (!id && !mst && lm) {
    const searchP = new URLSearchParams({ OC, target: 'law', type: 'JSON', query: lm, display: '1' });
    const searchJson = await apiFetch(`${BASE}/lawSearch.do?${searchP}`);
    const searchResult = parseSearchResult('law', searchJson);
    if (searchResult.items?.length > 0) {
      const first = searchResult.items[0];
      mst = first['법령일련번호'] || first['법령MST'] || first.MST;
      id = first['법령ID'] || first.ID;
    }
    if (!id && !mst) return outErr('error.law_not_found', { lm });
  }

  if (!id && !mst) return outErr('error.article_id_required', {});
  if (!jo) return outErr('error.article_jo_required', {});

  const p = new URLSearchParams({ OC, target: 'lawjosub', type: 'JSON' });
  if (id) p.set('ID', String(id));
  if (mst) p.set('MST', String(mst));
  p.set('JO', jo);
  if (data.HANG) p.set('HANG', data.HANG);   // 항번호 6자리
  if (data.HO) p.set('HO', data.HO);         // 호번호 6자리
  if (data.MOK) p.set('MOK', data.MOK);       // 목번호 한글 1글자 (가,나,다,라...)

  const json = await apiFetch(`${BASE}/lawService.do?${p}`);
  if (json._raw) return out(true, { rawText: json._raw });

  out(true, cleanObject(json));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  파싱 유틸
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function cleanObject(obj) {
  // null / undefined → 빈 object — config.output schema (root type=object) 와 일관성.
  // 옛에 null 그대로 반환 박혀 envelope `{success:true, data:null}` 박힘 → ModuleManager
  // validate_value warning ("null is not of type object") 박는 영역 root cause.
  if (obj == null) return {};
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(cleanObject);
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '' || k === '_raw') continue;
    result[k] = typeof v === 'string' ? v.trim() : (typeof v === 'object' ? cleanObject(v) : v);
  }
  return result;
}

function toArray(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }

// ── 검색 결과 파싱 ──────────────────────────────────────────────────────────
function parseSearchResult(target, json) {
  // API 응답 최상위 키: 영어/한국어/Search 접미사 등 다양한 형태
  const root = json[target] || json.LawSearch || json.PrecSearch || json.AdmRulSearch
    || json.OrdinSearch || json.DetcSearch || json.ExpcSearch || json.TrtySearch
    || json['법령'] || json['판례'] || json['행정규칙'] || json['자치법규']
    || json['헌재결정례'] || json['법령해석례'] || json['조약'] || json;
  if (!root) return { totalCnt: 0, page: 1, items: [] };

  const totalCnt = parseInt(root.totalCnt || root.totalCount || '0', 10);
  const page = parseInt(root.page || '1', 10);

  let rawItems = root.law || root.prec || root.admrul || root.ordin
    || root.detc || root.expc || root.trty || root.lsHistory || [];
  rawItems = toArray(rawItems);

  const items = rawItems.map(cleanObject);
  return { totalCnt, page, items };
}

// ── 본문 결과 파싱 ──────────────────────────────────────────────────────────
// API 응답 root 키: 영어(law) 또는 한국어(법령) 둘 다 가능
// 검색(lawSearch.do)은 `XxxSearch`, 상세(lawService.do)는 `XxxService` 래퍼로 응답한다.
// 2026-07-20 실측: 판례 상세가 {"PrecService":{판시사항…}} 인데 후보 키에 없어 root 를 못 찾고
// 전 필드가 빈 값 → cleanObject 가 {} 로 만들어 "본문 없음"처럼 보였다(파서 버그).
const ROOT_KEYS = {
  law:       ['law', 'eflaw', '법령', 'LawService', 'EfLawService'],
  eflaw:     ['eflaw', 'law', '법령', 'LawService', 'EfLawService'],
  prec:      ['prec', '판례', 'PrecService'],
  admrul:    ['admrul', '행정규칙', 'AdmRulService'],
  ordin:     ['ordin', '자치법규', 'OrdinService'],
  detc:      ['detc', '헌재결정례', 'DetcService'],
  expc:      ['expc', '법령해석례', 'ExpcService'],
  trty:      ['trty', '조약', 'TrtyService'],
  lsHistory: ['lsHistory', '연혁법령', 'law', '법령', 'LawService'],
};

function findRoot(json, target) {
  // target별 후보 키
  const keys = ROOT_KEYS[target] || [target];
  for (const k of keys) {
    if (json[k]) return json[k];
  }
  // 모든 후보 키 시도
  for (const vals of Object.values(ROOT_KEYS)) {
    for (const k of vals) {
      if (json[k]) return json[k];
    }
  }
  // 미등록 래퍼 흡수 — 응답이 객체 키 하나짜리 래퍼({"XxxService":{…}})면 그 값이 root.
  // 래퍼 이름이 바뀌거나 새 target 이 생겨도 파서가 따라간다(이름 나열에만 의존하지 않음).
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const outer = Object.keys(json).filter(k => k !== '_raw');
    if (outer.length === 1) {
      const inner = json[outer[0]];
      if (inner && typeof inner === 'object') return inner;
    }
  }
  return json;
}

function parseDetailResult(target, json) {
  const root = findRoot(json, target);

  if (target === 'law' || target === 'eflaw' || target === 'lsHistory') return parseLawDetail(root);
  if (target === 'prec') return parsePrecDetail(root);
  if (target === 'admrul') return parseAdmrulDetail(root);
  if (target === 'ordin') return parseOrdinDetail(root);
  if (target === 'detc') return parseDetcDetail(root);
  if (target === 'expc') return parseExpcDetail(root);
  if (target === 'trty') return parseTrtyDetail(root);

  return cleanObject(root);
}

// ── 법령 본문 ────────────────────────────────────────────────────────────────
function parseLawDetail(root) {
  // 배열로 감싸져 있는 경우 첫 번째 요소 사용
  const r = Array.isArray(root) ? root[0] : root;
  if (!r || typeof r !== 'object') return { error: '법령 본문 파싱 실패' };

  const info = {
    법령ID: r['법령ID'] || r['법령키'] || '',
    법령명: r['법령명_한글'] || r['법령명한글'] || r['법령명'] || '',
    법령명한자: r['법령명_한자'] || r['법령명한자'] || '',
    법령약칭: r['법령명약칭'] || r['법령약칭명'] || r['법령약칭'] || '',
    법종구분: r['법종구분'] || r['법종구분명'] || '',
    소관부처: r['소관부처'] || r['소관부처명'] || '',
    전화번호: r['전화번호'] || '',
    공포일자: r['공포일자'] || '',
    공포번호: r['공포번호'] || '',
    시행일자: r['시행일자'] || '',
    제개정구분: r['제개정구분'] || r['제개정구분명'] || '',
  };

  // 조문 — API가 { 조문: { 조문단위: [...] } } 또는 { 조문: [...] } 형태로 반환
  const rawJomun = r['조문'] || r['조문단위'] || r['조문내용'];
  const articles = toArray(
    rawJomun && typeof rawJomun === 'object' && !Array.isArray(rawJomun) && rawJomun['조문단위']
      ? rawJomun['조문단위']  // { 조문: { 조문단위: [...] } } 형태
      : rawJomun
  );
  if (articles.length > 0) {
    info.조문 = articles.map(a => {
      const art = {
        조문번호: a['조문번호'] || '',
        조문제목: a['조문제목'] || '',
        조문내용: a['조문내용'] || '',
        조문시행일자: a['조문시행일자'] || '',
      };
      // 항 — { 항: { 항배열: [...] } } 또는 { 항: [...] } 형태
      const rawHang = a['항'];
      const hangs = toArray(
        rawHang && typeof rawHang === 'object' && !Array.isArray(rawHang) && rawHang['항배열']
          ? rawHang['항배열']
          : rawHang
      );
      if (hangs.length > 0) {
        art.항 = hangs.map(h => {
          const hang = { 항번호: h['항번호'] || '', 항내용: h['항내용'] || '' };
          // 호
          const hos = toArray(h['호']);
          if (hos.length > 0) hang.호 = hos.map(ho => {
            const hoObj = { 호번호: ho['호번호'] || '', 호내용: ho['호내용'] || '' };
            // 목
            const moks = toArray(ho['목']);
            if (moks.length > 0) hoObj.목 = moks.map(m => ({ 목번호: m['목번호'] || '', 목내용: m['목내용'] || '' })).filter(m => m.목내용);
            return hoObj;
          }).filter(h => h.호내용);
          return hang;
        }).filter(h => h.항내용);
      }
      return art;
    }).filter(a => a.조문내용 || a.조문제목);
  }

  // 부칙
  const addenda = toArray(r['부칙']);
  if (addenda.length > 0 && addenda[0]) {
    info.부칙 = addenda.map(a => ({
      부칙공포일자: a['부칙공포일자'] || '',
      부칙공포번호: a['부칙공포번호'] || '',
      부칙내용: a['부칙내용'] || '',
    })).filter(a => a.부칙내용);
  }

  // 별표
  const tables = toArray(r['별표']);
  if (tables.length > 0 && tables[0]) {
    info.별표 = tables.map(t => ({
      별표번호: t['별표번호'] || '',
      별표구분: t['별표구분'] || '',
      별표제목: t['별표제목'] || '',
      별표내용: t['별표내용'] || '',
      별표HWP: t['별표서식파일링크'] || t['별표HWP파일명'] || '',
      별표PDF: t['별표서식PDF파일링크'] || t['별표PDF파일명'] || '',
    })).filter(t => t.별표제목 || t.별표내용);
  }

  // 개정문/제개정이유
  if (r['개정문내용']) info.개정문내용 = r['개정문내용'];
  if (r['제개정이유내용']) info.제개정이유내용 = r['제개정이유내용'];

  return cleanObject(info);
}

// ── 판례 본문 ────────────────────────────────────────────────────────────────
function parsePrecDetail(root) {
  return cleanObject({
    판례일련번호: root['판례정보일련번호'] || root['판례일련번호'] || '',
    사건명: root['사건명'] || '',
    사건번호: root['사건번호'] || '',
    선고일자: root['선고일자'] || '',
    선고: root['선고'] || '',
    법원명: root['법원명'] || '',
    법원종류코드: root['법원종류코드'] || '',
    사건종류명: root['사건종류명'] || '',
    판결유형: root['판결유형'] || '',
    판시사항: root['판시사항'] || '',
    판결요지: root['판결요지'] || '',
    참조조문: root['참조조문'] || '',
    참조판례: root['참조판례'] || '',
    판례내용: root['판례내용'] || root['전문'] || '',
  });
}

// ── 행정규칙 본문 ────────────────────────────────────────────────────────────
function parseAdmrulDetail(root) {
  const info = {
    행정규칙일련번호: root['행정규칙일련번호'] || '',
    행정규칙명: root['행정규칙명'] || '',
    행정규칙종류: root['행정규칙종류'] || '',
    발령일자: root['발령일자'] || '',
    발령번호: root['발령번호'] || '',
    제개정구분명: root['제개정구분명'] || '',
    행정규칙ID: root['행정규칙ID'] || '',
    소관부처명: root['소관부처명'] || '',
    담당부서기관명: root['담당부서기관명'] || '',
    담당자명: root['담당자명'] || '',
    전화번호: root['전화번호'] || '',
    시행일자: root['시행일자'] || '',
    현행여부: root['현행여부'] || '',
  };

  // 조문
  const articles = toArray(root['조문내용'] || root['조문']);
  if (articles.length > 0) {
    info.조문내용 = typeof articles[0] === 'string' ? articles[0] : articles.map(cleanObject);
  }

  // 부칙
  const addenda = toArray(root['부칙']);
  if (addenda.length > 0 && addenda[0]) {
    info.부칙 = addenda.map(a => ({
      부칙공포일자: a['부칙공포일자'] || '',
      부칙공포번호: a['부칙공포번호'] || '',
      부칙내용: a['부칙내용'] || '',
    })).filter(a => a.부칙내용);
  }

  return cleanObject(info);
}

// ── 자치법규 본문 ────────────────────────────────────────────────────────────
function parseOrdinDetail(root) {
  const info = {
    자치법규ID: root['자치법규ID'] || '',
    자치법규일련번호: root['자치법규일련번호'] || '',
    자치법규명: root['자치법규명'] || '',
    자치법규종류: root['자치법규종류'] || '',
    지자체기관명: root['지자체기관명'] || '',
    공포일자: root['공포일자'] || '',
    공포번호: root['공포번호'] || '',
    시행일자: root['시행일자'] || '',
    제개정구분: root['제개정구분'] || '',
    부서명: root['부서명'] || '',
    전화번호: root['전화번호'] || '',
  };

  const articles = toArray(root['조문'] || root['조문내용']);
  if (articles.length > 0) {
    info.조문 = articles.map(a => typeof a === 'string' ? a : ({
      조문번호: a['조문번호'] || '',
      조문제목: a['조문제목'] || '',
      조문내용: a['조문내용'] || '',
    })).filter(a => typeof a === 'string' ? a : (a.조문내용 || a.조문제목));
  }

  const addenda = toArray(root['부칙']);
  if (addenda.length > 0 && addenda[0]) {
    info.부칙 = addenda.map(a => ({
      부칙내용: a['부칙내용'] || (typeof a === 'string' ? a : ''),
    })).filter(a => a.부칙내용);
  }

  return cleanObject(info);
}

// ── 헌재결정례 본문 ──────────────────────────────────────────────────────────
function parseDetcDetail(root) {
  return cleanObject({
    헌재결정례일련번호: root['헌재결정례일련번호'] || '',
    사건명: root['사건명'] || '',
    사건번호: root['사건번호'] || '',
    종국일자: root['종국일자'] || '',
    사건종류명: root['사건종류명'] || '',
    재판부구분코드: root['재판부구분코드'] || '',
    판시사항: root['판시사항'] || '',
    결정요지: root['결정요지'] || '',
    참조조문: root['참조조문'] || '',
    참조판례: root['참조판례'] || '',
    심판대상조문: root['심판대상조문'] || '',
    전문: root['전문'] || '',
  });
}

// ── 법령해석례 본문 ──────────────────────────────────────────────────────────
function parseExpcDetail(root) {
  return cleanObject({
    법령해석례일련번호: root['법령해석례일련번호'] || '',
    안건명: root['안건명'] || '',
    안건번호: root['안건번호'] || '',
    해석일자: root['해석일자'] || '',
    해석기관명: root['해석기관명'] || '',
    질의기관명: root['질의기관명'] || '',
    질의요지: root['질의요지'] || '',
    회답: root['회답'] || '',
    이유: root['이유'] || '',
  });
}

// ── 조약 본문 ────────────────────────────────────────────────────────────────
function parseTrtyDetail(root) {
  return cleanObject({
    조약일련번호: root['조약일련번호'] || '',
    조약명한글: root['조약명한글'] || '',
    조약명영문: root['조약명영문'] || '',
    조약분류명: root['조약분류명'] || root['조약분류코드'] || '',
    발효일자: root['발효일자'] || '',
    서명일자: root['서명일자'] || '',
    조약번호: root['조약번호'] || '',
    관보게재일자: root['관보게재일자'] || '',
    국회비준동의여부: root['국회비준동의여부'] || '',
    조약대상국가한글: root['조약대상국가한글'] || '',
    양자조약분야명: root['양자조약분야명'] || '',
    다자조약분야명: root['다자조약분야명'] || '',
    조약내용: root['조약내용'] || '',
    비고: root['비고'] || '',
  });
}
