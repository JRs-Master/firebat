#!/usr/bin/env node
/**
 * Firebat 캘린더 sysmod — JSONL file-based.
 *
 * 저장: data/calendar/events.jsonl
 *   한 줄 = 한 이벤트 JSON. soft-delete (deletedAt 설정) — 추가만 빠르게 (파일 끝에 append).
 *   update = 기존 라인 → 새 라인 append (마지막이 우선). delete = deletedAt 추가한 라인 append.
 *
 * 필드:
 *   id (자동 생성), title, startAt, endAt, location, description, tags[], linkedJobId,
 *   createdAt, updatedAt, deletedAt?
 *
 * 통합 사용:
 *   - cron 의 linkedJobId 와 연결 (예: "상장일 매도" cron 잡 ID 참조)
 *   - sysmod_naver_search/dart 결과로 일정 add (공모주 일정 자동 등록)
 *   - sysmod_notes 와 chain (배정 정보 → 노트 동시 기록)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseInstantMs, parseDayMs, dayEndMs, renderWallClock, renderPinned,
         ZONE_FOLLOWS_SETTING } from '../_runtime/tz.mjs';

/** calendar 데이터 디렉토리 — input._hubScope 가 있으면 hub-scoped path 분기.
 *  - admin: `data/calendar/`
 *  - hub instance 단위 (옛 호환): `data/hub/<instance_id>/calendar/`
 *  - hub visitor 별 (`<instance_id>:<session_id>`): `data/hub/<instance_id>/<session_id>/calendar/` */
function resolveCalDir(hubScope) {
  // 진짜 부재 = admin (admin 은 _hubScope 를 보내지 않음).
  if (!hubScope || typeof hubScope !== 'string') return 'data/calendar';
  // hubScope 가 "있는데" 형식이 틀리면 admin 으로 폴백하지 말고 거부(throw). 옛 폴백이 조작된 session id
  // (예: 'a:b' 3-part / '..' / 64자 초과)로 admin 캘린더에 도달하던 cross-tenant root. deny 가 모든 경로를 닫음.
  const parts = hubScope.split(':');
  if (parts.length < 1 || parts.length > 2 || parts.some(p => !/^[a-zA-Z0-9_-]{1,64}$/.test(p))) {
    throw new Error('invalid _hubScope');
  }
  return parts.length === 1 ? `data/hub/${parts[0]}/calendar` : `data/hub/${parts[0]}/${parts[1]}/calendar`;
}

let CAL_DIR = 'data/calendar';
let EVENTS_FILE = join(CAL_DIR, 'events.jsonl');

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

/** i18n 에러 응답 — errorKey + errorParams. resolve_sysmod_error 가 module.calendar.{key} 로 변환. */
function outErr(key, params) {
  const r = { success: false, errorKey: key };
  if (params && Object.keys(params).length > 0) r.errorParams = params;
  process.stdout.write(JSON.stringify(r));
}

function ensureFile() {
  if (!existsSync(CAL_DIR)) mkdirSync(CAL_DIR, { recursive: true });
  if (!existsSync(EVENTS_FILE)) writeFileSync(EVENTS_FILE, '', 'utf-8');
}

