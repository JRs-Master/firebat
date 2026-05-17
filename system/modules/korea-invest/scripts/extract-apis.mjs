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
import { readdirSync, writeFileSync } from 'node:fs';
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
  console.error('한국투자증권_오픈API_*.xlsx 가 없습니다. 저장소 root 또는 본 모듈 디렉토리에 위치 박혀야 함.');
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
  return { request: { header, body, query, path } };
}

const apis = extractKis();
const outPath = resolve(MODULE_DIR, '_apis.json');
writeFileSync(outPath, JSON.stringify(apis, null, 2), 'utf8');
console.log(`✓ ${outPath} — ${apis.length} APIs`);

const menus = {};
for (const api of apis) menus[api.menu] = (menus[api.menu] || 0) + 1;
console.log(`\n메뉴 (${Object.keys(menus).length}):`);
for (const [k, v] of Object.entries(menus).sort()) console.log(`  ${k}: ${v}`);
