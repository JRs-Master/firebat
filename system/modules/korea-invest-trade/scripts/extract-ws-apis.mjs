#!/usr/bin/env node
/**
 * 한투 OPEN API 문서 (xlsx) → `_ws_apis.json` (WEBSOCKET 스펙 레퍼런스).
 *
 * 입력 (gitignore — 사용자 본인 로컬 reference):
 *   - `한국투자증권_오픈API_전체문서_*.xlsx` (저장소 root 또는 본 모듈 디렉토리)
 * 출력: `system/modules/korea-invest/_ws_apis.json`
 *
 * 사용: cd system/modules/korea-invest && node scripts/extract-ws-apis.mjs
 *   (xlsx 는 dev 전용 — `npm install --no-save xlsx` 후 실행)
 *
 * ⚠️ TR_ID 의 신뢰 소스 = **urlPath** (`/tryitout/<TR_ID>`), 목록 시트의 `실전 TR_ID` 열이
 * 아니다. 한투 문서 원본의 목록 시트에 오타가 있다(2026-07-09 판 기준 2건):
 *     실시간-053 일반채권 실시간호가        열=H0BJCNT0  → 실제 H0BJASP0
 *     실시간-067 KRX야간옵션실시간체결통보  열=H0MFCNI0  → 실제 H0EUCNI0
 * 그대로 믿으면 서로 다른 두 API 가 같은 trId 를 갖게 되고, 하위 codegen 이 이를 "중복"으로
 * 병합해 스트림 2개를 조용히 삭제한다(실측). 불일치는 경고로 출력하되 urlPath 를 채택한다.
 *
 * 실시간 프레임 디코드는 `responseBody` 의 **필드 순서**에 전적으로 의존하므로
 * (adapter 가 `^` 로 split 해 순서대로 매핑) 상세 시트의 Response 순서를 보존한다.
 */

import XLSX from 'xlsx';
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = resolve(__dirname, '..');
const ROOT = resolve(MODULE_DIR, '..', '..', '..');

function findXlsx() {
  for (const dir of [MODULE_DIR, ROOT]) {
    try {
      const f = readdirSync(dir).find((x) => /한국투자증권_오픈API.*\.xlsx$/.test(x));
      if (f) return resolve(dir, f);
    } catch {}
  }
  return null;
}

const xlsxPath = findXlsx();
if (!xlsxPath) {
  console.error('한국투자증권_오픈API_*.xlsx 가 없습니다.');
  process.exit(1);
}

const wb = XLSX.readFile(xlsxPath);

/** 진짜 필드명만 통과 (시트 하단의 요청/응답 "예시" JSON 블록이 B열에 통째로 들어있다). */
const isFieldName = (s) => /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(String(s).trim());

/** 문서의 예시 output 프레임(`^` 구분)에서 필드 개수를 센다 — responseBody 길이 역검증용. */
function exampleFieldCount(rows) {
  for (const row of rows) {
    for (const cell of row) {
      const s = String(cell ?? '');
      if (!s.includes('# output')) continue;
      const body = s.split('# output')[1] || '';
      // 예시는 줄바꿈으로 접혀 있다 — 공백/개행 제거 후 ^ 로 센다.
      const flat = body.replace(/[\r\n\s]/g, '');
      if (!flat.includes('^')) continue;
      return flat.split('^').length;
    }
  }
  return null;
}

/** Request/Response 필드를 순서 보존해 추출. Response 순서 = positional 디코드의 필드 순서. */
function extractDetail(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const requestHeader = [], requestBody = [], responseBody = [];
  let mode = '', section = '';
  for (const row of rows) {
    const [a, b, c, d, e, f, g] = row;
    if (a === 'Layout') { mode = 'layout'; continue; }
    if (mode !== 'layout') continue;
    if (a === '구분') continue;
    const s = (a || '').toString().toLowerCase();
    if (s.startsWith('request header')) section = 'req-header';
    else if (s.startsWith('request body')) section = 'req-body';
    else if (s.startsWith('response')) section = 'response';
    if (!b || !isFieldName(b)) continue;
    const field = {
      name: String(b).trim(),
      ko: (c || '').toString().trim(),
      type: (d || '').toString().trim(),
      required: e === 'Y',
      length: (f || '').toString().trim(),
      desc: (g || '').toString().trim().slice(0, 300),
    };
    if (section === 'req-header') requestHeader.push(field);
    else if (section === 'req-body') requestBody.push(field);
    else if (section === 'response') responseBody.push(field);
  }
  return { requestHeader, requestBody, responseBody, exampleFields: exampleFieldCount(rows) };
}

const listRows = XLSX.utils.sheet_to_json(wb.Sheets['API 목록'], { header: 1, defval: '' });
const apis = [];
const warnings = [];
const fieldCountMismatch = [];
let verified = 0;

