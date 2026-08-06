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
