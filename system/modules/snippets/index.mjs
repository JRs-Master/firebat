#!/usr/bin/env node
/**
 * Firebat snippets sysmod — a named store for visual code snippets collected
 * from the web: GLSL shaders (Shadertoy-style), canvas 2D pieces, ECharts
 * options, self-contained HTML embeds.
 *
 * Storage is stdlib-only. Rendering exists for ONE kind: `canvas` snippets
 * following the draw(ctx, t, w, h) contract render server-side through
 * @napi-rs/canvas (a browserless Skia canvas — the module's declared npm
 * package) into PNG stills and sprite-sheet grids for documents and motion
 * scenes. glsl/echarts/html snippets still run only in the published page's
 * browser (Html block wrappers, see the visual-snippets skill).
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

// ── server rendering (canvas kind) ──────────────────────────────────────────

const OUT_DIR = join(DIR, 'out');

async function canvasEngine() {
  try {
    return await import('@napi-rs/canvas');
  } catch {
    throw new Error(
      "canvas engine not installed — install this module's packages " +
      '(@napi-rs/canvas) from the module settings screen, then retry');
  }
}

function drawFnOf(code) {
  let fn;
  try {
    fn = new Function(`${code}\n;return typeof draw === 'function' ? draw : null;`)();
  } catch (e) {
    throw new Error(`snippet code failed to evaluate: ${e.message}`);
  }
  if (typeof fn !== 'function') {
    throw new Error(
      'the snippet does not define draw(ctx, t, w, h) — server rendering runs that ' +
      'contract. Adapt the code to it at add time; pieces that own their own ' +
      'rAF loop stay page-only (kind html).');
  }
  return fn;
}

function parseSize(v, dw, dh, cap) {
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(String(v || '').trim());
  const w = m ? Number(m[1]) : dw, h = m ? Number(m[2]) : dh;
  if (w < 16 || h < 16 || w > cap || h > cap) {
    throw new Error(`size must be 16..${cap} per side, got ${w}x${h}`);
  }
  return [w, h];
}

function codeFor(inp) {
  if (inp.code) return { code: String(inp.code), name: 'inline' };
  const name = String(inp.name || '').trim().toLowerCase();
  const rec = readOne(name);
  if (!rec) throw new Error(`no snippet named '${name}' — list shows what is stored`);
  if (rec.kind !== 'canvas') {
    throw new Error(
      `'${name}' is kind ${rec.kind} — server rendering is canvas-only; ` +
      'glsl/echarts/html run in the page browser (visual-snippets skill)');
  }
  return { code: rec.code, name };
}

function saveOut(buf, base) {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${base}-${Date.now().toString(36)}.png`)
    .replace(/\\/g, '/');
  writeFileSync(path, buf);
  return path;
}

async function actionRender(inp) {
  const { createCanvas } = await canvasEngine();
  const { code, name } = codeFor(inp);
  const [w, h] = parseSize(inp.size, 512, 512, 2048);
  const t = Number(inp.t) || 0;
  const fn = drawFnOf(code);
  const cv = createCanvas(w, h);
  fn(cv.getContext('2d'), t, w, h);
  const path = saveOut(cv.toBuffer('image/png'), `snippet-${name}`);
  return out(true, {
    width: w, height: h, t,
    _mediaImport: { path, contentType: 'image/png', filenameHint: `snippet-${name}` },
  });
}

async function actionSheet(inp) {
  const { createCanvas } = await canvasEngine();
  const { code, name } = codeFor(inp);
  const grid = inp.grid;
  if (!(Array.isArray(grid) && grid.length === 2)) {
    throw new Error('grid must be [cols, rows] — same field the motion spritesheet layer takes');
  }
  const cols = Math.floor(Number(grid[0])), rows = Math.floor(Number(grid[1]));
  if (!(cols >= 1 && rows >= 1) || cols * rows > 64 || cols > 16 || rows > 16) {
    throw new Error('grid is capped at 16 per side and 64 cells total');
  }
  const fps = Math.min(60, Math.max(1, Number(inp.fps) || 12));
  const [cw, ch] = parseSize(inp.cell, 256, 256, 512);
  if (cols * cw > 4096 || rows * ch > 4096) {
    throw new Error(`the sheet would be ${cols * cw}x${rows * ch} — keep it within 4096`);
  }
  const fn = drawFnOf(code);
  const count = cols * rows;
  const sheet = createCanvas(cols * cw, rows * ch);
  const sctx = sheet.getContext('2d');
  const cell = createCanvas(cw, ch);
  const cctx = cell.getContext('2d');
  for (let i = 0; i < count; i++) {
    cctx.clearRect(0, 0, cw, ch);
    cctx.save();
    fn(cctx, i / fps, cw, ch);
    cctx.restore();
    sctx.drawImage(cell, (i % cols) * cw, Math.floor(i / cols) * ch);
  }
  const path = saveOut(sheet.toBuffer('image/png'), `sheet-${name}`);
  return out(true, {
    grid: [cols, rows], fps, frames: count, cell: `${cw}x${ch}`,
    seconds: count / fps,
    next: 'use it in a motion scene as layer ' +
          `{kind:'spritesheet', media:'<imported media path>', grid:[${cols},${rows}], fps:${fps}}`,
    _mediaImport: { path, contentType: 'image/png', filenameHint: `sheet-${name}` },
  });
}

async function actionSelftest() {
  const checks = [];
  const ck = (name, want, got, ok) => checks.push({ name, want, got, ok });
  const tmp = 'selftest-tmp-snippet';
  try {
    // capture out() output instead of writing the envelope mid-test; a thrown
    // refusal becomes the same envelope main() would have written
    const grab = async (fn, inp) => {
      const w = process.stdout.write.bind(process.stdout);
      let buf = '';
      process.stdout.write = (s) => { buf += s; return true; };
      try {
        await fn(inp);
      } catch (e) {
        buf = JSON.stringify({ success: false, error: `${e.constructor.name}: ${e.message}` });
      } finally {
        process.stdout.write = w;
      }
      return JSON.parse(buf);
    };
    let r = await grab(actionAdd, { name: tmp, kind: 'glsl',
      code: 'void mainImage(out vec4 o, in vec2 u){o=vec4(u/iResolution.xy,0.5+0.5*sin(iTime),1);}',
      author: 'selftest', license: 'CC0', note: 'test gradient' });
    ck('add stores a glsl snippet', 'success', JSON.stringify(r.success), r.success === true);
    r = await grab(actionAdd, { name: tmp, kind: 'glsl', code: 'x' });
    ck('add without overwrite refuses a duplicate', 'refusal naming overwrite',
       String(r.error || ''), r.success === false && /overwrite/.test(r.error || ''));
    r = await grab(actionList, { query: 'gradient' });
    ck('list finds it by note substring', '1 hit', String(r.data?.items?.length),
       r.success === true && (r.data.items || []).some(s => s.name === tmp));
    r = await grab(actionGet, { name: tmp });
    ck('get returns code and credit', 'code + license CC0',
       `${r.data?.snippet?.license}/${r.data?.snippet?.chars}ch`,
       r.success === true && r.data.snippet.license === 'CC0'
         && /mainImage/.test(r.data.snippet.code));
    r = await grab(actionAdd, { name: 'BAD NAME', kind: 'glsl', code: 'x' });
    ck('a non-slug name is refused', 'refusal', String(r.error || ''), r.success === false);
    r = await grab(actionAdd, { name: 'k', kind: 'flash', code: 'x' });
    ck('an unknown kind is refused', 'refusal', String(r.error || ''), r.success === false);
    r = await grab(actionRemove, { name: tmp });
    ck('remove deletes it', 'removed', JSON.stringify(r.data), r.success === true);
    r = await grab(actionGet, { name: tmp });
    ck('get after remove points at list', 'not found', String(r.error || '').slice(0, 40),
       r.success === false);

    let engine = true;
    try { await import('@napi-rs/canvas'); } catch { engine = false; }
    if (engine) {
      const CODE = 'function draw(ctx,t,w,h){' +
        'ctx.fillStyle="rgb("+Math.min(255,Math.round(t*60))+",80,200)";' +
        'ctx.fillRect(0,0,w,h);}';
      r = await grab(actionRender, { code: CODE, t: 1, size: '64x64' });
      const p1 = r.data?._mediaImport?.path;
      ck('render bakes an inline canvas snippet to PNG', 'PNG on disk', String(p1),
         r.success === true && !!p1
           && readFileSync(p1).slice(1, 4).toString() === 'PNG');
      r = await grab(actionSheet, { code: CODE, grid: [4, 2], fps: 4, cell: '32x32' });
      const p2 = r.data?._mediaImport?.path;
      ck('sheet bakes a frame grid the motion layer can loop', '8 frames',
         `${r.data?.frames} frames, ${String(p2)}`,
         r.success === true && r.data?.frames === 8 && !!p2 && existsSync(p2));
      if (p1 && existsSync(p1)) unlinkSync(p1);
      if (p2 && existsSync(p2)) unlinkSync(p2);
      r = await grab(actionRender, { code: 'const x = 1;', size: '64x64' });
      ck('code without draw() is refused with the contract named',
         'draw(ctx, t, w, h) in the error', String(r.error || '').slice(0, 60),
         r.success === false && /draw\(ctx/.test(r.error || ''));
    } else {
      ck('canvas engine roundtrip (skipped — @napi-rs/canvas not installed here)',
         'skip', 'not installed', true);
    }
  } catch (e) {
    ck('selftest crashed', 'no exception', `${e.constructor.name}: ${e.message}`, false);
  }
  const failed = checks.filter(c => !c.ok).length;
  return out(failed === 0, { total: checks.length, failed, checks });
}

const HANDLERS = {
  add: actionAdd, list: actionList, get: actionGet, remove: actionRemove,
  render: actionRender, sheet: actionSheet,
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
    return await h(inp);
  } catch (e) {
    return out(false, undefined, `${e.constructor.name}: ${e.message}`);
  }
}

main();
