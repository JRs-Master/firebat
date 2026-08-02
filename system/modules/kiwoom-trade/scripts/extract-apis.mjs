#!/usr/bin/env node
/**
 * 키움 OPEN API 문서 (xlsx) → `_apis.json` metadata 추출.
 *
 * 입력 (gitignore — 사용자 본인 로컬 reference):
 *   - `키움 REST API 문서.xlsx` (저장소 root 또는 본 모듈 디렉토리)
 *
 * 출력: `system/modules/kiwoom/_apis.json` (208 APIs)
 *
 * 사용:
 *   cd system/modules/kiwoom && node scripts/extract-apis.mjs
 *
 * 옛 위치: `scripts/extract-stock-apis.mjs` 안 kiwoom + kis 통합 코드.
 * 단일 책임 정공 — sysmod 자체 안 자체 codegen.
 */

import XLSX from 'xlsx';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = resolve(__dirname, '..');
const ROOT = resolve(MODULE_DIR, '..', '..', '..');

const XLSX_CANDIDATES = [
  resolve(MODULE_DIR, '키움 REST API 문서.xlsx'),
  resolve(ROOT, '키움 REST API 문서.xlsx'),
];
const xlsxPath = XLSX_CANDIDATES.find(existsSync);
if (!xlsxPath) {
  console.error('키움 REST API 문서.xlsx 가 없습니다. 후보:');
  XLSX_CANDIDATES.forEach(p => console.error(`  - ${p}`));
  process.exit(1);
}

function extractKiwoom() {
  const wb = XLSX.readFile(xlsxPath);
  const listWs = wb.Sheets['API 리스트'];
  const listRows = XLSX.utils.sheet_to_json(listWs, { header: 1, defval: '' });

  const apis = [];
  for (let i = 2; i < listRows.length; i++) {
    const [, apiId, apiName, category, subCategory, urlPath] = listRows[i];
    if (!apiId || !apiName) continue;
    // REST/WS-action IDs only (ka/kt/au/usa/ust + digits). The "API 리스트" 시트에는 실시간
    // 타입코드(00·0B·F4…)와 "공통"(오류코드 시트) 행도 섞여 있는데, 이들은 REST API 가 아니라
    // config.ws typeCodes 소속이라 _apis.json 에 들어가면 안 된다. 걸러내지 않으면 regen 이
    // 24개 쓰레기를 도로 집어넣어 커밋 상태를 재현하지 못한다(오염).
    if (!/^(ka|kt|au|usa|ust)\d+$/.test(String(apiId).trim())) continue;
    const fullName = `${apiName}(${apiId})`;
    const sheetName = wb.SheetNames.find((s) => s === fullName || s.includes(apiId));
    let request = { header: [], body: [], query: [], path: [] };
    let method = '';
    if (sheetName) {
      const detail = extractKiwoomDetail(wb.Sheets[sheetName]);
      method = detail.method;
      request = detail.request;
    }
    apis.push({
      id: String(apiId).trim(),
      name: String(apiName).trim(),
      method: method || 'POST',
      path: String(urlPath || '').trim(),
      category: String(category || '').trim(),
      subCategory: String(subCategory || '').trim(),
      request,
    });
  }
  return apis;
}

function extractKiwoomDetail(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  let method = '';
  const header = [], body = [], query = [], path = [];
  let mode = '';
  let section = '';
  for (const row of rows) {
    const [a, b, c, d, e, f, g] = row;
    if (a === 'Method' && c) method = c;
    if (a === 'Request') { mode = 'request'; continue; }
    if (a === 'Response') { mode = 'response'; continue; }
    if (mode !== 'request') continue;
    if (a === '구분') continue;
    if (a === 'Header' || a === 'Body' || a === 'Query' || a === 'Path') section = a;
    const sect = a || section;
    if (!b) continue;
    const field = {
      name: b,
      ko: (c || '').toString().trim(),
      type: (d || '').toString().trim(),
      required: e === 'Y',
      length: (f || '').toString().trim(),
      // CRLF→LF 정규화 — xlsx 셀은 CRLF 를 담는데, 정규화하지 않으면 desc 안 \r\n 때문에
      // 내용이 같아도 재실행마다 diff 가 난다(재현 불가). 커밋본은 LF 로 정규화돼 있다.
      desc: (g || '').toString().replace(/\r\n?/g, '\n').trim().slice(0, 300),
    };
    if (sect === 'Header') header.push(field);
    else if (sect === 'Body') body.push(field);
    else if (sect === 'Query') query.push(field);
    else if (sect === 'Path') path.push(field);
  }
  return { method, request: { header, body, query, path } };
}

const apis = extractKiwoom();
const outPath = resolve(MODULE_DIR, '_apis.json');

// Reconciler, not a pure generator: `_apis.json` carries hand-kept entries the vendor's list sheet
// dropped but we still call (ka10009 — the doc removed its row but the endpoint is live). A plain
// rewrite would silently lose them. Carry over every existing entry the fresh extract lacks.
let carried = [];
try {
  const existing = JSON.parse(readFileSync(outPath, 'utf8'));
  const list = Array.isArray(existing) ? existing : existing.apis || [];
  const fresh = new Set(apis.map((a) => String(a.id)));
  carried = list.filter((a) => !fresh.has(String(a.id)));
} catch { /* first bootstrap */ }
if (carried.length) {
  console.log(`  (reconcile) 문서에 없는 손유지 엔트리 보존: ${carried.map((a) => a.id).join(', ')}`);
}
// 결정적 순서 — id 정렬. 추출기가 시트 순서를 그대로 쓰면 재실행마다 순서가 흔들려(손유지
// 엔트리는 뒤에 붙고 시트 편집 시 행이 밀림) 내용이 같아도 거대한 재정렬 diff 가 난다.
// id 로 정렬하면 재실행이 바이트 단위로 재현된다(내용 무관 = 룩업 테이블이라 순서는 자유).
const all = [...apis, ...carried].sort((a, b) => String(a.id).localeCompare(String(b.id)));

writeFileSync(outPath, JSON.stringify(all, null, 2), 'utf8');
console.log(`✓ ${outPath} — ${all.length} APIs (문서 ${apis.length} + 손유지 ${carried.length})`);

const cats = new Set();
const subs = {};
for (const api of apis) {
  cats.add(api.category);
  const key = `${api.category} > ${api.subCategory}`;
  subs[key] = (subs[key] || 0) + 1;
}
console.log(`\n대분류: ${[...cats].join(', ')}`);
console.log(`중분류 (${Object.keys(subs).length}):`);
for (const [k, v] of Object.entries(subs).sort()) console.log(`  ${k}: ${v}`);
