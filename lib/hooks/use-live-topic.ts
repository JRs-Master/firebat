'use client';

/**
 * useLiveTopic — viewport-gated SSE topic subscription (live components lifetime rule):
 * live only while VISIBLE (IntersectionObserver, handled by the caller via `active`),
 * frozen at the last value when hidden, transcript persistence stays the creation-time
 * snapshot (live updates are client state only). Upstream cost: the shared singleton
 * EventSource (events-manager) exists only while some subscriber is active (ref-counted).
 */
import { useEffect, useRef, useState } from 'react';
import { subscribeServerEvents } from '../../app/admin/hooks/events-manager';

/** Live surfaces: the events SSE is admin-authed — published/shared pages stay frozen. */
export function canLiveHere(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.startsWith('/admin');
}

export function useLiveTopic(
  topic: string | undefined,
  active: boolean,
  onEvent: (data: unknown) => void,
) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!topic || !active || !canLiveHere()) return;
    const unsub = subscribeServerEvents((ev: { type?: string; data?: unknown }) => {
      if (ev?.type === topic) cb.current(ev.data);
    });
    return unsub;
  }, [topic, active]);
}

/** Viewport visibility for the lifetime rule — subscribe only while on screen. */
export function useInViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const ob = new IntersectionObserver((es) => setVisible(es.some(e => e.isIntersecting)));
    ob.observe(el);
    return () => ob.disconnect();
  }, []);
  return [ref, visible];
}
