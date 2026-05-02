#!/usr/bin/env node
/**
 * Firebat 노트 sysmod — 마크다운 file-based.
 *
 * 저장: data/notes/<slug>.md
 *   frontmatter:
 *     ---
 *     title: ...
 *     tags: tag1, tag2
 *     createdAt: ISO
 *     updatedAt: ISO
 *     ---
 *     본문 마크다운...
 *
 * AI 자율 read/write. 외부 동기화 X (의도 — 자체 host 데이터).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const NOTES_DIR = 'data/notes';

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

function ensureDir() {
  if (!existsSync(NOTES_DIR)) mkdirSync(NOTES_DIR, { recursive: true });
}

function genSlug() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ymd}-${rand}`;
}

function sanitizeSlug(s) {
  return String(s).replace(/[^a-z0-9_\-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

/** frontmatter 파싱 — { title, tags[], createdAt, updatedAt } + content (frontmatter 뒤) */
function parseNote(raw) {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!fm) return { title: '', tags: [], createdAt: '', updatedAt: '', content: raw };
  const head = fm[1];
  const content = fm[2];
  const meta = { title: '', tags: [], createdAt: '', updatedAt: '' };
  for (const line of head.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'tags') meta.tags = val.split(',').map(t => t.trim()).filter(Boolean);
    else if (key in meta) meta[key] = val.trim();
  }
  return { ...meta, content };
}

function buildNoteContent({ title, tags, createdAt, updatedAt, content }) {
  const tagsLine = (tags || []).join(', ');
  return `---\ntitle: ${title || ''}\ntags: ${tagsLine}\ncreatedAt: ${createdAt}\nupdatedAt: ${updatedAt}\n---\n\n${content || ''}\n`;
}

async function main() {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); }
  catch { return out(false, undefined, 'stdin JSON 파싱 실패'); }

  const data = input.data ?? {};
  const { action } = data;

  ensureDir();

  try {
    if (action === 'list') {
      const tagFilter = data.tag || (Array.isArray(data.tags) && data.tags[0]) || null;
      const limit = data.limit || 20;
      const files = readdirSync(NOTES_DIR).filter(f => f.endsWith('.md'));
      const items = [];
      for (const f of files) {
        const fp = join(NOTES_DIR, f);
        const note = parseNote(readFileSync(fp, 'utf-8'));
        if (tagFilter && !note.tags.includes(tagFilter)) continue;
        items.push({
          slug: basename(f, '.md'),
          title: note.title,
          tags: note.tags,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          contentPreview: note.content.slice(0, 200),
        });
      }
      // 최신순 정렬
      items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      return out(true, { items: items.slice(0, limit), total: items.length });
    }

    if (action === 'read') {
      if (!data.slug) return out(false, undefined, 'read 는 slug 필요');
      const fp = join(NOTES_DIR, `${sanitizeSlug(data.slug)}.md`);
      if (!existsSync(fp)) return out(false, undefined, `노트 없음: ${data.slug}`);
      const note = parseNote(readFileSync(fp, 'utf-8'));
      return out(true, { note: { slug: sanitizeSlug(data.slug), ...note } });
    }

    if (action === 'write') {
      const slug = data.slug ? sanitizeSlug(data.slug) : genSlug();
      const fp = join(NOTES_DIR, `${slug}.md`);
      const now = new Date().toISOString();
      let existing = null;
      if (existsSync(fp)) existing = parseNote(readFileSync(fp, 'utf-8'));
      const noteData = {
        title: data.title ?? existing?.title ?? '',
        tags: Array.isArray(data.tags) ? data.tags : (existing?.tags ?? []),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        content: data.content ?? existing?.content ?? '',
      };
      writeFileSync(fp, buildNoteContent(noteData), 'utf-8');
      return out(true, { slug, ...noteData });
    }

    if (action === 'delete') {
      if (!data.slug) return out(false, undefined, 'delete 는 slug 필요');
      const fp = join(NOTES_DIR, `${sanitizeSlug(data.slug)}.md`);
      if (!existsSync(fp)) return out(false, undefined, `노트 없음: ${data.slug}`);
      unlinkSync(fp);
      return out(true, { deleted: true, slug: sanitizeSlug(data.slug) });
    }

    if (action === 'search') {
      const q = (data.query || '').toLowerCase();
      const tagFilter = data.tag || null;
      const limit = data.limit || 20;
      if (!q && !tagFilter) return out(false, undefined, 'search 는 query 또는 tag 필요');
      const files = readdirSync(NOTES_DIR).filter(f => f.endsWith('.md'));
      const items = [];
      for (const f of files) {
        const fp = join(NOTES_DIR, f);
        const note = parseNote(readFileSync(fp, 'utf-8'));
        if (tagFilter && !note.tags.includes(tagFilter)) continue;
        if (q) {
          const hay = `${note.title}\n${note.tags.join(' ')}\n${note.content}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }
        items.push({
          slug: basename(f, '.md'),
          title: note.title,
          tags: note.tags,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          contentPreview: note.content.slice(0, 200),
        });
      }
      items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      return out(true, { items: items.slice(0, limit), total: items.length });
    }

    return out(false, undefined, `알 수 없는 action: ${action}`);
  } catch (e) {
    return out(false, undefined, `예외: ${e?.message ?? String(e)}`);
  }
}

main();
