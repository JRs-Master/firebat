/** One ordering for every list of names in the app.
 *
 * `localeCompare('ko')` alone puts Hangul before Latin, which is the opposite of what Windows
 * Explorer does and therefore the opposite of what the lists here are expected to look like. So
 * the script is bucketed explicitly — digits, then Latin, then Hangul, then everything else — and
 * ordering inside a bucket is left to the locale (A-Z, 가나다), with `numeric` so `item2` sorts
 * before `item10`.
 *
 * This lived inside the table component and nowhere else, so every other list picked its own
 * order: schedules sorted one way, modules another, capabilities not at all. Same list, same
 * order, wherever it is drawn.
 */

/** 숫자(0) → 영문(1) → 한글(2) → 기타(3). */
function scriptRank(s: string): number {
  const ch = s.trim()[0] ?? '';
  if (/[0-9]/.test(ch)) return 0;
  if (/[A-Za-z]/.test(ch)) return 1;
  if (/[가-힣ㄱ-ㆎ]/.test(ch)) return 2;
  return 3;
}

/** Compare two display names. Case-insensitive, script-bucketed, numeric-aware. */
export function compareName(a: string | null | undefined, b: string | null | undefined): number {
  const av = String(a ?? '').trim();
  const bv = String(b ?? '').trim();
  const ra = scriptRank(av);
  const rb = scriptRank(bv);
  if (ra !== rb) return ra - rb;
  return av.localeCompare(bv, 'ko', { numeric: true, sensitivity: 'base' });
}

/** Sort a copy by a name read off each item — the shape most lists here need. */
export function sortByName<T>(items: readonly T[], name: (item: T) => string | null | undefined): T[] {
  return [...items].sort((x, y) => compareName(name(x), name(y)));
}
