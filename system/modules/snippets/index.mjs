#!/usr/bin/env node
/**
 * Firebat snippets sysmod — a named store for visual code snippets collected
 * from the web: GLSL shaders (Shadertoy-style), canvas 2D pieces, ECharts
 * options, self-contained HTML embeds.
 *
 * The module only stores and serves. Nothing here executes the code — the
 * consumer is the published page's browser (Html block wrappers, see the
 * visual-snippets skill). That is why a node-stdlib module is enough: no
 * renderer, no npm dependencies, no browser on the server.
 *
 * Credit fields (author/source/license) are first-class on purpose: much of
 * the prettiest web code is CC BY-NC-SA (Shadertoy default), which is fine
 * for this operator's personal pages but must carry attribution.
 *
 * Storage: data/snippets/<name>.json — one file per snippet, the JSON is the
 * original (no derived copies anywhere).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
         unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'data/snippets';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const KINDS = ['glsl', 'canvas', 'echarts', 'html'];
const CODE_MAX = 200_000;
const META_MAX = 500;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', c => { data += c.toString('utf-8'); });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function out(success, data, error) {
  const r = { success };
  if (data !== undefined) r.data = data;
  if (error) r.error = error;
  process.stdout.write(JSON.stringify(r));
}

const fileOf = (name) => join(DIR, `${name}.json`);

function readOne(name) {
  try {
    return JSON.parse(readFileSync(fileOf(name), 'utf-8'));
  } catch {
    return null;
  }
}

function listAll() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => readOne(f.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function metaStr(v, field) {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (s.length > META_MAX) throw new Error(`${field} exceeds ${META_MAX} chars`);
  return s || undefined;
}

function rowOf(s) {
  return { name: s.name, kind: s.kind, author: s.author, license: s.license,
           note: s.note, chars: s.chars, updatedAt: s.updatedAt };
}

function actionAdd(inp) {
  const name = String(inp.name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    return out(false, undefined,
      'name must be a lowercase slug (a-z, 0-9, dashes), max 48 chars');
  }
  const kind = String(inp.kind || '').trim().toLowerCase();
  if (!KINDS.includes(kind)) {
    return out(false, undefined, `kind must be one of ${KINDS.join(' | ')}`);
  }
  const code = String(inp.code || '');
  if (!code.trim()) return out(false, undefined, 'code is required');
  if (code.length > CODE_MAX) {
    return out(false, undefined, `code exceeds ${CODE_MAX} chars`);
  }
  const existing = readOne(name);
  if (existing && !inp.overwrite) {
    return out(false, undefined,
      `snippet '${name}' already exists (${existing.kind}, ${existing.chars} chars)` +
      ' — pass overwrite:true to replace it, or pick another name');
  }
  const now = Date.now();
  const rec = {
    name, kind, code, chars: code.length,
    author: metaStr(inp.author, 'author'),
    source: metaStr(inp.source, 'source'),
    license: metaStr(inp.license, 'license') || 'unknown',
    note: metaStr(inp.note, 'note'),
    addedAt: existing ? existing.addedAt : now,
    updatedAt: now,
  };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(fileOf(name), JSON.stringify(rec, null, 2));
  return out(true, {
    saved: rowOf(rec),
    next: 'to put it on a page, read the visual-snippets skill (get_skill) — ' +
          'it has the Html-block wrapper for each kind and the credit rule',
  });
}

function actionList(inp) {
  const q = String(inp.query || '').trim().toLowerCase();
  const kind = String(inp.kind || '').trim().toLowerCase();
  let items = listAll();
  if (kind) items = items.filter(s => s.kind === kind);
  if (q) {
    items = items.filter(s =>
      [s.name, s.note, s.author].some(v => (v || '').toLowerCase().includes(q)));
  }
  const limit = Math.max(1, Math.min(100, Number(inp.limit) || 50));
  return out(true, { items: items.slice(0, limit).map(rowOf), total: items.length });
}

function actionGet(inp) {
  const name = String(inp.name || '').trim().toLowerCase();
  const rec = readOne(name);
  if (!rec) {
    const names = listAll().map(s => s.name).slice(0, 20);
    return out(false, undefined,
      `no snippet named '${name}' — list shows what is stored` +
      (names.length ? ` (${names.join(', ')})` : ' (the store is empty)'));
  }
  return out(true, { snippet: rec });
}

function actionRemove(inp) {
  const name = String(inp.name || '').trim().toLowerCase();
  if (!existsSync(fileOf(name))) {
    return out(false, undefined, `no snippet named '${name}'`);
  }
  unlinkSync(fileOf(name));
  return out(true, { removed: name });
}

function actionSelftest() {
  const checks = [];
  const ck = (name, want, got, ok) => checks.push({ name, want, got, ok });
  const tmp = 'selftest-tmp-snippet';
  try {
    // capture out() output instead of writing the envelope mid-test
    const grab = (fn, inp) => {
      const w = process.stdout.write.bind(process.stdout);
      let buf = '';
      process.stdout.write = (s) => { buf += s; return true; };
      try { fn(inp); } finally { process.stdout.write = w; }
      return JSON.parse(buf);
    };
    let r = grab(actionAdd, { name: tmp, kind: 'glsl',
      code: 'void mainImage(out vec4 o, in vec2 u){o=vec4(u/iResolution.xy,0.5+0.5*sin(iTime),1);}',
      author: 'selftest', license: 'CC0', note: 'test gradient' });
    ck('add stores a glsl snippet', 'success', JSON.stringify(r.success), r.success === true);
    r = grab(actionAdd, { name: tmp, kind: 'glsl', code: 'x' });
    ck('add without overwrite refuses a duplicate', 'refusal naming overwrite',
       String(r.error || ''), r.success === false && /overwrite/.test(r.error || ''));
    r = grab(actionList, { query: 'gradient' });
    ck('list finds it by note substring', '1 hit', String(r.data?.items?.length),
       r.success === true && (r.data.items || []).some(s => s.name === tmp));
    r = grab(actionGet, { name: tmp });
    ck('get returns code and credit', 'code + license CC0',
       `${r.data?.snippet?.license}/${r.data?.snippet?.chars}ch`,
       r.success === true && r.data.snippet.license === 'CC0'
         && /mainImage/.test(r.data.snippet.code));
    r = grab(actionAdd, { name: 'BAD NAME', kind: 'glsl', code: 'x' });
    ck('a non-slug name is refused', 'refusal', String(r.error || ''), r.success === false);
    r = grab(actionAdd, { name: 'k', kind: 'flash', code: 'x' });
    ck('an unknown kind is refused', 'refusal', String(r.error || ''), r.success === false);
    r = grab(actionRemove, { name: tmp });
    ck('remove deletes it', 'removed', JSON.stringify(r.data), r.success === true);
    r = grab(actionGet, { name: tmp });
    ck('get after remove points at list', 'not found', String(r.error || '').slice(0, 40),
       r.success === false);
  } catch (e) {
    ck('selftest crashed', 'no exception', `${e.constructor.name}: ${e.message}`, false);
  }
  const failed = checks.filter(c => !c.ok).length;
  return out(failed === 0, { total: checks.length, failed, checks });
}

const HANDLERS = {
  add: actionAdd, list: actionList, get: actionGet, remove: actionRemove,
  selftest: actionSelftest,
};

async function main() {
  let inp;
  try {
    inp = JSON.parse(await readStdin());
  } catch {
    return out(false, undefined, 'stdin must be one JSON object');
  }
  const action = String(inp.action || (Object.keys(HANDLERS).length === 1 ? 'add' : '')).trim();
  const h = HANDLERS[action];
  if (!h) {
    return out(false, undefined,
      `unknown action '${action}' — one of ${Object.keys(HANDLERS).join(', ')}`);
  }
  try {
    return h(inp);
  } catch (e) {
    return out(false, undefined, `${e.constructor.name}: ${e.message}`);
  }
}

main();
