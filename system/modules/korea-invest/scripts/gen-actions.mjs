#!/usr/bin/env node
// gen-actions.mjs — _apis.json → actions.json (action catalog for search_module_actions).
// Writes ONLY actions.json (config.json untouched — the main gen.mjs owns that; this stays
// safe to re-run any time the API list changes). Entry shape consumed by
// core/src/managers/ai/action_catalog.rs: { id, name, description, domain, params:{name:desc} }.
// KIS params live in two locations (GET query vs POST body) — the key is prefixed
// ("query.FID_..." / "body.CANO") so the model knows exactly where each param goes; the
// envelope hint in config.json shows the overall call shape.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apis = JSON.parse(readFileSync(resolve(MODULE_DIR, '_apis.json'), 'utf8'));

// actions-overrides.json — hand-maintained semantic corrections merged over the generated
// entries (survives regeneration; kiwoom gen-actions mirror). Shape:
// { "<actionId>": { description?, params?: {name: desc} } }. Params merge per-key
// (override wins); other keys replace. Used to seed search synonyms on confusion clusters
// (차트/일봉/시세 — 2026-07-12 실측: 대상명 오염 쿼리에서 정답 액션이 top-K 밖).
let overrides = {};
try {
  overrides = JSON.parse(readFileSync(resolve(MODULE_DIR, 'actions-overrides.json'), 'utf8'));
} catch { /* no overrides file — generate as-is */ }

const cap = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

const actions = apis
  .filter(a => a.id && a.name)
  .map(a => {
    const params = {};
    for (const [loc, list] of [['query', a.request?.query ?? []], ['body', a.request?.body ?? []]]) {
      for (const p of list) {
        if (!p.name) continue;
        const label = p.ko || p.name;
        const req = p.required ? ' (필수)' : '';
        const desc = p.desc ? ' — ' + cap(p.desc, 80) : '';
        params[`${loc}.${p.name}`] = `${label}${req}${desc}`;
      }
    }
    const entry = {
      id: a.id,
      name: a.name,
      description: cap(a.name, 60),
      domain: a.menu || '',
      method: a.method || undefined,
      path: a.path || undefined,
      trId: a.trIdReal || undefined,
      params,
    };
    const ov = overrides[a.id];
    if (ov) {
      for (const [k, v] of Object.entries(ov)) {
        if (k === 'params' && v && typeof v === 'object') {
          entry.params = { ...entry.params, ...v };
        } else {
          entry[k] = v;
        }
      }
    }
    return entry;
  });

writeFileSync(resolve(MODULE_DIR, 'actions.json'), JSON.stringify(actions, null, 1), 'utf8');
console.log(`korea-invest actions.json — ${actions.length} actions`);
