/**
 * 숫자 표시 유틸 — 큰 수를 좁은 칸에 맞게 축약. 정확값은 호출부가 `title`(hover)로 노출 권장.
 */

/**
 * 일반 숫자·가격 축약 (로케일별).
 * - en: K(천) / M(백만) / B(십억) / T(조)
 * - ko: 만 / 억 / 조 / 경
 * 작은 수(en <1,000 / ko <10,000)는 풀 콤마.
 */
export function formatCompactNumber(n: number, lang: 'ko' | 'en' = 'en'): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  const f = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (lang === 'ko') {
    if (abs >= 1e16) return `${f(n / 1e16)}경`;
    if (abs >= 1e12) return `${f(n / 1e12)}조`;
    if (abs >= 1e8) return `${f(n / 1e8)}억`;
    if (abs >= 1e4) return `${f(n / 1e4)}만`;
    return n.toLocaleString('ko-KR');
  }
  if (abs >= 1e12) return `${f(n / 1e12)}T`;
  if (abs >= 1e9) return `${f(n / 1e9)}B`;
  if (abs >= 1e6) return `${f(n / 1e6)}M`;
  if (abs >= 1e3) return `${f(n / 1e3)}K`;
  return n.toLocaleString('en-US');
}

/**
 * 토큰 수 전용 — 로케일 무관 항상 **M(백만)** 단위.
 * LLM 공급사가 "1M 토큰당 $X" 로 가격을 안내하므로, 토큰은 만/억 대신 같은 M 단위로 표시해
 * 비용과 직접 대응시킨다 (토큰은 데이터 용량 KB/MB 가 아니라 개수다).
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const m = n / 1e6;
  const digits = Math.abs(m) < 1 ? 2 : 1;
  return `${m.toLocaleString('en-US', { maximumFractionDigits: digits })}M`;
}
