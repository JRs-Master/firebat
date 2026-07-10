#!/usr/bin/env node
// Dev-only codegen — derive config `ws.streams` (58 → 56 unique) from `_ws_apis.json` so the
// full 한투 realtime TR family is wired 1:1 with the doc (no cherry-picking). config.json is
// the module source; this reconciler keeps the ws-level fields (endpoint/frameFormat/token/…)
// and every non-ws block, replacing only ws.streams. Run: `node scripts/gen-ws-streams.mjs`.
//
// field_order is NOT emitted here — module.rs extracts it at runtime from _ws_apis.json by trId.
// decrypt is attached only to notification TRs (name includes 통보 = flag-1 AES256); 시세 = 평문.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const moduleDir = join(here, '..');
const spec = JSON.parse(readFileSync(join(moduleDir, '_ws_apis.json'), 'utf8'));
const config = JSON.parse(readFileSync(join(moduleDir, 'config.json'), 'utf8'));

const wsApis = spec.apis.filter((a) => String(a.domainReal || '').startsWith('ws://'));

// Asset prefix (checked longest-first so "지수선물" wins over "지수").
const ASSET = [
  ['해외선물옵션', 'overseas-fo'],
  ['해외주식', 'overseas'],
  ['KRX야간선물', 'night-futures'],
  ['KRX야간옵션', 'night-options'],
  ['지수선물', 'index-futures'],
  ['지수옵션', 'index-options'],
  ['주식선물', 'stock-futures'],
  ['주식옵션', 'stock-options'],
  ['상품선물', 'commodity-futures'],
  ['일반채권', 'bond'],
  ['채권지수', 'bond-index'],
  ['국내지수', 'index'],
  ['국내ETF', 'etf'],
  ['ELW', 'elw'],
  // Must come after the specific 지수선물/주식선물/상품선물/야간 entries so they win.
  ['선물옵션', 'futures-options'],
  ['국내주식', ''], // stock = default, category stands alone
];

// Category (checked in order; specific combos first).
const CATEGORY = [
  ['시간외', '예상체결', 'afterhours-expected'],
  ['시간외', '호가', 'afterhours-orderbook'],
  ['시간외', '체결', 'afterhours-trade'],
  [null, '주문내역통보', 'order-notify'],
  [null, '체결내역통보', 'exec-notify'],
  [null, '체결통보', 'exec-notify'],
  [null, '주문통보', 'order-notify'],
  [null, 'NAV추이', 'nav'],
  [null, '장운영정보', 'market-op'],
  [null, '예상체결', 'expected'],
  [null, '프로그램매매', 'program'],
  [null, '회원사', 'member'],
  [null, '지연호가', 'delayed-orderbook'],
  [null, '지연체결', 'delayed-trade'],
  [null, '호가', 'orderbook'],
  [null, '종목체결', 'trade'],
  [null, '체결가', 'trade'],
  [null, '체결', 'trade'],
];

function exchange(name) {
  if (/\(KRX\)/.test(name)) return 'krx';
  if (/\(NXT\)/.test(name)) return 'nxt';
  if (/\(통합\)/.test(name)) return 'unified';
  return '';
}

function assetOf(name) {
  for (const [ko, slug] of ASSET) if (name.includes(ko)) return slug;
  return '';
}

function categoryOf(name) {
  for (const [pre, word, slug] of CATEGORY) {
    if (pre && !name.includes(pre)) continue;
    if (name.includes(word)) return slug;
  }
  return '';
}

function slug(name) {
  const asset = assetOf(name);
  const cat = categoryOf(name);
  const ex = exchange(name);
  return [asset, cat, ex].filter(Boolean).join('-') || null;
}

const streams = {};
const seenTr = new Set();
const used = new Map(); // slug → count (collision → append trId)

for (const a of wsApis) {
  const trId = a.trIdReal;
  if (!trId || seenTr.has(trId)) continue; // dedup dup-trId doc entries
  seenTr.add(trId);

  let key = slug(a.name) || trId.toLowerCase();
  if (used.has(key)) key = `${key}-${trId.toLowerCase()}`; // guarantee uniqueness
  used.set(key, 1);

  const trIdMock = a.trIdMock && /^H/.test(a.trIdMock) ? a.trIdMock : null;
  const trKeyDesc = ((a.requestBody || []).find((b) => b.name === 'tr_key')?.desc || '')
    .replace(/\r?\n/g, ' ')
    .trim();
  const isNotify = /통보/.test(a.name); // flag-1 AES256 (account private)

  const header = (trType) => ({
    approval_key: '{TOKEN}',
    custtype: 'P',
    tr_type: trType,
    'content-type': 'utf-8',
  });
  const body = { input: { tr_id: '{TR_ID}', tr_key: '{key}' } };
  // {TR_ID} is a literal placeholder substituted below (real value baked per stream).
  const withTr = (o) => JSON.parse(JSON.stringify(o).replace(/\{TR_ID\}/g, trId));

  const entry = {
    trId,
    ...(trIdMock ? { trIdMock } : {}),
    realtimeMatch: trId,
    desc: a.name,
    keyDesc: trKeyDesc,
    subscribe: {
      frame: { header: header('1'), body: withTr(body) },
      match: trId,
      successWhen: { field: 'body.rt_cd', equals: '0' },
    },
    unsubscribe: { frame: { header: header('2'), body: withTr(body) } },
  };
  if (isNotify) entry.decrypt = { ivField: 'body.output.iv', keyField: 'body.output.key' };
  streams[key] = entry;
}

config.ws = config.ws || {};
config.ws.streams = streams;

writeFileSync(join(moduleDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');

const notifyCount = Object.values(streams).filter((s) => s.decrypt).length;
console.log(`ws.streams generated: ${Object.keys(streams).length} unique (${notifyCount} AES notify)`);
console.log('keys:', Object.keys(streams).join(' '));
