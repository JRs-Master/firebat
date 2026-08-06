'use client';

import { useZoneClock } from '../hooks/use-admin-timezone';

/**
 * Which clock the times on this panel are drawn in, and whether it is on summer time right now.
 *
 * A zone name is not a time: `America/New_York` is UTC−5 in January and UTC−4 in July, so a
 * schedule written against it drifts an hour a year against a zone that does not shift — and
 * Firebat's US market jobs are written in Seoul time, which does not. Saying which clock is on
 * screen is the cheap half of that problem; the other half is letting a job carry its own zone.
 *
 * Nothing is drawn for a zone that never shifts beyond its name, and nothing at all when the zone
 * is unknown — a header is no place to raise an error.
 */
export function ZoneBadge({ className = '' }: { className?: string }) {
  const clock = useZoneClock();
  if (!clock) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] ${className}`}>
      <span className="text-slate-400" title={`${clock.zone} (UTC${clock.offset})`}>
        {clock.abbr || clock.zone}
      </span>
      {clock.dstActive && (
        <span
          className="rounded bg-amber-100 px-1 py-px font-bold text-amber-700"
          title={`${clock.zone} 는 지금 서머타임입니다 (UTC${clock.offset}). 겨울에는 한 시간 물러납니다.`}
        >
          서머타임
        </span>
      )}
    </span>
  );
}
