#!/usr/bin/env node
/**
 * 한투 OPEN API 문서 (xlsx) → `_apis.json` metadata 추출.
 *
 * 입력 (gitignore — 사용자 본인 로컬 reference):
 *   - `한국투자증권_오픈API_전체문서_*.xlsx` (저장소 root 또는 본 모듈 디렉토리)
 *
 * 출력: `system/modules/korea-invest/_apis.json` (278 APIs)
 *
 * 사용:
 *   cd system/modules/korea-invest && node scripts/extract-apis.mjs
 */

import XLSX from 'xlsx';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = resolve(__dirname, '..');
const ROOT = resolve(MODULE_DIR, '..', '..', '..');

function findKisXlsx() {
  for (const dir of [MODULE_DIR, ROOT]) {
    try {
      const file = readdirSync(dir).find(f => /한국투자증권_오픈API.*\.xlsx$/.test(f));
      if (file) return resolve(dir, file);
    } catch {}
  }
  return null;
}

const xlsxPath = findKisXlsx();
if (!xlsxPath) {
  console.error('한국투자증권_오픈API_*.xlsx 가 없습니다. 저장소 root 또는 본 모듈 디렉토리에 두어야 합니다.');
  process.exit(1);
}

function extractKis() {
  const wb = XLSX.readFile(xlsxPath);
  const listWs = wb.Sheets['API 목록'];
  const listRows = XLSX.utils.sheet_to_json(listWs, { header: 1, defval: '' });

  const apis = [];
  for (let i = 1; i < listRows.length; i++) {
    const [, transport, menu, apiName, apiId, trIdReal, trIdMock, httpMethod, urlPath] = listRows[i];
    if (!apiId || !apiName) continue;
    if (transport !== 'REST') continue;

    const sheetName = wb.SheetNames.find((s) => s === apiName);
    let request = { header: [], body: [], query: [], path: [] };
    if (sheetName) {
      const detail = extractKisDetail(wb.Sheets[sheetName]);
      request = detail.request;
    }
    apis.push({
      id: apiId,
      name: apiName,
      method: (httpMethod || 'GET').toUpperCase(),
      path: urlPath,
      menu,
      trIdReal,
      trIdMock: trIdMock === '모의투자 미지원' ? null : trIdMock,
      request,
    });
  }
  return apis;
}

/**
 * 문서가 반복 파라미터를 범위 표기로 접어둔 것을 실제 이름으로 펼친다.
 *   `EXCD_01 ~ 10`          → EXCD_01 … EXCD_10
 *   `SRS_CD_02…` + `SRS_CD_32` → SRS_CD_02 … SRS_CD_32   (생략기호 다음의 마지막 값까지)
 * 접힌 표기를 그대로 두면 `get_action_schema` 가 `"EXCD_01 ~ 10"` 이라는 **보낼 수 없는**
 * 파라미터명을 모델에게 준다(실측 3건: 해외주식 복수종목 시세조회 / 해외선물-023 / -041).
 */
function expandRangeFields(fields) {
  const pad = (n, w) => String(n).padStart(w, '0');
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const nm = String(f.name).trim();

    // "BASE_01 ~ 10"
    let m = /^([A-Za-z_][A-Za-z0-9_]*)_(\d+)\s*~\s*(\d+)$/.exec(nm);
    if (m) {
      const [, base, from, to] = m;
      for (let k = +from; k <= +to; k++) out.push({ ...f, name: `${base}_${pad(k, from.length)}` });
      continue;
    }

    // "BASE_02…" / "BASE_02..." — 다음 항목이 같은 base 의 마지막 번호면 그 사이를 채운다.
    m = /^([A-Za-z_][A-Za-z0-9_]*)_(\d+)\s*(?:…|\.{2,})$/.exec(nm);
    if (m) {
      const [, base, from] = m;
      const next = fields[i + 1];
      const nm2 = next && new RegExp(`^${base}_(\\d+)$`).exec(String(next.name).trim());
      if (nm2) {
        for (let k = +from; k <= +nm2[1]; k++) out.push({ ...f, name: `${base}_${pad(k, from.length)}` });
        i++; // 마지막 항목까지 소비
        continue;
      }
      out.push({ ...f, name: `${base}_${from}` });
      continue;
    }

    out.push(f);
  }
  // 앞서 개별로 나온 이름(SRS_CD_01)과 전개분이 겹칠 수 있다.
  const seen = new Set();
  return out.filter((f) => (seen.has(f.name) ? false : seen.add(f.name)));
}

function extractKisDetail(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const header = [], body = [], query = [], path = [];
  let mode = '';
  let section = '';
  for (const row of rows) {
    const [a, b, c, d, e, f, g] = row;
    if (a === 'Layout') { mode = 'layout'; continue; }
    if (mode !== 'layout') continue;
    if (a === '구분') continue;
    const sectStr = (a || '').toString().toLowerCase();
    if (sectStr.startsWith('request header')) section = 'request-header';
    else if (sectStr.startsWith('request body')) section = 'request-body';
    else if (sectStr.startsWith('request query')) section = 'request-query';
    else if (sectStr.startsWith('request path')) section = 'request-path';
    else if (sectStr.startsWith('response')) section = 'response';
    if (!b) continue;
    if (section === 'response') continue;
    const field = {
      name: b,
      ko: (c || '').toString().trim(),
      type: (d || '').toString().trim(),
      required: e === 'Y',
      length: (f || '').toString().trim(),
      desc: (g || '').toString().trim().slice(0, 300),
    };
    if (section === 'request-header') header.push(field);
    else if (section === 'request-body') body.push(field);
    else if (section === 'request-query') query.push(field);
    else if (section === 'request-path') path.push(field);
  }
  return {
    request: {
      header: expandRangeFields(header),
      body: expandRangeFields(body),
      query: expandRangeFields(query),
      path: expandRangeFields(path),
    },
  };
}

const apis = extractKis();
const outPath = resolve(MODULE_DIR, '_apis.json');

// Reconciler, not a pure generator: `_apis.json` also carries entries that are NOT in the vendor's
// list sheet but are real endpoints we call (Hashkey). A plain rewrite would silently drop them —
// the same class of bug as the gen.mjs whitelist. Carry over every existing entry whose id the
// freshly extracted set does not contain.
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
const all = [...apis, ...carried];

writeFileSync(outPath, JSON.stringify(all, null, 2), 'utf8');
console.log(`✓ ${outPath} — ${all.length} APIs (문서 ${apis.length} + 손유지 ${carried.length})`);

const menus = {};
for (const api of apis) menus[api.menu] = (menus[api.menu] || 0) + 1;
console.log(`\n메뉴 (${Object.keys(menus).length}):`);
for (const [k, v] of Object.entries(menus).sort()) console.log(`  ${k}: ${v}`);
