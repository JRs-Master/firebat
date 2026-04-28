/**
 * 태그 alias / normalize — CMS Phase 8a Step B.
 *
 * 사용자가 어드민 CMS settings 의 tagAliases textarea 에 박은 줄별 매핑을 파싱:
 *   AI: ai, 인공지능, artificial-intelligence
 *   주식: stock, equity
 *
 * normalizeTag("ai", aliases) → "AI"
 * normalizeTag("인공지능", aliases) → "AI"
 * normalizeTag("foo", aliases) → "foo" (alias 없음 → 원본 유지)
 *
 * case-insensitive 매칭 — "AI" / "ai" / "Ai" 모두 같은 canonical.
 */

export type TagAliases = Record<string, string[]>;

/** "canonical: alias1, alias2" 줄별 → { canonical: [aliases] } 파싱.
 *  잘못된 줄 (콜론 없거나 빈 라인) 은 skip. */
export function parseTagAliases(raw: string | null | undefined): TagAliases {
  if (!raw || typeof raw !== 'string') return {};
  const result: TagAliases = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;
    const canonical = trimmed.slice(0, colonIdx).trim();
    const aliasStr = trimmed.slice(colonIdx + 1).trim();
    if (!canonical || !aliasStr) continue;
    const aliases = aliasStr.split(',').map((s) => s.trim()).filter(Boolean);
    if (aliases.length > 0) result[canonical] = aliases;
  }
  return result;
}

/** input keyword → canonical 매핑. case-insensitive.
 *  alias 없으면 원본 (trim) 그대로 반환. */
export function normalizeTag(raw: string, aliases: TagAliases): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    if (canonical.toLowerCase() === lower) return canonical;
    if (aliasList.some((a) => a.toLowerCase() === lower)) return canonical;
  }
  return trimmed;
}
