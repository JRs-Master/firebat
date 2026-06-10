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

/** notes 데이터 디렉토리 — input._hubScope 받으면 hub-scoped path 분기.
 *  - admin: `data/notes/`
 *  - hub instance 단위 (옛 호환, sid 빈 경우): `data/hub/<instance_id>/notes/`
 *  - hub visitor 별 격리 (`<instance_id>:<session_id>` 형태): `data/hub/<instance_id>/<session_id>/notes/`
 *  매 호출 시점 동적 결정 — _hubScope 영역 안 ':' 분리 / 영숫자·하이픈·언더스코어 가드. */
function resolveNotesDir(hubScope) {
  // 진짜 부재 = admin (admin 은 _hubScope 를 보내지 않음).
  if (!hubScope || typeof hubScope !== 'string') return 'data/notes';
  // hubScope 가 "있는데" 형식이 틀리면 admin 으로 폴백하지 말고 거부(throw). calendar 와 동일 admin-fallback root —
  // 조작된 session id 가 admin notes 에 도달하던 cross-tenant 누수. deny 가 sidebar·chat·FC·MCP 전 경로를 닫음.
  const parts = hubScope.split(':');
  if (parts.length < 1 || parts.length > 2 || parts.some(p => !/^[a-zA-Z0-9_-]{1,64}$/.test(p))) {
    throw new Error('invalid _hubScope');
  }
  return parts.length === 1 ? `data/hub/${parts[0]}/notes` : `data/hub/${parts[0]}/${parts[1]}/notes`;
}

let NOTES_DIR = 'data/notes';

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

/** i18n 에러 응답 — errorKey + errorParams. resolve_sysmod_error 가 module.notes.{key} 로 변환. */
function outErr(key, params) {
  const r = { success: false, errorKey: key };
  if (params && Object.keys(params).length > 0) r.errorParams = params;
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
  catch { return outErr('error.stdin_parse', {}); }

  const data = input.data ?? {};
  const { action } = data;
  // hub 모드 — input.data._hubScope 가 있으면 데이터 디렉토리 분기.
  NOTES_DIR = resolveNotesDir(data._hubScope);

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
      if (!data.slug) return outErr('error.read_slug_required', {});
      const fp = join(NOTES_DIR, `${sanitizeSlug(data.slug)}.md`);
      if (!existsSync(fp)) return outErr('error.note_not_found', { slug: data.slug });
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
      if (!data.slug) return outErr('error.delete_slug_required', {});
      const fp = join(NOTES_DIR, `${sanitizeSlug(data.slug)}.md`);
      if (!existsSync(fp)) return outErr('error.note_not_found', { slug: data.slug });
      unlinkSync(fp);
      return out(true, { deleted: true, slug: sanitizeSlug(data.slug) });
    }

    if (action === 'search') {
      const q = (data.query || '').toLowerCase();
      const tagFilter = data.tag || null;
      const limit = data.limit || 20;
      if (!q && !tagFilter) return outErr('error.search_query_or_tag_required', {});
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

    return outErr('error.unknown_action', { action: String(action) });
  } catch (e) {
    return outErr('error.runtime', { message: e?.message ?? String(e) });
  }
}

main();