for (let i = 1; i < listRows.length; i++) {
  const [, transport, menu, name, id, trListed, trMock, method, urlPath, domainReal, domainMock] =
    listRows[i];
  if (transport !== 'WEBSOCKET' || !name) continue;

  // TR_ID: urlPath 가 진실. `/tryitout/<TR>` 이 없으면(OAuth Approval 등) 목록 값을 쓴다.
  const m = /\/tryitout\/([A-Z0-9]+)/.exec(String(urlPath || ''));
  const trFromUrl = m ? m[1] : null;
  const listed = String(trListed || '').trim();
  if (trFromUrl && listed && trFromUrl !== listed) {
    warnings.push(`${id} | ${name} | 목록시트 TR_ID=${listed} → urlPath 채택 ${trFromUrl}`);
  }
  const trIdReal = trFromUrl || listed;

  const sheet = wb.Sheets[name];
  const detail = sheet
    ? extractDetail(sheet)
    : { requestHeader: [], requestBody: [], responseBody: [], exampleFields: null };
  // 역검증: 문서의 예시 output 프레임 필드 수 == responseBody 길이여야 positional 매핑이 맞다.
  const { exampleFields, ...fields } = detail;
  if (exampleFields != null && exampleFields !== fields.responseBody.length) {
    fieldCountMismatch.push(
      `${id} | ${name} | responseBody=${fields.responseBody.length} vs 예시프레임=${exampleFields}`
    );
  } else if (exampleFields != null) {
    verified++;
  }

  apis.push({
    id,
    name,
    menu,
    trIdReal,
    trIdMock: String(trMock || '').trim(),
    method: (method || 'POST').toUpperCase(),
    // 원본 셀에 선행 공백이 섞여 있다(실측: 실시간-003 H0STCNT0 / 실시간-005 H0STCNI0 의
    // domainReal 이 " ws://…"). trim 안 하면 ws:// 필터가 그 둘을 조용히 떨어뜨린다.
    domainReal: String(domainReal || '').trim(),
    domainMock: String(domainMock || '').trim(),
    urlPath: String(urlPath || '').trim(),
    ...fields,
  });
}

// 무결성: ws:// 스트림들의 trId 는 유일해야 한다 (병합 은폐 방지).
const streams = apis.filter((a) => a.domainReal.startsWith('ws://'));
const seen = new Map();
const dups = [];
for (const a of streams) {
  if (seen.has(a.trIdReal)) dups.push(`${a.trIdReal}: ${seen.get(a.trIdReal)} ↔ ${a.name}`);
  else seen.set(a.trIdReal, a.name);
}

const out = {
  meta: {
    source: `${xlsxPath.split(/[\\/]/).pop()} (WEBSOCKET APIs)`,
    note: '한투 실시간(웹소켓) 스펙. TR_ID 는 urlPath(/tryitout/<TR>)에서 추출 — 목록 시트 열은 오타가 있다.',
    approvalKey:
      'POST /oauth2/Approval {grant_type:client_credentials, appkey, secretkey} → approval_key(286자). 구독 요청 header 에 사용.',
    realtimeDecode:
      '실시간 프레임 = "암호화플래그|TR_ID|건수|데이터". 플래그 0=평문/1=AES256(구독 응답 body.output.iv+key 로 복호). 데이터는 ^ 구분 positional → responseBody 순서대로 매핑. 건수 N = 레코드 N개 연접.',
    subscribe:
      'header{approval_key,custtype(B법인/P개인),tr_type(1등록/2해제),content-type} + body{input:{tr_id, tr_key}}',
    count: apis.length,
    streamCount: streams.length,
  },
  apis,
};
writeFileSync(resolve(MODULE_DIR, '_ws_apis.json'), JSON.stringify(out, null, 1) + '\n', 'utf8');

console.log(`_ws_apis.json: ${apis.length} APIs (ws:// streams ${streams.length}, unique trId ${seen.size})`);
if (warnings.length) {
  console.log('\n⚠️ 목록시트 TR_ID 오타 → urlPath 로 교정:');
  for (const w of warnings) console.log('  ' + w);
}
if (dups.length) {
  console.error('\n❌ 스트림 trId 중복 — codegen 이 병합해 스트림을 삭제한다:');
  for (const d of dups) console.error('  ' + d);
  process.exit(1);
}
console.log('\n✅ 스트림 trId 유일성 검증 통과');

// responseBody 길이 vs 문서 예시 프레임의 `^` 필드 수.
// ⚠️ 경고일 뿐 게이트가 아니다 — 실측 결과 두 소스 다 부분적으로 틀리다:
//   국내주식 실시간호가: responseBody 62 정답 / 예시 59 구버전(중간가 3필드 누락)
//   국내지수 예상체결  : responseBody 30 오염(체결 스펙 복붙) / 예시 15 정답
//   KRX야간선물 호가   : responseBody 38 부족 / 예시 46
// 그래서 adapter 는 field_order 길이를 믿지 않고 프레임의 `건수`로 레코드 폭을 계산한다
// (`decode_positional`). 여기서는 사람이 볼 수 있게 드리프트를 남기기만 한다.
console.log(`\n예시 프레임 대조: 일치 ${verified}건 / 드리프트 ${fieldCountMismatch.length}건`);
if (fieldCountMismatch.length) {
  console.log('⚠️ responseBody 길이 ≠ 예시 프레임 필드 수 (문서 자체의 불일치 — adapter 가 건수로 보정):');
  for (const m of fieldCountMismatch) console.log('  ' + m);
}
