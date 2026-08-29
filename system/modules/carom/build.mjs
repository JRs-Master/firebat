/**
 * build.mjs — fold the engine into one self-contained page.
 *
 * The published page is a single Html block, so physics/rules/ai have to travel inside it. They
 * are NOT authored there: the sources on disk are the original, this only inlines them, and
 * game.html is a generated file that nobody edits by hand.
 *
 * The engine lands twice on purpose — once as a live script for the page, once as text so the
 * AI worker can be built from a Blob without a second fetch. Both copies come out of the same
 * read, so they cannot drift; hand-maintaining the second copy is what would break.
 *
 *   node build.mjs        (writes game.html next to this file)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', '..');   // repo root, only used for the friendly log below

const PARTS = ['physics.js', 'rules.js', 'ai.js'];
const engine = PARTS.map(f => {
  const text = readFileSync(join(here, f), 'utf8');
  if (text.includes('</script')) {
    throw new Error(`${f} contains a closing script tag — it cannot be inlined verbatim`);
  }
  return `/* ── ${f} ─────────────────────────────────────────── */\n${text}`;
}).join('\n');

const TEMPLATE = process.env.CAROM_TEMPLATE || join(here, 'game.src.html');
let page = readFileSync(TEMPLATE, 'utf8');
if (!page.includes('<!--ENGINE-->')) throw new Error('template has no <!--ENGINE--> marker');

page = page.replace('<!--ENGINE-->',
  `<script>\n${engine}\n</script>\n` +
  `<script id="caromEngineSrc" type="text/plain">\n${engine}\n</script>`);

const out = join(here, 'game.html');
writeFileSync(out, page, 'utf8');

// The published artefact is a fragment that drops into a page's Html block. For local play and
// for the headless probe it needs a document around it — generated from the same string, so
// what gets tested is byte-for-byte what gets published.
const standalone = join(here, 'game.local.html');
writeFileSync(standalone, `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>당구</title>
<style>html,body{margin:0;height:100%;background:#07090b;overflow:hidden}</style>
</head><body>
${page}
</body></html>
`, 'utf8');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('engine  ' + PARTS.join(' + ') + '  = ' + kb(engine.length));
console.log('page    ' + kb(page.length) + '  ->  ' + out.replace(src + '\\', ''));
