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

/** What the configured zone is doing — computed by core, never here. */
export type ZoneClock = {
  zone: string;
  observesDst: boolean;
  dstActive: boolean;
  abbr: string;
  offsetMinutes: number;
  offset: string;
};

type TzSnapshot = { tz: string | null; clock: ZoneClock | null };

let cached: TzSnapshot | undefined; // undefined = never asked
let inflight: Promise<TzSnapshot> | null = null;
const listeners = new Set<(s: TzSnapshot) => void>();

async function fetchTz(): Promise<TzSnapshot> {
  try {
    const s = await apiGet<{ timezone?: string; timezoneClock?: ZoneClock | null }>(
      '/api/settings', { category: 'settings' });
    return { tz: s?.timezone || null, clock: s?.timezoneClock ?? null };
  } catch {
    return { tz: null, clock: null };
  }
}

function useTzSnapshot(): TzSnapshot {
  const [snap, setSnap] = useState<TzSnapshot>(cached ?? { tz: null, clock: null });
  useEffect(() => {
    if (cached !== undefined) { setSnap(cached); return; }
    listeners.add(setSnap);
    if (!inflight) {
      inflight = fetchTz().then(v => {
        cached = v;
        listeners.forEach(l => l(v));
        listeners.clear();
        return v;
      });
    }
    return () => { listeners.delete(setSnap); };
  }, []);
  return snap;
}

export function useAdminTimezone(): string | null {
  return useTzSnapshot().tz;
}

/**
 * What the configured zone is doing right now, as core reported it.
 *
 * Not computed here on purpose: whether a zone is on summer time is a fact about time, decided by
 * the same zone rules the scheduler evaluates against. A second implementation in the browser is a
 * second answer waiting to disagree with the first.
 */
export function useZoneClock(): ZoneClock | null {
  return useTzSnapshot().clock;
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
