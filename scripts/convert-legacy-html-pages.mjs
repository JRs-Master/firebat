#!/usr/bin/env node
/**
 * Legacy 단일 Html 블록 페이지 → render_* 컴포넌트 배열 변환.
 *
 * CMS Phase 1 도입 전 cron-agent 가 발행한 옛 페이지의 spec.body 가
 * `[{type:'Html', props:{content:'<style>...<h1>...</h1>...</style>'}}]` 형태.
 * 이걸 `[{type:'Header'}, {type:'Text'}, {type:'Table'}, ...]` 형태로 변환.
 *
 * 콘텐츠 (텍스트·수치) 그대로 보존 — layout 만 새 패턴.
 *
 * 사용:
 *   node scripts/convert-legacy-html-pages.mjs <slug>
 *   node scripts/convert-legacy-html-pages.mjs --all  # stock-blog/2026-04-27-* 일괄
 *
 * 서버 환경 (data/app.db 있는 곳) 에서 실행.
 */
import Database from 'better-sqlite3';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import process from 'node:process';

const DB_PATH = process.env.FIREBAT_DB || path.resolve('data/app.db');

function elementToBlock(el) {
  const tag = el.tagName.toLowerCase();
  const text = (el.textContent || '').trim();

  // h1-h6 → Header
  const hMatch = tag.match(/^h([1-6])$/);
  if (hMatch) {
    return { type: 'Header', props: { text, level: parseInt(hMatch[1]) } };
  }

  // p → Text (마크다운 마커 보존: <strong>, <em> 등은 텍스트로 합침)
  if (tag === 'p') {
    if (!text) return null;
    return { type: 'Text', props: { content: text } };
  }

  // table → Table
  if (tag === 'table') {
    const rows = [...el.querySelectorAll('tr')];
    if (rows.length === 0) return null;
    const headerRow = rows[0];
    const headers = [...headerRow.querySelectorAll('th, td')].map(c => (c.textContent || '').trim());
    const dataRows = rows.slice(1).map(r => [...r.querySelectorAll('td')].map(c => (c.textContent || '').trim()));
    return { type: 'Table', props: { headers, rows: dataRows } };
  }

  // ul/ol → List
  if (tag === 'ul' || tag === 'ol') {
    const items = [...el.querySelectorAll('li')].map(li => (li.textContent || '').trim()).filter(Boolean);
    if (items.length === 0) return null;
    return { type: 'List', props: { items, ordered: tag === 'ol' } };
  }

  // hr → Divider
  if (tag === 'hr') {
    return { type: 'Divider', props: {} };
  }

  // div.callout / div.tip → Callout
  if (tag === 'div' && (el.classList.contains('callout') || el.classList.contains('tip'))) {
    if (!text) return null;
    return { type: 'Callout', props: { type: el.classList.contains('tip') ? 'tip' : 'info', message: text } };
  }

  // div.kpi / div.grid (KPI 카드 그룹) → Grid + Metric children
  if (tag === 'div' && (el.classList.contains('kpi') || el.classList.contains('grid'))) {
    const cards = [...el.querySelectorAll('.card, .kpi-card')];
    if (cards.length === 0) return null;
    const children = cards.map(c => {
      const lab = c.querySelector('.label, .lab')?.textContent?.trim() || '';
      const val = c.querySelector('.value, .val')?.textContent?.trim() || '';
      const delta = c.querySelector('.delta, .delta-up, .delta-down')?.textContent?.trim() || undefined;
      const deltaUp = c.querySelector('.delta-up') !== null;
      const deltaDown = c.querySelector('.delta-down') !== null;
      return {
        type: 'Metric',
        props: {
          label: lab,
          value: val,
          ...(delta ? { delta, deltaType: deltaUp ? 'up' : deltaDown ? 'down' : 'neutral' } : {}),
        },
      };
    });
    const cols = Math.min(cards.length, 4);
    return { type: 'Grid', props: { columns: cols, children } };
  }

  // div without specific class → 자식들 walk
  return null;
}

function htmlToBlocks(html) {
  const dom = new JSDOM(`<body>${html}</body>`);
  const doc = dom.window.document;
  const blocks = [];

  // top-level children walk (style/script 무시, 알려진 태그는 컴포넌트화, 나머지는 자식 재귀)
  function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue; // ELEMENT_NODE only
      const el = child;
      const tag = el.tagName.toLowerCase();
      if (tag === 'style' || tag === 'script') continue;

      const block = elementToBlock(el);
      if (block) {
        blocks.push(block);
        continue;
      }

      // 알려진 태그 매칭 안 됐고 자식이 있으면 재귀 (div wrapper 등)
      if (el.children.length > 0) {
        walk(el);
      } else if ((el.textContent || '').trim()) {
        // leaf 텍스트가 있으면 Text 로 잡음
        blocks.push({ type: 'Text', props: { content: (el.textContent || '').trim() } });
      }
    }
  }
  walk(doc.body);
  return blocks;
}

function convertPage(db, slug) {
  const row = db.prepare('SELECT spec FROM pages WHERE slug = ?').get(slug);
  if (!row) {
    console.error(`Page not found: ${slug}`);
    return false;
  }
  const spec = JSON.parse(row.spec);
  const body = spec.body || [];
  if (body.length !== 1 || body[0].type !== 'Html') {
    console.log(`${slug} — already migrated or not single-Html (${body.length} blocks, [0]=${body[0]?.type}). Skip.`);
    return false;
  }
  const html = body[0].props?.content || '';
  if (!html) {
    console.error(`${slug} — Html block has no content. Skip.`);
    return false;
  }
  const blocks = htmlToBlocks(html);
  if (blocks.length === 0) {
    console.error(`${slug} — conversion produced 0 blocks. Skip.`);
    return false;
  }
  spec.body = blocks;
  db.prepare('UPDATE pages SET spec = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?').run(JSON.stringify(spec), slug);
  console.log(`${slug} — converted: 1 Html → ${blocks.length} components (${blocks.map(b => b.type).join(', ')})`);
  return true;
}

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/convert-legacy-html-pages.mjs <slug> | --all');
  process.exit(1);
}

const db = new Database(DB_PATH);
let count = 0;

if (arg === '--all') {
  // stock-blog 의 단일 Html 페이지 전부 (4-28+ 새 페이지는 자동 skip — 이미 마이그레이션된 형태라 skip 처리)
  const rows = db.prepare("SELECT slug FROM pages WHERE slug LIKE 'stock-blog/%' ORDER BY slug").all();
  for (const r of rows) {
    if (convertPage(db, r.slug)) count++;
  }
} else {
  if (convertPage(db, arg)) count++;
}

db.close();
console.log(`\nDone. ${count} pages converted.`);
