'use client';

/**
 * The zone every timestamp on an admin screen should be rendered in.
 *
 * Inputs already resolve against the configured zone — a cron expression is evaluated in it, a
 * bare `runAt` is parsed in it — but the screens drew with `toLocaleString()`, which follows the
 * browser's clock. The two agree only while the operator's laptop happens to sit in the configured
 * zone; open the panel from anywhere else and every cron time silently shifts. Output should read
 * from the same setting the input resolves against.
 *
 * Fetched once per page load and shared module-wide: the setting changes rarely, and every list
 * on screen asking `/api/settings` per row would be noise. Falls back to the browser zone while
 * loading or when nothing is configured — the pre-existing behaviour, never worse.
 */
import { useEffect, useState } from 'react';
import { apiGet } from '../../../lib/api-fetch';

let cachedTz: string | null | undefined; // undefined = never asked, null = asked and unset
let inflight: Promise<string | null> | null = null;
const listeners = new Set<(tz: string | null) => void>();

async function fetchTz(): Promise<string | null> {
  try {
    const s = await apiGet<{ timezone?: string }>('/api/settings', { category: 'settings' });
    return s?.timezone || null;
  } catch {
    return null;
  }
}

export function useAdminTimezone(): string | null {
  const [tz, setTz] = useState<string | null>(cachedTz ?? null);
  useEffect(() => {
    if (cachedTz !== undefined) { setTz(cachedTz); return; }
    listeners.add(setTz);
    if (!inflight) {
      inflight = fetchTz().then(v => {
        cachedTz = v;
        listeners.forEach(l => l(v));
        listeners.clear();
        return v;
      });
    }
    return () => { listeners.delete(setTz); };
  }, []);
  return tz;
}

/** Epoch ms → `MM/DD HH:mm` in the given zone (browser zone when null). */
export function formatInTz(ms: number, tz: string | null): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz ?? undefined,
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
    return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    // An unknown zone name must not blank every timestamp on the panel.
    const d = new Date(ms);
    const p = (v: number) => String(v).padStart(2, '0');
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}

/**
 * What clock a zone is on right now — whether it observes daylight saving at all, whether it is
 * in it at this moment, and how to say so.
 *
 * Worth showing because a zone name alone does not tell you what time it is: `America/New_York`
 * is UTC−5 in January and UTC−4 in July, so a schedule written against it moves an hour relative
 * to any zone that does not (Seoul does not). Firebat's US market jobs are written in Seoul time
 * today, which is exactly the mismatch this badge exists to make visible.
 *
 * Daylight saving moves the clock forward, so the standard offset is the smaller of the year's
 * two — true in both hemispheres, where only the season differs.
 */
export type ZoneClock = {
  zone: string;
  /** Does this zone shift at some point in the year. */
  observesDst: boolean;
  /** Is the shift in force right now. */
  dstActive: boolean;
  /** `EDT`, `GMT+9` — whatever the runtime calls it. */
  abbr: string;
  /** `-04:00` */
  offset: string;
};

function offsetMinutes(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? '0');
  const hour = get('hour') === 24 ? 0 : get('hour');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60000);
}

export function zoneClock(zone: string | null, at: number = Date.now()): ZoneClock | null {
  if (!zone) return null;
  try {
    const year = new Date(at).getUTCFullYear();
    const jan = offsetMinutes(zone, Date.UTC(year, 0, 15));
    const jul = offsetMinutes(zone, Date.UTC(year, 6, 15));
    const now = offsetMinutes(zone, at);
    const standard = Math.min(jan, jul);
    const sign = now < 0 ? '-' : '+';
    const abs = Math.abs(now);
    const pad = (n: number) => String(n).padStart(2, '0');
    const abbr = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date(at)).find(p => p.type === 'timeZoneName')?.value ?? '';
    return {
      zone,
      observesDst: jan !== jul,
      dstActive: now > standard,
      abbr,
      offset: `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
    };
  } catch {
    // An unknown zone name must not break a panel header.
    return null;
  }
}
