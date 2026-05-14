#!/usr/bin/env node
/**
 * 키움 / 한투 OPEN API 문서 (xlsx) → JSON metadata 추출.
 *
 * Phase Stock-Split S1 (2026-05-14):
 * 옛 단일 sysmod_kiwoom (151 actions) + sysmod_korea_invest (277 actions) 의
 * action enum 폭발 → 도메인별 sysmod 분리 codegen 의 input.
 *
 * 입력 xlsx (gitignore — 로컬 reference):
 *   - 키움 REST API 문서.xlsx       — "API 리스트" 시트 + 각 API ID 별 sub-sheet
 *   - 한국투자증권_오픈API_전체문서_*.xlsx  — "API 목록" 시트 + 각 API 명 별 sub-sheet
 *
 * 출력:
 *   - infra/data/stock-apis-kiwoom.json
 *   - infra/data/stock-apis-kis.json
 *
 * 각 entry:
 *   { id, name, method, path, category, subCategory, request: { header, body, query, path } }
 */

import XLSX from 'xlsx';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─────────────────────────────────────────────────────────────────
// 키움 — "API 리스트" 7열 (No, API ID, API 명, 대분류, 중분류, URL, 바로가기)
// ─────────────────────────────────────────────────────────────────
function extractKiwoom() {
  const wb = XLSX.readFile(resolve(ROOT, '키움 REST API 문서.xlsx'));
  const listWs = wb.Sheets['API 리스트'];
  const listRows = XLSX.utils.sheet_to_json(listWs, { header: 1, defval: '' });

  const apis = [];
  // row 1 = header, row 2+ = data
  for (let i = 2; i < listRows.length; i++) {
    const [no, apiId, apiName, category, subCategory, urlPath] = listRows[i];
    if (!apiId || !apiName) continue;
    // 시트 이름 = "{API명}({API ID})". XLSX 가 sheet 이름 31자 cap 으로 자르는 경우 있음.
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
      method: method || 'POST', // 키움 기본 POST
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
  let mode = ''; // 'request' / 'response'
  let section = ''; // 'Header' / 'Body' / 'Query' / 'Path'
  for (const row of rows) {
    const [a, b, c, d, e, f, g] = row;
    if (a === 'Method' && c) method = c;
    if (a === 'Request') { mode = 'request'; continue; }
    if (a === 'Response') { mode = 'response'; continue; }
    if (mode !== 'request') continue;
    if (a === '구분') continue;
    if (a === 'Header' || a === 'Body' || a === 'Query' || a === 'Path') section = a;
    const sect = a || section;
    if (!b) continue; // empty element
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

// ─────────────────────────────────────────────────────────────────
// 한투 — "API 목록" 12열 (순번, API 통신방식, 메뉴 위치, API 명, API ID, 실전 TR_ID, ...)
// ─────────────────────────────────────────────────────────────────
function extractKis() {
  const wb = XLSX.readFile(resolve(ROOT, '한국투자증권_오픈API_전체문서_20260415_030007.xlsx'));
  const listWs = wb.Sheets['API 목록'];
  const listRows = XLSX.utils.sheet_to_json(listWs, { header: 1, defval: '' });

  const apis = [];
  // row 0 = header, row 1+ = data
  for (let i = 1; i < listRows.length; i++) {
    const [no, transport, menu, apiName, apiId, trIdReal, trIdMock, httpMethod, urlPath] = listRows[i];
    if (!apiId || !apiName) continue;
    // REST 만 추출 (WEBSOCKET 은 별도 transport — 후속 phase)
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
      menu, // 예: "[국내주식] 주문/계좌"
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
    // 한투 구분: 'Request Header' / 'Request Body' / 'Request Query Parameter' / 'Request Path' /
    //          'Response Header' / 'Response Body Output' / ...
    const sectStr = (a || '').toString().toLowerCase();
    if (sectStr.startsWith('request header')) section = 'request-header';
    else if (sectStr.startsWith('request body')) section = 'request-body';
    else if (sectStr.startsWith('request query')) section = 'request-query';
    else if (sectStr.startsWith('request path')) section = 'request-path';
    else if (sectStr.startsWith('response')) section = 'response';
    // empty section continuation rows use blank a — keep current section
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

// ─────────────────────────────────────────────────────────────────
function writeJson(filename, data) {
  const outPath = resolve(ROOT, 'infra/data', filename);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`✓ ${filename} — ${data.length} APIs`);
}

const kiwoomApis = extractKiwoom();
writeJson('stock-apis-kiwoom.json', kiwoomApis);

const kisApis = extractKis();
writeJson('stock-apis-kis.json', kisApis);

// 분류 통계
const kiwoomCats = new Set();
const kiwoomSubs = {};
for (const api of kiwoomApis) {
  kiwoomCats.add(api.category);
  const key = `${api.category} > ${api.subCategory}`;
  kiwoomSubs[key] = (kiwoomSubs[key] || 0) + 1;
}
console.log(`\n키움 대분류: ${[...kiwoomCats].join(', ')}`);
console.log(`키움 중분류 (${Object.keys(kiwoomSubs).length}):`);
for (const [k, v] of Object.entries(kiwoomSubs).sort()) console.log(`  ${k}: ${v}`);

const kisMenus = {};
for (const api of kisApis) {
  kisMenus[api.menu] = (kisMenus[api.menu] || 0) + 1;
}
console.log(`\n한투 메뉴 (${Object.keys(kisMenus).length}):`);
for (const [k, v] of Object.entries(kisMenus).sort()) console.log(`  ${k}: ${v}`);
