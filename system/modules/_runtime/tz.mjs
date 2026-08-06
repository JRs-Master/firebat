/**
 * The owner's clock, for a module that needs a wall clock.
 *
 * A module is a fresh process per pipeline step, so the zone it would read from the host is the
 * host's and has nothing to do with whose calendar the answer is for. The framework says which
 * zone in `FIREBAT_TZ`; this reads it. Nothing here asks the OS what zone it is in — which is
 * exactly what `new Date().getHours()` does, and why it is banned outside this file.
 *
 * Two rules, the same two the Rust side holds:
 *
 * 1. **Stored and compared in UTC** — `nowMs()` is epoch milliseconds, the same everywhere, with no
 *    offset to lose.
 * 2. **A calendar concept is resolved in the owner's zone** — "today", "the 5th", a daily limit are
 *    properties of a person's calendar, not of an instant. A *venue's* clock is a third thing and
 *    is not the owner's: see `partsIn`.
 *
 * `render()` writes RFC-3339 with the offset spelled out: `2026-08-03T23:41:12+09:00 (Asia/Seoul)`.
 * A bare `23:41` is the shape that caused the damage — it reads as local to whoever is looking. The
 * offset is *rendered*, never stored as the authority: `UTC+9` is a number and a zone is a rule, so
 * for any zone with daylight saving a stored offset is wrong half the year.
 */

const DEFAULT_TZ = 'Asia/Seoul';

/** The zone the framework said to use. */
export function zoneName() {
  const raw = (process.env['FIREBAT_TZ'] || process.env['TZ'] || '').trim();
  return raw || DEFAULT_TZ;
}

/** Epoch milliseconds. UTC by definition — no zone involved. */
export function nowMs() {
  return Date.now();
}

/**
 * The wall-clock parts in the owner's zone.
 *
 * `Intl` is the zone database every runtime already ships, so this needs no dependency and follows
 * daylight saving without a table of our own.
 */
/**
 * The wall-clock parts in a **named** zone, for a clock that is not the owner's.
 *
 * Three kinds of wall clock, and only the first belongs to the owner:
 *
 * - **the owner's calendar** — "today", "the 5th", a daily limit. `parts()` and friends.
 * - **a venue's schedule** — the weather service publishes at 02/05/08/… KST, an exchange opens at
 *   09:00 KST. That is a fact about the venue, not about whoever is asking: a hub user in New York
 *   reading Korean weather still needs the Seoul slot. This is the only entry point for that, and
 *   the module does its own converting from these parts — one primitive rather than a parallel
 *   family of zone-taking twins, so the specialness stays visible at the call site.
 * - **an instant** — UTC, and no zone is involved at all.
 *
 * Unifying the first two under "the user's timezone" is the trap: it looks tidy and silently picks
 * the wrong forecast the first time someone is not in Korea.
 */
export function partsIn(zone, ms = Date.now()) {
  return rawParts(zone, ms);
}

export function parts(ms = Date.now()) {
  return rawParts(zoneName(), ms);
}

function rawParts(zone, ms) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const got = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') got[p.type] = p.value;
  }
  // `hour12: false` still answers `24` at midnight in some runtimes.
  const hour = got.hour === '24' ? '00' : got.hour;
  return {
    year: Number(got.year), month: Number(got.month), day: Number(got.day),
    hour: Number(hour), minute: Number(got.minute), second: Number(got.second),
    ymd: `${got.year}-${got.month}-${got.day}`,
    ymdCompact: `${got.year}${got.month}${got.day}`,
    hh: hour, mm: got.minute, ss: got.second,
  };
}

/** The offset for that instant in the owner's zone, as `+09:00`. */
export function offset(ms = Date.now()) {
  return offsetIn(zoneName(), ms);
}

