#!/usr/bin/env node
// gen-actions.mjs — _apis.json → actions.json (action catalog for search_module_actions).
// Writes ONLY actions.json (config.json untouched — the main gen.mjs owns that; this stays
// safe to re-run any time the API list changes). Entry shape consumed by
// core/src/managers/ai/action_catalog.rs: { id, name, description, domain, params:{name:desc} }.
// KIS params live in two locations (GET query vs POST body) — the key is prefixed
// ("query.FID_..." / "body.CANO") so the model knows exactly where each param goes; the
// envelope hint in config.json shows the overall call shape.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
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


// One sheet, two catalogs. The account/quotes split is expressed by each module's action enum, so
// that is what decides where an entry goes — a catalog listing an action its module cannot run
// sends the model to the wrong half and the call is refused (2026-08-03: every chart action was
// indexed under the trading module, so `search_module_actions` routed the daily chart to it).
writeSplit(MODULE_DIR, actions, 'korea-invest');

function writeSplit(dir, entries, label) {
  const halves = [dir, resolve(dir, '..', basename(dir).replace(/-trade$/, ''))];
  for (const half of halves) {
    let allowed;
    try {
      const cfg = JSON.parse(readFileSync(resolve(half, 'config.json'), 'utf8'));
      allowed = new Set(cfg.input.properties.action.enum);
    } catch {
      continue; // no such half — a broker that was never split
    }
    const mine = entries.filter((a) => allowed.has(a.id));
    writeFileSync(resolve(half, 'actions.json'), JSON.stringify(mine, null, 1), 'utf8');
    console.log(`${label} ${basename(half)}/actions.json — ${mine.length} actions`);
  }
}
