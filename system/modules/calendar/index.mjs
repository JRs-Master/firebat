#!/usr/bin/env node
/**
 * Firebat 일정 sysmod — JSONL file-based.
 *
 * 저장: data/calendar/events.jsonl
 *   한 줄 = 한 이벤트 JSON. soft-delete (deletedAt 박힘) — 추가만 빠르게 (파일 끝에 append).
 *   update = 기존 라인 → 새 라인 append (마지막이 우선). delete = deletedAt 박은 라인 append.
 *
 * 필드:
 *   id (자동 생성), title, startAt, endAt, location, description, tags[], linkedJobId,
 *   createdAt, updatedAt, deletedAt?
 *
 * 통합 사용:
 *   - cron 의 linkedJobId 와 연결 (예: "상장일 매도" cron 잡 ID 박음)
 *   - sysmod_naver_search/dart 결과로 일정 add (공모주 일정 자동 등록)
 *   - sysmod_notes 와 chain (배정 정보 → 노트 동시 기록)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CAL_DIR = 'data/calendar';
const EVENTS_FILE = join(CAL_DIR, 'events.jsonl');

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

function ensureFile() {
  if (!existsSync(CAL_DIR)) mkdirSync(CAL_DIR, { recursive: true });
  if (!existsSync(EVENTS_FILE)) writeFileSync(EVENTS_FILE, '', 'utf-8');
}

function genId() {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** events.jsonl 읽고 id 별 최신 상태 (마지막 라인 우선) 반환. soft-deleted 는 deletedAt 박혀있음. */
function loadEvents() {
  ensureFile();
  const raw = readFileSync(EVENTS_FILE, 'utf-8');
  const byId = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.id) byId.set(ev.id, ev);
    } catch { /* 잘못된 라인 무시 */ }
  }
  return byId;
}

function appendEvent(ev) {
  appendFileSync(EVENTS_FILE, JSON.stringify(ev) + '\n', 'utf-8');
}

function isInRange(ev, fromIso, toIso) {
  // startAt 이 [from, to] 안에 있으면 true (단순 비교 — ISO 8601 lexicographic 가능)
  if (fromIso && ev.startAt < fromIso) return false;
  if (toIso && ev.startAt > toIso) return false;
  return true;
}

function matchesTag(ev, tag) {
  if (!tag) return true;
  return Array.isArray(ev.tags) && ev.tags.includes(tag);
}

async function main() {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); }
  catch { return out(false, undefined, 'stdin JSON 파싱 실패'); }

  const data = input.data ?? {};
  const { action } = data;
  const includeDeleted = data.includeDeleted === true;

  try {
    if (action === 'add') {
      if (!data.title) return out(false, undefined, 'add 는 title 필요');
      if (!data.startAt) return out(false, undefined, 'add 는 startAt 필요 (ISO 8601)');
      const now = new Date().toISOString();
      const ev = {
        id: genId(),
        title: data.title,
        startAt: data.startAt,
        endAt: data.endAt || null,
        location: data.location || null,
        description: data.description || null,
        tags: Array.isArray(data.tags) ? data.tags : [],
        linkedJobId: data.linkedJobId || null,
        createdAt: now,
        updatedAt: now,
      };
      appendEvent(ev);
      return out(true, { event: ev });
    }

    if (action === 'update') {
      if (!data.id) return out(false, undefined, 'update 는 id 필요');
      const events = loadEvents();
      const ev = events.get(data.id);
      if (!ev || ev.deletedAt) return out(false, undefined, `이벤트 없음: ${data.id}`);
      const now = new Date().toISOString();
      const updated = {
        ...ev,
        title: data.title ?? ev.title,
        startAt: data.startAt ?? ev.startAt,
        endAt: data.endAt !== undefined ? data.endAt : ev.endAt,
        location: data.location !== undefined ? data.location : ev.location,
        description: data.description !== undefined ? data.description : ev.description,
        tags: Array.isArray(data.tags) ? data.tags : ev.tags,
        linkedJobId: data.linkedJobId !== undefined ? data.linkedJobId : ev.linkedJobId,
        updatedAt: now,
      };
      appendEvent(updated);
      return out(true, { event: updated });
    }

    if (action === 'delete') {
      if (!data.id) return out(false, undefined, 'delete 는 id 필요');
      const events = loadEvents();
      const ev = events.get(data.id);
      if (!ev) return out(false, undefined, `이벤트 없음: ${data.id}`);
      const now = new Date().toISOString();
      const deleted = { ...ev, deletedAt: now, updatedAt: now };
      appendEvent(deleted);
      return out(true, { deleted: true, id: data.id });
    }

    if (action === 'list-upcoming') {
      const days = data.days || 7;
      const fromIso = new Date().toISOString();
      const toDate = new Date();
      toDate.setDate(toDate.getDate() + days);
      const toIso = toDate.toISOString();
      const events = loadEvents();
      const items = [];
      for (const ev of events.values()) {
        if (!includeDeleted && ev.deletedAt) continue;
        if (!isInRange(ev, fromIso, toIso)) continue;
        if (!matchesTag(ev, data.tag)) continue;
        items.push(ev);
      }
      items.sort((a, b) => a.startAt.localeCompare(b.startAt));
      return out(true, { items: items.slice(0, data.limit || 50), total: items.length });
    }

    if (action === 'list-range') {
      if (!data.fromTm || !data.toTm) return out(false, undefined, 'list-range 는 fromTm/toTm 필요 (ISO 일자 YYYY-MM-DD)');
      const fromIso = `${data.fromTm}T00:00:00`;
      const toIso = `${data.toTm}T23:59:59`;
      const events = loadEvents();
      const items = [];
      for (const ev of events.values()) {
        if (!includeDeleted && ev.deletedAt) continue;
        if (!isInRange(ev, fromIso, toIso)) continue;
        if (!matchesTag(ev, data.tag)) continue;
        items.push(ev);
      }
      items.sort((a, b) => a.startAt.localeCompare(b.startAt));
      return out(true, { items: items.slice(0, data.limit || 50), total: items.length });
    }

    if (action === 'find') {
      const q = (data.query || '').toLowerCase();
      if (!q && !data.tag) return out(false, undefined, 'find 는 query 또는 tag 필요');
      const events = loadEvents();
      const items = [];
      for (const ev of events.values()) {
        if (!includeDeleted && ev.deletedAt) continue;
        if (!matchesTag(ev, data.tag)) continue;
        if (q) {
          const hay = `${ev.title}\n${ev.description || ''}\n${(ev.tags || []).join(' ')}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }
        items.push(ev);
      }
      items.sort((a, b) => a.startAt.localeCompare(b.startAt));
      return out(true, { items: items.slice(0, data.limit || 50), total: items.length });
    }

    return out(false, undefined, `알 수 없는 action: ${action}`);
  } catch (e) {
    return out(false, undefined, `예외: ${e?.message ?? String(e)}`);
  }
}

main();