function genId() {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** events.jsonl 읽고 id 별 최신 상태 (마지막 라인 우선) 반환합니다. soft-deleted 는 deletedAt 가 설정됩니다. */
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

/**
 * An entry's time, stored in the shape its rule needs.
 *
 * Pinned (the default) keeps an offset, so the instant survives a setting change untouched.
 * Following stores a bare wall clock, so every later read resolves it in whatever zone is in
 * force then — which is the whole request. Nothing else in the module has to know the difference:
 * `parseInstantMs` already reads an offset-bearing string at its word and a bare one in the
 * owner's zone, so both shapes compare and sort correctly with no branch.
 */
function storedTime(value, follows) {
  const at = parseInstantMs(value);
  if (at == null) return value;            // unreadable: keep what the caller wrote
  return follows ? renderWallClock(at) : renderPinned(at);
}

function isInRange(ev, fromMs, toMs) {
  // Instants, not text. The stored events carry an offset (`Z` or `+09:00`) and the bounds used to
  // be built as plain strings, so the comparison sorted by punctuation: `+` is 0x2B and `Z` is
  // 0x5A, which puts the same moment written two ways on the wrong sides of a boundary. Measured
  // 2026-08-06 — every stored event is UTC while a day range means Seoul, so a range query was off
  // by nine hours at both ends.
  const at = parseInstantMs(ev.startAt);
  // Unreadable rather than out of range: dropping it silently would answer "no events" for a
  // calendar that has one, which is the worse of the two wrong answers.
  if (at == null) return true;
  if (fromMs != null && at < fromMs) return false;
  if (toMs != null && at > toMs) return false;
  return true;
}

/** Chronological, with an unreadable timestamp sorted last rather than pretending to be 1970. */
function byStart(a, b) {
  const am = parseInstantMs(a.startAt);
  const bm = parseInstantMs(b.startAt);
  if (am == null && bm == null) return 0;
  if (am == null) return 1;
  if (bm == null) return -1;
  return am - bm;
}

function matchesTag(ev, tag) {
  if (!tag) return true;
  return Array.isArray(ev.tags) && ev.tags.includes(tag);
}

async function main() {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); }
  catch { return outErr('error.stdin_parse', {}); }

  const data = input.data ?? {};
  const { action } = data;
  const includeDeleted = data.includeDeleted === true;
  // hub 모드 — input.data._hubScope 가 있으면 데이터 디렉토리 분기.
  CAL_DIR = resolveCalDir(data._hubScope);
  EVENTS_FILE = join(CAL_DIR, 'events.jsonl');

  try {
    if (action === 'add') {
      if (!data.title) return outErr('error.add_title_required', {});
      if (!data.startAt) return outErr('error.add_startAt_required', {});
      const now = new Date().toISOString();
      const ev = {
        id: genId(),
        title: data.title,
        // The rule and the exception — see `storedTime`. Declared per entry so a recurring
        // "09:00 wherever I am" and a fixed "09:00 in Seoul" can sit in the same calendar.
        zone: data.zone === ZONE_FOLLOWS_SETTING ? ZONE_FOLLOWS_SETTING : null,
        startAt: storedTime(data.startAt, data.zone === ZONE_FOLLOWS_SETTING),
        endAt: data.endAt ? storedTime(data.endAt, data.zone === ZONE_FOLLOWS_SETTING) : null,
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
      if (!data.id) return outErr('error.update_id_required', {});
      const events = loadEvents();
      const ev = events.get(data.id);
      if (!ev || ev.deletedAt) return outErr('error.event_not_found', { id: data.id });
      const now = new Date().toISOString();
      const nextZone = data.zone === undefined
        ? (ev.zone ?? null)
        : (data.zone === ZONE_FOLLOWS_SETTING ? ZONE_FOLLOWS_SETTING : null);
      const follows = nextZone === ZONE_FOLLOWS_SETTING;
      const updated = {
        ...ev,
        title: data.title ?? ev.title,
        zone: nextZone,
        // Re-stored in the shape the (possibly just changed) rule needs — ticking the box on an
        // existing entry has to convert what is already there, not only govern the next write.
        startAt: storedTime(data.startAt ?? ev.startAt, follows),
        endAt: (data.endAt !== undefined ? data.endAt : ev.endAt)
          ? storedTime(data.endAt !== undefined ? data.endAt : ev.endAt, follows)
          : null,
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
      if (!data.id) return outErr('error.delete_id_required', {});
      const events = loadEvents();
      const ev = events.get(data.id);
      if (!ev) return outErr('error.event_not_found', { id: data.id });
      const now = new Date().toISOString();
      const deleted = { ...ev, deletedAt: now, updatedAt: now };
      appendEvent(deleted);
      return out(true, { deleted: true, id: data.id });
    }

    if (action === 'list-upcoming') {
      const days = data.days || 7;
      // "the next N days" is a span of instants, not a calendar boundary, so it is arithmetic on
      // the epoch and no zone is involved. Doing it with setDate/getDate would read the host's
      // clock for an answer that does not depend on it.
      const fromMs = Date.now();
      const toMs = fromMs + days * 86400000;
      const events = loadEvents();
      const items = [];
      for (const ev of events.values()) {
        if (!includeDeleted && ev.deletedAt) continue;
        if (!isInRange(ev, fromMs, toMs)) continue;
        if (!matchesTag(ev, data.tag)) continue;
        items.push(ev);
      }
      items.sort(byStart);
      return out(true, { items: items.slice(0, data.limit || 50), total: items.length });
    }

    if (action === 'list-range') {
      if (!data.fromTm || !data.toTm) return outErr('error.list_range_required', {});
      // A date a person types is midnight where they are, and the end of that day is its last
      // millisecond — computed as a date, because two days a year are 23 or 25 hours long.
      const fromMs = parseDayMs(data.fromTm);
      const toMs = dayEndMs(data.toTm);
      if (fromMs == null || toMs == null) {
        return outErr('error.list_range_required', {});
      }
      const events = loadEvents();
      const items = [];
      for (const ev of events.values()) {
        if (!includeDeleted && ev.deletedAt) continue;
        if (!isInRange(ev, fromMs, toMs)) continue;
        if (!matchesTag(ev, data.tag)) continue;
        items.push(ev);
      }
      items.sort(byStart);
      return out(true, { items: items.slice(0, data.limit || 50), total: items.length });
    }

    if (action === 'find') {
      const q = (data.query || '').toLowerCase();
      if (!q && !data.tag) return outErr('error.find_query_or_tag_required', {});
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
      items.sort(byStart);
      return out(true, { items: items.slice(0, data.limit || 50), total: items.length });
    }

    return outErr('error.unknown_action', { action: String(action) });
  } catch (e) {
    return outErr('error.runtime', { message: e?.message ?? String(e) });
  }
}

main();