/** The offset for that instant in a named zone. Not exported: `parts()` carries what callers need. */
function offsetIn(zone, ms = Date.now()) {
  const p = rawParts(zone, ms);
  // The zone's wall clock read back as if it were UTC, minus the real instant, is the offset.
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const mins = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  const pad = (n) => String(n).padStart(2, '0');
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** `2026-08-03T23:41:12+09:00 (Asia/Seoul)` — unmisreadable by construction. */
export function render(ms = Date.now()) {
  const p = parts(ms);
  return `${p.ymd}T${p.hh}:${p.mm}:${p.ss}${offset(ms)} (${zoneName()})`;
}

/** The calendar date in the owner's zone, `YYYY-MM-DD`. */
export function todayYmd(ms = Date.now()) {
  return parts(ms).ymd;
}

/** `YYYYMMDD` — what most Korean venue APIs take. */
export function ymdCompact(ms = Date.now()) {
  return parts(ms).ymdCompact;
}

/** The hour of the wall clock in the owner's zone. */
export function hour(ms = Date.now()) {
  return parts(ms).hour;
}

/** Midnight of that instant's day in the owner's zone, as epoch ms. */
export function dayStartMs(ms = Date.now()) {
  const p = parts(ms);
  return dayStartOf(zoneName(), p.year, p.month, p.day);
}

/**
 * A date a person typed → midnight where they are, as epoch ms. `null` if unreadable.
 *
 * `activeUntil: 2026-08-05` means midnight in the owner's zone, not on the host.
 */
export function parseDayMs(text) {
  const m = /^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  return dayStartOf(zoneName(), Number(m[1]), Number(m[2]), Number(m[3]));
}

/** Add days to a calendar date in the owner's zone, answering `YYYY-MM-DD`. */
export function addDaysYmd(days, ms = Date.now()) {
  return todayYmd(dayStartMs(ms) + Math.round(days) * 86400000 + 12 * 3600000);
}

/**
 * A timestamp → the instant it names, as epoch ms. `null` if unreadable.
 *
 * The point is the string WITHOUT an offset. `2026-08-07T01:00:00` is a wall clock, and a wall
 * clock only means something once you say whose — so it is read in the owner's zone, the same rule
 * `parseDayMs` follows for a bare date. A string that carries `Z` or `+09:00` already names an
 * instant and is taken at its word.
 *
 * This exists because comparing these as TEXT looks like it works and does not: `+09:00` and `Z`
 * sort by their punctuation (`+` is 0x2B, `Z` is 0x5A), so the same moment written two ways
 * compares unequal in the wrong direction. Measured 2026-08-06 in the calendar module, where the
 * stored events are UTC and the range bounds were built as naive local text — a day's worth of
 * events fell in or out of "이번 주" by nine hours.
 */
export function parseInstantMs(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  // Offset spelled out (Z, +09:00, +0900) — unambiguous, and Date.parse handles all three.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
  }
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
  if (!m) {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
  }
  return wallTimeMs(
    zoneName(),
    Number(m[1]), Number(m[2]), Number(m[3]),
    Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0),
  );
}

/** The last millisecond of a calendar day in the owner's zone — the inclusive end of a range. */
export function dayEndMs(text) {
  const start = parseDayMs(text);
  if (start == null) return null;
  // Tomorrow's midnight minus one, computed as a date rather than +24h: a day is 23 or 25 hours
  // long twice a year, and this is exactly the boundary that would be off by an hour.
  const p = rawParts(zoneName(), start + 12 * 3600000);
  const next = dayStartOf(zoneName(), p.year, p.month, p.day + 1);
  return next - 1;
}

/**
 * Midnight for a calendar date in the owner's zone.
 *
 * Solved by correction rather than by a table: guess the instant as if the wall clock were UTC,
 * read what zone offset actually applies there, apply it, then check once more — the second pass
 * is what gets a date right when the offset itself changes that day (a clock going forward).
 */
function dayStartOf(zone, year, month, day) {
  return wallTimeMs(zone, year, month, day, 0, 0, 0);
}

/** The same correction, for any wall-clock time and not just midnight. */
function wallTimeMs(zone, year, month, day, hour, minute, second) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  for (let i = 0; i < 2; i += 1) {
    const p = rawParts(zone, guess);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const shift = asUtc - guess;                       // the offset in force at `guess`
    const next = target - shift;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}
