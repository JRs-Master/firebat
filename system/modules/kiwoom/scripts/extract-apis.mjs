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
import { writeFileSync, existsSync } from 'node:fs';
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
      id: apiId,
      name: apiName,
      method: method || 'POST',
      path: urlPath,
      category,
      subCategory,
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
      desc: (g || '').toString().trim().slice(0, 300),
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
writeFileSync(outPath, JSON.stringify(apis, null, 2), 'utf8');
console.log(`✓ ${outPath} — ${apis.length} APIs`);

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
